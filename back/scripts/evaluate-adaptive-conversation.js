#!/usr/bin/env node
import { access, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { parseArguments, validateOperatorMetadata, timedAttempt, percentile, readJson } from './evaluate-writing-feedback.js';
import { parseConversationEvaluation } from '../src/domain/adaptive-conversation/ConversationPrompt.js';
import { loadWritingFeedbackConfig } from '../src/config/loadWritingFeedbackConfig.js';

const DEFAULT_CASES = fileURLToPath(new URL('../../ielts/evaluation/adaptive-conversation-cases.json', import.meta.url));
const PENDING_REVIEW = 'pending_independent_review';

export function parseConversationArguments(args) {
  const options = parseArguments(args);
  if (!args.includes('--cases')) options.cases = DEFAULT_CASES;
  return options;
}

function validateDataset(dataset) {
  if (dataset?.schema_version !== 1 || typeof dataset.dataset_id !== 'string'
    || !/^[a-z0-9-]{1,100}$/u.test(dataset.dataset_id)
    || dataset.provenance?.kind !== 'original_synthetic_transcripts' || dataset.provenance.recorded_audio !== false
    || !Array.isArray(dataset.cases) || dataset.cases.length < 1 || dataset.cases.length > 32) {
    throw new Error('Expected 1 to 32 original synthetic text-turn cases with explicit non-audio provenance.');
  }
  const ids = new Set();
  return dataset.cases.map(item => {
    if (typeof item.case_id !== 'string' || !/^[a-z0-9-]{1,100}$/u.test(item.case_id) || ids.has(item.case_id)) {
      throw new Error('Conversation case IDs must be distinct bounded slugs.');
    }
    ids.add(item.case_id);
    for (const field of ['categories', 'review_criteria']) {
      if (!Array.isArray(item[field]) || !item[field].length || item[field].length > 10
        || item[field].some(value => typeof value !== 'string' || !value.trim() || value.length > 1000)) {
        throw new Error('Each conversation case requires bounded categories and separate reviewer criteria.');
      }
    }
    // This canonical parser returns only accepted request fields. Criteria and
    // case metadata never become part of the provider's task or transcript.
    return { ...item, request: parseConversationEvaluation(item.request) };
  });
}

const latencySummary = values => {
  const sorted = [...values].sort((left, right) => left - right);
  return { p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), maximum: sorted.at(-1) ?? null };
};

export async function evaluateConversationCases({ dataset, run = false, operatorMetadata, latencyBudgetMs,
  repetitions = 1, timeoutMs = 120000, providerFactory, now = () => performance.now() }) {
  const cases = validateDataset(dataset);
  // Share CLI numeric admission rather than introducing different trial bounds.
  parseArguments(['--repetitions', String(repetitions), '--timeout-ms', String(timeoutMs),
    ...(latencyBudgetMs === undefined ? [] : ['--latency-budget-ms', String(latencyBudgetMs)])]);
  const report = {
    schema_version: 1, execution_status: 'not_run', scope: 'synthetic_text_turns_only',
    dataset_id: dataset.dataset_id, dataset_sha256: createHash('sha256').update(JSON.stringify(dataset)).digest('hex'),
    provenance: dataset.provenance, planned_requests: cases.length * repetitions,
    planned_model_requests: cases.filter(item => item.request.transcript.status === 'transcribed').length * repetitions,
    workload: { concurrency: 1, repetitions, retries: 0, timeout_ms: timeoutMs },
    case_manifest: cases.map(({ case_id, categories }) => ({ case_id, categories })),
    provider_identity: null, operator_metadata: null, measurements: null,
    semantic_review: { status: PENDING_REVIEW, reviewers: [], quality_rates: null },
    release_decision: 'not_established', results: [],
  };
  if (!run) return report;
  validateOperatorMetadata(operatorMetadata);
  if (latencyBudgetMs === undefined) throw new Error('An operator-selected latency budget is required before inference.');
  if (typeof providerFactory !== 'function') throw new Error('An explicit pinned provider configuration is required.');
  const provider = await providerFactory();
  report.provider_identity = provider.getIdentity(); report.operator_metadata = operatorMetadata;
  report.execution_status = 'completed'; report.case_manifest = cases;
  attempts: for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    for (const item of cases) {
      const inferencePath = item.request.transcript.status === 'insufficient_evidence' ? 'server_abstention' : 'model_text_request';
      const outcome = await timedAttempt(provider, item.request, timeoutMs, now);
      report.results.push({ case_id: item.case_id, repetition, inference_path: inferencePath, ...outcome,
        deterministic_contract: outcome.execution_status === 'succeeded' ? 'validated_by_provider' : 'not_established',
        cache_state: 'unverified', semantic_review: { status: PENDING_REVIEW, reviewer_findings: [] } });
      if (outcome.error_code === 'HARNESS_TIMEOUT') {
        report.execution_status = 'stopped_after_timeout'; break attempts;
      }
    }
  }
  const modelPath = report.results.filter(item => item.inference_path === 'model_text_request');
  const successful = report.results.filter(item => item.execution_status === 'succeeded').length;
  const modelLatency = latencySummary(modelPath.map(item => item.wall_latency_ms));
  report.measurements = {
    sample_size: report.results.length, model_path_sample_size: modelPath.length,
    successful_requests: successful, failed_requests: report.results.length - successful,
    unattempted_requests: report.planned_requests - report.results.length,
    wall_latency_ms: latencySummary(report.results.map(item => item.wall_latency_ms)),
    model_path_wall_latency_ms: modelLatency, latency_budget_ms: latencyBudgetMs,
    request_latency_budget_met: successful === report.planned_requests && modelPath.length > 0 && modelLatency.p95 <= latencyBudgetMs,
    peak_provider_ram_bytes: null, cpu_saturation: null, cold_load_verified: false,
    colocated_service_latency: null, queue_and_burst_behavior: 'not_measured',
    asr_quality: 'not_measured', tts_quality: 'not_measured', recorded_speech_pipeline: 'not_measured',
  };
  return report;
}

export async function makeConversationProvider(config, timeoutMs) {
  if (!config || config.model !== 'qwen3:4b-instruct-2507-q4_K_M' || !config.tokenizer) {
    throw new Error('The exact local model and matching pinned tokenizer configuration are required.');
  }
  const checked = loadWritingFeedbackConfig({ WRITING_FEEDBACK_OLLAMA_URL: config.baseUrl,
    WRITING_FEEDBACK_MODEL_DIGEST: config.modelDigest,
    WRITING_FEEDBACK_GGUF_PATH: config.tokenizer.modelPath,
    WRITING_FEEDBACK_OLLAMA_MANIFEST_PATH: config.tokenizer.manifestPath,
    WRITING_FEEDBACK_TOKENIZER_PYTHON: config.tokenizer.pythonExecutable,
    WRITING_FEEDBACK_TOKENIZER_VERSION: config.tokenizer.llamaCppVersion,
    WRITING_FEEDBACK_TOKENIZER_LIBRARY_SHA256: config.tokenizer.nativeLibrarySha256,
  }, { requireProvider: true });
  // A malformed/missing native setup must not cause a model request first.
  await Promise.all([access(checked.tokenizer.modelPath, constants.R_OK),
    access(checked.tokenizer.manifestPath, constants.R_OK), access(checked.tokenizer.pythonExecutable, constants.X_OK)]);
  const { OllamaConversationProvider } = await import('../src/infrastructure/ai/OllamaConversationProvider.js');
  const { WritingFeedbackTokenizer } = await import('../src/infrastructure/ai/WritingFeedbackTokenizer.js');
  return new OllamaConversationProvider({ baseUrl: checked.providerUrl, model: checked.model, modelDigest: checked.modelDigest,
    numCtx: config.numCtx, numPredict: config.numPredict, timeoutMs, tokenizer: new WritingFeedbackTokenizer(checked.tokenizer) });
}

async function main() {
  const options = parseConversationArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('Usage: node back/scripts/evaluate-adaptive-conversation.js [--dry-run] [--cases FILE] [--output FILE]\n'
      + 'Text-turn inference only: --run --provider-config FILE --operator-metadata FILE --latency-budget-ms N\n'
      + 'Bounds: [--repetitions 1..3] [--timeout-ms 1..120000]. No ASR or TTS measurement.\n'); return;
  }
  const dataset = await readJson(options.cases);
  if (options.run && (!options.providerConfig || !options.operatorMetadata)) {
    throw new Error('--run requires --provider-config and --operator-metadata files.');
  }
  const report = await evaluateConversationCases({ dataset, run: options.run, repetitions: options.repetitions,
    timeoutMs: options.timeoutMs, latencyBudgetMs: options.latencyBudgetMs,
    operatorMetadata: options.run ? await readJson(options.operatorMetadata) : undefined,
    providerFactory: options.run ? async () => makeConversationProvider(await readJson(options.providerConfig), options.timeoutMs) : undefined });
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) await writeFile(options.output, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  else process.stdout.write(serialized);
  if (report.measurements?.failed_requests) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    process.stderr.write(`${JSON.stringify({ execution_status: 'failed', error: 'Conversation evaluation could not start or save its report. Check arguments, case files, metadata and pinned local provider configuration.' })}\n`);
    process.exitCode = 1;
  });
}
