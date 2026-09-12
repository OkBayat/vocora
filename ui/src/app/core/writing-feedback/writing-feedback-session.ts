import { signal } from '@angular/core';
import { ApiError } from '../http/api-client.service';
import type { WritingDraftRequest, WritingFeedbackAvailability, WritingFeedbackController, WritingFeedbackHistory, WritingSubmission } from '../../shared/slide-exercise/writing-feedback-contracts';

export interface WritingFeedbackGateway {
  history(): Promise<WritingFeedbackHistory>;
  save(request: WritingDraftRequest): Promise<WritingSubmission>;
  read(id: string): Promise<WritingSubmission>;
  retry(id: string): Promise<WritingSubmission>;
  cancel(id: string): Promise<WritingSubmission>;
}

export class WritingFeedbackSession implements WritingFeedbackController {
  readonly loading = signal(false);
  readonly loaded = signal(false);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly pollingPaused = signal(false);
  readonly contentChanged = signal(false);
  readonly currentContentVersion = signal('');
  readonly availability = signal<WritingFeedbackAvailability>({ enabled: false, maxCharacters: 2000, maxWords: 80 });
  readonly submissions = signal<readonly WritingSubmission[]>([]);
  readonly active = signal<WritingSubmission | null>(null);
  constructor(private readonly gateway: WritingFeedbackGateway, private readonly ensureStarted: () => Promise<boolean>, private readonly key: () => string) {}
  private version = 0;
  private disposed = false;
  private pollTimer?: ReturnType<typeof setTimeout>;
  private readonly requestTimers = new Map<ReturnType<typeof setTimeout>, () => void>();
  private pollCount = 0;
  private pollErrors = 0;
  private pollInFlight = false;
  private pendingDraft?: WritingDraftRequest;

  async load(): Promise<void> {
    if (this.disposed || this.busy() || this.loading()) return;
    const version = this.restart();
    this.loading.set(true);
    this.error.set('');
    try {
      const history = await this.bounded(this.gateway.history());
      if (!this.current(version)) return;
      this.availability.set(history.availability);
      this.currentContentVersion.set(history.currentContentVersion);
      this.submissions.set(history.submissions);
      this.active.set(history.submissions.find((item) => item.contentVersion === history.currentContentVersion) ?? null);
      const pending = this.pendingDraft;
      if (pending && history.submissions.some((item) => item.contentVersion === history.currentContentVersion
        && item.draftText === pending.draftText && item.notes === pending.notes
        && (item.parentSubmissionId ?? undefined) === pending.parentSubmissionId)) this.pendingDraft = undefined;
      this.loaded.set(true);
      this.schedule(version);
    } catch (error) {
      if (this.current(version)) this.fail(error, 'Saved responses could not be restored. Try loading again.');
    } finally {
      if (this.current(version)) this.loading.set(false);
    }
  }

  async save(draftText: string, notes: string, parentSubmissionId?: string): Promise<WritingSubmission | null> {
    if (this.disposed || this.busy() || !this.loaded() || this.contentChanged()) return null;
    if (!draftText.trim() || draftText.length > this.availability().maxCharacters || notes.length > 2000) {
      this.error.set('Write a response within the displayed character limit. Your text is still here.');
      return null;
    }
    const pending = this.pendingDraft;
    if (pending && (pending.draftText !== draftText || pending.notes !== notes || pending.parentSubmissionId !== parentSubmissionId)) {
      this.error.set('Retry saving the previous draft first. Your text is still here.');
      return null;
    }
    const request = this.pendingDraft ??= {
      draftText, notes, idempotencyKey: this.key(), ...(parentSubmissionId ? { parentSubmissionId } : {}),
    };
    const version = this.restart();
    this.busy.set(true);
    this.error.set('');
    try {
      if (!await this.bounded(this.ensureStarted())) throw new Error('Exercise not started.');
      if (!this.current(version)) return null;
      const saved = await this.bounded(this.gateway.save(request));
      if (!this.current(version)) return null;
      this.pendingDraft = undefined;
      this.accept(saved);
      this.schedule(version);
      return saved;
    } catch (error) {
      if (this.current(version)) this.fail(error, 'Your response could not be saved. Your text is still here. Try saving again.');
      return null;
    } finally {
      if (this.current(version)) this.busy.set(false);
    }
  }

  async check(): Promise<void> {
    if (this.disposed || this.busy() || this.pollInFlight || !this.active()) return;
    const version = this.restart();
    await this.poll(version);
  }

  async retry(): Promise<void> { await this.command('retry'); }
  async cancel(): Promise<void> { await this.command('cancel'); }

  select(id: string): void {
    if (this.disposed || this.busy()) return;
    const submission = this.submissions().find((item) => item.id === id);
    if (!submission) return;
    const version = this.restart();
    this.active.set(submission);
    this.error.set('');
    this.schedule(version);
  }

  dispose(): void {
    this.disposed = true;
    this.restart();
    for (const cancel of this.requestTimers.values()) cancel();
    this.requestTimers.clear();
    this.pendingDraft = undefined;
  }

  private async command(operation: 'retry' | 'cancel'): Promise<void> {
    const active = this.active();
    if (this.disposed || this.busy() || !active) return;
    const version = this.restart();
    this.busy.set(true);
    this.error.set('');
    try {
      const saved = await this.bounded(this.gateway[operation](active.id));
      if (!this.current(version)) return;
      this.accept(saved);
      this.schedule(version);
    } catch {
      if (this.current(version)) {
        this.error.set('Feedback could not be updated. Your saved response is unchanged. Check again.');
        this.pollingPaused.set(true);
      }
    } finally {
      if (this.current(version)) this.busy.set(false);
    }
  }

  private async poll(version: number): Promise<void> {
    const active = this.active();
    if (!this.current(version) || !active || this.pollInFlight) return;
    this.pollInFlight = true;
    this.pollCount += 1;
    try {
      const saved = await this.bounded(this.gateway.read(active.id));
      if (!this.current(version)) return;
      this.accept(saved);
      this.pollErrors = 0;
      this.error.set('');
    } catch {
      if (!this.current(version)) return;
      this.pollErrors += 1;
      this.error.set('Feedback status could not be checked. Your response is saved.');
    } finally {
      if (this.current(version)) {
        this.pollInFlight = false;
        this.schedule(version);
      }
    }
  }

  private schedule(version: number): void {
    const status = this.active()?.status;
    if (!this.current(version) || (status !== 'queued' && status !== 'running')) return;
    if (this.pollCount >= 60 || this.pollErrors >= 3) {
      this.pollingPaused.set(true);
      return;
    }
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined;
      void this.poll(version);
    }, 2000);
  }

  private accept(submission: WritingSubmission): void {
    this.submissions.update((items) => [submission, ...items.filter((item) => item.id !== submission.id)]);
    this.active.set(submission);
  }

  private restart(): number {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
    this.pollInFlight = false;
    this.pollCount = 0;
    this.pollErrors = 0;
    this.pollingPaused.set(false);
    return ++this.version;
  }

  private current(version: number): boolean { return !this.disposed && this.version === version; }

  private fail(error: unknown, fallback: string): void {
    if (error instanceof ApiError && error.code === 'WRITING_FEEDBACK_CONTENT_CHANGED') {
      this.contentChanged.set(true);
      this.error.set('This lesson changed. Your text is still here. Copy it, then reopen the lesson before submitting.');
      return;
    }
    this.error.set(fallback);
  }

  private bounded<T>(request: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requestTimers.delete(timer);
        reject(new Error('Writing request timed out.'));
      }, 15000);
      this.requestTimers.set(timer, () => {
        clearTimeout(timer);
        reject(new Error('Writing session closed.'));
      });
      request.then(resolve, reject).finally(() => {
        clearTimeout(timer);
        this.requestTimers.delete(timer);
      });
    });
  }
}
