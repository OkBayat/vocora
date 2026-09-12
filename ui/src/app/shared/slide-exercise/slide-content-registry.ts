import type { Type } from '@angular/core';
import type { SlideContentComponent } from './slide-content-contracts';
import { REUSABLE_SLIDE_TYPES } from './library/slide-library.models';
import type { SlideExerciseChromeConfig } from './slide-exercise.models';

export type SlideContentComponentLoader = () => Promise<Type<SlideContentComponent>>;

export interface SlideContentRenderer {
  readonly type: string;
  readonly loadComponent: SlideContentComponentLoader;
  readonly chromeDefaults?: SlideExerciseChromeConfig;
}

export class SlideContentRegistry {
  private readonly renderers = new Map<string, SlideContentRenderer>();

  register(renderer: SlideContentRenderer): void {
    const type = renderer.type.trim();
    if (!type) throw new Error('Slide content renderer type is required.');
    if (this.renderers.has(type)) throw new Error(`Slide content renderer already registered: ${type}`);
    this.renderers.set(type, { ...renderer, type });
  }

  resolve(type: string): SlideContentRenderer | undefined {
    return this.renderers.get(type.trim());
  }

  registeredTypes(): readonly string[] {
    return [...this.renderers.keys()];
  }
}

export function createDefaultSlideContentRegistry(): SlideContentRegistry {
  const registry = new SlideContentRegistry();
  registry.register({
    type: 'message',
    loadComponent: () => import('./content/message-slide-content.component')
      .then((module) => module.MessageSlideContentComponent),
  });
  registry.register({
    type: 'summary',
    chromeDefaults: { header: { visible: false } },
    loadComponent: () => import('./content/summary-slide-content.component')
      .then((module) => module.SummarySlideContentComponent),
  });
  const component = () => import('./library/slide-library.components');
  const scoredDefaults = {
    footer: { primary: { id: 'check', label: 'Check', behavior: 'content' as const, disabled: true } },
  };
  const submittedDefaults = {
    footer: { primary: { id: 'submit', label: 'Submit', behavior: 'content' as const, disabled: true } },
  };
  const selectionDefaults = {
    footer: { primary: { id: 'continue', label: 'Continue', behavior: 'content' as const, disabled: true } },
  };
  registry.register({ type: 'teaching-card', loadComponent: () => component().then((module) => module.TeachingCardSlideComponent) });
  registry.register({ type: 'selection', chromeDefaults: selectionDefaults, loadComponent: () => component().then((module) => module.SelectionSlideComponent) });
  registry.register({ type: 'number-input', chromeDefaults: selectionDefaults, loadComponent: () => component().then((module) => module.NumberInputSlideComponent) });
  registry.register({ type: 'choice', chromeDefaults: scoredDefaults, loadComponent: () => component().then((module) => module.ChoiceSlideComponent) });
  registry.register({ type: 'truth', chromeDefaults: scoredDefaults, loadComponent: () => component().then((module) => module.TruthSlideComponent) });
  registry.register({ type: 'matching', chromeDefaults: scoredDefaults, loadComponent: () => component().then((module) => module.MatchingSlideComponent) });
  registry.register({ type: 'classification', chromeDefaults: scoredDefaults, loadComponent: () => component().then((module) => module.ClassificationSlideComponent) });
  registry.register({ type: 'ordering', chromeDefaults: { footer: { primary: { id: 'check', label: 'Check', behavior: 'content', disabled: false } } }, loadComponent: () => component().then((module) => module.OrderingSlideComponent) });
  registry.register({ type: 'labeling', chromeDefaults: scoredDefaults, loadComponent: () => component().then((module) => module.LabelingSlideComponent) });
  registry.register({ type: 'cloze', chromeDefaults: scoredDefaults, loadComponent: () => component().then((module) => module.ClozeSlideComponent) });
  registry.register({ type: 'structured-completion', chromeDefaults: scoredDefaults, loadComponent: () => component().then((module) => module.StructuredCompletionSlideComponent) });
  registry.register({ type: 'short-answer', chromeDefaults: scoredDefaults, loadComponent: () => component().then((module) => module.ShortAnswerSlideComponent) });
  registry.register({ type: 'word-formation', chromeDefaults: scoredDefaults, loadComponent: () => component().then((module) => module.WordFormationSlideComponent) });
  registry.register({ type: 'error-correction', chromeDefaults: scoredDefaults, loadComponent: () => component().then((module) => module.ErrorCorrectionSlideComponent) });
  registry.register({ type: 'rewrite', chromeDefaults: scoredDefaults, loadComponent: () => component().then((module) => module.RewriteSlideComponent) });
  registry.register({ type: 'pronunciation', chromeDefaults: scoredDefaults, loadComponent: () => component().then((module) => module.PronunciationSlideComponent) });
  registry.register({ type: 'dictation', chromeDefaults: scoredDefaults, loadComponent: () => component().then((module) => module.DictationSlideComponent) });
  registry.register({ type: 'speaking-response', chromeDefaults: submittedDefaults, loadComponent: () => component().then((module) => module.SpeakingResponseSlideComponent) });
  registry.register({ type: 'writing-response', chromeDefaults: submittedDefaults, loadComponent: () => component().then((module) => module.WritingResponseSlideComponent) });
  registry.register({ type: 'adaptive-conversation', chromeDefaults: { footer: { primary: false } }, loadComponent: () => component().then((module) => module.AdaptiveConversationSlideComponent) });
  if (!REUSABLE_SLIDE_TYPES.every((type) => registry.resolve(type))) throw new Error('Reusable slide registry is incomplete.');
  return registry;
}
