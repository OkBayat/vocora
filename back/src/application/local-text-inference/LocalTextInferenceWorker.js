import { inferenceProfileKey } from "./inferenceIdentity.js";

const LEASE_FENCING_RESERVE_MS = 10_000;

async function settledWithin(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

export class LocalTextInferenceWorker {
  constructor({ repository, handlers, clock = () => new Date(), idFactory, timeoutMs = 120_000, cleanupTimeoutMs = 5000, pollIntervalMs = 1000, logger = console }) {
    Object.assign(this, { repository, handlers, clock, idFactory, timeoutMs, cleanupTimeoutMs, pollIntervalMs, logger });
    this.workerId = idFactory();
    this.active = null;
    this.running = null;
    this.timer = null;
    this.started = false;
    this.stopping = false;
  }

  runOnce() {
    if (this.stopping) return Promise.resolve();
    if (this.running) return this.running;
    // A provider violating its abort contract must not receive another request.
    if (this.active) return Promise.resolve();
    this.running = this.processNext().finally(() => { this.running = null; });
    return this.running;
  }

  async processNext() {
    const now = this.clock().toISOString();
    await this.repository.purgeExpired(now, 100);
    const leaseToken = this.idFactory();
    const evaluationProfiles = Object.fromEntries(Object.entries(this.handlers).map(([kind, handler]) => [kind, handler.enabled ? handler.provider?.getIdentity?.() ?? null : null]));
    const requestedLeaseUntil = new Date(Date.parse(now) + this.timeoutMs + this.cleanupTimeoutMs + LEASE_FENCING_RESERVE_MS).toISOString();
    const record = await this.repository.claim({ workerId: this.workerId, leaseToken, now, leaseUntil: requestedLeaseUntil, maxAttempts: 3, evaluationProfiles });
    if (!record) return;
    const handler = this.handlers[record.kind];
    const prefix = handler?.prefix ?? "LOCAL_INFERENCE";
    const evaluationProfile = evaluationProfiles[record.kind];
    const controller = new AbortController();
    const active = { id: record.id, kind: record.kind, sessionId: record.sessionId, prefix, controller };
    this.active = active;
    let timeout;
    let evaluation;
    let result = null;
    let identity = null;
    let metrics = null;
    let errorCode = null;
    try {
      if (this.stopping) throw Object.assign(new Error(), { code: `${prefix}_CANCELLED` });
      if (!handler?.enabled) throw Object.assign(new Error(), { code: `${prefix}_DISABLED` });
      if (record.evaluationProfile && inferenceProfileKey(record.evaluationProfile) !== inferenceProfileKey(evaluationProfile)) {
        throw Object.assign(new Error(), { code: `${prefix}_PROFILE_CHANGED` });
      }
      const claimCurrent = await this.repository.isClaimCurrent({ kind: record.kind, id: record.id, userId: record.userId, leaseToken, now: this.clock().toISOString() });
      if (!claimCurrent || this.stopping || controller.signal.aborted) throw Object.assign(new Error(), { code: `${prefix}_CANCELLED` });
      // Database waits consume the same persisted lease as inference. Keep
      // cleanup and fencing reserves inside it rather than restarting a full
      // provider allowance after a slow claim or current-claim read.
      const leaseDeadline = Date.parse(record.leaseUntil ?? requestedLeaseUntil);
      const executionMs = Math.min(this.timeoutMs, leaseDeadline - this.clock().getTime() - this.cleanupTimeoutMs - LEASE_FENCING_RESERVE_MS);
      if (!Number.isFinite(executionMs) || executionMs <= 0) throw Object.assign(new Error(), { code: `${prefix}_TIMEOUT` });
      const interruption = new Promise((_resolve, reject) => {
        controller.signal.addEventListener("abort", () => reject(Object.assign(new Error(), { code: controller.signal.reason ?? `${prefix}_CANCELLED` })), { once: true });
        timeout = setTimeout(() => controller.abort(`${prefix}_TIMEOUT`), executionMs);
      });
      evaluation = Promise.resolve().then(() => handler.evaluate(record, controller.signal));
      ({ result, identity, metrics } = await Promise.race([evaluation, interruption]));
    } catch (error) {
      errorCode = [`${prefix}_DISABLED`, `${prefix}_TIMEOUT`, `${prefix}_CANCELLED`, `${prefix}_PROFILE_CHANGED`].includes(error?.code) || handler?.isSafeError(error) ? error.code : `${prefix}_UNAVAILABLE`;
    } finally { clearTimeout(timeout); }

    const finish = async () => {
      try {
        await this.repository.finish({ kind: record.kind, applyConversationResult: handler?.applyResult, id: record.id, leaseToken, now: this.clock().toISOString(), status: errorCode ? "unavailable" : "completed", result, identity, metrics, errorCode });
      } finally { if (this.active === active) this.active = null; }
    };
    if (evaluation && !await settledWithin(evaluation, this.cleanupTimeoutMs)) {
      // Keep the persisted lease while cleanup is unresolved. The next process
      // can reconcile expiry; this process remains closed to further inference.
      active.cleanup = evaluation.then(finish, finish).catch(() => {
        this.logger.warn?.("Local text inference cleanup could not update its queue.");
      });
      return;
    }
    await finish();
  }

  cancel(id, kind) {
    if (this.active?.id === id && (!kind || this.active.kind === kind)) this.active.controller.abort(`${this.active.prefix}_CANCELLED`);
  }

  cancelSession(sessionId) {
    if (this.active?.sessionId === sessionId) this.active.controller.abort(`${this.active.prefix}_CANCELLED`);
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.stopping = false;
    const tick = async () => {
      try { await this.runOnce(); } catch { this.logger.warn?.("Local text inference worker could not access its queue."); }
      if (this.started) {
        this.timer = setTimeout(tick, this.pollIntervalMs);
        this.timer.unref?.();
      }
    };
    void tick();
  }

  async stop() {
    this.started = false;
    this.stopping = true;
    clearTimeout(this.timer);
    this.active?.controller.abort(`${this.active.prefix}_CANCELLED`);
    await this.running?.catch(() => {});
  }
}
