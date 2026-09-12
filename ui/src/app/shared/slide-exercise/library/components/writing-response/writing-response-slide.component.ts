import {
	ChangeDetectionStrategy,
	Component,
	OnDestroy,
	signal,
} from '@angular/core';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatSelectModule } from '@angular/material/select';
import { VocoPrimaryButtonComponent, VocoSecondaryButtonComponent } from '../../../../voco-button';
import type { WritingFeedbackController, WritingFeedbackControllerFactory, WritingSubmission } from '../../../writing-feedback-contracts';
import { parseWritingFeedback, selectedWritingPreview, writingStatusMessage } from './writing-feedback.utils';
import { MatChipsModule } from '@angular/material/chips';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import type {
	SlideContentComponent,
	SlideContentContext,
} from '../../../slide-content-contracts';
import { ScoredSlideBase } from '../../scored-slide.base';
import type { WritingResponseSlideData } from '../../slide-library.models';
import { SlideStimulusComponent } from '../../slide-stimulus.component';
import {
	common,
	inputValue,
	stringMode,
} from '../../slide-library.component-support';
import {
	record,
	requiredText,
	strings,
	text,
	wordCount,
} from '../../slide-library.utils';

function parseWriting(value: unknown): WritingResponseSlideData {
	const source = record(value);
	const timerSeconds = Number(source['timerSeconds']);
	const minimum = Number(source['recommendedMinimumWords']);
	const wordLimit = source['wordLimit'];
	const writingFeedback = parseWritingFeedback(source['writingFeedback']);
	if (writingFeedback && !['sentence', 'paragraph'].includes(String(source['mode'] ?? 'sentence'))) {
		throw new Error('Writing feedback supports sentence and paragraph responses.');
	}
	return {
		...common(source),
		writingFeedback,
		wordLimit: typeof wordLimit === 'number' && Number.isInteger(wordLimit) && wordLimit > 0 ? wordLimit : undefined,
		mode: stringMode(
			source['mode'],
			[
				'sentence',
				'paragraph',
				'task1-chart',
				'task1-process',
				'task2-essay',
				'general-letter',
			] as const,
			'sentence',
		),
		prompt: requiredText(source['prompt'], 'Writing prompt'),
		timerSeconds:
			Number.isInteger(timerSeconds) && timerSeconds > 0
				? timerSeconds
				: undefined,
		recommendedMinimumWords:
			Number.isInteger(minimum) && minimum > 0 ? minimum : undefined,
		targetVocabulary: strings(source['targetVocabulary']),
		planningNotes: source['planningNotes'] === true,
		modelAnswer: text(source['modelAnswer']) || undefined,
		register: stringMode(
			source['register'],
			['formal', 'informal', 'neutral'] as const,
			'neutral',
		),
	};
}

@Component({
	selector: 'app-writing-response-slide',
	standalone: true,
	imports: [
		MatChipsModule,
		MatCheckboxModule,
		MatSelectModule,
		VocoPrimaryButtonComponent,
		VocoSecondaryButtonComponent,
		MatFormFieldModule,
		MatInputModule,
		SlideStimulusComponent,
	],
	templateUrl: './writing-response-slide.component.html',
	styleUrl: '../../slide-library.component.scss',
	changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WritingResponseSlideComponent
	extends ScoredSlideBase<WritingResponseSlideData>
	implements SlideContentComponent, OnDestroy
{
	private timer: ReturnType<typeof setInterval> | null = null;
	readonly response = signal('');
	readonly notes = signal('');
	readonly remainingSeconds = signal(0);
	readonly feedback = signal<WritingFeedbackController | null>(null);
	readonly original = signal<WritingSubmission | null>(null);
	readonly revising = signal(false);
	readonly recoveredLocalDraft = signal(false);
	readonly revisionText = signal('');
	readonly revisionNotes = signal('');
	readonly selectedEdits = signal<readonly number[]>([]);
	readonly statusMessage = writingStatusMessage;
	private generation = 0;
	private originalAttempted = false;
	private revisionAttempted = false;
	private saveInFlight = false;
	private revisionParentId = '';
	private feedbackConfigured = false;
	inputFrom(event: Event): string {
		return inputValue(event);
	}
	wordCount(): number {
		return wordCount(this.response());
	}
	load(context: SlideContentContext): void {
		const data = parseWriting(context.data);
		this.feedback()?.dispose();
		this.generation += 1;
		this.feedback.set(null);
		this.original.set(null);
		this.revising.set(false);
		this.recoveredLocalDraft.set(false);
		this.selectedEdits.set([]);
		this.originalAttempted = false;
		this.revisionAttempted = false;
		this.saveInFlight = false;
		this.feedbackConfigured = Boolean(data.writingFeedback);
		this.clearTimer();
		this.begin(context.slideId, data, 'submit');
		this.response.set('');
		this.notes.set('');
		this.remainingSeconds.set(data.timerSeconds ?? 0);
		if (data.writingFeedback) {
			const environment = context.environment as { writingFeedback?: WritingFeedbackControllerFactory } | undefined;
			if (typeof environment?.writingFeedback !== 'function') {
				this.stateChanges.next({ chrome: { footer: { tone: 'information', title: 'Writing unavailable', detail: 'This exercise needs a saved writing session. Open it from its learning path.' } } });
				return;
			}
			const controller = environment.writingFeedback(context.slideId);
			this.feedback.set(controller);
			void this.restoreFeedback(controller, this.generation);
		}
		if (data.timerSeconds)
			this.timer = setInterval(() => {
				this.remainingSeconds.update((value) => Math.max(0, value - 1));
				if (!this.remainingSeconds()) this.clearTimer();
			}, 1000);
	}
	setResponse(value: string): void {
		if (this.originalLocked()) return;
		this.response.set(value);
		this.updateReady();
	}
	setNotes(value: string): void {
		if (this.originalLocked()) return;
		this.notes.set(value);
		this.updateReady();
	}
	originalLocked(): boolean {
		return this.interactionState() !== 'idle' || this.originalAttempted || Boolean(this.feedback()?.loading());
	}
	writingWordTarget(): number {
		return this.data().wordLimit ?? this.feedback()?.availability().maxWords ?? 80;
	}
	handleAction(actionId: string): void {
		if (actionId !== 'submit' || this.interactionState() !== 'idle' || !this.response().trim() || this.saveInFlight) return;
		if (this.feedbackConfigured) {
			const controller = this.feedback();
			if (!controller?.loaded() || controller.contentChanged()) return;
			void this.saveOriginal(controller);
			return;
		}
		this.clearTimer();
		this.emitOriginal(this.response(), this.notes());
	}
	submitWithoutFeedback(): void {
		const controller = this.feedback();
		if (!controller?.error() || controller.contentChanged() || controller.busy() || controller.loading() || this.saveInFlight || this.interactionState() !== 'idle' || !this.response().trim()) return;
		controller.dispose();
		this.clearTimer();
		this.emitOriginal(this.response(), this.notes(), false);
	}
	async reloadFeedback(): Promise<void> {
		const controller = this.feedback();
		if (controller) await this.restoreFeedback(controller, this.generation);
	}
	preview(): string {
		const active = this.feedback()?.active();
		return active ? selectedWritingPreview(active.draftText, active.feedback?.issues ?? [], this.selectedEdits()) : '';
	}
	selectEdit(index: number, selected: boolean): void {
		if (this.revising()) return;
		this.selectedEdits.update((indices) => selected ? [...new Set([...indices, index])] : indices.filter((item) => item !== index));
	}
	selectSubmission(id: string): void {
		if (this.revising()) return;
		this.selectedEdits.set([]);
		this.feedback()?.select(id);
	}
	startRevision(): void {
		const active = this.feedback()?.active();
		if (!active || active.contentVersion !== this.feedback()?.currentContentVersion() || this.feedback()?.busy() || this.revising()) return;
		this.revisionText.set(this.preview());
		this.revisionNotes.set('');
		this.revisionParentId = active.id;
		this.revisionAttempted = false;
		this.revising.set(true);
	}
	setRevision(value: string): void {
		if (!this.revisionAttempted) this.revisionText.set(value);
	}
	setRevisionNotes(value: string): void {
		if (!this.revisionAttempted) this.revisionNotes.set(value);
	}
	revisionLocked(): boolean { return this.revisionAttempted; }
	async saveRevision(): Promise<void> {
		const controller = this.feedback();
		if (!controller || this.saveInFlight || !this.revising() || !this.revisionText().trim()) return;
		if (this.revisionText().length > controller.availability().maxCharacters || this.revisionNotes().length > 2000) return;
		const generation = this.generation;
		this.revisionAttempted = true;
		this.saveInFlight = true;
		const saved = await controller.save(this.revisionText(), this.revisionNotes(), this.revisionParentId);
		if (generation !== this.generation) return;
		this.saveInFlight = false;
		if (saved) {
			this.revising.set(false);
			this.recoveredLocalDraft.set(false);
			this.selectedEdits.set([]);
		}
	}
	canRetryFeedback(): boolean {
		const controller = this.feedback();
		const active = controller?.active();
		return Boolean(controller?.availability().enabled && !controller.contentChanged() && active?.contentVersion === controller.currentContentVersion() && active?.status === 'unavailable' && active.attemptCount < 3
			&& !['WRITING_FEEDBACK_INPUT_LIMIT', 'WRITING_FEEDBACK_INPUT_TOO_LARGE', 'WRITING_FEEDBACK_PROFILE_CHANGED'].includes(active.errorCode ?? ''));
	}
	private async restoreFeedback(controller: WritingFeedbackController, generation: number): Promise<void> {
		await controller.load();
		if (generation !== this.generation) return;
		const original = [...controller.submissions()].reverse().find((submission) => !submission.parentSubmissionId && submission.contentVersion === controller.currentContentVersion());
		if (original && !this.original()) {
			if (this.response().trim() && (this.response() !== original.draftText || this.notes() !== original.notes)) {
				this.revisionText.set(this.response());
				this.revisionNotes.set(this.notes());
				this.revisionParentId = original.id;
				this.revisionAttempted = false;
				this.revising.set(true);
				this.recoveredLocalDraft.set(true);
			}
			this.original.set(original);
			this.response.set(original.draftText);
			this.notes.set(original.notes);
			this.clearTimer();
			this.emitOriginal(original.draftText, original.notes);
		} else {
			this.updateReady();
		}
	}
	private async saveOriginal(controller: WritingFeedbackController): Promise<void> {
		if (this.response().length > controller.availability().maxCharacters || this.notes().length > 2000) return;
		const generation = this.generation;
		this.originalAttempted = true;
		this.saveInFlight = true;
		this.clearTimer();
		this.setReady(false, 'submit');
		const saved = await controller.save(this.response(), this.notes());
		if (generation !== this.generation) return;
		this.saveInFlight = false;
		if (saved) {
			this.original.set(saved);
			this.emitOriginal(saved.draftText, saved.notes);
		} else {
			this.setReady(!controller.contentChanged(), 'submit');
		}
	}
	private emitOriginal(response: string, notes: string, durable = true): void {
		this.submit({ response, notes, wordCount: wordCount(response), mode: this.data().mode, register: this.data().register },
			this.data().modelAnswer ? 'Compare your response with the model answer.' : '');
		if (this.feedbackConfigured) {
			this.stateChanges.next({ chrome: { footer: {
				tone: 'information',
				title: durable ? 'Draft saved' : 'Response ready',
				detail: durable ? 'Your original response is saved.' : 'Finish this exercise to save your response. Feedback is unavailable.',
				primary: { id: 'continue', label: 'Continue', behavior: 'next', disabled: false },
			} } });
		}
	}
	private updateReady(): void {
		const controller = this.feedback();
		const allowed = !this.feedbackConfigured || Boolean(controller?.loaded() && !controller.contentChanged());
		this.setReady(allowed && Boolean(this.response().trim()) && (!controller ||
			(this.response().length <= controller.availability().maxCharacters && this.notes().length <= 2000)), 'submit');
	}
	private clearTimer(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}
	ngOnDestroy(): void {
		this.generation += 1;
		this.feedback()?.dispose();
		this.clearTimer();
		this.destroy();
	}
}
