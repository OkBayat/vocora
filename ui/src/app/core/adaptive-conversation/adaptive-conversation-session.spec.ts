import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConversationSession, ConversationTranscript } from '../../shared/slide-exercise/adaptive-conversation-contracts';
import type { MicrophoneHandlers } from '../shadowing-practice/pcm-recorder.service';
import { AdaptiveConversationSession } from './adaptive-conversation-session';
import { ApiError } from '../http/api-client.service';

export function conversation(overrides: Partial<ConversationSession> = {}): ConversationSession {
  return { id: 'session', status: 'active', revision: 1, contentVersion: 'v1', pathContentVersion: 3,
    currentTurnId: 'turn-1', minimumTurns: 2, maximumTurns: 3, responseSeconds: 5, acceptedTurnCount: 0, canFinish: false,
    turns: [{ id: 'turn-1', index: 1, question: 'What do you eat?', status: 'ready', recordingId: null, transcript: null, feedback: null, attemptCount: 0, errorCode: null }],
    expiresAt: '2026-10-01T00:00:00Z', completionEvidenceId: null, ...overrides };
}
const transcript: ConversationTranscript = { schemaVersion: 1, status: 'partial', text: 'I eat bread', confidence: null,
  wordEvidence: [], providerIdentity: { provider: 'vosk', runtimeVersion: null, modelId: null, modelDigest: null } };
function setup() {
  const ready = conversation();
  const recording = conversation({ revision: 2, turns: [{ ...ready.turns[0], status: 'recording', recordingId: 'recording' }] });
  const queued = conversation({ revision: 3, turns: [{ ...ready.turns[0], status: 'queued', transcript: { ...transcript, status: 'transcribed' } }] });
  const gateway = { history: vi.fn().mockResolvedValue({ sessions: [], pathContentVersion: 3, currentContentVersion: 'v1', availability: { enabled: true } }),
    start: vi.fn().mockResolvedValue({ session: ready, availability: { enabled: true } }), read: vi.fn().mockResolvedValue({ session: queued, availability: { enabled: true } }),
    record: vi.fn().mockResolvedValue({ session: recording, recording: { id: 'recording', turnId: 'turn-1', nextSequence: 0, responseSeconds: 5 } }),
    chunk: vi.fn().mockResolvedValue({ recordingId: 'recording', nextSequence: 1, transcript }),
    finishRecording: vi.fn().mockResolvedValue({ session: queued, availability: { enabled: true } }), cancelRecording: vi.fn().mockResolvedValue(undefined),
    retry: vi.fn(), audio: vi.fn().mockResolvedValue(new Blob(['audio'], { type: 'audio/mpeg' })), finish: vi.fn(),
    cancel: vi.fn().mockResolvedValue({ session: conversation({ status: 'cancelled' }), availability: { enabled: true } }) };
  let handlers!: MicrophoneHandlers;
  const microphone = { supported: () => true, open: vi.fn().mockResolvedValue(undefined), begin: vi.fn(value => { handlers = value; }), stop: vi.fn().mockResolvedValue(undefined), cancel: vi.fn() };
  const speaker = { playServerAudio: vi.fn().mockReturnValue(true), cancel: vi.fn() };
  const ensureStarted = vi.fn().mockResolvedValue(true);
  const key = vi.fn().mockReturnValue('key');
  const session = new AdaptiveConversationSession(gateway, microphone, speaker, ensureStarted, key, 3);
  return { session, gateway, microphone, speaker, ensureStarted, key, handlers: () => handlers, ready, queued };
}
async function flush(): Promise<void> { for (let index = 0; index < 12; index++) await Promise.resolve(); }
describe('AdaptiveConversationSession', () => {
  afterEach(() => vi.useRealTimers());

  it('keeps unavailable practice incomplete and rejects changed lesson history', async () => {
    const { session, gateway } = setup();
    gateway.history.mockResolvedValueOnce({ sessions: [], pathContentVersion: 3, currentContentVersion: 'v1', availability: { enabled: false } });
    await session.load(); await session.start();
    expect(session.loaded()).toBe(true); expect(session.session()).toBeNull(); expect(gateway.start).not.toHaveBeenCalled();
    gateway.history.mockResolvedValueOnce({ sessions: [conversation({ status: 'completed', completionEvidenceId: 'old' })], pathContentVersion: 4, currentContentVersion: 'v2', availability: { enabled: true } });
    await session.load(); expect(session.contentChanged()).toBe(true); expect(session.session()).toBeNull(); session.dispose();
  });

  it('reuses a start key after an ambiguous error and waits for exercise start', async () => {
    const { session, gateway, ensureStarted, key } = setup();
    await session.load(); gateway.start.mockRejectedValueOnce(new Error('Network'));
    await session.start(); await session.start();
    expect(ensureStarted).toHaveBeenCalledTimes(2);
    expect(key).toHaveBeenCalledOnce();
    expect(gateway.start.mock.calls).toEqual([['key'], ['key']]); expect(session.session()?.id).toBe('session'); session.dispose();
  });

  it('streams ordered bounded PCM and preserves server transcript before queueing', async () => {
    const { session, gateway, handlers } = setup(); await session.load(); await session.start(); await session.record();
    expect(session.phase()).toBe('recording');
    for (let index = 0; index < 10; index++) { handlers().pcm(new ArrayBuffer(16000)); await flush(); }
    await flush();
    expect(gateway.chunk).toHaveBeenCalledTimes(10);
    expect(gateway.chunk.mock.calls.map(call => call[2])).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(session.seconds()).toBe(5); expect(session.currentTurn()?.transcript?.text).toBe('I eat bread');
    expect(session.currentTurn()?.status).toBe('queued'); expect(gateway.finishRecording).toHaveBeenCalledOnce(); session.dispose();
  });

  it('retries ambiguous finish using the same recording without capturing another answer', async () => {
    const { session, gateway, handlers, microphone } = setup(); await session.load(); await session.start(); await session.record();
    handlers().pcm(new ArrayBuffer(16000)); await flush(); gateway.finishRecording.mockRejectedValueOnce(new Error('Network'));
    await session.stop(); expect(session.canRetryUpload()).toBe(true); await session.retryUpload();
    expect(gateway.finishRecording.mock.calls).toEqual([['session', 'recording'], ['session', 'recording']]);
    expect(microphone.open).toHaveBeenCalledOnce(); session.dispose();
  });

  it('cancels microphone permission and cleans up late allocated recordings on disposal', async () => {
    const { session, gateway, microphone } = setup(); await session.load(); await session.start();
    let resolve!: (value: unknown) => void;
    gateway.record.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const recording = session.record(); await flush(); session.dispose();
    resolve({ session: conversation(), recording: { id: 'late', turnId: 'turn-1', nextSequence: 0, responseSeconds: 5 } });
    await recording; await flush();
    expect(gateway.cancelRecording).toHaveBeenCalledWith('session', 'late'); expect(microphone.cancel).toHaveBeenCalled();
    expect(microphone.begin).not.toHaveBeenCalled();
  });

  it('does not restore an active session from a stale poll after cancellation', async () => {
    const { session, gateway, queued } = setup(); await session.load(); await session.start();
    let resolve!: (value: unknown) => void;
    gateway.read.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const check = session.check(); await session.cancel(); resolve({ session: queued, availability: { enabled: true } }); await check;
    expect(session.session()?.status).toBe('cancelled'); expect(session.session()?.completionEvidenceId).toBeNull(); session.dispose();
  });

  it('uses server finish eligibility and requires a completed receipt', async () => {
    const { session, gateway } = setup();
    gateway.history.mockResolvedValueOnce({ sessions: [conversation({ acceptedTurnCount: 2 })], pathContentVersion: 3, currentContentVersion: 'v1', availability: { enabled: true } });
    await session.load(); await session.finish(); expect(gateway.finish).not.toHaveBeenCalled();
    gateway.read.mockResolvedValueOnce({ session: conversation({ acceptedTurnCount: 2, canFinish: true }), availability: { enabled: true } });
    await session.check(); gateway.finish.mockResolvedValueOnce({ session: conversation({ status: 'completed', completionEvidenceId: 'receipt' }), availability: { enabled: true } });
    await session.finish(); expect(session.session()?.completionEvidenceId).toBe('receipt'); session.dispose();
  });

  it('pauses polling after repeated transport failures without losing the transcript', async () => {
    vi.useFakeTimers(); const { session, gateway, queued } = setup();
    gateway.history.mockResolvedValueOnce({ sessions: [queued], pathContentVersion: 3, currentContentVersion: 'v1', availability: { enabled: true } });
    gateway.read.mockRejectedValue(new Error('Network')); await session.load();
    await vi.advanceTimersByTimeAsync(6000);
    expect(gateway.read).toHaveBeenCalledTimes(3); expect(session.pollingPaused()).toBe(true);
    expect(session.currentTurn()?.transcript?.text).toBe('I eat bread'); session.dispose();
  });

  it('explains denied microphone permission without creating a server recording', async () => {
    const { session, microphone, gateway } = setup(); await session.load(); await session.start();
    microphone.open.mockRejectedValueOnce(new Error('Microphone permission was denied. Allow microphone access in your browser settings, then try again.'));
    await session.record(); expect(session.error()).toContain('Microphone permission was denied.');
    expect(gateway.record).not.toHaveBeenCalled(); expect(session.phase()).toBe('idle'); session.dispose();
  });

  it('keeps status checks single-flight and settles a disposed pending request', async () => {
    const { session, gateway } = setup(); await session.load(); await session.start();
    gateway.read.mockImplementationOnce(() => new Promise(() => {}));
    const first = session.check(); const second = session.check();
    expect(gateway.read).toHaveBeenCalledOnce(); session.dispose(); await Promise.all([first, second]);
  });

  it('pauses a long-running job after sixty reads without issuing an inference retry', async () => {
    vi.useFakeTimers(); const { session, gateway, queued } = setup();
    gateway.history.mockResolvedValueOnce({ sessions: [queued], pathContentVersion: 3, currentContentVersion: 'v1', availability: { enabled: true } });
    await session.load(); await vi.advanceTimersByTimeAsync(120000);
    expect(gateway.read).toHaveBeenCalledTimes(60); expect(session.pollingPaused()).toBe(true); expect(gateway.retry).not.toHaveBeenCalled(); session.dispose();
  });

  it('restores a saved selected recording for feedback retry without deleting its transcript on navigation', async () => {
    const { session, gateway, ready } = setup();
    const saved = conversation({ turns: [{ ...ready.turns[0], status: 'retryable_failure', recordingId: 'saved-recording',
      transcript: { ...transcript, status: 'transcribed' }, errorCode: 'CONVERSATION_MODEL_BUSY', attemptCount: 1 }] });
    gateway.history.mockResolvedValueOnce({ sessions: [saved], pathContentVersion: 3, currentContentVersion: 'v1', availability: { enabled: true } });
    await session.load(); expect(session.canRetry()).toBe(true); expect(session.canRecord()).toBe(false);
    session.dispose(); expect(gateway.cancelRecording).not.toHaveBeenCalled();
  });

  it('can request a real completion receipt for accepted practice after the feature is disabled', async () => {
    const { session, gateway } = setup();
    gateway.history.mockResolvedValueOnce({ sessions: [conversation({ acceptedTurnCount: 2, canFinish: true })], pathContentVersion: 3, currentContentVersion: 'v1', availability: { enabled: false } });
    await session.load(); expect(session.canRecord()).toBe(false); expect(session.canFinish()).toBe(true);
    gateway.finish.mockResolvedValueOnce({ session: conversation({ status: 'completed', completionEvidenceId: 'receipt' }), availability: { enabled: false } });
    await session.finish(); expect(gateway.finish).toHaveBeenCalledWith('session', 1); expect(session.session()?.completionEvidenceId).toBe('receipt'); session.dispose();
  });

  it.each(['cancelled', 'expired'] as const)('uses a fresh start key after status recovery confirms the session is %s', async status => {
    const { session, gateway, key } = setup(); key.mockReturnValueOnce('first-key').mockReturnValueOnce('next-key');
    await session.load(); await session.start(); gateway.cancel.mockRejectedValueOnce(new Error('Acknowledgement lost.'));
    await session.cancel(); expect(session.session()?.status).toBe('active'); expect(key).toHaveBeenCalledOnce();
    gateway.read.mockResolvedValueOnce({ session: conversation({ status }), availability: { enabled: true } });
    await session.check(); await session.start();
    expect(gateway.start.mock.calls).toEqual([['first-key'], ['next-key']]); session.dispose();
  });

  it('disables recording after the server limit and explains how to start a new session', async () => {
    const { session, gateway, microphone, ready } = setup(); await session.load(); await session.start();
    gateway.record.mockRejectedValueOnce(new ApiError('Limit reached.', 409, 'CONVERSATION_RECORDING_LIMIT'));
    await session.record();
    expect(session.error()).toContain('Cancel this conversation and start a new session');
    expect(session.canRecord()).toBe(false); await session.record(); expect(microphone.open).toHaveBeenCalledOnce();
    gateway.read.mockResolvedValueOnce({ session: ready, availability: { enabled: true } }); await session.check();
    expect(session.canRecord()).toBe(false); session.dispose();
  });
});
