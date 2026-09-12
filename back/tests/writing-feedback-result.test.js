import assert from 'node:assert/strict';
import test from 'node:test';
import { validateWritingFeedbackResult } from '../src/domain/writing-feedback/WritingFeedbackResult.js';

const available = () => ({
  schema_version: 1, assessment_status: 'feedback_available', abstention_reason: null,
  task_relevance: 'on_topic', task_comment: 'You described yesterday.',
  issues: [{ category: 'grammar', kind: 'error', quoted_text: 'go', occurrence: 1,
    replacement: 'went', explanation: 'Use the past form for yesterday.' }],
  revision_actions: ['Use the past form.'], not_assessed: ['ielts_band'], ielts_band: null,
});

test('anchors quotes in the original draft using Unicode code points and exact occurrences', () => {
  const draft = '😀 I go, then go.\r\n';
  const model = available(); model.issues[0].occurrence = 2;
  const result = validateWritingFeedbackResult(model, draft);
  assert.deepEqual(result.issues[0].span, { start: 13, end: 15, indexing: 'unicode-code-points' });
  assert.equal(Array.from(draft).slice(13, 15).join(''), 'go');
  assert.equal(model.issues[0].span, undefined);
});

test('accepts a correct alternative without manufacturing an issue or a score', () => {
  const result = available(); result.issues = [];
  result.revision_actions = ['Keep this clear meaning in your next answer.'];
  assert.equal(validateWritingFeedbackResult(result, 'I stayed at home.').issues.length, 0);
});

test('rejects extra fields, score injection, unknown enums, missing fields and excessive feedback', () => {
  const changes = [
    value => { value.score = 9; },
    value => { value.ielts_band = 9; },
    value => { value.schema_version = 2; },
    value => { value.issues[0].span = { start: 2, end: 4 }; },
    value => { value.issues[0].kind = 'correct'; },
    value => { delete value.not_assessed; },
    value => { value.not_assessed = ['grammar']; },
    value => { value.issues = Array.from({ length: 4 }, () => value.issues[0]); },
  ];
  for (const change of changes) {
    const result = available(); change(result);
    assert.throws(() => validateWritingFeedbackResult(result, 'I go.'), { code: 'WRITING_FEEDBACK_INVALID_RESULT' });
  }
});

test('rejects nonexistent quotes, absent or invalid occurrences and overlapping edits', () => {
  const changes = [
    value => { value.issues[0].quoted_text = 'went'; },
    value => { value.issues[0].occurrence = 0; },
    value => { value.issues[0].occurrence = 2; },
    value => { value.issues[0].occurrence = null; },
    value => { value.issues.push({ ...value.issues[0], quoted_text: 'I go', replacement: 'I went' }); },
  ];
  for (const change of changes) {
    const result = available(); change(result);
    assert.throws(() => validateWritingFeedbackResult(result, 'I go.'), { code: 'WRITING_FEEDBACK_INVALID_RESULT' });
  }
});

test('counts repeated quotes as non-overlapping occurrences', () => {
  const model = available(); model.issues[0].quoted_text = 'aa'; model.issues[0].occurrence = 2;
  assert.throws(() => validateWritingFeedbackResult(model, 'aaa'), { code: 'WRITING_FEEDBACK_INVALID_RESULT' });
});

test('task-level omissions never invent draft spans or replacement sentences', () => {
  const model = available();
  model.issues = [{ category: 'task_coverage', kind: 'suggestion', quoted_text: null,
    occurrence: null, replacement: null, explanation: 'Add the place you visited.' }];
  assert.equal(validateWritingFeedbackResult(model, 'I travelled yesterday.').issues[0].span, null);
  model.issues[0].replacement = 'I travelled to London.';
  assert.throws(() => validateWritingFeedbackResult(model, 'I travelled yesterday.'), { code: 'WRITING_FEEDBACK_INVALID_RESULT' });
});

test('abstention is explicit and cannot carry contradictory assessed findings', () => {
  const model = available(); Object.assign(model, {
    assessment_status: 'insufficient_evidence', abstention_reason: 'The source text is missing.',
    task_relevance: 'not_assessed', issues: [], revision_actions: ['Provide the source text.'],
  });
  assert.equal(validateWritingFeedbackResult(model, 'It increased.').assessment_status, 'insufficient_evidence');
  model.abstention_reason = null;
  assert.throws(() => validateWritingFeedbackResult(model, 'It increased.'), { code: 'WRITING_FEEDBACK_INVALID_RESULT' });
});

test('preserves codepoint distinctions instead of silently normalizing evidence', () => {
  const model = available(); model.issues[0].quoted_text = 'é';
  assert.throws(() => validateWritingFeedbackResult(model, 'e\u0301'), { code: 'WRITING_FEEDBACK_INVALID_RESULT' });
});

test('an explicitly unassessed dimension cannot produce a correction or task-level issue', () => {
  for (const category of ['source_fidelity', 'task_coverage']) {
    for (const anchored of [true, false]) {
      const model = available(); model.not_assessed.push(category);
      model.issues = [{ category, kind: 'error', quoted_text: anchored ? '80' : null,
        occurrence: anchored ? 1 : null, replacement: anchored ? '50' : null,
        explanation: 'Check the number against the task.' }];
      assert.throws(() => validateWritingFeedbackResult(model, 'There were 80 people.'),
        { code: 'WRITING_FEEDBACK_INVALID_RESULT' });
    }
  }
});
