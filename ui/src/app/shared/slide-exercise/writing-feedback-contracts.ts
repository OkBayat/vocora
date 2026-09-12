import type { Signal } from '@angular/core';

export interface WritingFeedbackContext {
  readonly schemaVersion: 1;
  readonly learnerLevel: 'A1' | 'A2' | 'B1' | 'B2' | 'C1' | 'C2';
  readonly targetSkill: string;
  readonly languageObjectives: readonly string[];
  readonly taskExpectations: readonly string[];
  readonly sourceText?: string;
}

export interface WritingFeedbackIssue {
  readonly category: 'grammar' | 'spelling' | 'punctuation' | 'word_choice' | 'coherence' | 'task_coverage' | 'source_fidelity';
  readonly kind: 'error' | 'suggestion';
  readonly quoted_text: string | null;
  readonly occurrence: number | null;
  readonly replacement: string | null;
  readonly explanation: string;
  readonly span: { readonly start: number; readonly end: number; readonly indexing: 'unicode-code-points' } | null;
}

export interface WritingFeedbackResult {
  readonly schema_version: 1;
  readonly assessment_status: 'feedback_available' | 'insufficient_evidence';
  readonly abstention_reason: string | null;
  readonly task_relevance: 'on_topic' | 'partly_on_topic' | 'off_topic' | 'not_assessed';
  readonly task_comment: string;
  readonly issues: readonly WritingFeedbackIssue[];
  readonly revision_actions: readonly string[];
  readonly not_assessed: readonly ('ielts_band' | 'task_coverage' | 'source_fidelity')[];
  readonly ielts_band: null;
}

export interface WritingSubmission {
  readonly id: string;
  readonly status: 'queued' | 'running' | 'completed' | 'unavailable' | 'cancelled';
  readonly draftText: string;
  readonly notes: string;
  readonly parentSubmissionId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string;
  readonly feedback: WritingFeedbackResult | null;
  readonly errorCode: string | null;
  readonly attemptCount: number;
  readonly contentVersion: string;
}

export interface WritingFeedbackAvailability {
  readonly enabled: boolean;
  readonly maxCharacters: number;
  readonly maxWords: number;
}

export interface WritingFeedbackHistory {
  readonly pathContentVersion: number;
  readonly currentContentVersion: string;
  readonly availability: WritingFeedbackAvailability;
  readonly submissions: readonly WritingSubmission[];
}

export interface WritingDraftRequest {
  readonly draftText: string;
  readonly notes: string;
  readonly idempotencyKey: string;
  readonly parentSubmissionId?: string;
}

export interface WritingFeedbackSaveRequest extends WritingDraftRequest {
  readonly expectedPathContentVersion: number;
}

export interface WritingFeedbackController {
  readonly loading: Signal<boolean>;
  readonly loaded: Signal<boolean>;
  readonly busy: Signal<boolean>;
  readonly error: Signal<string>;
  readonly pollingPaused: Signal<boolean>;
  readonly contentChanged: Signal<boolean>;
  readonly currentContentVersion: Signal<string>;
  readonly availability: Signal<WritingFeedbackAvailability>;
  readonly submissions: Signal<readonly WritingSubmission[]>;
  readonly active: Signal<WritingSubmission | null>;
  load(): Promise<void>;
  save(draftText: string, notes: string, parentSubmissionId?: string): Promise<WritingSubmission | null>;
  check(): Promise<void>;
  retry(): Promise<void>;
  cancel(): Promise<void>;
  select(id: string): void;
  dispose(): void;
}

export type WritingFeedbackControllerFactory = (slideId: string) => WritingFeedbackController;
