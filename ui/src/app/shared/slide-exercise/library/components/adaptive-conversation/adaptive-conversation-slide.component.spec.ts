import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import type { AdaptiveConversationController, ConversationSession } from '../../../adaptive-conversation-contracts';
import { AdaptiveConversationSlideComponent } from './adaptive-conversation-slide.component';

const data = { mode: 'guided-dialogue', goal: 'Talk about meals.', openingPrompt: 'What do you eat?', minimumTurns: 2, maximumTurns: 3, responseSeconds: 5, learnerLevel: 'beginner', targetVocabulary: ['bread'], questionConstraints: { maximumWords: 14, oneQuestionOnly: true, avoidAnswerDisclosure: true } };
function saved(overrides: Partial<ConversationSession> = {}): ConversationSession {
  return { id: 'session', status: 'active', revision: 1, contentVersion: 'v1', pathContentVersion: 3, currentTurnId: 'turn',
    minimumTurns: 2, maximumTurns: 3, responseSeconds: 5, acceptedTurnCount: 0, canFinish: false, turns: [{ id: 'turn', index: 1,
      question: 'What do you eat?', status: 'ready', recordingId: null, transcript: null, feedback: null, attemptCount: 0, errorCode: null }],
    expiresAt: '2026-10-01', completionEvidenceId: null, ...overrides };
}
function controller() {
  const session = signal<ConversationSession | null>(null);
  return { session, currentTurn: computed(() => session()?.turns[0] ?? null), loaded: signal(true), loading: signal(false), enabled: signal(false), busy: signal(false),
    phase: signal<'idle' | 'requesting' | 'recording' | 'uploading'>('idle'), seconds: signal(0), error: signal(''), audioError: signal(''), audioPlaying: signal(false),
    pollingPaused: signal(false), contentChanged: signal(false), liveTranscript: signal(null), supported: true, canRecord: signal(false), recordingLimitReached: signal(false), canRetry: signal(false), canFinish: signal(false), canRetryUpload: signal(false),
    load: vi.fn().mockResolvedValue(undefined), start: vi.fn(), record: vi.fn(), stop: vi.fn(), retryUpload: vi.fn(), cancelRecording: vi.fn(), check: vi.fn(), retry: vi.fn(), finish: vi.fn(), cancel: vi.fn(), listen: vi.fn(), stopAudio: vi.fn(), dispose: vi.fn(),
  } satisfies AdaptiveConversationController;
}
function setup() {
  const control = controller(); const fixture = TestBed.createComponent(AdaptiveConversationSlideComponent);
  const events = vi.fn(); fixture.componentInstance.event.subscribe(events);
  fixture.componentInstance.load({ slideId: 'conversation', type: 'adaptive-conversation', data, environment: { adaptiveConversation: () => control } });
  fixture.detectChanges(); return { fixture, component: fixture.componentInstance, control, events };
}
describe('AdaptiveConversationSlideComponent', () => {
  it('keeps disabled practice incomplete and preserves the opening question', () => {
    const { fixture, events } = setup();
    expect(fixture.nativeElement.textContent).toContain('What do you eat?');
    expect(fixture.nativeElement.textContent).toContain('New conversation practice is not enabled.');
    expect(events).not.toHaveBeenCalled();
  });
  it('emits completion once only after a completed server receipt', () => {
    const { fixture, control, events } = setup();
    control.session.set(saved({ status: 'completed' })); fixture.detectChanges(); expect(events).not.toHaveBeenCalled();
    control.session.set(saved({ status: 'completed', completionEvidenceId: 'receipt' })); fixture.detectChanges();
    control.session.set(saved({ status: 'completed', revision: 2, completionEvidenceId: 'receipt' })); fixture.detectChanges();
    expect(events).toHaveBeenCalledExactlyOnceWith({ type: 'submitted', data: { conversationEvidenceId: 'receipt' } });
  });
  it('shows escaped feedback, transcript uncertainty, task rubric and unassessed dimensions', () => {
    const { fixture, control } = setup();
    const turn = saved().turns[0];
    control.session.set(saved({ turns: [{ ...turn, status: 'feedback_available', transcript: { schemaVersion: 1, status: 'transcribed', text: '<img src=x>', confidence: null, wordEvidence: [], providerIdentity: { provider: 'vosk', runtimeVersion: null, modelId: null, modelDigest: null } },
      feedback: { schemaVersion: 1, assessmentStatus: 'feedback_available', taskResponse: 'partial', formativeTaskScore: 1, feedback: '<script>bad()</script>', nextQuestion: null, endConversation: false, notAssessed: ['ielts_band', 'pronunciation', 'fluency'] } }] }));
    fixture.detectChanges();
    const text = fixture.nativeElement.textContent;
    expect(fixture.nativeElement.querySelector('script, img')).toBeNull(); expect(text).toContain('<script>bad()</script>');
    expect(text).toContain('Speech recognition can make mistakes.'); expect(text).toContain('Confidence is unavailable.');
    expect(text).toContain('Task response signal: 1 of 2'); expect(text).toContain('1: relevant but incomplete');
    expect(text).toContain('0: did not answer this question');
    expect(text).toContain('IELTS band, pronunciation and fluency are not assessed.');
  });
  it('keeps the accepted question visible when audio fails', () => {
    const { fixture, control } = setup(); control.session.set(saved()); control.audioError.set('Question audio is unavailable.'); fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('What do you eat?'); expect(fixture.nativeElement.textContent).toContain('Question audio is unavailable.');
  });
  it('keeps recording-limit recovery visible after a status check clears the temporary error', () => {
    const { fixture, control } = setup(); control.session.set(saved()); control.recordingLimitReached.set(true); fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Cancel this conversation and start a new session to record again.');
    expect(fixture.nativeElement.textContent).not.toContain('Record answer');
  });
  it('disposes the prior controller and ignores its late completion after reloading', () => {
    const { fixture, component, control, events } = setup(); const next = controller();
    component.load({ slideId: 'second', type: 'adaptive-conversation', data, environment: { adaptiveConversation: () => next } });
    control.session.set(saved({ status: 'completed', completionEvidenceId: 'stale' })); fixture.detectChanges();
    expect(control.dispose).toHaveBeenCalledOnce(); expect(events).not.toHaveBeenCalled();
    fixture.destroy(); expect(next.dispose).toHaveBeenCalledOnce();
  });
});
