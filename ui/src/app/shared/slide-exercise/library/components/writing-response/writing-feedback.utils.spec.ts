import { describe, expect, it } from 'vitest';
import type { WritingFeedbackIssue } from '../../../writing-feedback-contracts';
import { selectedWritingPreview } from './writing-feedback.utils';

const issue: WritingFeedbackIssue = {
  category: 'grammar', kind: 'error', quoted_text: 'go', occurrence: 1, replacement: 'went',
  explanation: 'Use the past form.', span: { start: 4, end: 6, indexing: 'unicode-code-points' },
};

describe('selectedWritingPreview', () => {
  it('applies only selected edits using Unicode codepoint positions without changing the original', () => {
    const original = '😀 I go.';
    expect(selectedWritingPreview(original, [issue], [])).toBe(original);
    expect(selectedWritingPreview(original, [issue], [0])).toBe('😀 I went.');
    expect(original).toBe('😀 I go.');
  });

  it('rejects invalid or overlapping selections instead of applying unanchored edits', () => {
    expect(selectedWritingPreview('😀 I go.', [{ ...issue, quoted_text: 'absent' }], [0])).toBe('😀 I go.');
    expect(selectedWritingPreview('😀 I go.', [issue, issue], [0, 1])).toBe('😀 I go.');
  });
});
