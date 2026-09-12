#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const DEFAULT_CASES = fileURLToPath(new URL('../../ielts/evaluation/writing-feedback-cases.json', import.meta.url));
const PENDING_REVIEW = 'pending_independent_review';

function boundedInteger(value, name, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${maximum}.`);
  }
  return number;
}

export function parseArguments(args) {
  const options = { run: false, cases: DEFAULT_CASES, repetitions: 1, timeoutMs: 120000 };
  const values = {
    '--cases': 'cases', '--provider-config': 'providerConfig',
    '--operator-metadata': 'operatorMetadata', '--output': 'output',
    '--latency-budget-ms': 'latencyBudgetMs', '--timeout-ms': 'timeoutMs',
    '--repetitions': 'repetitions',
  };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (seen.has(key)) throw new Error(`Duplicate argument: ${key}`);
    seen.add(key);
    if (key === '--run') options.run = true;
    else if (key === '--dry-run') options.run = false;
    else if (key === '--help') options.help = true;
    else if (values[key]) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
      options[values[key]] = value;
    } else throw new Error(`Unknown argument: ${key}`);
  }
  if (seen.has('--run') && seen.has('--dry-run')) throw new Error('--run and --dry-run are mutually exclusive.');
  options.repetitions = boundedInteger(options.repetitions, 'repetitions', 3);
  options.timeoutMs = boundedInteger(options.timeoutMs, 'timeout-ms', 120000);
  if (options.latencyBudgetMs !== undefined) {
    options.latencyBudgetMs = boundedInteger(options.latencyBudgetMs, 'latency-budget-ms', 120000);
  }
  return options;
}

export function validateOperatorMetadata(metadata) {
  if (!metadata || metadata.environment !== 'isolated_non_production') {
    throw new Error('Operator metadata must identify an isolated_non_production environment.');
  }
  for (const key of ['operator', 'cpu_model', 'cpu_flags', 'os', 'runtime_version', 'workload_notes']) {
    if (typeof metadata[key] !== 'string' || !metadata[key].trim()) throw new Error(`Operator metadata requires ${key}.`);
  }
  for (const key of ['physical_cores', 'ram_bytes', 'available_ram_bytes']) {
    if (!Number.isSafeInteger(metadata[key]) || metadata[key] < 1) throw new Error(`Operator metadata requires positive ${key}.`);
  }
  if (metadata.available_ram_bytes > metadata.ram_bytes) throw new Error('available_ram_bytes cannot exceed ram_bytes.');
  if (!/^sha256:[a-f0-9]{64}$/.test(metadata.container_digest ?? '')) {
    throw new Error('Operator metadata requires a full immutable container_digest.');
  }
  for (const key of ['cpu_only_verified', 'cloud_disabled_verified', 'private_endpoint_verified']) {
    if (metadata[key] !== true) throw new Error(`Operator metadata requires ${key}: true.`);
  }
}

function validateDataset(dataset) {
  if (dataset?.schema_version !== 1 || typeof dataset.dataset_id !== 'string'
    || !Array.isArray(dataset.cases) || dataset.cases.length < 1 || dataset.cases.length > 32) {
    throw new Error('Dataset must have schema_version 1, a dataset_id and 1 to 32 cases.');
  }
  const ids = new Set();
  for (const item of dataset.cases) {
    if (!/^[a-z0-9-]+$/.test(item.case_id ?? '') || ids.has(item.case_id)) throw new Error('Dataset case IDs must be unique slug strings.');
    ids.add(item.case_id);
    if (typeof item.draft_text !== 'string' || !item.draft_text.trim() || item.draft_text.length > 8000) {
      throw new Error(`Case ${item.case_id} requires a nonempty draft of at most 8000 UTF-16 code units.`);
    }
    if (!item.task_context || typeof item.task_context.prompt !== 'string') throw new Error(`Case ${item.case_id} requires task_context.prompt.`);
    if (!Array.isArray(item.categories) || !item.categories.length || item.categories.some((value) => typeof value !== 'string')) {
      throw new Error(`Case ${item.case_id} requires categories.`);
    }
    if (!Array.isArray(item.review_criteria) || !item.review_criteria.length
      || item.review_criteria.some((value) => typeof value !== 'string' || !value.trim())) {
      throw new Error(`Case ${item.case_id} requires human review_criteria.`);
    }
  }
}

export function percentile(sorted, fraction) {
  return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] : null;
}

export async function timedAttempt(provider, request, timeoutMs, now) {
  const controller = new AbortController();
  const started = now();
  let timer;
  try {
    const timeout = new Promise((resolveTimeout, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(Object.assign(new Error('Harness deadline exceeded.'), { code: 'HARNESS_TIMEOUT' }));
      }, timeoutMs);
    });
    const output = await Promise.race([
      Promise.resolve().then(() => provider.evaluate({ ...request, signal: controller.signal })), timeout,
    ]);
    return { execution_status: 'succeeded', wall_latency_ms: now() - started, ...output };
  } catch (error) {
    const code = typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
      ? error.code : 'PROVIDER_FAILURE';
    return { execution_status: 'failed', wall_latency_ms: now() - started, error_code: code };
  } finally {
    clearTimeout(timer);
  }
}

export async function evaluateCases({
  dataset, run = false, operatorMetadata, latencyBudgetMs, repetitions = 1,
  timeoutMs = 120000, providerFactory, now = () => performance.now(),
}) {
  validateDataset(dataset);
  boundedInteger(repetitions, 'repetitions', 3);
  boundedInteger(timeoutMs, 'timeout-ms', 120000);
  const report = {
    schema_version: 1,
    execution_status: 'not_run',
    dataset_id: dataset.dataset_id,
    dataset_sha256: createHash('sha256').update(JSON.stringify(dataset)).digest('hex'),
    planned_requests: dataset.cases.length * repetitions,
    workload: { concurrency: 1, repetitions, retries: 0, timeout_ms: timeoutMs },
    case_manifest: dataset.cases.map(({ case_id, categories }) => ({ case_id, categories })),
    provider_identity: null,
    operator_metadata: null,
    measurements: null,
    semantic_review: { status: PENDING_REVIEW, reviewers: [], quality_rates: null },
    release_decision: 'not_established',
    results: [],
  };
  if (!run) return report;
  validateOperatorMetadata(operatorMetadata);
  if (latencyBudgetMs === undefined) throw new Error('An operator-selected latency budget is required before inference.');
  boundedInteger(latencyBudgetMs, 'latency budget', 120000);
  if (typeof providerFactory !== 'function') throw new Error('An explicit provider configuration is required before inference.');
  const provider = await providerFactory();
  report.provider_identity = provider.getIdentity();
  report.operator_metadata = operatorMetadata;
  report.execution_status = 'completed';
  report.case_manifest = dataset.cases;
  attempts: for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    for (const item of dataset.cases) {
      const outcome = await timedAttempt(provider, {
        draftText: item.draft_text, draftVersion: 'evaluation-draft-v1', taskContext: item.task_context,
        contentVersion: `${dataset.dataset_id}:${item.case_id}`, locale: 'en',
      }, timeoutMs, now);
      report.results.push({
        case_id: item.case_id, repetition, ...outcome,
        deterministic_contract: outcome.execution_status === 'succeeded' ? 'validated_by_provider' : 'not_established',
        cache_state: 'unverified',
        semantic_review: { status: PENDING_REVIEW, reviewer_findings: [] },
      });
      if (outcome.error_code === 'HARNESS_TIMEOUT') {
        report.execution_status = 'stopped_after_timeout';
        break attempts;
      }
    }
  }
  const latencies = report.results.map((item) => item.wall_latency_ms).sort((left, right) => left - right);
  const successful = report.results.filter((item) => item.execution_status === 'succeeded').length;
  report.measurements = {
    sample_size: report.results.length,
    successful_requests: successful,
    failed_requests: report.results.length - successful,
    unattempted_requests: report.planned_requests - report.results.length,
    wall_latency_ms: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), maximum: latencies.at(-1) ?? null },
    latency_budget_ms: latencyBudgetMs,
    request_latency_budget_met: successful === report.planned_requests && percentile(latencies, 0.95) <= latencyBudgetMs,
    peak_provider_ram_bytes: null,
    cpu_saturation: null,
    cold_load_verified: false,
    colocated_service_latency: null,
    queue_and_burst_behavior: 'not_measured',
  };
  return report;
}

export async function readJson(filename) {
  try { return JSON.parse(await readFile(filename, 'utf8')); }
  catch { throw new Error('Could not read valid JSON from a supplied configuration or case file.'); }
}

async function makeProvider(config, timeoutMs) {
  const { OllamaWritingFeedbackProvider } = await import('../src/infrastructure/ai/OllamaWritingFeedbackProvider.js');
  const { WritingFeedbackTokenizer } = await import('../src/infrastructure/ai/WritingFeedbackTokenizer.js');
  return new OllamaWritingFeedbackProvider({ ...config, tokenizer: new WritingFeedbackTokenizer(config.tokenizer), timeoutMs });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('Usage: node back/scripts/evaluate-writing-feedback.js [--dry-run] [--cases FILE] [--output FILE]\n'
      + 'Inference: --run --provider-config FILE --operator-metadata FILE --latency-budget-ms N\n'
      + 'Bounds: [--repetitions 1..3] [--timeout-ms 1..120000]\n');
    return;
  }
  const dataset = await readJson(options.cases);
  if (options.run && (!options.providerConfig || !options.operatorMetadata)) {
    throw new Error('--run requires --provider-config and --operator-metadata files.');
  }
  const report = await evaluateCases({
    dataset, run: options.run, repetitions: options.repetitions, timeoutMs: options.timeoutMs,
    latencyBudgetMs: options.latencyBudgetMs,
    operatorMetadata: options.run ? await readJson(options.operatorMetadata) : undefined,
    providerFactory: options.run ? async () => makeProvider(await readJson(options.providerConfig), options.timeoutMs) : undefined,
  });
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) await writeFile(options.output, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  else process.stdout.write(serialized);
  if (report.measurements?.failed_requests) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    process.stderr.write(`${JSON.stringify({ execution_status: 'failed', error: 'Evaluation could not start or save its report. Check arguments, JSON files, operator metadata and provider configuration.' })}\n`);
    process.exitCode = 1;
  });
}
