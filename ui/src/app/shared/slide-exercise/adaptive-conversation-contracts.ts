import type { Signal } from '@angular/core';

export interface ConversationTranscript {
  readonly schemaVersion: 1;
  readonly status: 'partial' | 'transcribed' | 'insufficient_evidence';
  readonly text: string;
  readonly confidence: number | null;
  readonly wordEvidence: readonly { word: string; startSeconds: number; endSeconds: number; confidence: number | null }[];
  readonly providerIdentity: { provider: 'vosk'; runtimeVersion: string | null; modelId: string | null; modelDigest: string | null };
}

export interface ConversationFeedback {
  readonly schemaVersion: 1;
  readonly assessmentStatus: 'feedback_available' | 'insufficient_evidence';
  readonly taskResponse: 'complete' | 'partial' | 'off_topic' | 'not_assessed';
  readonly formativeTaskScore: 0 | 1 | 2 | null;
  readonly feedback: string;
  readonly nextQuestion: string | null;
  readonly endConversation: boolean;
  readonly notAssessed: readonly ('ielts_band' | 'pronunciation' | 'fluency')[];
}

export interface ConversationTurn {
  readonly id: string;
  readonly index: number;
  readonly question: string;
  readonly status: 'ready' | 'recording' | 'queued' | 'evaluating' | 'feedback_available' | 'retryable_failure';
  readonly recordingId: string | null;
  readonly transcript: ConversationTranscript | null;
  readonly feedback: ConversationFeedback | null;
  readonly attemptCount: number;
  readonly errorCode: string | null;
}

export interface ConversationSession {
  readonly id: string;
  readonly status: 'active' | 'completed' | 'cancelled' | 'expired';
  readonly revision: number;
  readonly contentVersion: string;
  readonly pathContentVersion: number;
  readonly currentTurnId: string;
  readonly minimumTurns: number;
  readonly maximumTurns: number;
  readonly responseSeconds: number;
  readonly acceptedTurnCount: number;
  readonly canFinish: boolean;
  readonly turns: readonly ConversationTurn[];
  readonly expiresAt: string;
  readonly completionEvidenceId: string | null;
}

export interface ConversationEnvelope { readonly session: ConversationSession; readonly availability: { readonly enabled: boolean }; }
export interface ConversationHistory {
  readonly sessions: readonly ConversationSession[];
  readonly pathContentVersion: number;
  readonly currentContentVersion: string;
  readonly availability: { readonly enabled: boolean };
}
export interface ConversationRecording {
  readonly session: ConversationSession;
  readonly recording: { readonly id: string; readonly turnId: string; readonly nextSequence: number; readonly responseSeconds: number };
}
export interface ConversationChunk { readonly recordingId: string; readonly nextSequence: number; readonly transcript: ConversationTranscript; }

export interface AdaptiveConversationController {
  readonly session: Signal<ConversationSession | null>;
  readonly currentTurn: Signal<ConversationTurn | null>;
  readonly loaded: Signal<boolean>;
  readonly loading: Signal<boolean>;
  readonly enabled: Signal<boolean>;
  readonly busy: Signal<boolean>;
  readonly phase: Signal<'idle' | 'requesting' | 'recording' | 'uploading'>;
  readonly seconds: Signal<number>;
  readonly error: Signal<string>;
  readonly audioError: Signal<string>;
  readonly audioPlaying: Signal<boolean>;
  readonly pollingPaused: Signal<boolean>;
  readonly contentChanged: Signal<boolean>;
  readonly liveTranscript: Signal<ConversationTranscript | null>;
  readonly supported: boolean;
  readonly canRecord: Signal<boolean>;
  readonly recordingLimitReached: Signal<boolean>;
  readonly canRetry: Signal<boolean>;
  readonly canFinish: Signal<boolean>;
  readonly canRetryUpload: Signal<boolean>;
  load(): Promise<void>;
  start(): Promise<void>;
  record(): Promise<void>;
  stop(): Promise<void>;
  retryUpload(): Promise<void>;
  cancelRecording(): Promise<void>;
  check(): Promise<void>;
  retry(): Promise<void>;
  finish(): Promise<void>;
  cancel(): Promise<void>;
  listen(): void;
  stopAudio(): void;
  dispose(): void;
}
export type AdaptiveConversationControllerFactory = (slideId: string) => AdaptiveConversationController;
