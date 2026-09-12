import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { describe, expect, it, vi } from 'vitest';
import { VocabularyIntakeFacade } from '../../../../application/collection-learning-path/vocabulary-intake.facade';
import type { ExerciseContextView } from '../../../../domain/collection-learning-path/learning-path';
import { ExerciseHostComponent } from './exercise-host.component';
import { CollectionLearningPathApiService } from '../../../../core/collection-learning-path/collection-learning-path-api.service';
import { WritingResponseSlideComponent } from '../../../../shared/slide-exercise/library/components/writing-response/writing-response-slide.component';
import { AdaptiveConversationSlideComponent } from '../../../../shared/slide-exercise/library/components/adaptive-conversation/adaptive-conversation-slide.component';
import { AdaptiveConversationApiService } from '../../../../core/adaptive-conversation/adaptive-conversation-api.service';

function context(type = 'vocabulary.intake'): ExerciseContextView {
  return {
    path: { id: 'path-1', collectionId: 'collection-1', title: 'Course', mode: 'finite', contentVersion: '1' },
    lesson: { id: 'lesson-1', title: 'Lesson 1', position: 1 },
    exercise: {
      id: 'exercise-1', position: 1, type, schemaVersion: 1, required: true,
      completionPolicy: type === 'vocabulary.intake' ? 'vocabulary-intake' : 'explicit',
      config: type === 'vocabulary.intake' ? { scope: { kind: 'listening-episode', ref: 'episode-1' } } : {},
    },
    progress: null,
    state: 'in_progress',
    payload: type === 'vocabulary.intake' ? {
      scope: { kind: 'listening-episode', ref: 'episode-1' },
      items: [{ id: 'v-1', term: 'word', definitions: [], examples: [], progress: { state: 'new', box: 0 } }],
      summary: { total: 1, newCount: 1, learningCount: 0, masteredCount: 0, excludedCount: 0 },
    } : null,
  };
}

describe('ExerciseHostComponent', () => {
  it('binds conversation to the displayed version and starts the exercise before allocating a session', async () => {
    const history = vi.fn().mockResolvedValue({ pathContentVersion: 1, currentContentVersion: 'task-v1', availability: { enabled: true }, sessions: [] });
    const start = vi.fn().mockRejectedValue(new Error('Provider unavailable.'));
    TestBed.configureTestingModule({ imports: [ExerciseHostComponent], providers: [
      { provide: CollectionLearningPathApiService, useValue: {} }, { provide: AdaptiveConversationApiService, useValue: { history, start } },
    ] });
    const fixture = TestBed.createComponent(ExerciseHostComponent);
    let started!: (value: boolean) => void;
    const ensureStarted = vi.fn(() => new Promise<boolean>(resolve => { started = resolve; }));
    const conversation = context('slides.sequence'); conversation.exercise.completionPolicy = 'slide-sequence';
    conversation.exercise.config = { slides: [
      { id: 'conversation-slide', type: 'adaptive-conversation', data: { mode: 'guided-dialogue', goal: 'Talk about meals.', openingPrompt: 'What do you eat?', learnerLevel: 'beginner', minimumTurns: 2, maximumTurns: 3, responseSeconds: 5, questionConstraints: { maximumWords: 14, oneQuestionOnly: true, avoidAnswerDisclosure: true } } },
      { id: 'summary', type: 'summary', terminal: true, data: {} },
    ] };
    fixture.componentRef.setInput('context', conversation); fixture.componentRef.setInput('ensureStarted', ensureStarted); fixture.detectChanges();
    await vi.waitFor(() => expect(history).toHaveBeenCalled()); await fixture.whenStable(); fixture.detectChanges();
    const component = fixture.debugElement.query(By.directive(AdaptiveConversationSlideComponent)).componentInstance as AdaptiveConversationSlideComponent;
    const command = component.controller()!.start(); expect(ensureStarted).toHaveBeenCalledOnce(); expect(start).not.toHaveBeenCalled();
    started(true); await command;
    expect(start).toHaveBeenCalledWith({ pathId: 'path-1', lessonId: 'lesson-1', exerciseId: 'exercise-1', slideId: 'conversation-slide', expectedPathContentVersion: 1 }, expect.any(String));
    expect(component.controller()?.session()).toBeNull();
  });

  it('binds generic writing to the displayed task version and waits for exercise start before saving', async () => {
    const history = vi.fn().mockResolvedValue({ pathContentVersion: 1, currentContentVersion: 'task-v1', availability: { enabled: false, maxCharacters: 2000, maxWords: 80 }, submissions: [] });
    const save = vi.fn().mockResolvedValue({ id: 'draft-1', status: 'unavailable', draftText: 'I eat bread.', notes: '', parentSubmissionId: null, contentVersion: 'task-v1', errorCode: 'WRITING_FEEDBACK_DISABLED' });
    TestBed.configureTestingModule({
      imports: [ExerciseHostComponent],
      providers: [{ provide: CollectionLearningPathApiService, useValue: { queryWritingFeedbackHistory: history, commandSaveWritingFeedback: save } }],
    });
    const fixture = TestBed.createComponent(ExerciseHostComponent);
    let started!: (value: boolean) => void;
    const ensureStarted = vi.fn(() => new Promise<boolean>((resolve) => { started = resolve; }));
    const writing = context('slides.sequence');
    writing.exercise.completionPolicy = 'slide-sequence';
    writing.exercise.config = { slides: [
      { id: 'writing-slide', type: 'writing-response', data: { mode: 'sentence', prompt: 'Describe breakfast.', writingFeedback: { schemaVersion: 1, learnerLevel: 'A1', targetSkill: 'Personal writing', languageObjectives: ['Present simple'], taskExpectations: ['Describe a meal'] } } },
      { id: 'summary', type: 'summary', terminal: true, data: {} },
    ] };
    fixture.componentRef.setInput('context', writing);
    fixture.componentRef.setInput('ensureStarted', ensureStarted);
    fixture.detectChanges();
    await vi.waitFor(() => expect(history).toHaveBeenCalledWith('path-1', 'lesson-1', 'exercise-1', 'writing-slide'));
    await fixture.whenStable();
    fixture.detectChanges();
    const component = fixture.debugElement.query(By.directive(WritingResponseSlideComponent)).componentInstance as WritingResponseSlideComponent;
    component.setResponse('I eat bread.');
    component.handleAction('submit');
    expect(ensureStarted).toHaveBeenCalledOnce();
    expect(save).not.toHaveBeenCalled();
    started(true);
    await vi.waitFor(() => expect(save).toHaveBeenCalledWith('path-1', 'lesson-1', 'exercise-1', 'writing-slide', {
      draftText: 'I eat bread.', notes: '', idempotencyKey: expect.any(String), expectedPathContentVersion: 1,
    }));
  });

  it('creates the registered vocabulary intake renderer from the generic host', async () => {
    TestBed.configureTestingModule({
      imports: [ExerciseHostComponent],
      providers: [{ provide: VocabularyIntakeFacade, useValue: { activate: vi.fn() } }],
    });
    const fixture = TestBed.createComponent(ExerciseHostComponent);
    fixture.componentRef.setInput('context', context());
    fixture.detectChanges();
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).querySelector('[data-testid="vocabulary-intake"]')).not.toBeNull();
  });

  it('renders the explicit unsupported state for unknown exercise types', async () => {
    TestBed.configureTestingModule({
      imports: [ExerciseHostComponent],
      providers: [{ provide: VocabularyIntakeFacade, useValue: { activate: vi.fn() } }],
    });
    const fixture = TestBed.createComponent(ExerciseHostComponent);
    fixture.componentRef.setInput('context', context('future.exercise'));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent).toContain('future.exercise');
  });

  it('reports a button interaction as engagement', async () => {
    TestBed.configureTestingModule({
      imports: [ExerciseHostComponent],
      providers: [{ provide: VocabularyIntakeFacade, useValue: { activate: vi.fn() } }],
    });
    const fixture = TestBed.createComponent(ExerciseHostComponent);
    fixture.componentRef.setInput('context', context());
    const engaged = vi.fn();
    fixture.componentInstance.engaged.subscribe(engaged);
    fixture.detectChanges();
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();

    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('.intake__primary')?.click();

    expect(engaged).toHaveBeenCalledTimes(1);
  });

  it.each([
    'slide-exercise-header__close',
    'slide-exercise__guide-action',
    'slide-exercise-action--guide-return',
  ])('does not report %s wrapper interactions as engagement', (excludedClass) => {
    const fixture = TestBed.createComponent(ExerciseHostComponent);
    const engaged = vi.fn();
    fixture.componentInstance.engaged.subscribe(engaged);
    const wrapper = document.createElement('voco-icon-button');
    wrapper.className = excludedClass;
    const button = document.createElement('button');
    wrapper.append(button);

    fixture.componentInstance.onClick({ target: button } as unknown as MouseEvent);

    expect(engaged).not.toHaveBeenCalled();
  });
});
