import type { WritingFeedbackContext, WritingFeedbackIssue, WritingSubmission } from '../../../writing-feedback-contracts';
import { record, requiredText, strings } from '../../slide-library.utils';

export function parseWritingFeedback(value: unknown): WritingFeedbackContext | undefined {
  if (value === undefined) return undefined;
  const source = record(value);
  const level = requiredText(source['learnerLevel'], 'Writing learner level');
  if (source['schemaVersion'] !== 1 || !['A1', 'A2', 'B1', 'B2', 'C1', 'C2'].includes(level)) {
    throw new Error('Unsupported writing feedback context.');
  }
  return {
    schemaVersion: 1, learnerLevel: level as WritingFeedbackContext['learnerLevel'],
    targetSkill: requiredText(source['targetSkill'], 'Writing target skill'),
    languageObjectives: strings(source['languageObjectives']), taskExpectations: strings(source['taskExpectations']),
    ...(typeof source['sourceText'] === 'string' ? { sourceText: source['sourceText'] } : {}),
  };
}

export function selectedWritingPreview(original: string, issues: readonly WritingFeedbackIssue[], selected: readonly number[]): string {
  const characters = Array.from(original);
  const edits = [...new Set(selected)].map((index) => issues[index]);
  if (edits.some((issue) => !issue?.span || issue.replacement === null || issue.span.indexing !== 'unicode-code-points'
    || !Number.isInteger(issue.span.start) || !Number.isInteger(issue.span.end)
    || issue.span.start < 0 || issue.span.end > characters.length || issue.span.end <= issue.span.start
    || characters.slice(issue.span.start, issue.span.end).join('') !== issue.quoted_text)) return original;
  edits.sort((a, b) => a.span!.start - b.span!.start);
  if (edits.some((issue, index) => index > 0 && issue.span!.start < edits[index - 1].span!.end)) return original;
  for (const issue of edits.reverse()) {
    characters.splice(issue.span!.start, issue.span!.end - issue.span!.start, ...Array.from(issue.replacement!));
  }
  return characters.join('');
}

export function writingStatusMessage(submission: WritingSubmission): string {
  if (submission.status === 'queued') return 'Draft saved. Feedback is queued.';
  if (submission.status === 'running') return 'Draft saved. Feedback is processing.';
  if (submission.status === 'cancelled') return 'Feedback cancelled. Your draft is still saved.';
  if (submission.status === 'completed') {
    return submission.feedback?.assessment_status === 'feedback_available'
      ? 'Formative feedback is available.' : 'There is not enough evidence for feedback.';
  }
  if (submission.errorCode === 'WRITING_FEEDBACK_DISABLED') return 'Draft saved. Feedback is not enabled.';
  if (submission.errorCode === 'WRITING_FEEDBACK_INPUT_LIMIT') return 'Draft saved. This response is beyond the feedback word limit. You can save a shorter revision.';
  if (submission.errorCode === 'WRITING_FEEDBACK_PROFILE_CHANGED') return 'Draft saved. The feedback settings changed. Save a new revision to request feedback.';
  return 'Draft saved. Feedback is unavailable. Your response has not been marked wrong.';
}
