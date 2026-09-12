import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseConversationEvaluation } from '../src/domain/adaptive-conversation/ConversationPrompt.js';
import { OllamaConversationProvider } from '../src/infrastructure/ai/OllamaConversationProvider.js';
import { parseConversationArguments, evaluateConversationCases, makeConversationProvider } from '../scripts/evaluate-adaptive-conversation.js';

const dataset = JSON.parse(await readFile(new URL('../../ielts/evaluation/adaptive-conversation-cases.json', import.meta.url), 'utf8'));
const metadata = { environment: 'isolated_non_production', operator: 'fixture operator', cpu_model: 'fixture CPU',
  cpu_flags: 'fixture flags', physical_cores: 4, ram_bytes: 16000000000, available_ram_bytes: 8000000000,
  os: 'fixture OS', runtime_version: 'fixture runtime', container_digest: `sha256:${'a'.repeat(64)}`,
  cpu_only_verified: true, cloud_disabled_verified: true, private_endpoint_verified: true, workload_notes: 'Synthetic contract test.' };
const subset = (...ids) => ({ ...dataset, cases: dataset.cases.filter(item => ids.includes(item.case_id)) });

test('AC CLI defaults to a no-inference dry run with synthetic text-only scope', async () => {
  assert.equal(parseConversationArguments([]).run, false);
  assert.match(parseConversationArguments([]).cases, /adaptive-conversation-cases\.json$/);
  assert.throws(() => parseConversationArguments(['--repetitions', '4']));
  assert.throws(() => parseConversationArguments(['--run', '--dry-run']));
  const report = await evaluateConversationCases({ dataset, providerFactory: () => { throw new Error('Must not instantiate'); } });
  assert.equal(report.execution_status, 'not_run'); assert.equal(report.measurements, null);
  assert.equal(report.scope, 'synthetic_text_turns_only'); assert.equal(report.planned_requests, 12);
  assert.equal(report.planned_model_requests, 11); assert.equal(report.provenance.recorded_audio, false);
  assert.equal(report.semantic_review.status, 'pending_independent_review'); assert.equal(report.release_decision, 'not_established');
  const { stdout } = await promisify(execFile)(process.execPath, [new URL('../scripts/evaluate-adaptive-conversation.js', import.meta.url).pathname]);
  assert.equal(JSON.parse(stdout).execution_status, 'not_run');
});

test('every original case fits the actual bounded E09 provider request contract', () => {
  assert.equal(dataset.cases.length, 12);
  for (const item of dataset.cases) {
    assert.deepEqual(parseConversationEvaluation(item.request), item.request, item.case_id);
    assert.equal(item.request.transcript.confidence, null);
    assert.equal(item.request.transcript.providerIdentity.modelDigest, null);
    assert.equal(item.request.config.questionConstraints.maximumWords, 14);
  }
  assert.equal(dataset.cases.find(item => item.case_id === 'where-elliptical-complete').request.transcript.text, 'At home.');
  assert.equal(dataset.cases.find(item => item.case_id === 'where-off-topic-drink').request.transcript.text, 'I drink milk.');
});

test('operator metadata, prior budget and real provider pins fail closed before inference', async () => {
  let created = false; const providerFactory = () => { created = true; };
  await assert.rejects(evaluateConversationCases({ dataset, run: true, providerFactory }), /metadata/i);
  await assert.rejects(evaluateConversationCases({ dataset, run: true, operatorMetadata: metadata, providerFactory }), /latency budget/i);
  await assert.rejects(evaluateConversationCases({ dataset, run: true, operatorMetadata: { ...metadata, private_endpoint_verified: false }, latencyBudgetMs: 100, providerFactory }));
  assert.equal(created, false);
  for (const config of [{}, { model: 'cloud-model' }, { model: 'qwen3:4b-instruct-2507-q4_K_M', modelDigest: 'latest', tokenizer: {} },
    { model: 'qwen3:4b-instruct-2507-q4_K_M', modelDigest: `sha256:${'a'.repeat(64)}`, tokenizer: { manifestPath: '/missing/manifest', modelPath: '/missing/model', pythonExecutable: '/missing/python', llamaCppVersion: '0.3.16', nativeLibrarySha256: 'b'.repeat(64) } }]) {
    await assert.rejects(makeConversationProvider(config, 100));
  }
});

test('review criteria and categories never reach the provider; success remains unreviewed', async () => {
  const requests = []; let ticks = 0;
  const report = await evaluateConversationCases({ dataset: subset('where-elliptical-complete'), run: true,
    operatorMetadata: metadata, latencyBudgetMs: 100, now: () => (ticks += 20),
    providerFactory: () => ({ getIdentity: () => ({ modelDigest: 'test-only' }), evaluate: async request => {
      requests.push(request); return { result: { taskResponse: 'complete' }, identity: { test: true }, metrics: { prompt_eval_count: 15 } };
    } }) });
  const { signal, ...request } = requests[0];
  assert.ok(signal instanceof AbortSignal); assert.deepEqual(request, dataset.cases[0].request);
  assert.equal(JSON.stringify(request).includes('review_criteria'), false);
  assert.equal(JSON.stringify(request).includes(dataset.cases[0].review_criteria[0]), false);
  assert.equal(report.results[0].semantic_review.status, 'pending_independent_review');
  assert.equal(report.measurements.asr_quality, 'not_measured'); assert.equal(report.measurements.tts_quality, 'not_measured');
  assert.equal(report.measurements.peak_provider_ram_bytes, null); assert.equal(report.release_decision, 'not_established');
});

test('harness deadline aborts once and stops remaining cases without retry or overlapping work', async () => {
  let calls = 0; let signal;
  const report = await evaluateConversationCases({ dataset, run: true, operatorMetadata: metadata,
    latencyBudgetMs: 100, timeoutMs: 10, providerFactory: () => ({ getIdentity: () => ({}), evaluate: input => {
      calls += 1; signal = input.signal; return new Promise(() => {});
    } }) });
  assert.equal(calls, 1); assert.equal(signal.aborted, true);
  assert.equal(report.execution_status, 'stopped_after_timeout'); assert.equal(report.results[0].error_code, 'HARNESS_TIMEOUT');
  assert.equal(report.measurements.unattempted_requests, 11);
});

test('real provider request admission preserves ASR abstention and never claims that it ran a model', async () => {
  let transportCalls = 0;
  const report = await evaluateConversationCases({ dataset, run: true, operatorMetadata: metadata, latencyBudgetMs: 100,
    providerFactory: () => new OllamaConversationProvider({ modelDigest: `sha256:${'a'.repeat(64)}`,
      fetchImpl: async () => { transportCalls += 1; throw new Error('Must not call a model'); } }) });
  assert.equal(transportCalls, 0);
  for (const item of report.results) {
    if (item.case_id === 'asr-insufficient-evidence') {
      assert.equal(item.execution_status, 'succeeded'); assert.equal(item.result.assessmentStatus, 'insufficient_evidence');
      assert.equal(item.inference_path, 'server_abstention');
    } else assert.equal(item.error_code, 'CONVERSATION_TOKENIZER_UNAVAILABLE');
  }
  assert.equal(report.measurements.model_path_sample_size, 11);
  assert.equal(report.measurements.request_latency_budget_met, false);
});

test('provider failures expose bounded codes while semantic judgments remain pending', async () => {
  const report = await evaluateConversationCases({ dataset: subset('where-elliptical-complete'), run: true,
    operatorMetadata: metadata, latencyBudgetMs: 100, providerFactory: () => ({ getIdentity: () => ({}),
      evaluate: async () => { throw new Error('secret raw model text'); } }) });
  assert.equal(report.results[0].error_code, 'PROVIDER_FAILURE');
  assert.equal(JSON.stringify(report).includes('secret raw model text'), false);
  assert.equal(report.results[0].semantic_review.status, 'pending_independent_review');
});
