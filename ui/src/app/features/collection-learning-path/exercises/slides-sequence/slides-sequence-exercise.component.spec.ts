import { TestBed } from "@angular/core/testing";
import { By } from "@angular/platform-browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CollectionLearningPathApiService } from "../../../../core/collection-learning-path/collection-learning-path-api.service";
import { ReviewAnswerSoundService } from "../../../../core/sound/review-answer-sound.service";
import { SpeakingResponseSlideComponent } from "../../../../shared/slide-exercise/library/components/speaking-response/speaking-response-slide.component";
import { SlideExerciseComponent } from "../../../../shared/slide-exercise";
import type { SlideExerciseResult } from "../../../../shared/slide-exercise";
import type { ExerciseContext } from "../exercise-runtime/exercise-contracts";
import { SlidesSequenceExerciseComponent } from "./slides-sequence-exercise.component";

const context: ExerciseContext = {
	pathId: "path-1",
	lessonId: "lesson-1",
	exerciseId: "exercise-1",
	type: "slides.sequence",
	schemaVersion: 1,
	completionPolicy: "slide-sequence",
	config: {
		slides: [
			{
				id: "intro",
				type: "teaching-card",
				data: { title: "Ready?", body: "Work through the slides." },
			},
			{
				id: "summary",
				type: "summary",
				terminal: true,
				data: { title: "Done" },
			},
		],
	},
	payload: null,
};

describe("SlidesSequenceExerciseComponent", () => {
	const uploadRecording = vi.fn();

	beforeEach(() => {
		uploadRecording.mockReset();
		uploadRecording.mockResolvedValue({ artifactId: "recording-1" });
		TestBed.configureTestingModule({
			providers: [
				{
					provide: CollectionLearningPathApiService,
					useValue: {
						commandUploadSlideSequenceRecording: uploadRecording,
					},
				},
			],
		});
	});

	afterEach(() => vi.unstubAllGlobals());

	it("renders configured slides and completes only from the terminal slide", async () => {
		TestBed.configureTestingModule({
			imports: [SlidesSequenceExerciseComponent],
		});
		const fixture = TestBed.createComponent(
			SlidesSequenceExerciseComponent,
		);
		const outcomes = vi.fn();
		fixture.componentInstance.outcome.subscribe(outcomes);

		fixture.componentInstance.load(context);
		fixture.detectChanges();
		expect(
			fixture.nativeElement.querySelector(
				'[data-testid="slides-sequence-exercise"]',
			),
		).not.toBeNull();
		expect(
			fixture.componentInstance.slides().map((slide) => slide.id),
		).toEqual(["intro", "summary"]);

		await fixture.componentInstance.finish();
		expect(outcomes).not.toHaveBeenCalled();

		const slideExercise = fixture.debugElement.query(
			By.directive(SlideExerciseComponent),
		).componentInstance as SlideExerciseComponent;
		slideExercise.next();
		expect(outcomes).not.toHaveBeenCalled();
		await fixture.componentInstance.finish("summary");
		expect(outcomes).toHaveBeenCalledOnce();
		expect(outcomes).toHaveBeenCalledWith({
			kind: "completed",
			evidence: { schemaVersion: 1, results: [] },
		});
	});

	it("fails closed when the deck is invalid", () => {
		TestBed.configureTestingModule({
			imports: [SlidesSequenceExerciseComponent],
		});
		const fixture = TestBed.createComponent(
			SlidesSequenceExerciseComponent,
		);
		fixture.componentInstance.load({ ...context, config: { slides: [] } });
		fixture.detectChanges();

		expect(fixture.nativeElement.textContent).toContain(
			"Exercise unavailable",
		);
		expect(fixture.componentInstance.slides()).toEqual([]);
	});

	it("requeues an incorrectly answered scored slide before the terminal summary", () => {
		TestBed.configureTestingModule({
			imports: [SlidesSequenceExerciseComponent],
		});
		const fixture = TestBed.createComponent(
			SlidesSequenceExerciseComponent,
		);
		fixture.componentInstance.load({
			...context,
			config: { ...context.config, retryIncorrect: true },
		});
		fixture.detectChanges();
		const slideExercise = fixture.debugElement.query(
			By.directive(SlideExerciseComponent),
		).componentInstance as SlideExerciseComponent;

		fixture.componentInstance.onContentEvent({
			slideId: "intro",
			type: "answered",
			data: { correct: false },
		});

		expect(slideExercise.deck.map((slide) => slide.id)).toEqual([
			"intro",
			"intro-retry-1",
			"summary",
		]);
		expect(slideExercise.deck[1]).toEqual(
			expect.objectContaining({
				rootSlideId: "intro",
				retryNumber: 1,
				terminal: false,
			}),
		);

		slideExercise.next();
		fixture.componentInstance.onContentEvent({
			slideId: "intro-retry-1",
			type: "answered",
			data: { correct: false },
		});
		expect(slideExercise.deck.map((slide) => slide.id)).toEqual([
			"intro",
			"intro-retry-1",
			"intro-retry-2",
			"summary",
		]);
	});

	it("emits bounded result evidence from the completed deck", async () => {
		TestBed.configureTestingModule({
			imports: [SlidesSequenceExerciseComponent],
			providers: [
				{
					provide: ReviewAnswerSoundService,
					useValue: { play: vi.fn(), stop: vi.fn() },
				},
			],
		});
		const fixture = TestBed.createComponent(
			SlidesSequenceExerciseComponent,
		);
		const outcomes = vi.fn();
		fixture.componentInstance.outcome.subscribe(outcomes);
		fixture.componentInstance.load({
			...context,
			config: {
				retryIncorrect: true,
				slides: [
					{ id: "choice", type: "choice", data: {} },
					{
						id: "summary",
						type: "summary",
						terminal: true,
						data: {},
					},
				],
			},
		});
		fixture.detectChanges();
		const slideExercise = fixture.debugElement.query(
			By.directive(SlideExerciseComponent),
		).componentInstance as SlideExerciseComponent;

		slideExercise.onContentEvent({
			type: "answered",
			data: {
				selectedOptionIds: ["correct"],
				correctOptionIds: ["correct"],
				correct: true,
			},
		});
		slideExercise.next();
		await fixture.componentInstance.finish("summary");

		expect(outcomes).toHaveBeenCalledWith({
			kind: "completed",
			evidence: {
				schemaVersion: 1,
				results: [
					{
						rootSlideId: "choice",
						slideType: "choice",
						itemId: undefined,
						eventType: "answered",
						data: { selectedOptionIds: ["correct"] },
					},
				],
			},
		});
	});

	async function recordSpeakingSequence(count = 1) {
		const blobs = new Map<string, Blob>();
		let recordingNumber = 0;
		const OriginalUrl = URL;
		const revoke = vi.fn((url: string) => blobs.delete(url));
		vi.stubGlobal("URL", class extends OriginalUrl {
			static override createObjectURL(blob: Blob): string {
				const url = `blob:local-recording-${++recordingNumber}`;
				blobs.set(url, blob);
				return url;
			}
			static override revokeObjectURL = revoke;
		});
		// Local playback can work even when fetching a blob URL is prohibited.
		const localFetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
		vi.stubGlobal("fetch", localFetch);
		vi.stubGlobal("isSecureContext", true);
		vi.stubGlobal("navigator", {
			mediaDevices: {
				getUserMedia: async () => ({ getTracks: () => [{ stop: vi.fn() }] }),
			},
		});
		vi.stubGlobal("MediaRecorder", class {
			state = "inactive";
			mimeType = "audio/webm";
			ondataavailable?: (event: { data: Blob }) => void;
			onstop?: () => void;
			start(): void { this.state = "recording"; }
			stop(): void {
				this.state = "inactive";
				this.ondataavailable?.({
					data: new Blob([new Uint8Array(512)], { type: this.mimeType }),
				});
				this.onstop?.();
			}
		});
		TestBed.configureTestingModule({
			imports: [SlidesSequenceExerciseComponent],
			providers: [{
				provide: ReviewAnswerSoundService,
				useValue: { play: vi.fn(), stop: vi.fn() },
			}],
		});
		const fixture = TestBed.createComponent(SlidesSequenceExerciseComponent);
		const outcomes = vi.fn();
		fixture.componentInstance.outcome.subscribe(outcomes);
		fixture.componentInstance.load({
			...context,
			config: {
				slides: [
					...Array.from({ length: count }, (_, index) => ({
						id: index ? "revision" : "speaking", type: "speaking-response", data: {
							mode: "part1", prompt: "What do you eat for breakfast?",
						},
					})),
					{ id: "summary", type: "summary", terminal: true, data: {} },
				],
			},
		});
		fixture.detectChanges();
		await fixture.whenStable();
		const slideExercise = fixture.debugElement.query(
			By.directive(SlideExerciseComponent),
		).componentInstance as SlideExerciseComponent;
		const recordings: Blob[] = [];
		for (let index = 0; index < count; index++) {
			await vi.waitFor(() => {
				fixture.detectChanges();
				expect(fixture.debugElement.query(By.directive(SpeakingResponseSlideComponent))).not.toBeNull();
			});
			const speaking = fixture.debugElement.query(
				By.directive(SpeakingResponseSlideComponent),
			).componentInstance as SpeakingResponseSlideComponent;
			await speaking.startRecording();
			await speaking.stopRecording();
			const url = speaking.recordingUrl();
			recordings.push(blobs.get(url)!);
			speaking.handleAction("submit");
			slideExercise.next();
			fixture.detectChanges();
			await fixture.whenStable();
			expect(revoke).toHaveBeenCalledWith(url);
			expect(blobs.has(url)).toBe(false);
		}
		return { fixture, outcomes, recording: recordings[0], recordings, localFetch };
	}

	it("uploads speaking evidence without fetching a revoked preview URL", async () => {
		const { fixture, outcomes, recording, localFetch } = await recordSpeakingSequence();

		await fixture.componentInstance.finish("summary");

		expect(localFetch).not.toHaveBeenCalled();
		expect(uploadRecording).toHaveBeenCalledExactlyOnceWith(
			"path-1", "lesson-1", "exercise-1", "speaking", recording,
		);
		expect(outcomes).toHaveBeenCalledWith({
			kind: "completed",
			evidence: {
				schemaVersion: 1,
				results: [{
					rootSlideId: "speaking", slideType: "speaking-response",
					itemId: undefined, eventType: "submitted",
					data: { recordingArtifactId: "recording-1", notes: "", mode: "part1" },
				}],
			},
		});
	});

	it("submits both the first answer and revision when local URL fetch is unavailable", async () => {
		const { fixture, outcomes, recordings, localFetch } = await recordSpeakingSequence(2);
		uploadRecording.mockImplementation((_path, _lesson, _exercise, slideId) =>
			Promise.resolve({ artifactId: `saved-${slideId}` }));

		await fixture.componentInstance.finish("summary");

		expect(localFetch).not.toHaveBeenCalled();
		expect(fixture.componentInstance.error()).toBe("");
		expect(recordings[0]).not.toBe(recordings[1]);
		expect(uploadRecording).toHaveBeenCalledTimes(2);
		expect(uploadRecording).toHaveBeenNthCalledWith(1, "path-1", "lesson-1", "exercise-1", "speaking", recordings[0]);
		expect(uploadRecording).toHaveBeenNthCalledWith(2, "path-1", "lesson-1", "exercise-1", "revision", recordings[1]);
		expect(outcomes).toHaveBeenCalledOnce();
		const evidence = outcomes.mock.calls[0][0].evidence;
		expect(evidence.results.map((result: { data: { recordingArtifactId: string } }) => result.data.recordingArtifactId))
			.toEqual(["saved-speaking", "saved-revision"]);
		expect(JSON.stringify(evidence)).not.toMatch(/recordingBlob|recordingUrl|blob:/);
	});

	it("retries a failed speaking upload using retained bytes and reuses successful uploads", async () => {
		const { fixture, outcomes, recording } = await recordSpeakingSequence();
		const completion = vi.fn().mockRejectedValueOnce(new Error("Completion unavailable."));
		fixture.componentInstance.runtime.update((runtime) => ({ ...runtime!, sequenceCompletion: completion }));
		uploadRecording.mockRejectedValueOnce(new Error("Upload unavailable."));

		await fixture.componentInstance.finish("summary");
		expect(fixture.componentInstance.error()).toBe("Upload unavailable.");
		expect(outcomes).not.toHaveBeenCalled();
		await fixture.componentInstance.finish("summary");
		expect(fixture.componentInstance.error()).toBe("Completion unavailable.");
		expect(outcomes).not.toHaveBeenCalled();
		await fixture.componentInstance.finish("summary");

		expect(uploadRecording).toHaveBeenCalledTimes(2);
		expect(uploadRecording).toHaveBeenLastCalledWith(
			"path-1", "lesson-1", "exercise-1", "speaking", recording,
		);
		expect(outcomes).toHaveBeenCalledOnce();
	});

	it("does not complete a replacement exercise when an earlier recording upload resolves", async () => {
		const { fixture, outcomes } = await recordSpeakingSequence();
		let uploaded!: (artifact: { artifactId: string }) => void;
		uploadRecording.mockImplementationOnce(() => new Promise((resolve) => { uploaded = resolve; }));
		const finishing = fixture.componentInstance.finish("summary");
		await vi.waitFor(() => expect(uploadRecording).toHaveBeenCalledOnce());
		const replacementCompletion = vi.fn();
		fixture.componentInstance.load({ ...context, exerciseId: "replacement", sequenceCompletion: replacementCompletion });
		uploaded({ artifactId: "recording-1" });
		await finishing;

		expect(replacementCompletion).not.toHaveBeenCalled();
		expect(outcomes).not.toHaveBeenCalled();
		expect(fixture.componentInstance.error()).toBe("");
	});

	it("preserves labeling, supporting evidence, and writing metadata in completion evidence", async () => {
		TestBed.configureTestingModule({
			imports: [SlidesSequenceExerciseComponent],
			providers: [
				{
					provide: ReviewAnswerSoundService,
					useValue: { play: vi.fn(), stop: vi.fn() },
				},
			],
		});
		const fixture = TestBed.createComponent(SlidesSequenceExerciseComponent);
		const outcomes = vi.fn();
		fixture.componentInstance.outcome.subscribe(outcomes);
		fixture.componentInstance.load({
			...context,
			config: {
				slides: [
					{ id: "labels", type: "labeling", data: {} },
					{ id: "answer", type: "short-answer", data: {} },
					{ id: "writing", type: "writing-response", data: {} },
					{ id: "summary", type: "summary", terminal: true, data: {} },
				],
			},
		});
		fixture.detectChanges();
		const slideExercise = fixture.debugElement.query(
			By.directive(SlideExerciseComponent),
		).componentInstance as SlideExerciseComponent;
		slideExercise.onContentEvent({
			type: "answered",
			data: { answers: { one: "library" }, correct: true },
		});
		slideExercise.next();
		slideExercise.onContentEvent({
			type: "answered",
			data: {
				answer: "beside the library",
				supportingEvidence: "The cafe is beside the library.",
				correct: true,
			},
		});
		slideExercise.next();
		slideExercise.onContentEvent({
			type: "submitted",
			data: {
				response: "The main feature increased.",
				notes: "Mention the overview first.",
				wordCount: 4,
				mode: "task1-chart",
				register: "formal",
			},
		});
		slideExercise.next();

		await fixture.componentInstance.finish("summary");

		expect(outcomes).toHaveBeenCalledWith({
			kind: "completed",
			evidence: {
				schemaVersion: 1,
				results: [
					{
						rootSlideId: "labels",
						slideType: "labeling",
						itemId: undefined,
						eventType: "answered",
						data: { answers: { one: "library" } },
					},
					{
						rootSlideId: "answer",
						slideType: "short-answer",
						itemId: undefined,
						eventType: "answered",
						data: {
							answer: "beside the library",
							supportingEvidence: "The cafe is beside the library.",
						},
					},
					{
						rootSlideId: "writing",
						slideType: "writing-response",
						itemId: undefined,
						eventType: "submitted",
						data: {
							response: "The main feature increased.",
							notes: "Mention the overview first.",
							wordCount: 4,
							mode: "task1-chart",
							register: "formal",
						},
					},
				],
			},
		});
	});

	it("passes only the server conversation receipt into completion evidence", async () => {
		const fixture = TestBed.createComponent(SlidesSequenceExerciseComponent);
		const outcomes = vi.fn(); fixture.componentInstance.outcome.subscribe(outcomes);
		fixture.componentInstance.load({ ...context, config: { slides: [
			{ id: 'conversation', type: 'adaptive-conversation', data: { mode: 'guided-dialogue', goal: 'Talk about meals.', openingPrompt: 'What do you eat?', learnerLevel: 'beginner', minimumTurns: 2, maximumTurns: 3, responseSeconds: 5, questionConstraints: { maximumWords: 14, oneQuestionOnly: true, avoidAnswerDisclosure: true } } },
			{ id: 'summary', type: 'summary', terminal: true, data: {} },
		] } });
		fixture.detectChanges();
		const slides = fixture.debugElement.query(By.directive(SlideExerciseComponent)).componentInstance as SlideExerciseComponent;
		slides.onContentEvent({ type: 'submitted', data: { conversationEvidenceId: 'receipt', transcript: 'private transcript', score: 2 } });
		slides.next(); await fixture.componentInstance.finish('summary');
		expect(outcomes).toHaveBeenCalledWith({ kind: 'completed', evidence: { schemaVersion: 1, results: [{
			rootSlideId: 'conversation', slideType: 'adaptive-conversation', itemId: undefined, eventType: 'submitted', data: { conversationEvidenceId: 'receipt' },
		}] } });
	});

	it("awaits an application-owned sequence completion handler before emitting completion", async () => {
		TestBed.configureTestingModule({
			imports: [SlidesSequenceExerciseComponent],
			providers: [
				{
					provide: ReviewAnswerSoundService,
					useValue: { play: vi.fn(), stop: vi.fn() },
				},
			],
		});
		const fixture = TestBed.createComponent(SlidesSequenceExerciseComponent);
		const outcomes = vi.fn();
		const sequenceCompletion = vi.fn().mockResolvedValue(undefined);
		fixture.componentInstance.outcome.subscribe(outcomes);
		fixture.componentInstance.load({
			...context,
			sequenceCompletion,
			config: {
				slides: [
					{ id: "choice", type: "choice", data: {} },
					{ id: "summary", type: "summary", terminal: true, data: {} },
				],
			},
		});
		fixture.detectChanges();
		const slideExercise = fixture.debugElement.query(
			By.directive(SlideExerciseComponent),
		).componentInstance as SlideExerciseComponent;
		slideExercise.onContentEvent({
			type: "answered",
			data: { selectedOptionIds: ["correct"], correct: true },
		});
		slideExercise.next();

		await fixture.componentInstance.finish("summary");

		expect(sequenceCompletion).toHaveBeenCalledWith([
			expect.objectContaining({ slideId: "choice", eventType: "answered" }),
		]);
		expect(outcomes).toHaveBeenCalledOnce();

		sequenceCompletion.mockRejectedValueOnce(new Error("Could not save practice."));
		fixture.componentInstance.load({
			...context,
			sequenceCompletion,
		});
		fixture.detectChanges();
		const reloadedSlideExercise = fixture.debugElement.query(
			By.directive(SlideExerciseComponent),
		).componentInstance as SlideExerciseComponent;
		reloadedSlideExercise.goTo("summary");
		outcomes.mockClear();

		await fixture.componentInstance.finish("summary");

		expect(outcomes).not.toHaveBeenCalled();
		expect(fixture.componentInstance.error()).toBe("Could not save practice.");
	});

	it("sends each first recorded slide result immediately and does not resend it at completion", async () => {
		TestBed.configureTestingModule({
			imports: [SlidesSequenceExerciseComponent],
			providers: [{
				provide: ReviewAnswerSoundService,
				useValue: { play: vi.fn(), stop: vi.fn() },
			}],
		});
		const fixture = TestBed.createComponent(SlidesSequenceExerciseComponent);
		const slideResult = vi.fn().mockResolvedValue(undefined);
		fixture.componentInstance.load({
			...context,
			slideResult,
			config: {
				slides: [
					{ id: "choice", itemId: "word-1", type: "choice", data: {} },
					{ id: "summary", type: "summary", terminal: true, data: {} },
				],
			},
		});
		fixture.detectChanges();
		const slideExercise = fixture.debugElement.query(
			By.directive(SlideExerciseComponent),
		).componentInstance as SlideExerciseComponent;

		slideExercise.onContentEvent({
			type: "answered",
			data: { selectedOptionIds: ["correct"], correct: true },
		});
		await vi.waitFor(() => expect(slideResult).toHaveBeenCalledOnce());
		expect(slideResult).toHaveBeenCalledWith(expect.objectContaining({
			slideId: "choice",
			itemId: "word-1",
			eventType: "answered",
		}));

		slideExercise.next();
		await fixture.componentInstance.finish("summary");

		expect(slideResult).toHaveBeenCalledOnce();
	});

	it("keeps an earlier immediate-save error visible until that exact result is retried successfully", async () => {
		TestBed.configureTestingModule({
			imports: [SlidesSequenceExerciseComponent],
			providers: [{ provide: ReviewAnswerSoundService, useValue: { play: vi.fn(), stop: vi.fn() } }],
		});
		const fixture = TestBed.createComponent(SlidesSequenceExerciseComponent);
		let firstAttempts = 0;
		const slideResult = vi.fn(async (result: SlideExerciseResult) => {
			if (result.slideId === "first" && firstAttempts++ === 0) throw new Error("First result was not saved.");
		});
		fixture.componentInstance.load({
			...context,
			slideResult,
			config: { slides: [
				{ id: "first", itemId: "word-1", type: "choice", data: {} },
				{ id: "second", itemId: "word-2", type: "choice", data: {} },
				{ id: "summary", type: "summary", terminal: true, data: {} },
			] },
		});
		fixture.detectChanges();
		const slideExercise = fixture.debugElement.query(By.directive(SlideExerciseComponent)).componentInstance as SlideExerciseComponent;

		slideExercise.onContentEvent({ type: "answered", data: { selectedOptionIds: ["a"], correct: true } });
		await vi.waitFor(() => expect(fixture.componentInstance.error()).toBe("First result was not saved."));
		slideExercise.next();
		slideExercise.onContentEvent({ type: "answered", data: { selectedOptionIds: ["b"], correct: true } });
		await vi.waitFor(() => expect(slideResult).toHaveBeenCalledTimes(2));

		expect(fixture.componentInstance.error()).toBe("First result was not saved.");
		slideExercise.next();
		await fixture.componentInstance.finish("summary");

		expect(slideResult).toHaveBeenCalledTimes(3);
		expect(fixture.componentInstance.error()).toBe("");
	});
});
