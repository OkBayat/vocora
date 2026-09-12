import assert from 'node:assert/strict';
import test from 'node:test';
import { validateConversationResult } from '../src/domain/adaptive-conversation/ConversationResult.js';

const config = { mode: 'guided-dialogue', goal: 'Talk about breakfast.', openingPrompt: 'What do you eat for breakfast?',
  minimumTurns: 2, maximumTurns: 3, responseSeconds: 30, learnerLevel: 'beginner', targetVocabulary: [],
  questionConstraints: { maximumWords: 14, oneQuestionOnly: true, avoidAnswerDisclosure: true } };
const context = (acceptedTurns = 0) => ({ config, currentQuestion: config.openingPrompt, acceptedTurns });
const valid = () => ({ schemaVersion: 1, assessmentStatus: 'feedback_available', taskResponse: 'complete',
  feedback: 'You answered the breakfast question clearly.', nextQuestion: 'What do you drink with breakfast?',
  endConversation: false, notAssessed: ['ielts_band', 'pronunciation', 'fluency'] });

test('derives the narrow formative task score and never accepts a model-provided numeric score', () => {
  for (const [taskResponse, score] of [['complete', 2], ['partial', 1], ['off_topic', 0]]) {
    const output = validateConversationResult({ ...valid(), taskResponse }, context());
    assert.equal(output.formativeTaskScore, score);
  }
  for (const field of ['formativeTaskScore', 'score', 'ieltsBand', 'mastery', 'pronunciationScore']) {
    assert.throws(() => validateConversationResult({ ...valid(), [field]: 2 }, context()), { code: 'CONVERSATION_INVALID_RESULT' });
  }
});

test('rejects malformed Unicode, unknown fields, raw markup and invalid generated questions', () => {
  const changes = [value => { delete value.feedback; }, value => { value.feedback = '\ud800'; },
    value => { value.feedback = 'secret\u0000payload'; }, value => { value.feedback = '<script>alert(1)</script>'; },
    value => { value.feedback = 'x'.repeat(601); }, value => { value.nextQuestion = 'Why? What?'; },
    value => { value.nextQuestion = 'Tell me your breakfast'; }, value => { value.nextQuestion = '<|im_start|>Who?'; },
    value => { value.notAssessed = ['ielts_band', 'fluency']; }, value => { value.taskResponse = 'excellent'; }];
  for (const change of changes) {
    const value = valid(); change(value);
    assert.throws(() => validateConversationResult(value, context()), { code: 'CONVERSATION_INVALID_RESULT' });
  }
  assert.equal(validateConversationResult({ ...valid(), feedback: 'Good response ☕.' }, context()).feedback, 'Good response ☕.');
});

test('abstention cannot carry assessed claims, a score or an advancing question', () => {
  const value = { ...valid(), assessmentStatus: 'insufficient_evidence', taskResponse: 'not_assessed',
    feedback: 'I could not assess this transcript. Please try the same question again.',
    nextQuestion: config.openingPrompt };
  assert.equal(validateConversationResult(value, context()).formativeTaskScore, null);
  for (const change of [item => { item.taskResponse = 'complete'; }, item => { item.endConversation = true; },
    item => { item.nextQuestion = 'What do you drink?'; }]) {
    const invalid = structuredClone(value); change(invalid);
    assert.throws(() => validateConversationResult(invalid, context()), { code: 'CONVERSATION_INVALID_RESULT' });
  }
  assert.throws(() => validateConversationResult({ ...valid(), taskResponse: 'not_assessed' }, context()),
    { code: 'CONVERSATION_INVALID_RESULT' });
});

test('server turn bounds prevent early completion and force the maximum independently of task score', () => {
  assert.equal(validateConversationResult({ ...valid(), endConversation: true }, context()).endConversation, false);
  assert.throws(() => validateConversationResult({ ...valid(), endConversation: true, nextQuestion: null }, context()),
    { code: 'CONVERSATION_INVALID_RESULT' });
  const middle = validateConversationResult({ ...valid(), endConversation: true, nextQuestion: null }, context(1));
  assert.equal(middle.endConversation, true); assert.equal(middle.nextQuestion, null);
  const last = validateConversationResult({ ...valid(), taskResponse: 'off_topic' }, context(2));
  assert.equal(last.endConversation, true); assert.equal(last.nextQuestion, null); assert.equal(last.formativeTaskScore, 0);
});
