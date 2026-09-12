import { ChangeDetectionStrategy, Component, effect, OnDestroy, signal } from '@angular/core';
import { Subject } from 'rxjs';
import { VocoPrimaryButtonComponent, VocoSecondaryButtonComponent } from '../../../../voco-button';
import type { AdaptiveConversationController, AdaptiveConversationControllerFactory } from '../../../adaptive-conversation-contracts';
import type { SlideContentComponent, SlideContentContext } from '../../../slide-content-contracts';
import type { SlideContentEvent } from '../../../slide-content-contracts';
import type { SlideExerciseRuntimeState } from '../../../slide-exercise.models';
import type { AdaptiveConversationSlideData } from '../../slide-library.models';
import { parseAdaptiveConversation } from './adaptive-conversation.definition';

@Component({
  selector: 'app-adaptive-conversation-slide', standalone: true,
  imports: [VocoPrimaryButtonComponent, VocoSecondaryButtonComponent],
  templateUrl: './adaptive-conversation-slide.component.html', styleUrl: '../../slide-library.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdaptiveConversationSlideComponent implements SlideContentComponent, OnDestroy {
  private readonly events = new Subject<SlideContentEvent>();
  private readonly states = new Subject<SlideExerciseRuntimeState>();
  readonly event = this.events.asObservable();
  readonly stateChange = this.states.asObservable();
  readonly content = signal<AdaptiveConversationSlideData | null>(null);
  readonly controller = signal<AdaptiveConversationController | null>(null);
  private emittedReceipt = '';

  constructor() {
    effect(() => {
      const session = this.controller()?.session();
      const receipt = session?.completionEvidenceId;
      if (session?.status !== 'completed' || !receipt || this.emittedReceipt === receipt) return;
      this.emittedReceipt = receipt;
      this.states.next({ chrome: { footer: { tone: 'information', title: 'Conversation practice saved',
        detail: 'Your completed practice is saved. No IELTS score or mastery result is recorded.',
        primary: { id: 'continue', label: 'Continue', behavior: 'next', disabled: false },
      } } });
      this.events.next({ type: 'submitted', data: { conversationEvidenceId: receipt } });
    });
  }

  load(context: SlideContentContext): void {
    const data = parseAdaptiveConversation(context.data);
    this.controller()?.dispose(); this.controller.set(null); this.emittedReceipt = ''; this.content.set(data);
    this.states.next({ chrome: { footer: { tone: 'neutral', title: '', detail: '', primary: false } } });
    const environment = context.environment as { adaptiveConversation?: AdaptiveConversationControllerFactory } | undefined;
    if (typeof environment?.adaptiveConversation !== 'function') return;
    const controller = environment.adaptiveConversation(context.slideId);
    this.controller.set(controller); void controller.load();
  }
  ngOnDestroy(): void {
    this.controller()?.dispose(); this.controller.set(null); this.events.complete(); this.states.complete();
  }
}
