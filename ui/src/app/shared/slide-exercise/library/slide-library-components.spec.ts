import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import type { SlideExerciseRuntimeState } from '../slide-exercise.models';
import { ReviewAnswerSoundService } from '../../../core/sound/review-answer-sound.service';
import { SpeechService } from '../../../core/speech/speech.service';
import { LearningStoreService } from '../../../core/state/learning-store.service';
import { LocalAudioRecorderService } from './local-audio-recorder.service';
import { SlideAudioControlComponent } from './slide-audio-control.component';
import {
	ChoiceSlideComponent,
	ClassificationSlideComponent,
	ClozeSlideComponent,
	DictationSlideComponent,
	ErrorCorrectionSlideComponent,
	LabelingSlideComponent,
	MatchingSlideComponent,
	NumberInputSlideComponent,
	OrderingSlideComponent,
	PronunciationSlideComponent,
	RewriteSlideComponent,
	SelectionSlideComponent,
	ShortAnswerSlideComponent,
	SpeakingResponseSlideComponent,
	StructuredCompletionSlideComponent,
	WordFormationSlideComponent,
	WritingResponseSlideComponent,
} from './slide-library.components';

function load(
	component: {
		load(context: {
			slideId: string;
			type: string;
			data: unknown;
			environment?: unknown;
		}): void;
	},
	type: string,
	data: unknown,
	environment?: unknown,
): void {
	component.load({ slideId: 'slide-1', type, data, environment });
}

function configure(): {
	speak: ReturnType<typeof vi.fn>;
	cancel: ReturnType<typeof vi.fn>;
} {
	const speech = { speak: vi.fn().mockReturnValue(true), cancel: vi.fn() };
	TestBed.configureTestingModule({
		providers: [
			{
				provide: ReviewAnswerSoundService,
				useValue: { play: vi.fn(), stop: vi.fn() },
			},
			{
				provide: LocalAudioRecorderService,
				useValue: {
					supported: () => true,
					start: vi.fn().mockResolvedValue(undefined),
					stop: vi.fn().mockResolvedValue({ blob: new Blob(['recording'], { type: 'audio/webm' }), url: 'blob:recording' }),
					cancel: vi.fn(),
				},
			},
			{ provide: SpeechService, useValue: speech },
			{
				provide: LearningStoreService,
				useValue: { state: signal({ settings: { voiceRate: 0.95 } }) },
			},
		],
	});
	return speech;
}

describe('reusable slide library behavior', () => {
	it('autoplays repeat-mode pronunciation and starts recording when playback ends', () => {
		const speech = configure();
		let playbackObserver: { onEnd?: () => void } | undefined;
		speech.speak.mockImplementation(
			(_text: string, _rate: number, observer: { onEnd?: () => void }) => {
				playbackObserver = observer;
				return true;
			},
		);
		const practice = {
			supported: true,
			phase: signal('ready'),
			levels: signal<readonly number[]>(Array(28).fill(4)),
			seconds: signal(0),
			assessment: signal(null),
			result: signal(null),
			error: signal(''),
			selectPrompt: vi.fn().mockReturnValue(true),
			record: vi.fn().mockResolvedValue(undefined),
			stop: vi.fn().mockResolvedValue(undefined),
			pause: vi.fn(),
		};
		const component = TestBed.runInInjectionContext(
			() => new PronunciationSlideComponent(),
		);

		load(
			component,
			'pronunciation',
			{
				mode: 'repeat',
				instruction: 'Listen, then repeat the complete sentence aloud.',
				question: 'She is persistent.',
				word: 'persistent',
				speech: { text: 'She is persistent.' },
				recording: { itemId: 'word-2', promptId: 'sentence-2' },
			},
			{ pronunciationPractice: practice },
		);

		expect(practice.selectPrompt).toHaveBeenCalledWith(
			'word-2',
			'sentence-2',
		);
		expect(speech.speak).toHaveBeenCalledWith(
			'She is persistent.',
			0.95,
			expect.objectContaining({ onEnd: expect.any(Function) }),
		);
		playbackObserver?.onEnd?.();
		expect(practice.record).toHaveBeenCalledOnce();
	});

	it('submits general single and multiple selections without correctness', () => {
		const next = vi.fn();
		const component = new SelectionSlideComponent();
		const states: unknown[] = [];
		const events: unknown[] = [];
		component.stateChange.subscribe((state) => states.push(state));
		component.event.subscribe((event) => events.push(event));
		component.load({
			slideId: 'selection',
			type: 'selection',
			data: {
				mode: 'single',
				question: 'Choose a practice mode',
				options: [
					{ id: 'dictation', label: 'Vocabulary Dictation', description: 'Hear and type a word or collocation.' },
					{ id: 'completion', label: 'Sentence Completion', description: 'Complete a sentence from audio.' },
				],
			},
			deck: { insertSlides: vi.fn(), next, results: () => [] },
		});

		expect(states.at(-1)).toEqual({ chrome: { footer: { primary: { disabled: true } } } });
		component.selectOption('completion');
		expect(component.selectedOptionIds()).toEqual(['completion']);
		expect(states.at(-1)).toEqual({ chrome: { footer: { primary: { disabled: false } } } });
		component.handleAction('continue');
		expect(events.at(-1)).toEqual({ type: 'submitted', data: { selectedOptionIds: ['completion'] } });
		expect(next).toHaveBeenCalledOnce();

		component.load({
			slideId: 'selection',
			type: 'selection',
			data: {
				mode: 'multiple',
				question: 'Choose study topics',
				options: [
					{ id: 'vocabulary', label: 'Vocabulary' },
					{ id: 'grammar', label: 'Grammar' },
					{ id: 'listening', label: 'Listening' },
				],
			},
			deck: { insertSlides: vi.fn(), next, results: () => [] },
		});
		component.selectOption('vocabulary');
		component.selectOption('listening');
		expect(component.selectedOptionIds()).toEqual(['vocabulary', 'listening']);
		component.selectOption('vocabulary');
		expect(component.selectedOptionIds()).toEqual(['listening']);

		expect(() => component.load({
			slideId: 'selection',
			type: 'selection',
			data: {
				mode: 'ranked',
				question: 'Choose an option',
				options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
			},
		})).toThrow('Selection mode must be single or multiple.');

		expect(() => component.load({
			slideId: 'selection',
			type: 'selection',
			data: {
				mode: 'single',
				question: 'Choose an option',
				expansionId: ' ',
				options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
			},
		})).toThrow('Selection expansionId is required when configured.');
	});

	it('expands a selection through its external runtime handler before advancing', async () => {
		const insertSlides = vi.fn();
		const next = vi.fn();
		const expansion = vi.fn().mockResolvedValue({
			slides: [{ id: 'generated-one', type: 'message', data: { title: 'One' } }],
		});
		const component = new SelectionSlideComponent();
		const events: unknown[] = [];
		component.event.subscribe((event) => events.push(event));
		component.load({
			slideId: 'selection',
			type: 'selection',
			data: {
				mode: 'single',
				question: 'Choose a path',
				expansionId: 'build-path',
				options: [
					{ id: 'first', label: 'First' },
					{ id: 'second', label: 'Second' },
				],
			},
			environment: { selectionExpansion: expansion },
			deck: { insertSlides, next, results: () => [] },
		});
		component.selectOption('second');
		component.handleAction('continue');

		await vi.waitFor(() => expect(next).toHaveBeenCalledOnce());
		expect(expansion).toHaveBeenCalledWith({
			expansionId: 'build-path',
			slideId: 'selection',
			selectedOptionIds: ['second'],
		});
		expect(insertSlides).toHaveBeenCalledWith({
			anchorId: 'selection',
			gap: 0,
			slides: [{ id: 'generated-one', type: 'message', data: { title: 'One' } }],
		});
		expect(events).toEqual([{ type: 'submitted', data: { selectedOptionIds: ['second'] } }]);
	});

	it('submits a bounded number through an external expansion handler before advancing', async () => {
		const insertSlides = vi.fn();
		const next = vi.fn();
		const expansion = vi.fn().mockResolvedValue({
			slides: [{ id: 'generated-one', type: 'message', data: { title: 'One' } }],
		});
		const component = new NumberInputSlideComponent();
		const states: unknown[] = [];
		const events: unknown[] = [];
		component.stateChange.subscribe((state) => states.push(state));
		component.event.subscribe((event) => events.push(event));
		component.load({
			slideId: 'word-count',
			type: 'number-input',
			data: {
				instruction: 'Choose the size of this practice.',
				question: 'How many new words would you like to add?',
				label: 'Number of words',
				min: 1,
				max: 20,
				step: 1,
				initialValue: 10,
				expansionId: 'new-word-practice',
			},
			environment: { numberInputExpansion: expansion },
			deck: { insertSlides, next, results: () => [] },
		});

		expect(component.value()).toBe(10);
		expect(states.at(-1)).toEqual({ chrome: { footer: { primary: { disabled: false } } } });
		component.setValue('21');
		expect(states.at(-1)).toEqual({ chrome: { footer: { primary: { disabled: true } } } });
		component.setValue('12');
		component.handleAction('continue');

		await vi.waitFor(() => expect(next).toHaveBeenCalledOnce());
		expect(expansion).toHaveBeenCalledWith({
			expansionId: 'new-word-practice',
			slideId: 'word-count',
			value: 12,
		});
		expect(insertSlides).toHaveBeenCalledWith({
			anchorId: 'word-count',
			gap: 0,
			slides: [{ id: 'generated-one', type: 'message', data: { title: 'One' } }],
		});
		expect(events).toEqual([{ type: 'submitted', data: { value: 12 } }]);
	});

	it('keeps an expanded selection open when generation fails', async () => {
		const next = vi.fn();
		const states: unknown[] = [];
		const component = new SelectionSlideComponent();
		component.stateChange.subscribe((state) => states.push(state));
		component.load({
			slideId: 'selection',
			type: 'selection',
			data: {
				mode: 'single',
				question: 'Choose a path',
				expansionId: 'build-path',
				options: [
					{ id: 'first', label: 'First' },
					{ id: 'second', label: 'Second' },
				],
			},
			environment: {
				selectionExpansion: vi.fn().mockRejectedValue(new Error('No items are available.')),
			},
			deck: { insertSlides: vi.fn(), next, results: () => [] },
		});
		component.selectOption('first');
		component.handleAction('continue');

		await vi.waitFor(() => expect(states.at(-1)).toMatchObject({
			chrome: { footer: { tone: 'error', detail: 'No items are available.' } },
		}));
		expect(next).not.toHaveBeenCalled();
	});

	it('shows the correct ShortAnswerSlide answer in the footer after a wrong answer', () => {
		const component = new ShortAnswerSlideComponent();
		let footerDetail = '';
		component.stateChange.subscribe((state) => {
			footerDetail = state.chrome?.footer?.detail ?? footerDetail;
		});
		load(component, 'short-answer', {
			question: 'Which noun describes a strong emotional connection?',
			answers: ['bond', 'connection'],
			exactSpelling: true,
		});

		component.setAnswer('friendship');
		component.handleAction('check');

		expect(component.interactionState()).toBe('answered-incorrect');
		expect(footerDetail).toBe('Correct answer: bond');
	});

	it('keeps optional short-answer evidence separate from the scored answer', () => {
		const component = new ShortAnswerSlideComponent();
		const events: unknown[] = [];
		const states: SlideExerciseRuntimeState[] = [];
		component.event.subscribe((event) => events.push(event));
		component.stateChange.subscribe((state) => states.push(state));
		load(component, 'short-answer', {
			question: 'Where is the cafe?',
			answers: ['beside the library'],
			evidencePrompt: 'Copy the words that prove your answer.',
			evidenceRequired: true,
		});

		component.setAnswer('beside the library');
		const answerOnlyAction = states.at(-1)?.chrome?.footer?.primary;
		expect(answerOnlyAction ? answerOnlyAction.disabled : undefined).toBe(true);
		component.setSupportingEvidence('The cafe is beside the library.');
		const completeAction = states.at(-1)?.chrome?.footer?.primary;
		expect(completeAction ? completeAction.disabled : undefined).toBe(false);
		component.handleAction('check');

		expect(events.at(-1)).toMatchObject({
			type: 'answered',
			data: {
				answer: 'beside the library',
				supportingEvidence: 'The cafe is beside the library.',
				correct: true,
			},
		});
	});

	it('accepts any explicitly configured valid ordering', () => {
		const component = new OrderingSlideComponent();
		load(component, 'ordering', {
			items: [
				{ id: 'intro', label: 'Introduction' },
				{ id: 'reason', label: 'Reason' },
				{ id: 'example', label: 'Example' },
			],
			correctOrderIds: ['intro', 'reason', 'example'],
			acceptedOrders: [
				['intro', 'reason', 'example'],
				['intro', 'example', 'reason'],
			],
		});

		component.move('example', -1);
		component.handleAction('check');

		expect(component.interactionState()).toBe('answered-correct');
		expect(component.orderState('example')).toBe('correct');
	});

	it('uses one coherent accepted order for incorrect ordering feedback', () => {
		const component = new OrderingSlideComponent();
		load(component, 'ordering', {
			items: [
				{ id: 'a', label: 'A' },
				{ id: 'b', label: 'B' },
				{ id: 'd', label: 'D' },
				{ id: 'c', label: 'C' },
			],
			correctOrderIds: ['a', 'b', 'c', 'd'],
			acceptedOrders: [
				['a', 'b', 'c', 'd'],
				['b', 'a', 'd', 'c'],
			],
		});

		component.handleAction('check');

		expect(component.interactionState()).toBe('answered-incorrect');
		expect(component.orderedItems().map((item) => component.orderState(item.id))).toEqual([
			'correct',
			'correct',
			'incorrect',
			'incorrect',
		]);
	});

	it('grades reusable map, plan, and diagram labels from positioned JSON targets', () => {
		const component = new LabelingSlideComponent();
		const events: unknown[] = [];
		component.event.subscribe((event) => events.push(event));
		load(component, 'labeling', {
			mode: 'map',
			question: 'Label the two locations.',
			stimulus: {
				type: 'diagram',
				imageSrc: '/assets/maps/campus.svg',
				alt: 'A campus map with two numbered locations.',
			},
			inputMode: 'word-bank',
			wordBank: ['library', 'cafe', 'station'],
			targets: [
				{
					id: 'one',
					label: 'Location 1',
					markerLabel: '1',
					xPercent: 20,
					yPercent: 35,
					answers: ['library'],
				},
				{
					id: 'two',
					label: 'Location 2',
					markerLabel: '2',
					xPercent: 75,
					yPercent: 60,
					answers: ['cafe'],
				},
			],
		});

		component.setAnswer('one', 'library');
		component.setAnswer('two', 'cafe');
		component.handleAction('check');

		expect(component.interactionState()).toBe('answered-correct');
		expect(events.at(-1)).toMatchObject({
			type: 'answered',
			data: { answers: { one: 'library', two: 'cafe' }, correct: true },
		});
	});

	it('rejects labeling targets that cannot be placed or rendered accessibly', () => {
		const component = new LabelingSlideComponent();
		expect(() => load(component, 'labeling', {
			mode: 'diagram',
			question: 'Label the diagram.',
			stimulus: { type: 'diagram', imageSrc: '/assets/diagram.svg', alt: 'A diagram.' },
			targets: [
				{
					id: 'one',
					label: ' ',
					markerLabel: '1',
					xPercent: 101,
					yPercent: 20,
					answers: ['intake'],
				},
			],
		})).toThrow('Labeling target label is required.');
		expect(() => load(component, 'labeling', {
			mode: 'diagram',
			question: 'Label the diagram.',
			stimulus: { type: 'diagram', imageSrc: '/assets/diagram.svg', alt: 'A diagram.' },
			targets: [
				{
					id: 'one',
					label: 'Stage 1',
					markerLabel: '1',
					xPercent: 101,
					yPercent: 20,
					answers: ['intake'],
				},
			],
		})).toThrow('Labeling target coordinates must be between 0 and 100.');
	});

	it('preserves the selected wrong and correct ChoiceSlide states after checking', () => {
		configure();
		const component = TestBed.runInInjectionContext(
			() => new ChoiceSlideComponent(),
		);
		const random = vi.spyOn(Math, 'random').mockReturnValue(0);
		load(component, 'choice', {
			question: 'Choose the correct spelling.',
			options: [
				{ id: 'a', label: 'enviroment' },
				{ id: 'b', label: 'environment' },
			],
			correctOptionIds: ['b'],
		});
		random.mockRestore();

		expect(component.content()?.options.map((option) => option.id)).toEqual([
			'b',
			'a',
		]);
		component.handleShortcut('2');
		expect(component.selectedOptionIds()).toEqual(['a']);
		component.handleAction('check');

		expect(component.interactionState()).toBe('answered-incorrect');
		expect(component.optionState('a')).toBe('incorrect');
		expect(component.optionState('b')).toBe('correct');

		load(component, 'choice', {
			question: 'Choose the correct spelling.',
			options: [
				{ id: 'a', label: 'enviroment' },
				{ id: 'b', label: 'environment' },
			],
			correctOptionIds: ['b'],
		});
		component.selectOption('b');
		component.handleAction('check');

		expect(component.optionState('a')).toBe('neutral');
		expect(component.optionState('b')).toBe('correct');
	});

	it('supports multiple ChoiceSlide selection and a correct result', () => {
		configure();
		const component = TestBed.runInInjectionContext(
			() => new ChoiceSlideComponent(),
		);
		let footerTitle = '';
		component.stateChange.subscribe((state) => {
			footerTitle = state.chrome?.footer?.title ?? footerTitle;
		});
		load(component, 'choice', {
			mode: 'multiple',
			question: 'Choose both formal words.',
			options: [
				{ id: 'a', label: 'purchase' },
				{ id: 'b', label: 'buy' },
				{ id: 'c', label: 'obtain' },
			],
			correctOptionIds: ['a', 'c'],
		});
		component.selectOption('a');
		component.selectOption('c');
		component.handleAction('check');
		expect(component.interactionState()).toBe('answered-correct');
		expect(footerTitle).toBe('Nice!');
	});

	it('supports optional generic speech autoplay and replay for ChoiceSlide', () => {
		const speech = configure();
		const component = TestBed.runInInjectionContext(
			() => new ChoiceSlideComponent(),
		);
		load(component, 'choice', {
			question: 'persistent',
			options: [
				{ id: 'a', label: 'continuing for a long time' },
				{ id: 'b', label: 'ending quickly' },
			],
			correctOptionIds: ['a'],
			speech: { text: 'persistent', autoplay: true, replay: true },
		});

		expect(speech.speak).toHaveBeenCalledWith('persistent', 0.95);
		component.playSpeech();
		expect(speech.speak).toHaveBeenCalledTimes(2);
		component.ngOnDestroy();
		expect(speech.cancel).toHaveBeenCalledOnce();
	});

	it('plays the left MatchingSlide phrase when it is selected', () => {
		const speech = configure();
		const component = TestBed.runInInjectionContext(
			() => new MatchingSlideComponent(),
		);
		load(component, 'matching', {
			pairs: [
				{
					id: 'relationship',
					left: 'establish a relationship',
					right: 'create a new connection',
				},
			],
		});

		component.selectLeft('relationship');

		expect(speech.speak).toHaveBeenCalledWith(
			'establish a relationship',
			0.95,
		);
		component.ngOnDestroy();
		expect(speech.cancel).toHaveBeenCalledOnce();
	});

	it('locks correct MatchingSlide pairs, rejects wrong pairs, and completes only after every pair', () => {
		configure();
		const component = TestBed.runInInjectionContext(
			() => new MatchingSlideComponent(),
		);
		const events: unknown[] = [];
		component.event.subscribe((event) => events.push(event));
		load(component, 'matching', {
			instruction: 'Match each pair.',
			pairs: [
				{ id: 'make', left: 'make', right: 'a decision' },
				{ id: 'take', left: 'take', right: 'a risk' },
			],
		});

		component.selectLeft('make');
		component.selectRight('take');
		expect(component.matchedPairIds()).toEqual([]);
		component.selectLeft('make');
		component.selectRight('make');
		expect(component.matchedPairIds()).toEqual(['make']);
		expect(component.matchedAssignments()).toEqual({ make: 'make' });
		expect(component.interactionState()).toBe('idle');
		component.selectLeft('take');
		component.selectRight('take');
		expect(component.interactionState()).toBe('answered-correct');
		expect(events.at(-1)).toMatchObject({
			type: 'answered',
			data: { correct: true, assignments: { make: 'make', take: 'take' } },
		});
	});

	it('suppresses pair-level error feedback when MatchingSlide feedback is deferred', () => {
		configure();
		const component = TestBed.runInInjectionContext(
			() => new MatchingSlideComponent(),
		);
		const events: unknown[] = [];
		component.event.subscribe((event) => events.push(event));
		load(component, 'matching', {
			feedbackMode: 'on-complete',
			pairs: [
				{ id: 'make', left: 'make', right: 'a decision' },
				{ id: 'take', left: 'take', right: 'a risk' },
			],
		});

		component.selectLeft('make');
		component.selectRight('take');
		expect(component.wrongPair()).toBeNull();
		expect(component.pairFeedback()).toBe('');
		expect(events).toEqual([]);
	});

	it('validates every ClassificationSlide category assignment', () => {
		configure();
		const component = TestBed.runInInjectionContext(
			() => new ClassificationSlideComponent(),
		);
		const random = vi.spyOn(Math, 'random').mockReturnValue(0);
		load(component, 'classification', {
			instruction: 'Classify the words.',
			categories: [
				{ id: 'animal', label: 'Animal' },
				{ id: 'plant', label: 'Plant' },
			],
			items: [
				{ id: 'paw', label: 'paw', correctCategoryId: 'animal' },
				{ id: 'root', label: 'root', correctCategoryId: 'plant' },
			],
		});
		random.mockRestore();
		expect(component.content()?.items.map((item) => item.id)).toEqual([
			'root',
			'paw',
		]);
		component.assignDropped('paw', 'animal');
		component.assignDropped('root', 'plant');
		component.handleAction('check');
		expect(component.interactionState()).toBe('answered-correct');
		expect(component.assignmentState('paw')).toBe('correct');
	});

	it('assigns and reassigns ClassificationSlide items dropped into categories', () => {
		configure();
		const component = TestBed.runInInjectionContext(
			() => new ClassificationSlideComponent(),
		);
		const states: unknown[] = [];
		component.stateChange.subscribe((state) => states.push(state));
		const random = vi.spyOn(Math, 'random').mockReturnValue(0.999);
		load(component, 'classification', {
			categories: [
				{ id: 'animal', label: 'Animal' },
				{ id: 'plant', label: 'Plant' },
			],
			items: [
				{ id: 'paw', label: 'paw', correctCategoryId: 'animal' },
				{ id: 'root', label: 'root', correctCategoryId: 'plant' },
			],
		});
		random.mockRestore();
		expect(component.unassignedItems().map((item) => item.id)).toEqual([
			'paw',
			'root',
		]);

		component.assignDropped('paw', 'plant');
		expect(component.assignments()).toEqual({ paw: 'plant' });
		expect(component.assignmentState('paw')).toBe('neutral');
		expect(component.unassignedItems().map((item) => item.id)).toEqual([
			'root',
		]);
		expect(component.assignedItems('plant').map((item) => item.id)).toEqual([
			'paw',
		]);
		expect(component.interactionState()).toBe('idle');

		component.assignDropped('paw', 'animal');
		expect(component.assignedItems('plant')).toEqual([]);
		expect(component.assignedItems('animal').map((item) => item.id)).toEqual([
			'paw',
		]);
		component.unassignDropped('paw');
		expect(component.assignments()).toEqual({});
		expect(component.unassignedItems().map((item) => item.id)).toEqual([
			'paw',
			'root',
		]);
		expect(states.at(-1)).toMatchObject({
			chrome: { footer: { primary: { disabled: true } } },
		});
		component.assignDropped('paw', 'animal');
		component.assignDropped('root', 'animal');
		expect(component.assignments()).toEqual({ paw: 'animal', root: 'animal' });
		expect(states.at(-1)).toMatchObject({
			chrome: { footer: { primary: { disabled: false } } },
		});
		component.handleAction('check');
		expect(component.assignmentState('paw')).toBe('correct');
		expect(component.assignmentState('root')).toBe('incorrect');
	});

	it('validates ClozeSlide blanks independently, including variants and word limits', () => {
		configure();
		const component = TestBed.runInInjectionContext(
			() => new ClozeSlideComponent(),
		);
		load(component, 'cloze', {
			instruction: 'Complete the sentence.',
			content: '{{energy}} can reduce {{pollution}}.',
			blanks: [
				{ id: 'energy', answers: ['renewable energy'], wordLimit: 2 },
				{
					id: 'pollution',
					answers: ['emissions', 'pollution'],
					wordLimit: 1,
				},
			],
		});
		component.setAnswer('energy', 'renewable energy');
		component.setAnswer('pollution', ' emissions ');
		component.handleAction('check');
		expect(component.interactionState()).toBe('answered-correct');
		expect(component.blankState('energy')).toBe('correct');

		load(component, 'cloze', {
			content: '{{energy}}',
			blanks: [
				{ id: 'energy', answers: ['renewable energy'], wordLimit: 1 },
			],
		});
		component.setAnswer('energy', 'renewable energy');
		component.handleAction('check');
		expect(component.blankState('energy')).toBe('incorrect');
	});

	it('reveals shuffled answer options for a free-text ClozeSlide on request', () => {
		configure();
		const component = TestBed.runInInjectionContext(
			() => new ClozeSlideComponent(),
		);
		load(component, 'cloze', {
			content: '{{first}} power reduces {{second}} and {{third}}.',
			blanks: [
				{ id: 'first', answers: ['Renewable'] },
				{ id: 'second', answers: ['emissions'] },
				{ id: 'third', answers: ['pollution'] },
			],
		});

		expect(component.answerOptionsVisible()).toBe(false);
		component.toggleAnswerOptions();

		expect(component.answerOptionsVisible()).toBe(true);
		expect(component.answerOptions()).toEqual([
			'emissions',
			'pollution',
			'Renewable',
		]);
	});

	it('autoplays and tracks whole-sentence speech for ClozeSlide replay', () => {
		const speech = configure();
		const component = TestBed.runInInjectionContext(
			() => new ClozeSlideComponent(),
		);
		load(component, 'cloze', {
			content: 'Use {{source}} today.',
			speech: { text: 'Use renewable energy today.' },
			blanks: [{ id: 'source', answers: ['renewable energy'] }],
		});

		expect(speech.speak).toHaveBeenCalledWith(
			'Use renewable energy today.',
			0.95,
			expect.objectContaining({
				onStart: expect.any(Function),
				onWordBoundary: expect.any(Function),
				onEnd: expect.any(Function),
			}),
		);
		const observer = speech.speak.mock.calls[0][2] as {
			onStart: () => void;
			onWordBoundary: (charIndex: number) => void;
			onEnd: () => void;
		};
		expect(component.playbackCharIndex()).toBeNull();
		observer.onStart();
		expect(component.playbackActive()).toBe(true);
		observer.onWordBoundary(4);
		expect(component.playbackCharIndex()).toBe(4);
		observer.onEnd();
		expect(component.playbackActive()).toBe(false);
		expect(component.playbackCharIndex()).toBe(27);

		expect(component.playSentence()).toBe(true);
		expect(speech.speak).toHaveBeenCalledTimes(2);
		component.ngOnDestroy();
		expect(speech.cancel).toHaveBeenCalled();
	});

	it('advances across ClozeSlide blanks when the word bank is the only input', () => {
		configure();
		const component = TestBed.runInInjectionContext(
			() => new ClozeSlideComponent(),
		);
		load(component, 'cloze', {
			content: '{{first}} power reduces {{second}}.',
			inputMode: 'word-bank',
			wordBank: ['Renewable', 'emissions'],
			blanks: [
				{ id: 'first', answers: ['Renewable'] },
				{ id: 'second', answers: ['emissions'] },
			],
		});

		component.useWord('Renewable');
		component.useWord('emissions');
		expect(component.answers()).toEqual({
			first: 'Renewable',
			second: 'emissions',
		});
		component.handleAction('check');
		expect(component.interactionState()).toBe('answered-correct');
	});

	it('fills the active select-mode ClozeSlide blank from numbered choices', () => {
		configure();
		const component = TestBed.runInInjectionContext(
			() => new ClozeSlideComponent(),
		);
		load(component, 'cloze', {
			content: '{{first}} power reduces {{second}}.',
			inputMode: 'select',
			wordBank: ['Renewable', 'emissions', 'pollution'],
			blanks: [
				{ id: 'first', answers: ['Renewable'] },
				{ id: 'second', answers: ['emissions'] },
			],
		});

		component.selectChoice('Renewable');
		expect(component.answers()).toEqual({ first: 'Renewable' });
		expect(component.choiceState('Renewable')).toBe('selected');

		component.focusBlank('second');
		expect(component.choiceState('Renewable')).toBe('neutral');
		component.selectChoice('emissions');
		expect(component.answers()).toEqual({
			first: 'Renewable',
			second: 'emissions',
		});

		component.handleAction('check');
		expect(component.interactionState()).toBe('answered-correct');
		expect(component.choiceState('emissions')).toBe('correct');
	});

	it('honors exact spelling and rejects unrenderable AnswerField configurations', () => {
		configure();
		const component = TestBed.runInInjectionContext(
			() => new ClozeSlideComponent(),
		);
		load(component, 'cloze', {
			content: '{{term}}',
			blanks: [
				{ id: 'term', answers: ['environment'], exactSpelling: true },
			],
		});
		component.setAnswer('term', 'Environment.');
		component.handleAction('check');
		expect(component.interactionState()).toBe('answered-incorrect');

		expect(() =>
			load(TestBed.runInInjectionContext(() => new ClozeSlideComponent()), 'cloze', {
				content: '{{first}} and {{first}}',
				blanks: [
					{ id: 'first', answers: ['one'] },
					{ id: 'second', answers: ['two'] },
				],
			}),
		).toThrow('placeholders');

		expect(() =>
			load(TestBed.runInInjectionContext(() => new ClozeSlideComponent()), 'cloze', {
				content: 'Use {{term}} today.',
				speech: { text: 'Use a different sentence.' },
				blanks: [{ id: 'term', answers: ['renewable energy'] }],
			}),
		).toThrow('completed sentence');

		expect(() =>
			load(
				new StructuredCompletionSlideComponent(),
				'structured-completion',
				{
					layout: 'table',
					fields: [
						{ id: 'visible', answers: ['one'] },
						{ id: 'missing', answers: ['two'] },
					],
					rows: [{ id: 'row', cells: [{ fieldId: 'visible' }] }],
				},
			),
		).toThrow('render every answer field once');
	});

	it('checks only the requested WordFormationSlide forms', () => {
		const component = new WordFormationSlideComponent();
		load(component, 'word-formation', {
			baseWord: 'create',
			fields: [
				{ id: 'noun', partOfSpeech: 'noun', answers: ['creation'] },
				{
					id: 'adjective',
					partOfSpeech: 'adjective',
					answers: ['creative'],
				},
			],
		});
		component.setAnswer('noun', 'creation');
		component.setAnswer('adjective', 'creative');
		component.handleAction('check');
		expect(component.interactionState()).toBe('answered-correct');
	});

	it('keeps original, learner correction, answer, and explanation in ErrorCorrectionSlide', () => {
		const component = new ErrorCorrectionSlideComponent();
		load(component, 'error-correction', {
			original: 'This is an economic car to run.',
			answers: ['This is an economical car to run.'],
			explanation: 'Economical means inexpensive to operate.',
		});
		component.setCorrection('This is an economical car to run.');
		component.handleAction('check');
		expect(component.interactionState()).toBe('answered-correct');
		expect(component.content()?.original).toContain('economic car');
		expect(component.correction()).toContain('economical car');
	});

	it('shares replay-limited audio control with DictationSlide and enforces exact spelling', () => {
		configure();
		const audioControl = new SlideAudioControlComponent();
		audioControl.maxReplays = 1;
		const play = vi.fn().mockResolvedValue(undefined);
		const audio = {
			play,
			currentTime: 2,
			playbackRate: 1,
			preservesPitch: false,
		} as unknown as HTMLAudioElement;
		audioControl.play(audio, 0.85);
		audioControl.play(audio);
		expect(play).toHaveBeenCalledTimes(1);
		expect(audio.playbackRate).toBe(0.85);
		expect(audio.preservesPitch).toBe(true);

		const component = TestBed.runInInjectionContext(
			() => new DictationSlideComponent(),
		);
		load(component, 'dictation', {
			audio: '/audio/example.mp3',
			answer: 'environment',
			maxReplays: 1,
		});
		component.setAnswer('Environment');
		component.handleAction('check');
		expect(component.interactionState()).toBe('answered-incorrect');
	});

	it('supports browser speech as the playback source for word dictation', () => {
		const speech = configure();
		const component = TestBed.runInInjectionContext(
			() => new DictationSlideComponent(),
		);
		load(component, 'dictation', {
			speech: { text: 'environment', autoplay: true, replay: true },
			answer: 'environment',
			acceptedAnswers: ['environment'],
			caseSensitive: false,
		});

		expect(speech.speak).toHaveBeenCalledWith('environment', 0.95);
		expect(component.playSpeech('slow')).toBe(true);
		expect(speech.speak).toHaveBeenLastCalledWith(
			'environment',
			0.95,
			undefined,
			undefined,
			'slow',
		);
		component.setAnswer('Environment');
		component.handleAction('check');
		expect(component.interactionState()).toBe('answered-correct');
	});

	it('shows the configured dictation definition in the footer after any checked answer', () => {
		configure();
		const definition = 'the natural world in which people, animals, and plants live';

		for (const { answer, tone } of [
			{ answer: 'environment', tone: 'success' },
			{ answer: 'enviroment', tone: 'error' },
		] as const) {
			const component = TestBed.runInInjectionContext(
				() => new DictationSlideComponent(),
			);
			const states: unknown[] = [];
			component.stateChange.subscribe((state) => states.push(state));
			load(component, 'dictation', {
				audio: '/audio/environment.mp3',
				answer: 'environment',
				definition: `  ${definition}  `,
			});

			component.setAnswer(answer);
			component.handleAction('check');

			expect(states.at(-1)).toMatchObject({
				chrome: { footer: { tone, detail: definition } },
			});
			component.ngOnDestroy();
		}
	});

	it('submits model-only RewriteSlide responses without false scoring', () => {
		const component = new RewriteSlideComponent();
		const events: unknown[] = [];
		component.event.subscribe((event) => events.push(event));
		load(component, 'rewrite', {
			original: 'People use less energy now.',
			modelAnswer: 'Less energy is used now.',
		});

		component.setResponse('Energy use has fallen.');
		component.handleAction('submit');
		expect(component.interactionState()).toBe('revealed');
		expect(events.at(-1)).toMatchObject({
			type: 'submitted',
			data: { response: 'Energy use has fallen.' },
		});
	});

	it('loads target-grammar RewriteSlide configurations', () => {
		const component = new RewriteSlideComponent();

		expect(() =>
			load(component, 'rewrite', {
				mode: 'target-grammar',
				original: "Tom's normal Saturday activity is football.",
				instruction: 'Rewrite the idea as a present simple habit.',
				modelAnswer: 'Tom plays football every Saturday.',
				acceptedAnswers: ['Tom plays football every Saturday.'],
			}),
		).not.toThrow();
		expect(component.content()?.mode).toBe('target-grammar');
	});

	it('moves SpeakingResponseSlide through recording and enables submission after stopping', async () => {
		configure();
		const component = TestBed.runInInjectionContext(
			() => new SpeakingResponseSlideComponent(),
		);
		load(component, 'speaking-response', {
			mode: 'part1',
			prompt: 'What technology do you use?',
		});
		await component.startRecording();
		expect(component.recordingState()).toBe('recording');
		await component.stopRecording();
		expect(component.recordingState()).toBe('recorded');
		expect(component.recordingUrl()).toBe('blob:recording');
	});

	it('preserves submitted speaking audio and notes while allowing playback', async () => {
		configure();
		const fixture = TestBed.createComponent(SpeakingResponseSlideComponent);
		const component = fixture.componentInstance;
		const recorder = TestBed.inject(LocalAudioRecorderService);
		const submitted = vi.fn();
		component.event.subscribe(submitted);
		load(component, 'speaking-response', {
			mode: 'part1',
			prompt: 'What do you eat for breakfast?',
			notesEnabled: true,
		});
		fixture.detectChanges();
		const notes = fixture.nativeElement.querySelector('textarea') as HTMLTextAreaElement;
		notes.value = 'Bread and water.';
		notes.dispatchEvent(new Event('input'));
		await component.startRecording();
		await component.stopRecording();
		component.handleAction('submit');
		fixture.detectChanges();

		expect(notes.disabled).toBe(true);
		expect((fixture.nativeElement.querySelector('voco-secondary-button button') as HTMLButtonElement).disabled).toBe(true);
		vi.mocked(recorder.stop).mockResolvedValueOnce({ blob: new Blob(['replacement']), url: 'blob:replacement' });
		notes.value = 'Different notes.';
		notes.dispatchEvent(new Event('input'));
		await component.startRecording();
		await component.stopRecording();
		component.handleAction('submit');
		fixture.detectChanges();

		expect(recorder.start).toHaveBeenCalledOnce();
		expect(recorder.stop).toHaveBeenCalledOnce();
		expect(component.recordingUrl()).toBe('blob:recording');
		expect(component.notes()).toBe('Bread and water.');
		expect(submitted).toHaveBeenCalledExactlyOnceWith({
			type: 'submitted',
			data: { recordingBlob: expect.any(Blob), notes: 'Bread and water.', mode: 'part1' },
		});
		const playback = fixture.nativeElement.querySelector('audio') as HTMLAudioElement;
		expect(playback.getAttribute('src')).toBe('blob:recording');
		expect(playback.controls).toBe(true);
	});

	it('counts and persists WritingResponseSlide responses in the emitted result', () => {
		const component = new WritingResponseSlideComponent();
		const events: unknown[] = [];
		component.event.subscribe((event) => events.push(event));
		load(component, 'writing-response', {
			mode: 'sentence',
			prompt: 'Write one sentence.',
		});
		component.setResponse('Energy use declined significantly.');
		expect(component.wordCount()).toBe(4);
		component.handleAction('submit');
		expect(events.at(-1)).toMatchObject({
			type: 'submitted',
			data: {
				response: 'Energy use declined significantly.',
				wordCount: 4,
			},
		});
	});
});
