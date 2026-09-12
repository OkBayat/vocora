import {
	ChangeDetectionStrategy,
	Component,
	EventEmitter,
	OnDestroy,
	Output,
	ViewChild,
	inject,
	signal,
} from "@angular/core";
import { CollectionLearningPathApiService } from "../../../../core/collection-learning-path/collection-learning-path-api.service";
import { parseSlideSequenceExercise } from "../../../../domain/collection-learning-path/slide-sequence-exercise";
import {
	createDefaultSlideContentRegistry,
	SlideExerciseComponent,
	type SlideExerciseActionEvent,
	type SlideExerciseContentEvent,
	type SlideExerciseResult,
	type SlideExerciseSlide,
} from "../../../../shared/slide-exercise";
import { LessonVocabularyScopeSlideComponent } from "./lesson-vocabulary-scope-slide.component";
import type {
	ExerciseComponent,
	ExerciseContext,
	ExerciseOutcome,
} from "../exercise-runtime/exercise-contracts";

function message(error: unknown): string {
	return error instanceof Error && error.message
		? error.message
		: "This slide sequence could not be prepared.";
}

function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function learnerResponse(
	slideType: string,
	value: unknown,
): Record<string, unknown> | null {
	const data = record(value);
	if (!data) return null;
	if (
		slideType === "selection" ||
		slideType === "choice" ||
		slideType === "truth" ||
		slideType === "pronunciation"
	) {
		return { selectedOptionIds: data["selectedOptionIds"] };
	}
	if (slideType === "number-input") return { value: data["value"] };
	if (slideType === "classification")
		return { assignments: data["assignments"] };
	if (slideType === "matching")
		return { assignments: data["assignments"] };
	if (
		slideType === "cloze" ||
		slideType === "structured-completion" ||
		slideType === "word-formation" ||
		slideType === "labeling"
	) {
		return { answers: data["answers"] };
	}
	if (slideType === "short-answer")
		return {
			answer: data["answer"],
			supportingEvidence: data["supportingEvidence"],
		};
	if (slideType === "dictation") return { answer: data["answer"] };
	if (slideType === "error-correction")
		return { correction: data["correction"] };
	if (slideType === "rewrite") return { response: data["response"] };
	if (slideType === "adaptive-conversation") return { conversationEvidenceId: data["conversationEvidenceId"] };
	if (slideType === "writing-response")
		return {
			response: data["response"],
			notes: data["notes"],
			wordCount: data["wordCount"],
			mode: data["mode"],
			register: data["register"],
		};
	if (slideType === "ordering")
		return { orderedItemIds: data["orderedItemIds"] };
	return null;
}

@Component({
	selector: "app-slides-sequence-exercise",
	standalone: true,
	imports: [SlideExerciseComponent],
	templateUrl: "./slides-sequence-exercise.component.html",
	styleUrl: "./slides-sequence-exercise.component.scss",
	changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SlidesSequenceExerciseComponent implements ExerciseComponent, OnDestroy {
	private readonly api = inject(CollectionLearningPathApiService);
	@Output() readonly outcome = new EventEmitter<ExerciseOutcome>();
	@ViewChild(SlideExerciseComponent)
	private slideExercise?: SlideExerciseComponent;

	readonly slides = signal<readonly SlideExerciseSlide[]>([]);
	readonly runtime = signal<ExerciseContext | null>(null);
	readonly registry = (() => {
		const registry = createDefaultSlideContentRegistry();
		registry.register({
			type: "lesson-vocabulary-scope",
			chromeDefaults: {
				header: { visible: false },
				footer: {
					primary: {
						id: "start-vocabulary-scope",
						behavior: "content",
						disabled: false,
					},
					secondary: false,
				},
			},
			loadComponent: async () => LessonVocabularyScopeSlideComponent,
		});
		return registry;
	})();
	readonly error = signal("");
	private readonly completed = signal(false);
	private readonly finishing = signal(false);
	private retryIncorrect = false;
	private readonly sourceSlides = new Map<string, SlideExerciseSlide>();
	private readonly retryCounts = new Map<string, number>();
	private readonly savedResultIds = new Set<string>();
	private readonly failedResultIds = new Set<string>();
	private readonly resultSaves = new Map<string, Promise<void>>();
	private readonly recordings = new Map<string, {
		blob: Promise<Blob>;
		upload?: Promise<{ artifactId: string }>;
	}>();
	private loadGeneration = 0;

	load(context: ExerciseContext): void {
		this.runtime.set(context);
		this.error.set("");
		this.completed.set(false);
		this.finishing.set(false);
		this.retryIncorrect = false;
		this.sourceSlides.clear();
		this.retryCounts.clear();
		this.savedResultIds.clear();
		this.failedResultIds.clear();
		this.resultSaves.clear();
		this.recordings.clear();
		this.loadGeneration += 1;
		try {
			const definition = parseSlideSequenceExercise(context.config);
			const slides = definition.slides as readonly SlideExerciseSlide[];
			this.retryIncorrect = definition.retryIncorrect;
			this.slides.set(slides);
			slides
				.filter((slide) => !slide.terminal)
				.forEach((slide) => {
					this.sourceSlides.set(slide.id, slide);
				});
		} catch (error) {
			this.slides.set([]);
			this.error.set(message(error));
		}
	}

	onSlideResult(result: SlideExerciseResult): void {
		const generation = this.loadGeneration;
		const recording = result.slideType === "speaking-response"
			? this.captureRecording(result)
			: Promise.resolve();
		void Promise.all([recording, this.persistSlideResult(result)]).catch((error) => {
			if (generation === this.loadGeneration) this.error.set(message(error));
		});
	}

	private captureRecording(result: SlideExerciseResult): Promise<Blob> {
		const existing = this.recordings.get(result.slideId);
		if (existing) return existing.blob;
		// Retain the actual bytes. Preview URLs belong to the renderer and may
		// be revoked on navigation or unavailable to fetch under browser policy.
		const blob = record(result.data)?.["recordingBlob"];
		if (!(blob instanceof Blob) || !blob.size) {
			return Promise.reject(new Error("A local speaking recording is missing."));
		}
		const recording = { blob: Promise.resolve(blob) };
		this.recordings.set(result.slideId, recording);
		return recording.blob;
	}

	onAction(event: SlideExerciseActionEvent): void {
		if (event.actionId === "finish") void this.finish(event.slideId);
	}

	onContentEvent(event: SlideExerciseContentEvent): void {
		if (!this.retryIncorrect || event.type !== "answered") return;
		const result = event.data;
		if (
			!result ||
			typeof result !== "object" ||
			Array.isArray(result) ||
			(result as Record<string, unknown>)["correct"] !== false
		)
			return;
		const deck = this.slideExercise;
		const current = deck?.currentSlide;
		if (!current || current.id !== event.slideId) return;
		const rootId = current.rootSlideId?.trim() || current.id;
		const source =
			this.sourceSlides.get(rootId) ??
			deck.deck.find((slide) => slide.id === rootId);
		if (!source) return;
		const retryNumber = (this.retryCounts.get(rootId) ?? 0) + 1;
		this.retryCounts.set(rootId, retryNumber);
		deck.deckController.insertSlides({
			anchorId: current.id,
			gap: 2,
			slides: [
				{
					...source,
					id: `${rootId}-retry-${retryNumber}`,
					rootSlideId: rootId,
					retryNumber,
					terminal: false,
				},
			],
		});
	}

	async finish(
		slideId = this.slideExercise?.currentSlide?.id ?? "",
	): Promise<void> {
		if (this.completed() || this.finishing()) return;
		const terminal = this.slides().at(-1);
		if (
			!terminal?.terminal ||
			terminal.id !== slideId ||
			this.slideExercise?.currentSlide?.id !== slideId
		)
			return;
		const runtime = this.runtime();
		if (!runtime) return;
		const generation = this.loadGeneration;
		this.finishing.set(true);
		this.error.set("");
		try {
			const slideResults = this.slideExercise.deckController.results();
			await Promise.all(slideResults.map((result) => this.persistSlideResult(result)));
			if (generation !== this.loadGeneration) return;
			const results = (
				await Promise.all(
					slideResults.map((result) => this.evidenceResult(result, runtime, generation)),
				)
			).filter((result) => result !== null);
			if (generation !== this.loadGeneration) return;
			await runtime.sequenceCompletion?.(slideResults);
			if (generation !== this.loadGeneration) return;
			this.completed.set(true);
			this.recordings.clear();
			this.outcome.emit({
				kind: "completed",
				evidence: { schemaVersion: 1, results },
			});
		} catch (error) {
			if (generation !== this.loadGeneration) return;
			this.error.set(
				message(error) ||
					"The speaking recording could not be saved. Try again.",
			);
		} finally {
			if (generation === this.loadGeneration) this.finishing.set(false);
		}
	}

	private persistSlideResult(result: SlideExerciseResult): Promise<void> {
		const handler = this.runtime()?.slideResult;
		if (!handler || this.savedResultIds.has(result.slideId)) return Promise.resolve();
		const pending = this.resultSaves.get(result.slideId);
		if (pending) return pending;
		const generation = this.loadGeneration;
		const save = handler(result)
			.then(() => {
				if (generation === this.loadGeneration) {
					this.savedResultIds.add(result.slideId);
					this.failedResultIds.delete(result.slideId);
					if (!this.failedResultIds.size) this.error.set("");
				}
			})
			.catch((error) => {
				if (generation === this.loadGeneration) this.failedResultIds.add(result.slideId);
				throw error;
			})
			.finally(() => {
				if (this.resultSaves.get(result.slideId) === save) this.resultSaves.delete(result.slideId);
			});
		this.resultSaves.set(result.slideId, save);
		return save;
	}

	private async evidenceResult(
		result: SlideExerciseResult,
		runtime: ExerciseContext,
		generation: number,
	): Promise<{
		rootSlideId: string;
		slideType: string;
		itemId: string | undefined;
		eventType: "answered" | "submitted";
		data: Record<string, unknown>;
	} | null> {
		if (result.slideType === "speaking-response") {
			const recording = this.recordings.get(result.slideId);
			if (!recording) throw new Error("A speaking recording is missing.");
			if (!recording.upload) {
				const upload = recording.blob.then((blob) => {
					if (generation !== this.loadGeneration) throw new Error("The exercise changed before the recording was saved.");
					return this.api.commandUploadSlideSequenceRecording(
						runtime.pathId, runtime.lessonId, runtime.exerciseId, result.rootSlideId, blob,
					);
				});
				recording.upload = upload;
				void upload.catch(() => {
					if (recording.upload === upload) recording.upload = undefined;
				});
			}
			const artifact = await recording.upload;
			const evidenceData: Record<string, unknown> = {
				recordingArtifactId: artifact.artifactId,
			};
			for (const key of ["notes", "mode"] as const) {
				if (typeof record(result.data)?.[key] === "string")
					evidenceData[key] = record(result.data)?.[key];
			}
			return {
				rootSlideId: result.rootSlideId,
				slideType: result.slideType,
				itemId: result.itemId,
				eventType: result.eventType,
				data: evidenceData,
			};
		}
		const data = learnerResponse(result.slideType, result.data);
		return data
			? {
					rootSlideId: result.rootSlideId,
					slideType: result.slideType,
					itemId: result.itemId,
					eventType: result.eventType,
					data,
				}
			: null;
	}

	cancel(): void {
		this.loadGeneration += 1;
		this.recordings.clear();
		if (!this.completed()) this.outcome.emit({ kind: "cancelled" });
	}

	ngOnDestroy(): void {
		this.loadGeneration += 1;
		this.recordings.clear();
	}
}
