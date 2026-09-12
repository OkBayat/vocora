import { computed, signal } from '@angular/core';
import type { AdaptiveConversationController, ConversationChunk, ConversationEnvelope, ConversationHistory, ConversationRecording, ConversationSession, ConversationTranscript } from '../../shared/slide-exercise/adaptive-conversation-contracts';
import type { PcmRecorderService } from '../shadowing-practice/pcm-recorder.service';
import type { SpeechService } from '../speech/speech.service';
import { ApiError } from '../http/api-client.service';

export interface ConversationGateway {
  history(): Promise<ConversationHistory>;
  start(key: string): Promise<ConversationEnvelope>;
  read(id: string): Promise<ConversationEnvelope>;
  record(id: string, revision: number, key: string): Promise<ConversationRecording>;
  chunk(id: string, recordingId: string, sequence: number, pcm: ArrayBuffer): Promise<ConversationChunk>;
  finishRecording(id: string, recordingId: string): Promise<ConversationEnvelope>;
  cancelRecording(id: string, recordingId: string): Promise<void>;
  retry(id: string, turnId: string): Promise<ConversationEnvelope>;
  audio(id: string, turnId: string): Promise<Blob>;
  finish(id: string, revision: number): Promise<ConversationEnvelope>;
  cancel(id: string): Promise<ConversationEnvelope>;
}
type Microphone = Pick<PcmRecorderService, 'supported' | 'open' | 'begin' | 'stop' | 'cancel'>;
type Speaker = Pick<SpeechService, 'playServerAudio' | 'cancel'>;

export class AdaptiveConversationSession implements AdaptiveConversationController {
  readonly session = signal<ConversationSession | null>(null);
  readonly currentTurn = computed(() => this.session()?.turns.find(turn => turn.id === this.session()?.currentTurnId) ?? null);
  readonly loaded = signal(false);
  readonly loading = signal(false);
  readonly enabled = signal(false);
  readonly busy = signal(false);
  readonly phase = signal<'idle' | 'requesting' | 'recording' | 'uploading'>('idle');
  readonly seconds = signal(0);
  readonly error = signal('');
  readonly audioError = signal('');
  readonly audioPlaying = signal(false);
  readonly pollingPaused = signal(false);
  readonly contentChanged = signal(false);
  readonly liveTranscript = signal<ConversationTranscript | null>(null);
  readonly supported: boolean;
  private readonly recordingId = signal<string | null>(null);
  private readonly uploadFinished = signal(false);
  private readonly exhaustedRecordingTurn = signal<{ sessionId: string; turnId: string } | null>(null);
  readonly recordingLimitReached = computed(() => this.currentTurn()?.errorCode === 'CONVERSATION_RECORDING_LIMIT'
    || (this.exhaustedRecordingTurn()?.sessionId === this.session()?.id
      && this.exhaustedRecordingTurn()?.turnId === this.currentTurn()?.id && this.exhaustedRecordingTurn() !== null));
  private readonly actionable = computed(() => this.loaded() && this.enabled() && !this.busy() && !this.loading()
    && !this.contentChanged() && this.session()?.status === 'active');
  readonly canRecord = computed(() => {
    const turn = this.currentTurn();
    return this.actionable() && this.supported && !this.recordingId() && !this.recordingLimitReached() && (turn?.status === 'ready'
      || (turn?.status === 'retryable_failure' && (!turn.transcript || turn.transcript.status === 'insufficient_evidence'
        || turn.errorCode === 'CONVERSATION_INSUFFICIENT_SPEECH' || turn.feedback?.assessmentStatus === 'insufficient_evidence')));
  });
  readonly canRetry = computed(() => this.actionable() && !this.recordingId() && this.currentTurn()?.status === 'retryable_failure'
    && this.currentTurn()?.transcript?.status === 'transcribed' && this.currentTurn()?.feedback?.assessmentStatus !== 'insufficient_evidence'
    && !['CONVERSATION_ASR_CHANGED', 'CONVERSATION_INSUFFICIENT_SPEECH'].includes(this.currentTurn()?.errorCode ?? '')
    && (this.currentTurn()?.attemptCount ?? 3) < 3);
  readonly canFinish = computed(() => this.loaded() && !this.busy() && !this.loading() && !this.contentChanged()
    && !this.recordingId() && this.session()?.status === 'active' && this.session()?.canFinish === true);
  readonly canRetryUpload = computed(() => this.actionable() && Boolean(this.recordingId()) && this.uploadFinished());
  private disposed = false;
  private version = 0;
  private startKey?: string;
  private taskVersion = '';
  private recordingTimer?: ReturnType<typeof setTimeout>;
  private pollTimer?: ReturnType<typeof setTimeout>;
  private pollCount = 0;
  private pollErrors = 0;
  private pollInFlight = false;
  private cancelling = false;
  private pending: Promise<void> = Promise.resolve();
  private queued = 0;
  private readonly waiters = new Map<ReturnType<typeof setTimeout>, () => void>();
  constructor(private readonly gateway: ConversationGateway, private readonly microphone: Microphone,
    private readonly speaker: Speaker, private readonly ensureStarted: () => Promise<boolean>,
    private readonly key: () => string, private readonly pathVersion: number) { this.supported = microphone.supported(); }
  async load(): Promise<void> {
    if (this.disposed || this.loading() || this.busy()) return;
    const version = this.restart(); this.loading.set(true); this.error.set('');
    try {
      const history = await this.bounded(this.gateway.history());
      if (!this.current(version)) return;
      if (history.pathContentVersion !== this.pathVersion) throw new ApiError('Lesson changed.', 409, 'CONVERSATION_CONTENT_CHANGED');
      this.taskVersion = history.currentContentVersion;
      this.enabled.set(history.availability.enabled);
      const knownSession = history.sessions.find(item => item.id === this.session()?.id);
      if (knownSession) this.resetConfirmedTerminal(knownSession);
      const saved = history.sessions.find(item => item.contentVersion === this.taskVersion && ['active', 'completed'].includes(item.status));
      this.session.set(saved ?? null);
      this.recordingId.set(this.currentTurn()?.status === 'recording' ? this.currentTurn()?.recordingId ?? null : null);
      this.loaded.set(true); this.schedule(version);
    } catch (error) { if (this.current(version)) this.fail(error, 'Conversation history could not be restored. Try loading again.'); }
    finally { if (this.current(version)) this.loading.set(false); }
  }

  async start(): Promise<void> {
    if (this.disposed || !this.loaded() || !this.enabled() || this.contentChanged() || this.busy() || this.loading()
      || this.session()?.status === 'active' || this.session()?.status === 'completed') return;
    const version = this.restart(); this.busy.set(true); this.error.set('');
    const key = this.startKey ??= this.key();
    try {
      if (!await this.bounded(this.ensureStarted())) throw new Error('Exercise not started.');
      if (!this.current(version)) return;
      const result = await this.bounded(this.gateway.start(key));
      if (this.current(version)) { this.accept(result); this.schedule(version); }
    } catch (error) { if (this.current(version)) this.fail(error, 'Conversation could not start. Try again; no practice has been completed.'); }
    finally { if (this.current(version)) this.busy.set(false); }
  }

  async record(): Promise<void> {
    if (!this.canRecord() || this.disposed) return;
    this.stopAudio(); const version = this.restart(); const session = this.session()!;
    this.busy.set(true); this.phase.set('requesting'); this.error.set(''); this.seconds.set(0);
    this.liveTranscript.set(null); this.uploadFinished.set(false); this.pending = Promise.resolve(); this.queued = 0;
    let microphoneOpened = false;
    try {
      await this.bounded(this.microphone.open());
      if (!this.current(version)) return;
      microphoneOpened = true;
      const allocation = this.gateway.record(session.id, session.revision, this.key()).then(result => {
        if (!this.current(version)) void this.gateway.cancelRecording(session.id, result.recording.id).catch(() => {});
        return result;
      });
      const result = await this.bounded(allocation);
      if (!this.current(version)) return;
      this.session.set(result.session); this.recordingId.set(result.recording.id); this.phase.set('recording');
      let sequence = result.recording.nextSequence; let bytes = 0;
      const maximumBytes = Math.min(30, result.recording.responseSeconds) * 32000;
      this.microphone.begin({
        pcm: audio => {
          if (!this.current(version) || bytes >= maximumBytes) return;
          const pcm = audio.slice(0, Math.min(audio.byteLength, maximumBytes - bytes));
          if (!pcm.byteLength) return;
          bytes += pcm.byteLength; this.seconds.set(bytes / 32000);
          if (++this.queued > 8) { this.failRecording(new Error('The connection is too slow. Cancel this recording and try again.'), version); return; }
          const index = sequence++;
          this.pending = this.pending.then(async () => {
            if (!this.current(version)) return;
            const chunk = await this.bounded(this.gateway.chunk(session.id, result.recording.id, index, pcm));
            if (this.current(version)) { this.queued--; this.liveTranscript.set(chunk.transcript); }
          }).catch(error => this.failRecording(error, version));
          if (bytes >= maximumBytes) void this.stop();
        },
        level: () => {},
        limit: () => { if (this.current(version)) void this.stop(); },
        error: message => this.failRecording(new Error(message), version),
      });
      this.recordingTimer = setTimeout(() => { if (this.current(version)) void this.stop(); }, result.recording.responseSeconds * 1000);
    } catch (error) {
      const permissionError = !microphoneOpened && this.current(version) && error instanceof Error ? error.message : null;
      this.failRecording(error, version);
      if (permissionError) this.error.set(permissionError);
    }
  }

  async stop(): Promise<void> {
    if (this.phase() !== 'recording' || this.disposed) return;
    const version = this.version; this.phase.set('uploading'); clearTimeout(this.recordingTimer);
    try {
      await this.bounded(this.microphone.stop()); await this.pending;
      if (!this.current(version)) return;
      this.uploadFinished.set(true); await this.finishUpload(version);
    } catch (error) { this.failRecording(error, version); }
  }

  async retryUpload(): Promise<void> {
    if (!this.canRetryUpload() || this.disposed) return;
    const version = this.restart(); this.busy.set(true); this.phase.set('uploading');
    await this.finishUpload(version);
  }

  async cancelRecording(): Promise<void> {
    if (this.disposed || this.cancelling || !this.session()) return;
    this.cancelling = true;
    const session = this.session()!; const id = this.recordingId() ?? this.currentTurn()?.recordingId;
    const version = this.restart(); this.stopCapture(); this.stopAudio(); this.busy.set(true); this.uploadFinished.set(false);
    try {
      if (id) await this.bounded(this.gateway.cancelRecording(session.id, id));
      if (!this.current(version)) return;
      const result = await this.bounded(this.gateway.read(session.id));
      if (this.current(version)) { this.recordingId.set(null); this.accept(result); this.error.set(''); this.schedule(version); }
    } catch (error) { if (this.current(version)) this.fail(error, 'Recording cancellation could not be confirmed. Check the session again.'); }
    finally { this.cancelling = false; if (this.current(version)) this.busy.set(false); }
  }

  async check(): Promise<void> {
    if (this.disposed || this.busy() || this.loading() || this.pollInFlight || !this.session()) return;
    await this.poll(this.restart());
  }
  async retry(): Promise<void> {
    if (!this.canRetry()) return;
    await this.command(session => this.gateway.retry(session.id, session.currentTurnId));
  }
  async finish(): Promise<void> {
    if (!this.canFinish()) return;
    await this.command(session => this.gateway.finish(session.id, session.revision));
  }
  async cancel(): Promise<void> {
    if (this.disposed || this.cancelling || this.session()?.status !== 'active') return;
    this.cancelling = true;
    this.stopCapture(); this.stopAudio();
    try { await this.command(session => this.gateway.cancel(session.id), true); }
    finally { this.cancelling = false; }
    if (this.session()?.status === 'cancelled') this.recordingId.set(null);
  }

  listen(): void {
    const session = this.session(); const turn = this.currentTurn();
    if (!session || !turn || this.disposed || this.audioPlaying() || this.phase() !== 'idle' || this.contentChanged()) return;
    this.stopAudio(); this.audioError.set(''); this.audioPlaying.set(true);
    const failed = () => { this.audioPlaying.set(false); this.audioError.set('Question audio is unavailable. Read the question above or try playback again.'); };
    if (!this.speaker.playServerAudio(() => this.bounded(this.gateway.audio(session.id, turn.id)), {
      onEnd: () => this.audioPlaying.set(false), onError: failed,
    })) failed();
  }
  stopAudio(): void { this.speaker.cancel(); this.audioPlaying.set(false); }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.restart(); this.stopCapture(); this.stopAudio();
    const id = this.recordingId(); const session = this.session();
    if (id && session && !this.uploadFinished()) void this.gateway.cancelRecording(session.id, id).catch(() => {});
    for (const cancel of this.waiters.values()) cancel(); this.waiters.clear();
  }

  private async finishUpload(version: number): Promise<void> {
    const session = this.session()!; const id = this.recordingId();
    if (!id) return;
    try {
      const result = await this.bounded(this.gateway.finishRecording(session.id, id));
      if (!this.current(version)) return;
      this.recordingId.set(null); this.uploadFinished.set(false); this.accept(result); this.error.set(''); this.schedule(version);
    } catch (error) { if (this.current(version)) this.fail(error, 'The recording finish was not confirmed. Retry sending the same recording or check its status.'); }
    finally { if (this.current(version)) { this.busy.set(false); this.phase.set('idle'); } }
  }

  private async command(operation: (session: ConversationSession) => Promise<ConversationEnvelope>, interrupt = false): Promise<void> {
    if (this.disposed || (!interrupt && this.busy()) || !this.session()) return;
    const version = this.restart(); this.busy.set(true); this.error.set(''); this.stopAudio();
    try {
      const result = await this.bounded(operation(this.session()!));
      if (this.current(version)) { this.accept(result); this.schedule(version); }
    } catch (error) { if (this.current(version)) this.fail(error, 'The request could not be confirmed. Your accepted answers remain saved. Check the session again.'); }
    finally { if (this.current(version)) this.busy.set(false); }
  }

  private async poll(version: number): Promise<void> {
    if (!this.current(version) || this.pollInFlight || !this.session()) return;
    this.pollInFlight = true; this.pollCount++;
    try {
      const result = await this.bounded(this.gateway.read(this.session()!.id));
      if (!this.current(version)) return;
      this.accept(result); this.pollErrors = 0; this.error.set('');
      if (this.currentTurn()?.status !== 'recording') { this.recordingId.set(null); this.uploadFinished.set(false); }
    } catch (error) {
      if (this.current(version)) { this.pollErrors++; this.fail(error, 'Conversation status could not be checked. Saved answers are unchanged.'); }
    } finally { if (this.current(version)) { this.pollInFlight = false; this.schedule(version); } }
  }

  private schedule(version: number): void {
    if (!this.current(version) || this.session()?.status !== 'active' || !['queued', 'evaluating'].includes(this.currentTurn()?.status ?? '')) return;
    if (this.pollCount >= 60 || this.pollErrors >= 3) { this.pollingPaused.set(true); return; }
    this.pollTimer = setTimeout(() => { this.pollTimer = undefined; void this.poll(version); }, 2000);
  }
  private accept(result: ConversationEnvelope): void {
    if (result.session.pathContentVersion !== this.pathVersion || result.session.contentVersion !== this.taskVersion) {
      throw new ApiError('Lesson changed.', 409, 'CONVERSATION_CONTENT_CHANGED');
    }
    if (this.session()?.currentTurnId !== result.session.currentTurnId) { this.stopAudio(); this.liveTranscript.set(null); }
    this.resetConfirmedTerminal(result.session);
    this.session.set(result.session); this.enabled.set(result.availability.enabled);
  }
  private resetConfirmedTerminal(session: ConversationSession): void {
    if (session.status === 'cancelled' || session.status === 'expired') {
      this.startKey = undefined; this.exhaustedRecordingTurn.set(null);
      this.recordingId.set(null); this.uploadFinished.set(false);
    }
  }
  private failRecording(error: unknown, version: number): void {
    if (!this.current(version)) return;
    this.restart(); this.stopCapture(); this.busy.set(false);
    this.fail(error, 'The recording was interrupted. Cancel it and record again. No answer was marked wrong.');
  }
  private stopCapture(): void { clearTimeout(this.recordingTimer); this.microphone.cancel(); this.phase.set('idle'); }
  private restart(): number {
    clearTimeout(this.pollTimer); this.pollTimer = undefined; this.pollInFlight = false;
    this.pollCount = 0; this.pollErrors = 0; this.pollingPaused.set(false); return ++this.version;
  }
  private current(version: number): boolean { return !this.disposed && version === this.version; }
  private fail(error: unknown, fallback: string): void {
    if (error instanceof ApiError && error.code.endsWith('_CONTENT_CHANGED')) {
      this.contentChanged.set(true); this.error.set('This lesson changed. Reopen the lesson before continuing the conversation.');
    } else if (error instanceof ApiError && error.code === 'CONVERSATION_RECORDING_LIMIT') {
      const session = this.session();
      if (session) this.exhaustedRecordingTurn.set({ sessionId: session.id, turnId: session.currentTurnId });
      this.error.set('This question has reached its recording limit. Cancel this conversation and start a new session to record again.');
    } else if (error instanceof ApiError && error.status === 503) {
      this.error.set('Conversation practice is unavailable. Try again later. This exercise has not been completed.');
    } else this.error.set(fallback);
  }
  private bounded<T>(request: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.waiters.delete(timer); reject(new Error('Conversation request timed out.')); }, 15000);
      this.waiters.set(timer, () => { clearTimeout(timer); reject(new Error('Conversation closed.')); });
      request.then(resolve, reject).finally(() => { clearTimeout(timer); this.waiters.delete(timer); });
    });
  }
}
