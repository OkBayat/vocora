import { matchesClosedSchema } from '../structured-output/matchesClosedSchema.js';
import { WritingFeedbackError } from './WritingFeedbackError.js';
import { WRITING_FEEDBACK_SCHEMA } from './WritingFeedbackSchema.js';

function invalid() { throw new WritingFeedbackError('WRITING_FEEDBACK_INVALID_RESULT'); }


function locateQuote(draft, quote, occurrence) {
  if (!quote || !Number.isSafeInteger(occurrence)) invalid();
  let start = -1; let cursor = 0;
  for (let found = 0; found < occurrence; found += 1) {
    start = draft.indexOf(quote, cursor);
    if (start < 0) invalid();
    cursor = start + quote.length;
  }
  return { start: Array.from(draft.slice(0, start)).length,
    end: Array.from(draft.slice(0, cursor)).length, indexing: 'unicode-code-points' };
}

export function validateWritingFeedbackResult(value, draftText) {
  if (typeof draftText !== 'string' || !matchesClosedSchema(WRITING_FEEDBACK_SCHEMA, value)
      || !value.not_assessed.includes('ielts_band')) invalid();
  if (value.assessment_status === 'feedback_available' && value.abstention_reason !== null) invalid();
  if (value.assessment_status === 'insufficient_evidence'
      && (typeof value.abstention_reason !== 'string' || !value.abstention_reason.trim()
        || value.task_relevance !== 'not_assessed' || value.issues.length !== 0)) invalid();
  const spans = [];
  const issues = value.issues.map(issue => {
    if (value.not_assessed.includes(issue.category)) invalid();
    if (issue.quoted_text === null) {
      if (issue.occurrence !== null || issue.replacement !== null
          || !['coherence', 'task_coverage', 'source_fidelity'].includes(issue.category)) invalid();
      return { ...issue, span: null };
    }
    const span = locateQuote(draftText, issue.quoted_text, issue.occurrence);
    if (spans.some(other => span.start < other.end && other.start < span.end)) invalid();
    spans.push(span);
    return { ...issue, span };
  });
  return { ...value, issues, revision_actions: [...value.revision_actions], not_assessed: [...value.not_assessed] };
}
