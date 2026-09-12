import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ComponentRef,
  EventEmitter,
  Input,
  Injector,
  OnChanges,
  OnDestroy,
  OnInit,
  Output,
  SimpleChanges,
  ViewChild,
  ViewContainerRef,
  inject,
} from '@angular/core';
import { Subscription } from 'rxjs';
import type { ExerciseContextView } from '../../../../domain/collection-learning-path/learning-path';
import type { ExerciseComponent, ExerciseContext, ExerciseOutcome } from './exercise-contracts';
import { createLearningPathExerciseRegistry } from './learning-path-exercise-registry';
import { UnsupportedExerciseComponent } from './unsupported-exercise.component';
import { WritingFeedbackService } from '../../../../core/writing-feedback/writing-feedback.service';
import type { WritingFeedbackControllerFactory } from '../../../../shared/slide-exercise/writing-feedback-contracts';
import { AdaptiveConversationService } from '../../../../core/adaptive-conversation/adaptive-conversation.service';
import type { AdaptiveConversationControllerFactory } from '../../../../shared/slide-exercise/adaptive-conversation-contracts';

function runtimeContext(
  context: ExerciseContextView,
  ensureStarted?: () => Promise<boolean>,
  writingFeedback?: WritingFeedbackControllerFactory,
  adaptiveConversation?: AdaptiveConversationControllerFactory,
): ExerciseContext {
  return {
    pathId: context.path.id,
    lessonId: context.lesson.id,
    exerciseId: context.exercise.id,
    type: context.exercise.type,
    schemaVersion: context.exercise.schemaVersion,
    completionPolicy: context.exercise.completionPolicy,
    state: context.state,
    config: context.exercise.config,
    payload: context.payload,
    ensureStarted,
    writingFeedback,
    adaptiveConversation,
  };
}

@Component({
  selector: 'app-learning-path-exercise-host',
  standalone: true,
  imports: [UnsupportedExerciseComponent],
  templateUrl: './exercise-host.component.html',
  styleUrl: './exercise-host.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ExerciseHostComponent implements OnInit, OnChanges, OnDestroy {
  @Input({ required: true }) context!: ExerciseContextView;
  @Input() ensureStarted?: () => Promise<boolean>;
  @Output() readonly engaged = new EventEmitter<void>();
  @Output() readonly outcome = new EventEmitter<ExerciseOutcome>();
  @ViewChild('outlet', { read: ViewContainerRef, static: true }) private outlet!: ViewContainerRef;

  unsupportedType = '';
  rendererLoadFailed = false;
  rendererLoading = false;
  private readonly changeDetector = inject(ChangeDetectorRef);
  private readonly injector = inject(Injector);
  private readonly registry = createLearningPathExerciseRegistry();
  private componentRef: ComponentRef<ExerciseComponent> | null = null;
  private outcomeSubscription: Subscription | null = null;
  private initialized = false;
  private renderVersion = 0;

  ngOnInit(): void {
    this.initialized = true;
    void this.render();
  }

  ngOnChanges(_changes: SimpleChanges): void {
    if (this.initialized) void this.render();
  }

  ngOnDestroy(): void {
    this.renderVersion += 1;
    this.disposeRenderer();
  }

  retryRenderer(): void {
    void this.render();
  }

  onInteraction(): void {
    this.engaged.emit();
  }

  onClick(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest(
      '.slide-exercise-header__close, .slide-exercise__guide-action, .slide-exercise-action--guide-return',
    )) return;
    const control = target.closest('button, [role="button"]');
    if (!control) return;
    this.onInteraction();
  }

  private async render(): Promise<void> {
    const version = ++this.renderVersion;
    this.disposeRenderer();
    this.rendererLoadFailed = false;
    this.rendererLoading = false;
    const loader = this.registry.resolve(this.context.exercise.type);
    if (!loader) {
      this.unsupportedType = this.context.exercise.type;
      return;
    }
    this.unsupportedType = '';
    this.rendererLoading = true;
    this.changeDetector.markForCheck();
    try {
      const renderer = await loader();
      if (version !== this.renderVersion) return;
      this.componentRef = this.outlet.createComponent(renderer);
      const context = this.context;
      const ensureStarted = this.ensureStarted;
      this.componentRef.instance.load(runtimeContext(context, ensureStarted, (slideId) =>
        this.injector.get(WritingFeedbackService).create({
          pathId: context.path.id, lessonId: context.lesson.id, exerciseId: context.exercise.id, slideId,
          expectedPathContentVersion: Number(context.path.contentVersion),
        }, ensureStarted),
        (slideId) => this.injector.get(AdaptiveConversationService).create({
          pathId: context.path.id, lessonId: context.lesson.id, exerciseId: context.exercise.id, slideId,
          expectedPathContentVersion: Number(context.path.contentVersion),
        }, ensureStarted),
      ));
      this.outcomeSubscription = this.componentRef.instance.outcome.subscribe((outcome) => this.outcome.emit(outcome));
      this.rendererLoading = false;
      this.changeDetector.markForCheck();
    } catch {
      if (version !== this.renderVersion) return;
      this.rendererLoading = false;
      this.rendererLoadFailed = true;
      this.changeDetector.markForCheck();
    }
  }

  private disposeRenderer(): void {
    this.outcomeSubscription?.unsubscribe();
    this.outcomeSubscription = null;
    this.outlet?.clear();
    this.componentRef = null;
  }
}
