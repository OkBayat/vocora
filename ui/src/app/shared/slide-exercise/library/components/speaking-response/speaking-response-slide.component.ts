import {
	ChangeDetectionStrategy,
	Component,
	OnDestroy,
	inject,
	signal,
} from '@angular/core';
import { VocoPrimaryButtonComponent, VocoSecondaryButtonComponent } from '../../../../voco-button';
import { MatChipsModule } from '@angular/material/chips';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import type {
	SlideContentComponent,
	SlideContentContext,
} from '../../../slide-content-contracts';
import { LocalAudioRecorderService } from '../../local-audio-recorder.service';
import { ScoredSlideBase } from '../../scored-slide.base';
import type { SpeakingResponseSlideData } from '../../slide-library.models';
import { SlideStimulusComponent } from '../../slide-stimulus.component';
import {
	common,
	inputValue,
	stringMode,
} from '../../slide-library.component-support';
import { record, requiredText, strings } from '../../slide-library.utils';

function parseSpeaking(value: unknown): SpeakingResponseSlideData {
	const source = record(value);
	const prepSeconds = Number(source['prepSeconds']);
	const speakingSeconds = Number(source['speakingSeconds']);
	return {
		...common(source),
		mode: stringMode(
			source['mode'],
			['part1', 'cue-card', 'part3', 'vocabulary-production'] as const,
			'part1',
		),
		prompt: requiredText(source['prompt'], 'Speaking prompt'),
		promptBullets: strings(source['promptBullets']),
		prepSeconds:
			Number.isInteger(prepSeconds) && prepSeconds > 0
				? prepSeconds
				: undefined,
		speakingSeconds:
			Number.isInteger(speakingSeconds) && speakingSeconds > 0
				? speakingSeconds
				: undefined,
		targetVocabulary: strings(source['targetVocabulary']),
		notesEnabled: source['notesEnabled'] === true,
	};
}

@Component({
	selector: 'app-speaking-response-slide',
	standalone: true,
	imports: [
		VocoPrimaryButtonComponent, VocoSecondaryButtonComponent,
		MatChipsModule,
		MatFormFieldModule,
		MatInputModule,
		SlideStimulusComponent,
	],
	templateUrl: './speaking-response-slide.component.html',
	styleUrl: '../../slide-library.component.scss',
	changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SpeakingResponseSlideComponent
	extends ScoredSlideBase<SpeakingResponseSlideData>
	implements SlideContentComponent, OnDestroy
{
	private readonly recorder = inject(LocalAudioRecorderService);
	private recordingBlob: Blob | null = null;
	private timer: ReturnType<typeof setInterval> | null = null;
	readonly supported = this.recorder.supported();
	readonly recordingState = signal<
		'idle' | 'requesting' | 'recording' | 'recorded'
	>('idle');
	readonly recordingUrl = signal('');
	readonly recordingError = signal('');
	readonly notes = signal('');
	readonly prepRemaining = signal(0);
	readonly speakingRemaining = signal(0);
	inputFrom(event: Event): string {
		return inputValue(event);
	}
	setNotes(value: string): void {
		if (this.interactionState() !== 'idle') return;
		this.notes.set(value);
	}
	load(context: SlideContentContext): void {
		const data = parseSpeaking(context.data);
		this.clearTimer();
		this.recorder.cancel();
		this.begin(context.slideId, data, 'submit');
		this.recordingState.set('idle');
		this.recordingUrl.set('');
		this.recordingBlob = null;
		this.recordingError.set('');
		this.notes.set('');
		this.prepRemaining.set(data.prepSeconds ?? 0);
		this.speakingRemaining.set(data.speakingSeconds ?? 0);
		if (data.prepSeconds) this.startCountdown(this.prepRemaining);
	}
	async startRecording(): Promise<void> {
		if (
			this.interactionState() !== 'idle' ||
			!this.supported ||
			this.recordingState() === 'requesting' ||
			this.recordingState() === 'recording'
		)
			return;
		this.clearTimer();
		this.recordingError.set('');
		this.recordingState.set('requesting');
		this.recordingBlob = null;
		this.recordingUrl.set('');
		this.setReady(false, 'submit');
		try {
			await this.recorder.start();
			this.recordingState.set('recording');
			const seconds = this.data().speakingSeconds ?? 0;
			this.speakingRemaining.set(seconds);
			if (seconds)
				this.startCountdown(this.speakingRemaining, () => {
					void this.stopRecording();
				});
		} catch (error) {
			this.recordingState.set('idle');
			this.recordingError.set(
				error instanceof Error
					? error.message
					: 'Recording could not start.',
			);
		}
	}
	async stopRecording(): Promise<void> {
		if (
			this.interactionState() !== 'idle' ||
			this.recordingState() !== 'recording'
		)
			return;
		this.clearTimer();
		try {
			const recording = await this.recorder.stop();
			this.recordingBlob = recording.blob;
			this.recordingUrl.set(recording.url);
			this.recordingState.set('recorded');
			this.setReady(true, 'submit');
		} catch (error) {
			this.recordingState.set('idle');
			this.recordingError.set(
				error instanceof Error
					? error.message
					: 'Recording could not be saved.',
			);
		}
	}
	handleAction(actionId: string): void {
		if (
			this.interactionState() !== 'idle' ||
			actionId !== 'submit' ||
			this.recordingState() !== 'recorded' ||
			!this.recordingBlob
		)
			return;
		this.submit({
			recordingBlob: this.recordingBlob,
			notes: this.notes(),
			mode: this.data().mode,
		});
	}
	private startCountdown(
		target: { update(fn: (value: number) => number): void; (): number },
		done?: () => void,
	): void {
		this.clearTimer();
		this.timer = setInterval(() => {
			target.update((value) => Math.max(0, value - 1));
			if (target() === 0) {
				this.clearTimer();
				done?.();
			}
		}, 1000);
	}
	private clearTimer(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}
	ngOnDestroy(): void {
		this.clearTimer();
		this.recorder.cancel();
		this.recordingBlob = null;
		this.destroy();
	}
}
