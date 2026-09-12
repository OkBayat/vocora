import { createHash } from "node:crypto";
import { AppError, NotFoundError, ValidationError } from "../../domain/errors.js";
import { conversationError, conversationInput, requireConversationActive, requireConversationTurn } from "./conversationState.js";

function missingRecording() { return new NotFoundError("CONVERSATION_RECORDING_NOT_FOUND", "This recording is no longer available. Record the question again."); }
const identityKey = (identity) => JSON.stringify(Object.fromEntries(Object.entries(identity ?? {}).sort(([a], [b]) => a.localeCompare(b))));

export class ConversationRecordings {
  constructor({ sessions, repository, speech, idFactory, evaluationProfile = null, cancelWork = () => {} }) {
    Object.assign(this, { sessions, repository, speech, idFactory, evaluationProfile, cancelWork });
    this.live = new Map(); this.starting = new Set(); this.stopping = false;
  }
  requireRunning() { if (this.stopping) throw new AppError(503, "CONVERSATION_UNAVAILABLE", "Conversation practice is restarting. Try again shortly."); }
  async start(userId, sessionId, rawInput) {
    this.requireRunning();
    const input = conversationInput(rawInput, ["expectedSessionRevision", "idempotencyKey"], ["expectedSessionRevision", "idempotencyKey"]);
    this.sessions.requireEnabled();
    const original = await this.sessions.owned(userId, sessionId);
    this.requireRunning();
    requireConversationActive(original, this.sessions.now());
    const current = requireConversationTurn(original);
    const duplicateTurn = original.state.turns.find((turn) => turn.recordings.some((item) => item.idempotencyKey === input.idempotencyKey));
    const duplicate = duplicateTurn?.recordings.find((item) => item.idempotencyKey === input.idempotencyKey);
    if (duplicate) {
      if (duplicateTurn.id !== current.id || duplicate.status !== "recording" || !this.live.get(duplicate.id)?.ready) throw conversationError("RECORDING_CHANGED", "Reload the saved conversation before recording again.");
      return this.allocation(original, duplicate.id, current.id);
    }
    if (this.live.size + this.starting.size >= 8) throw new AppError(429, "CONVERSATION_RECORDING_BUSY", "Speech recording is busy. Try again shortly.");
    const id = this.idFactory(); this.starting.add(id);
    let session;
    try {
      session = await this.repository.mutateOwned(userId, sessionId, input.expectedSessionRevision, (record) => {
        requireConversationActive(record, this.sessions.now());
        const state = structuredClone(record.state); const turn = requireConversationTurn({ ...record, state });
        if (!["ready", "retryable_failure"].includes(turn.status)) throw conversationError("TURN_BUSY", "Finish the current turn before recording again.");
        if (turn.transcript?.status === "transcribed" && turn.feedback?.assessmentStatus !== "insufficient_evidence" && turn.errorCode !== "CONVERSATION_INSUFFICIENT_SPEECH") throw conversationError("RETRY_EVALUATION", "Retry feedback for the saved transcript before recording again.");
        if (turn.recordings.length >= 3) throw conversationError("RECORDING_LIMIT", "This question has reached its recording attempt limit.");
        turn.recordings.push({ id, idempotencyKey: input.idempotencyKey, status: "recording", createdAt: this.sessions.now(), transcript: null });
        turn.selectedRecordingId = id; turn.status = "recording"; turn.transcript = null; turn.feedback = null; turn.errorCode = null; turn.attemptCount = 0;
        return { state };
      }, { now: this.sessions.now() });
      this.requireRunning();
      const entry = { id, userId, sessionId, turnId: session.state.currentTurnId, bytes: 0, sequence: 0, cached: null, finalTranscript: null, busy: false, controller: new AbortController(), responseSeconds: session.config.responseSeconds };
      entry.timer = setTimeout(() => {
        if (this.live.get(id) !== entry) return;
        this.releaseEntry(id); entry.controller.abort();
        void this.speech.cancel(id).catch(() => {});
        void this.failRecording(userId, sessionId, id, "CONVERSATION_RECORDING_INTERRUPTED").catch(() => {});
      }, (session.config.responseSeconds + 30) * 1000);
      entry.timer.unref?.();
      this.live.set(id, entry);
      // Reserve cancellation before rereading the committed aggregate. A cancel
      // may have won after the allocation transaction but before this continuation.
      const latest = await this.sessions.owned(userId, sessionId);
      requireConversationActive(latest, this.sessions.now());
      if (this.live.get(id) !== entry || entry.controller.signal.aborted || requireConversationTurn(latest).selectedRecordingId !== id) throw missingRecording();
      await this.speech.start(id, { signal: entry.controller.signal });
      if (this.live.get(id) !== entry) throw missingRecording();
      entry.ready = true;
      return this.allocation(session, id, entry.turnId);
    } catch (error) {
      if (session) {
        this.releaseEntry(id);
        await this.failRecording(userId, sessionId, id, "CONVERSATION_TRANSCRIPTION_UNAVAILABLE").catch(() => {});
        await this.speech.cancel(id).catch(() => {});
      }
      throw error;
    } finally { this.starting.delete(id); }
  }
  releaseEntry(id) {
    const entry = this.live.get(id);
    clearTimeout(entry?.timer);
    this.live.delete(id);
    return entry;
  }
  allocation(session, id, turnId) {
    return { ...this.sessions.response(session), recording: { id, turnId, nextSequence: this.live.get(id)?.sequence ?? 0, responseSeconds: session.config.responseSeconds } };
  }
  async exclusive(userId, sessionId, id, operation) {
    const session = await this.sessions.owned(userId, sessionId);
    requireConversationActive(session, this.sessions.now());
    const entry = this.live.get(id);
    if (!entry || !entry.ready || entry.userId !== userId || entry.sessionId !== sessionId || requireConversationTurn(session).selectedRecordingId !== id) throw missingRecording();
    if (entry.busy) throw conversationError("RECORDING_BUSY", "Wait for the current audio request.");
    entry.busy = true;
    try { return await operation(entry, session); } finally { entry.busy = false; }
  }
  async chunk(userId, sessionId, id, sequence, pcm) {
    if (!Buffer.isBuffer(pcm) || !pcm.length || pcm.length % 2 || pcm.length > 32000 || !Number.isSafeInteger(sequence) || sequence < 0) throw new ValidationError("CONVERSATION_INVALID_AUDIO", "Send an ordered, bounded 16 kHz mono PCM chunk.");
    return this.exclusive(userId, sessionId, id, async (entry) => {
      const hash = createHash("sha256").update(pcm).digest("hex");
      if (entry.cached?.sequence === sequence && entry.cached.hash === hash) return entry.cached.value;
      if (entry.finalTranscript || sequence !== entry.sequence) throw conversationError("AUDIO_ORDER", "Audio arrived out of order. Record the question again.");
      if (entry.bytes + pcm.length > 32000 * entry.responseSeconds) throw new AppError(413, "CONVERSATION_AUDIO_LIMIT", "The recording exceeds this question's time limit.");
      const transcript = await this.speech.chunkDetailed(id, sequence, pcm, { signal: entry.controller.signal });
      if (this.live.get(id) !== entry) throw missingRecording();
      entry.bytes += pcm.length; entry.sequence++;
      const value = { recordingId: id, nextSequence: entry.sequence, transcript };
      entry.cached = { sequence, hash, value };
      return value;
    });
  }
  async finish(userId, sessionId, id) {
    const existing = await this.sessions.owned(userId, sessionId);
    const oldTurn = existing.state.turns.find((turn) => turn.recordings.some((recording) => recording.id === id));
    const oldRecording = oldTurn?.recordings.find((item) => item.id === id);
    if (!oldRecording) throw missingRecording();
    if (oldRecording.transcript) return this.sessions.response(existing);
    if (!this.live.has(id)) {
      const interrupted = await this.failRecording(userId, sessionId, id, "CONVERSATION_RECORDING_INTERRUPTED");
      return this.sessions.response(interrupted);
    }
    return this.exclusive(userId, sessionId, id, async (entry) => {
      let transcript;
      try {
        transcript = entry.finalTranscript ?? await this.speech.finishDetailed(id, { signal: entry.controller.signal });
        entry.finalTranscript = transcript;
      } catch (error) {
        this.releaseEntry(id);
        entry.controller.abort();
        await this.speech.cancel(id).catch(() => {});
        await this.failRecording(userId, sessionId, id, "CONVERSATION_TRANSCRIPTION_UNAVAILABLE");
        throw error;
      }
      if (this.live.get(id) !== entry) throw missingRecording();
      const record = await this.repository.mutateOwned(userId, sessionId, null, (current) => {
        requireConversationActive(current, this.sessions.now());
        const state = structuredClone(current.state); const turn = requireConversationTurn({ ...current, state }, entry.turnId);
        if (turn.selectedRecordingId !== id || turn.status !== "recording") throw missingRecording();
        const recording = turn.recordings.find((item) => item.id === id);
        recording.transcript = transcript; recording.bytes = entry.bytes; recording.status = transcript.status;
        turn.transcript = transcript; turn.status = "retryable_failure";
        if (transcript.status !== "transcribed" || !transcript.text.trim() || entry.bytes < 8000) {
          turn.errorCode = "CONVERSATION_INSUFFICIENT_SPEECH";
        } else if (state.asrIdentity && identityKey(state.asrIdentity) !== identityKey(transcript.providerIdentity)) {
          turn.errorCode = "CONVERSATION_ASR_CHANGED";
        } else {
          state.asrIdentity ??= transcript.providerIdentity;
          turn.errorCode = "CONVERSATION_QUEUE_PENDING";
        }
        return { state };
      }, { now: this.sessions.now() });
      this.releaseEntry(id);
      await this.speech.cancel(id).catch(() => {});
      if (requireConversationTurn(record, entry.turnId).errorCode !== "CONVERSATION_QUEUE_PENDING") return this.sessions.response(record);
      return this.queue(userId, sessionId, entry.turnId);
    });
  }
  async queue(userId, sessionId, turnId) {
    const now = this.sessions.now();
    const record = await this.repository.mutateOwned(userId, sessionId, null, (current) => {
      requireConversationActive(current, now);
      const state = structuredClone(current.state); const turn = requireConversationTurn({ ...current, state }, turnId);
      if (turn.transcript?.status !== "transcribed" || !turn.selectedRecordingId || turn.errorCode !== "CONVERSATION_QUEUE_PENDING") throw conversationError("TRANSCRIPT_NOT_READY", "A saved transcript is required for feedback.");
      turn.status = "queued"; turn.errorCode = null;
      const payload = { sessionVersion: current.id, turnVersion: turn.id, contentVersion: current.contentVersion, config: current.config, currentQuestion: turn.question, previousTurns: state.turns.filter((item) => item.feedback?.assessmentStatus === "feedback_available").map((item) => ({ question: item.question, transcriptText: item.transcript.text })), transcript: turn.transcript, acceptedTurns: state.acceptedTurnCount, activeUntil: state.activeUntil };
      return { state, job: { id: turn.selectedRecordingId, sessionId, turnId, userId, payload, evaluationProfile: current.evaluationProfile, status: "queued", attemptCount: 0, createdAt: now, expiresAt: state.activeUntil } };
    }, { now });
    return this.sessions.response(record);
  }
  async retry(userId, sessionId, turnId) {
    this.sessions.requireEnabled();
    const current = await this.sessions.owned(userId, sessionId);
    requireConversationActive(current, this.sessions.now());
    const turn = requireConversationTurn(current, turnId);
    if (turn.errorCode === "CONVERSATION_QUEUE_PENDING") return this.queue(userId, sessionId, turnId);
    return this.sessions.response(await this.repository.retryJobOwned(userId, sessionId, turnId, { now: this.sessions.now() }));
  }
  async failRecording(userId, sessionId, id, errorCode) {
    return this.repository.mutateOwned(userId, sessionId, null, (current) => {
      const state = structuredClone(current.state); const turn = state.turns.find((item) => item.selectedRecordingId === id);
      if (!turn || turn.status !== "recording") return { state };
      const recording = turn.recordings.find((item) => item.id === id); recording.status = "failed";
      turn.status = "retryable_failure"; turn.errorCode = errorCode;
      return { state };
    }, { now: this.sessions.now() });
  }
  async cancel(userId, sessionId, id) {
    await this.sessions.owned(userId, sessionId);
    await this.repository.mutateOwned(userId, sessionId, null, (current) => {
      const state = structuredClone(current.state); const turn = state.turns.find((item) => item.recordings.some((recording) => recording.id === id));
      if (!turn) throw missingRecording();
      if (turn.feedback?.assessmentStatus === "feedback_available") throw conversationError("TURN_ACCEPTED", "This accepted turn cannot be replaced.");
      const recording = turn.recordings.find((item) => item.id === id); recording.status = "cancelled";
      if (turn.selectedRecordingId === id) { turn.selectedRecordingId = null; turn.status = "ready"; turn.transcript = null; turn.feedback = null; turn.errorCode = null; }
      return { state, cancelJobIds: [id] };
    }, { now: this.sessions.now() });
    const entry = this.live.get(id); this.releaseEntry(id); entry?.controller.abort();
    this.cancelWork(id);
    await this.speech.cancel(id).catch(() => {});
  }
  async cancelSession(sessionId) {
    for (const [id, entry] of this.live) if (entry.sessionId === sessionId) {
      this.releaseEntry(id); entry.controller.abort(); await this.speech.cancel(id).catch(() => {});
    }
  }
  async stop() {
    this.stopping = true;
    for (const entry of [...this.live.values()]) await this.cancelSession(entry.sessionId);
  }
}
