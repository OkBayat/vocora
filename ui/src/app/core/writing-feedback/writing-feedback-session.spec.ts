import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WritingFeedbackHistory, WritingSubmission } from '../../shared/slide-exercise/writing-feedback-contracts';
import { WritingFeedbackSession } from './writing-feedback-session';

function submission(overrides: Partial<WritingSubmission> = {}): WritingSubmission {
  return {
    id: 'draft-1', status: 'queued', draftText: '  I eat bread.  ', notes: 'Breakfast.',
    parentSubmissionId: null, createdAt: '2026-09-12T00:00:00Z', updatedAt: '2026-09-12T00:00:00Z',
    expiresAt: '2026-10-12T00:00:00Z', feedback: null, errorCode: null, attemptCount: 0,
    contentVersion: 'v1', ...overrides,
  };
}

function setup(history: readonly WritingSubmission[] = []) {
  const gateway = {
    history: vi.fn().mockResolvedValue({
      pathContentVersion: 1, currentContentVersion: 'v1', availability: { enabled: false, maxCharacters: 2000, maxWords: 80 }, submissions: history,
    } satisfies WritingFeedbackHistory),
    save: vi.fn().mockResolvedValue(submission()),
    read: vi.fn().mockResolvedValue(submission({ status: 'completed' })),
    retry: vi.fn().mockResolvedValue(submission()),
    cancel: vi.fn().mockResolvedValue(submission({ status: 'cancelled' })),
  };
  const ensureStarted = vi.fn().mockResolvedValue(true);
  const key = vi.fn().mockReturnValue('stable-key');
  return { gateway, ensureStarted, key, session: new WritingFeedbackSession(gateway, ensureStarted, key) };
}

afterEach(() => vi.useRealTimers());

describe('WritingFeedbackSession', () => {
  it('recovers current-attempt drafts while inference is disabled', async () => {
    const original = submission({ status: 'unavailable', errorCode: 'WRITING_FEEDBACK_DISABLED' });
    const { session, gateway } = setup([original]);
    await session.load();
    expect(session.loaded()).toBe(true);
    expect(session.active()).toEqual(original);
    expect(session.availability().enabled).toBe(false);
    expect(gateway.save).not.toHaveBeenCalled();
    expect(gateway.retry).not.toHaveBeenCalled();
    session.dispose();
  });

  it('waits for durable acknowledgement and reuses the immutable request key after save failure', async () => {
    const { session, gateway, ensureStarted, key } = setup();
    await session.load();
    gateway.save.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(submission({ status: 'unavailable' }));
    expect(await session.save('  I eat bread.  ', 'Breakfast.')).toBeNull();
    expect(session.active()).toBeNull();
    expect(session.error()).toContain('Your text is still here');
    await session.save('  I eat bread.  ', 'Breakfast.');
    expect(gateway.save.mock.calls.map(([request]) => request)).toEqual([
      { draftText: '  I eat bread.  ', notes: 'Breakfast.', idempotencyKey: 'stable-key' },
      { draftText: '  I eat bread.  ', notes: 'Breakfast.', idempotencyKey: 'stable-key' },
    ]);
    expect(key).toHaveBeenCalledOnce();
    expect(ensureStarted).toHaveBeenCalledTimes(2);
    expect(session.active()?.feedback).toBeNull();
    session.dispose();
  });

  it('stores a revision as a new linked draft without changing the original', async () => {
    const original = submission({ status: 'completed' });
    const revision = submission({ id: 'draft-2', parentSubmissionId: original.id, draftText: 'I eat bread and drink water.', status: 'unavailable' });
    const { session, gateway } = setup([original]);
    await session.load();
    gateway.save.mockResolvedValueOnce(revision);
    await session.save(revision.draftText, '', original.id);
    expect(gateway.save).toHaveBeenCalledWith({ draftText: revision.draftText, notes: '', parentSubmissionId: original.id, idempotencyKey: 'stable-key' });
    expect(session.submissions()).toEqual([revision, original]);
    session.dispose();
  });

  it('polls jobs without creating new submissions and pauses at a finite limit', async () => {
    vi.useFakeTimers();
    const { session, gateway } = setup([submission()]);
    gateway.read.mockResolvedValue(submission({ status: 'running' }));
    await session.load();
    await vi.advanceTimersByTimeAsync(2000 * 61);
    expect(gateway.read).toHaveBeenCalledTimes(60);
    expect(session.pollingPaused()).toBe(true);
    expect(gateway.save).not.toHaveBeenCalled();
    expect(gateway.retry).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10000);
    expect(gateway.read).toHaveBeenCalledTimes(60);
    session.dispose();
  });

  it('pauses after three polling errors and keeps the saved draft available', async () => {
    vi.useFakeTimers();
    const { session, gateway } = setup([submission()]);
    gateway.read.mockRejectedValue(new Error('network'));
    await session.load();
    await vi.advanceTimersByTimeAsync(10000);
    expect(gateway.read).toHaveBeenCalledTimes(3);
    expect(session.pollingPaused()).toBe(true);
    expect(session.active()?.draftText).toBe('  I eat bread.  ');
    session.dispose();
  });

  it('explicit cancellation preserves the draft and ignores an older poll result', async () => {
    vi.useFakeTimers();
    const { session, gateway } = setup([submission()]);
    let complete!: (value: WritingSubmission) => void;
    gateway.read.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    await session.load();
    await vi.advanceTimersByTimeAsync(2000);
    await session.cancel();
    complete(submission({ status: 'completed' }));
    await Promise.resolve();
    await Promise.resolve();
    expect(session.active()?.status).toBe('cancelled');
    expect(session.active()?.draftText).toBe('  I eat bread.  ');
    session.dispose();
  });

  it('does not save if the owning exercise cannot be started', async () => {
    const { session, gateway, ensureStarted } = setup();
    await session.load();
    ensureStarted.mockResolvedValue(false);
    expect(await session.save('My response.', '')).toBeNull();
    expect(gateway.save).not.toHaveBeenCalled();
    session.dispose();
  });

  it('ignores a delayed save acknowledgement after the slide is disposed', async () => {
    const { session, gateway } = setup();
    await session.load();
    let complete!: (value: WritingSubmission) => void;
    gateway.save.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    const saving = session.save('My response.', '');
    await vi.waitFor(() => expect(gateway.save).toHaveBeenCalledOnce());
    session.dispose();
    expect(await saving).toBeNull();
    complete(submission());
    expect(session.active()).toBeNull();
  });
});
