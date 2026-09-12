import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseWritingFeedbackTask } from '../src/domain/writing-feedback/WritingFeedbackTask.js';
import { OllamaWritingFeedbackProvider } from '../src/infrastructure/ai/OllamaWritingFeedbackProvider.js';
import {
  parseArguments,
  validateOperatorMetadata,
  evaluateCases,
} from '../scripts/evaluate-writing-feedback.js';

const metadata = {
  environment: 'isolated_non_production',
  operator: 'evaluation-operator',
  cpu_model: 'Operator-recorded CPU',
  cpu_flags: 'Operator-recorded instruction flags',
  physical_cores: 4,
  ram_bytes: 16_000_000_000,
  available_ram_bytes: 8_000_000_000,
  os: 'Operator-recorded OS',
  runtime_version: 'Operator-recorded Ollama version',
  container_digest: `sha256:${'a'.repeat(64)}`,
  cpu_only_verified: true,
  cloud_disabled_verified: true,
  private_endpoint_verified: true,
  workload_notes: 'Isolated test host; no Vocora learner traffic.',
};
const dataset = {
  schema_version: 1,
  dataset_id: 'test-fixtures',
  cases: [{
    case_id: 'valid-personal-answer',
    categories: ['alternative_valid_personal'],
    draft_text: 'I cooked dinner.',
    task_context: { prompt: 'What did you do yesterday?' },
    review_criteria: ['Accept this valid personal answer.'],
  }],
};

test('evaluation CLI defaults to dry-run and rejects unknown or unbounded options', () => {
  assert.equal(parseArguments([]).run, false);
  assert.equal(parseArguments(['--run']).run, true);
  assert.throws(() => parseArguments(['--runs', '8']), /Unknown argument/);
  assert.throws(() => parseArguments(['--repetitions', '4']), /repetitions/);
  assert.throws(() => parseArguments(['--timeout-ms', '0']), /timeout-ms/);
  assert.throws(() => parseArguments(['--run', '--dry-run']), /mutually exclusive/);
});

test('run validation requires complete immutable target-host metadata', () => {
  assert.doesNotThrow(() => validateOperatorMetadata(metadata));
  assert.throws(() => validateOperatorMetadata({ ...metadata, environment: 'production' }), /non.production/);
  assert.throws(() => validateOperatorMetadata({ ...metadata, container_digest: 'ollama:latest' }), /container_digest/);
  assert.throws(() => validateOperatorMetadata({ ...metadata, cpu_only_verified: false }), /cpu_only_verified/);
  assert.throws(() => validateOperatorMetadata({ ...metadata, cpu_flags: '' }), /cpu_flags/);
});

test('dry-run does not create or invoke a provider and fabricates no measurements', async () => {
  const report = await evaluateCases({
    dataset,
    providerFactory: () => { throw new Error('Network provider must stay unused'); },
  });
  assert.equal(report.execution_status, 'not_run');
  assert.equal(report.measurements, null);
  assert.equal(report.semantic_review.status, 'pending_independent_review');
  assert.equal(report.planned_requests, 1);
});

test('run refuses missing budget or metadata before creating a provider', async () => {
  let created = false;
  const providerFactory = () => { created = true; };
  await assert.rejects(evaluateCases({ dataset, run: true, providerFactory }), /metadata/);
  await assert.rejects(evaluateCases({ dataset, run: true, operatorMetadata: metadata, providerFactory }), /latency budget/);
  assert.equal(created, false);
});

test('successful provider results remain pending semantic review with evidence for each case', async () => {
  let ticks = 0;
  const requests = [];
  const identity = { model_digest: `sha256:${'b'.repeat(64)}` };
  const report = await evaluateCases({
    dataset, run: true, operatorMetadata: metadata, latencyBudgetMs: 100,
    repetitions: 2, now: () => { ticks += 40; return ticks; },
    providerFactory: () => ({
      getIdentity: () => identity,
      evaluate: async (request) => {
        requests.push(request);
        return { result: { issues: [] }, identity, metrics: { eval_count: 8 } };
      },
    }),
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].draftText, dataset.cases[0].draft_text);
  assert.equal(requests[0].locale, 'en');
  assert.equal('review_criteria' in requests[0], false);
  assert.equal(report.measurements.sample_size, 2);
  assert.equal(report.measurements.wall_latency_ms.p95, 40);
  assert.equal(report.measurements.request_latency_budget_met, true);
  assert.equal(report.measurements.peak_provider_ram_bytes, null);
  assert.equal(report.semantic_review.status, 'pending_independent_review');
  assert.equal(report.release_decision, 'not_established');
  assert.equal(report.results[0].semantic_review.status, 'pending_independent_review');
});

test('failed provider results are recorded without raw exception payloads or semantic failure claims', async () => {
  const report = await evaluateCases({
    dataset, run: true, operatorMetadata: metadata, latencyBudgetMs: 100,
    providerFactory: () => ({
      getIdentity: () => ({}),
      evaluate: async () => { throw Object.assign(new Error('secret raw provider output'), { code: 'INVALID_FEEDBACK' }); },
    }),
  });
  assert.equal(report.measurements.failed_requests, 1);
  assert.equal(report.results[0].execution_status, 'failed');
  assert.equal(JSON.stringify(report).includes('secret raw provider output'), false);
  assert.equal(report.results[0].semantic_review.status, 'pending_independent_review');
});

test('deadline aborts one bounded attempt and does not retry a hung provider', async () => {
  let calls = 0;
  const report = await evaluateCases({
    dataset, run: true, operatorMetadata: metadata, latencyBudgetMs: 100, timeoutMs: 10, repetitions: 2,
    providerFactory: () => ({
      getIdentity: () => ({}),
      evaluate: () => { calls += 1; return new Promise(() => {}); },
    }),
  });
  assert.equal(calls, 1);
  assert.equal(report.results[0].error_code, 'HARNESS_TIMEOUT');
  assert.equal(report.measurements.failed_requests, 1);
  assert.equal(report.measurements.unattempted_requests, 1);
  assert.equal(report.execution_status, 'stopped_after_timeout');
});

test('held-out context matches the canonical short-text task contract', async () => {
  const fixture = JSON.parse(await readFile(new URL('../../ielts/evaluation/writing-feedback-cases.json', import.meta.url), 'utf8'));
  assert.equal(fixture.cases.length, 17);
  for (const item of fixture.cases) {
    const { schemaVersion, learnerLevel, targetSkill, languageObjectives, taskExpectations, sourceText, targetVocabulary, ...slideData } = item.task_context;
    const parsed = parseWritingFeedbackTask({
      ...slideData,
      ...(targetVocabulary.length ? { targetVocabulary } : {}),
      writingFeedback: { schemaVersion, learnerLevel, targetSkill, languageObjectives, taskExpectations, ...(sourceText ? { sourceText } : {}) },
    });
    assert.deepEqual(parsed, item.task_context, item.case_id);
    assert.ok(item.draft_text.trim().split(/\s+/u).length <= parsed.wordLimit, item.case_id);
  }
});

test('held-out requests pass real provider input validation before missing-tokenizer refusal', async () => {
  const fixture = JSON.parse(await readFile(new URL('../../ielts/evaluation/writing-feedback-cases.json', import.meta.url), 'utf8'));
  let transportCalls = 0;
  const report = await evaluateCases({
    dataset: fixture, run: true, operatorMetadata: metadata, latencyBudgetMs: 100,
    providerFactory: () => new OllamaWritingFeedbackProvider({
      baseUrl: 'http://127.0.0.1:11434',
      modelDigest: `sha256:${'b'.repeat(64)}`,
      fetchImpl: async () => { transportCalls += 1; throw new Error('Transport must remain unused.'); },
    }),
  });
  assert.equal(report.results.length, fixture.cases.length);
  for (const result of report.results) {
    assert.equal(result.error_code, 'WRITING_FEEDBACK_TOKENIZER_UNAVAILABLE', result.case_id);
  }
  assert.equal(transportCalls, 0);
});
