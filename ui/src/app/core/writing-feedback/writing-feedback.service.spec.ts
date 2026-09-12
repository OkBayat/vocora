import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { CollectionLearningPathApiService } from '../collection-learning-path/collection-learning-path-api.service';
import { ApiError } from '../http/api-client.service';
import { WritingFeedbackService } from './writing-feedback.service';

function setup(pathContentVersion = 1) {
  const api = {
    queryWritingFeedbackHistory: vi.fn().mockResolvedValue({ pathContentVersion, currentContentVersion: 'current-task', availability: { enabled: false, maxWords: 80, maxCharacters: 2000 }, submissions: [] }),
    commandSaveWritingFeedback: vi.fn().mockResolvedValue({ id: 'saved', status: 'unavailable', contentVersion: 'current-task', draftText: 'My draft.', notes: '' }),
  };
  TestBed.configureTestingModule({ providers: [{ provide: CollectionLearningPathApiService, useValue: api }] });
  const scope = { pathId: '1', lessonId: '2', exerciseId: '3', slideId: 'writing', expectedPathContentVersion: 1 };
  const session = TestBed.inject(WritingFeedbackService).create(scope);
  return { api, session, scope };
}

describe('WritingFeedbackService', () => {
  it('keeps the displayed content version immutable for every saved draft', async () => {
    const { api, session, scope } = setup();
    await session.load();
    scope.expectedPathContentVersion = 2;
    await session.save('My draft.', '');
    expect(api.commandSaveWritingFeedback).toHaveBeenCalledWith('1', '2', '3', 'writing', {
      draftText: 'My draft.', notes: '', idempotencyKey: expect.any(String), expectedPathContentVersion: 1,
    });
    session.dispose();
  });

  it('does not restore a newer server task beneath a stale displayed prompt', async () => {
    const { session } = setup(2);
    await session.load();
    expect(session.contentChanged()).toBe(true);
    expect(session.loaded()).toBe(false);
    expect(session.active()).toBeNull();
    expect(session.error()).toContain('Copy it, then reopen');
    session.dispose();
  });

  it('retains the draft after a save-time content change and never retries with a newer version', async () => {
    const { api, session } = setup();
    await session.load();
    api.commandSaveWritingFeedback.mockRejectedValueOnce(new ApiError('changed', 409, 'WRITING_FEEDBACK_CONTENT_CHANGED'));
    expect(await session.save('My draft.', '')).toBeNull();
    expect(session.contentChanged()).toBe(true);
    expect(await session.save('My draft.', '')).toBeNull();
    expect(api.commandSaveWritingFeedback).toHaveBeenCalledOnce();
    session.dispose();
  });
});
