import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import type { WritingFeedbackController, WritingSubmission } from '../../../writing-feedback-contracts';
import type { SlideExerciseRuntimeState } from '../../../slide-exercise.models';
import { WritingResponseSlideComponent } from './writing-response-slide.component';

const metadata = { schemaVersion: 1, learnerLevel: 'A1', targetSkill: 'Simple personal writing', languageObjectives: ['Present simple'], taskExpectations: ['Describe breakfast'] };
function saved(overrides: Partial<WritingSubmission> = {}): WritingSubmission {
  return { id: 'first', status: 'unavailable', draftText: '  I eat bread.  ', notes: 'Breakfast.', parentSubmissionId: null,
    createdAt: '2026-09-12T00:00:00Z', updatedAt: '2026-09-12T00:00:00Z', expiresAt: '2026-10-12T00:00:00Z',
    feedback: null, errorCode: 'WRITING_FEEDBACK_DISABLED', attemptCount: 0, contentVersion: 'v1', ...overrides };
}
async function setup(history: readonly WritingSubmission[] = []) {
  const controller = {
    contentChanged: signal(false), currentContentVersion: signal('v1'), loading: signal(false), loaded: signal(true), busy: signal(false), error: signal(''), pollingPaused: signal(false),
    availability: signal({ enabled: false, maxCharacters: 2000, maxWords: 80 }), submissions: signal(history),
    active: signal(history[0] ?? null), load: vi.fn().mockResolvedValue(undefined), save: vi.fn(), check: vi.fn(),
    retry: vi.fn(), cancel: vi.fn(), select: vi.fn(), dispose: vi.fn(),
  } satisfies WritingFeedbackController;
  const fixture = TestBed.createComponent(WritingResponseSlideComponent);
  const events = vi.fn();
  fixture.componentInstance.event.subscribe(events);
  fixture.componentInstance.load({ slideId: 'writing-1', type: 'writing-response',
    data: { mode: 'paragraph', prompt: 'Write 20–40 words about one meal.', recommendedMinimumWords: 20, wordLimit: 40, planningNotes: true, writingFeedback: metadata },
    environment: { writingFeedback: () => controller },
  });
  fixture.detectChanges();
  await Promise.resolve();
  await Promise.resolve();
  fixture.detectChanges();
  return { fixture, component: fixture.componentInstance, controller, events };
}

describe('Writing response formative feedback', () => {
  it('shows the authored word target separately from the feedback cap and still saves a longer draft', async () => {
    const { fixture, component, controller, events } = await setup();
    expect(fixture.nativeElement.textContent).toContain('Aim for up to 40 words.');
    expect(fixture.nativeElement.textContent).toContain('Feedback supports up to 80 words.');
    const draftText = Array.from({ length: 41 }, () => 'food').join(' ');
    component.setResponse(draftText);
    controller.save.mockResolvedValueOnce(saved({ draftText, notes: '' }));
    component.handleAction('submit');
    await Promise.resolve();
    expect(controller.save).toHaveBeenCalledWith(draftText, '');
    expect(events).toHaveBeenCalledExactlyOnceWith({ type: 'submitted', data: expect.objectContaining({ response: draftText }) });
  });

  it('emits saved participation only after the immutable draft is acknowledged, even with feedback off', async () => {
    const { fixture, component, controller, events } = await setup();
    const states: SlideExerciseRuntimeState[] = [];
    component.stateChange.subscribe((state) => states.push(state));
    component.setResponse('  I eat bread.  ');
    component.notes.set('Breakfast.');
    let acknowledge!: (value: WritingSubmission) => void;
    controller.save.mockImplementationOnce(() => new Promise((resolve) => { acknowledge = resolve; }));
    component.handleAction('submit');
    expect(events).not.toHaveBeenCalled();
    expect(controller.save).toHaveBeenCalledWith('  I eat bread.  ', 'Breakfast.');
    acknowledge(saved());
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();
    expect(events).toHaveBeenCalledExactlyOnceWith({ type: 'submitted', data: expect.objectContaining({ response: '  I eat bread.  ', notes: 'Breakfast.' }) });
    expect(component.interactionState()).toBe('revealed');
    expect(states.at(-1)?.chrome?.footer?.primary).toMatchObject({ id: 'continue', behavior: 'next', disabled: false });
    expect(fixture.nativeElement.textContent).not.toContain('mastered');
  });

  it('retains the attempted draft after a save error and prevents edits from replacing the pending original', async () => {
    const { component, controller, events } = await setup();
    component.setResponse('  I eat bread.  ');
    controller.save.mockResolvedValueOnce(null).mockResolvedValueOnce(saved({ notes: '' }));
    component.handleAction('submit');
    await Promise.resolve();
    component.setResponse('A different answer.');
    expect(component.response()).toBe('  I eat bread.  ');
    expect(events).not.toHaveBeenCalled();
    component.handleAction('submit');
    await Promise.resolve();
    expect(controller.save).toHaveBeenNthCalledWith(2, '  I eat bread.  ', '');
  });

  it('restores the original independently from a later revision without emitting revision mastery', async () => {
    const first = saved();
    const revision = saved({ id: 'revision', parentSubmissionId: first.id, draftText: 'I eat bread and drink water.' });
    const { component, events } = await setup([revision, first]);
    expect(component.response()).toBe(first.draftText);
    expect(events).toHaveBeenCalledExactlyOnceWith({ type: 'submitted', data: expect.objectContaining({ response: first.draftText }) });
  });

  it('keeps locally typed text as a separate revision when history recovery finds the original', async () => {
    const { component, controller } = await setup();
    component.setResponse('My local text must not disappear.');
    component.notes.set('My local notes.');
    const first = saved();
    controller.submissions.set([first]);
    controller.active.set(first);
    await component.reloadFeedback();
    expect(component.response()).toBe(first.draftText);
    expect(component.revisionText()).toBe('My local text must not disappear.');
    expect(component.revisionNotes()).toBe('My local notes.');
    expect(component.revising()).toBe(true);
  });

  it('allows explicit normal submission after optional draft storage fails without claiming a durable save', async () => {
    const { component, controller, events } = await setup();
    const states = vi.fn();
    component.stateChange.subscribe(states);
    component.setResponse('My response is still here.');
    controller.save.mockResolvedValueOnce(null);
    component.handleAction('submit');
    await Promise.resolve();
    controller.error.set('Feedback storage is unavailable.');
    component.submitWithoutFeedback();
    expect(events).toHaveBeenCalledExactlyOnceWith({ type: 'submitted', data: expect.objectContaining({ response: 'My response is still here.' }) });
    expect(states).toHaveBeenLastCalledWith(expect.objectContaining({ chrome: { footer: {
      tone: 'information', title: 'Response ready', detail: 'Finish this exercise to save your response. Feedback is unavailable.',
      primary: { id: 'continue', label: 'Continue', behavior: 'next', disabled: false },
    } } }));
    expect(controller.dispose).toHaveBeenCalledOnce();
  });

  it('does not auto-submit archived drafts or use the optional fallback after a content change', async () => {
    const archived = saved({ contentVersion: 'old-task' });
    const { component, controller, events } = await setup([archived]);
    expect(component.response()).toBe('');
    expect(events).not.toHaveBeenCalled();
    component.startRevision();
    expect(component.revising()).toBe(false);
    component.setResponse('A new answer.');
    controller.contentChanged.set(true);
    controller.error.set('The lesson changed.');
    component.submitWithoutFeedback();
    expect(events).not.toHaveBeenCalled();
  });

  it('renders model output as text and creates an independent revision from selected Unicode edits', async () => {
    const first = saved({ draftText: '😀 I go.', status: 'completed', feedback: {
      schema_version: 1, assessment_status: 'feedback_available', abstention_reason: null, task_relevance: 'on_topic',
      task_comment: '<img src=x onerror=alert(1)>', revision_actions: ['Use the past form.'], not_assessed: ['ielts_band'], ielts_band: null,
      issues: [{ category: 'grammar', kind: 'error', quoted_text: 'go', occurrence: 1, replacement: 'went', explanation: '<script>bad()</script>', span: { start: 4, end: 6, indexing: 'unicode-code-points' } }],
    } });
    const { fixture, component, controller, events } = await setup([first]);
    expect(fixture.nativeElement.querySelector('script')).toBeNull();
    expect(fixture.nativeElement.querySelector('img')).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('<img src=x onerror=alert(1)>');
    component.selectEdit(0, true);
    expect(component.preview()).toBe('😀 I went.');
    component.startRevision();
    expect(component.revisionText()).toBe('😀 I went.');
    controller.save.mockResolvedValueOnce(saved({ id: 'revision', parentSubmissionId: first.id, draftText: '😀 I went.' }));
    await component.saveRevision();
    expect(controller.save).toHaveBeenCalledWith('😀 I went.', '', first.id);
    expect(component.response()).toBe('😀 I go.');
    expect(events).toHaveBeenCalledOnce();
  });

  it('shows unassessed task and source limits even when formative feedback is available', async () => {
    const first = saved({ status: 'completed', feedback: {
      schema_version: 1, assessment_status: 'feedback_available', abstention_reason: null, task_relevance: 'on_topic',
      task_comment: 'The sentences are understandable.', issues: [], revision_actions: ['Read your response again.'],
      not_assessed: ['ielts_band', 'task_coverage', 'source_fidelity'], ielts_band: null,
    } });
    const { fixture } = await setup([first]);
    expect(fixture.nativeElement.textContent).toContain('Formative feedback is available.');
    expect(fixture.nativeElement.textContent).toContain('Task requirements were not assessed.');
    expect(fixture.nativeElement.textContent).toContain('Accuracy against the source was not assessed.');
    expect(fixture.nativeElement.textContent).toContain('No IELTS score is given.');
  });
});
