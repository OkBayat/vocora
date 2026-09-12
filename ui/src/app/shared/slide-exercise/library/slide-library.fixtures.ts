import type { SlideExerciseSlide } from '../slide-exercise.models';

const SILENT_AUDIO =
	'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
const SIMPLE_DIAGRAM =
	'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="640" height="220" viewBox="0 0 640 220"%3E%3Crect width="640" height="220" rx="24" fill="%23effbf3"/%3E%3Cg fill="none" stroke="%23258a49" stroke-width="6"%3E%3Cpath d="M100 110h130M275 110h130M450 110h90"/%3E%3C/g%3E%3Cg fill="%23258a49"%3E%3Ccircle cx="80" cy="110" r="24"/%3E%3Ccircle cx="255" cy="110" r="24"/%3E%3Ccircle cx="430" cy="110" r="24"/%3E%3Ccircle cx="560" cy="110" r="24"/%3E%3C/g%3E%3C/svg%3E';

export const REUSABLE_SLIDE_FIXTURES: readonly SlideExerciseSlide[] = [
	{
		id: 'showcase-adaptive-conversation',
		type: 'adaptive-conversation',
		data: {
			mode: 'guided-dialogue',
			goal: 'Exchange simple information about a familiar meal.',
			openingPrompt: 'What do you eat in the morning?',
			minimumTurns: 2,
			maximumTurns: 3,
			responseSeconds: 30,
			learnerLevel: 'beginner',
			targetVocabulary: ['bread', 'rice', 'water', 'milk', 'eat', 'drink'],
			questionConstraints: { maximumWords: 14, oneQuestionOnly: true, avoidAnswerDisclosure: true },
		},
	},
	{
		id: 'showcase-teaching-card',
		type: 'teaching-card',
		data: {
			mode: 'word',
			instruction: 'Explore the word',
			title: 'adaptable',
			markdown: [
				'### Adjective · /əˈdæptəbəl/',
				'**adaptable** means able to change for a new situation.',
				'',
				'#### Useful patterns',
				'- highly adaptable',
				'- adaptable approach',
				'',
				'#### Example',
				'The design is *adaptable* to small spaces.',
			].join('\n'),
		},
	},
	{
		id: 'showcase-selection',
		type: 'selection',
		data: {
			mode: 'single',
			instruction: 'Choose one option.',
			question: 'How would you like to continue?',
			options: [
				{ id: 'guided', label: 'Guided practice', description: 'Work with additional support.' },
				{ id: 'independent', label: 'Independent practice', description: 'Work without additional support.' },
			],
		},
	},
	{
		id: 'showcase-number-input',
		type: 'number-input',
		data: {
			instruction: 'Choose the size of this practice.',
			question: 'How many words would you like to practice?',
			label: 'Number of words',
			min: 1,
			max: 50,
			step: 1,
			initialValue: 10,
		},
	},
	{
		id: 'showcase-choice',
		type: 'choice',
		data: {
			mode: 'correct-spelling',
			question: 'Choose the correct spelling.',
			options: [
				{ id: 'a', label: 'enviroment' },
				{ id: 'b', label: 'environment' },
				{ id: 'c', label: 'enviornment' },
			],
			correctOptionIds: ['b'],
			explanation: 'Environment contains the sequence “n-m-e-n-t”.',
		},
	},
	{
		id: 'showcase-truth',
		type: 'truth',
		data: {
			mode: 'true-false-not-given',
			statement: 'The passage says every city expanded after 1990.',
			correctOptionId: 'not-given',
			stimulus: {
				type: 'text',
				content: 'Read the short report.',
				sections: [
					{
						id: 'A',
						title: 'A',
						content:
							'Rivergate grew steadily from 1990 to 2010 as new transport links opened.',
					},
					{
						id: 'B',
						title: 'B',
						content:
							'The report compares Rivergate with two coastal cities but gives no dates for their growth.',
					},
				],
			},
		},
	},
	{
		id: 'showcase-matching',
		type: 'matching',
		data: {
			instruction: 'Match each verb with its natural partner.',
			pairs: [
				{ id: 'make', left: 'make', right: 'a decision' },
				{ id: 'take', left: 'take', right: 'a risk' },
				{ id: 'set', left: 'set', right: 'a goal' },
			],
			shuffleRight: true,
			feedbackMode: 'immediate',
		},
	},
	{
		id: 'showcase-classification',
		type: 'classification',
		data: {
			instruction: 'Classify each feature.',
			categories: [
				{ id: 'animal', label: 'Animal' },
				{ id: 'plant', label: 'Plant' },
			],
			items: [
				{ id: 'paw', label: 'paw', correctCategoryId: 'animal' },
				{ id: 'petal', label: 'petal', correctCategoryId: 'plant' },
				{ id: 'beak', label: 'beak', correctCategoryId: 'animal' },
				{ id: 'root', label: 'root', correctCategoryId: 'plant' },
			],
		},
	},
	{
		id: 'showcase-ordering',
		type: 'ordering',
		data: {
			mode: 'process',
			instruction: 'Put the recycling stages in order.',
			stimulus: {
				type: 'diagram',
				imageSrc: SIMPLE_DIAGRAM,
				alt: 'Four connected stages in a process',
			},
			items: [
				{ id: 'sort', label: 'Sort the material' },
				{ id: 'collect', label: 'Collect used material' },
				{ id: 'manufacture', label: 'Manufacture a new product' },
				{ id: 'clean', label: 'Clean the material' },
			],
			correctOrderIds: ['collect', 'sort', 'clean', 'manufacture'],
		},
	},
	{
		id: 'showcase-labeling',
		type: 'labeling',
		data: {
			mode: 'diagram',
			instruction: 'Label the marked stages.',
			question: 'Complete the process diagram.',
			stimulus: {
				type: 'diagram',
				imageSrc: SIMPLE_DIAGRAM,
				alt: 'Four connected stages with two numbered markers.',
			},
			inputMode: 'word-bank',
			wordBank: ['collect', 'sort', 'clean'],
			targets: [
				{
					id: 'first-stage',
					label: 'Stage 1',
					markerLabel: '1',
					xPercent: 12.5,
					yPercent: 50,
					answers: ['collect'],
				},
				{
					id: 'second-stage',
					label: 'Stage 2',
					markerLabel: '2',
					xPercent: 40,
					yPercent: 50,
					answers: ['sort'],
				},
			],
		},
	},
	{
		id: 'showcase-cloze',
		type: 'cloze',
		data: {
			inputMode: 'word-bank',
			instruction: 'Complete both gaps.',
			content: '{{energy}} can reduce harmful {{output}}.',
			wordBank: ['renewable energy', 'emissions', 'traffic'],
			blanks: [
				{
					id: 'energy',
					label: 'Energy source',
					answers: ['renewable energy'],
					wordLimit: 2,
				},
				{
					id: 'output',
					label: 'Harmful output',
					answers: ['emissions'],
					wordLimit: 1,
				},
			],
		},
	},
	{
		id: 'showcase-structured-completion',
		type: 'structured-completion',
		data: {
			layout: 'table',
			title: 'Project plan',
			instruction: 'Complete the table.',
			columns: ['Stage', 'Owner'],
			fields: [
				{ id: 'research-owner', label: 'Owner', answers: ['Mina'] },
				{ id: 'review-owner', label: 'Owner', answers: ['Jon'] },
			],
			rows: [
				{
					id: 'research',
					cells: [
						{ text: 'Research' },
						{ fieldId: 'research-owner' },
					],
				},
				{
					id: 'review',
					cells: [{ text: 'Review' }, { fieldId: 'review-owner' }],
				},
			],
		},
	},
	{
		id: 'showcase-short-answer',
		type: 'short-answer',
		data: {
			question: 'What word means “a period of one hundred years”?',
			answers: ['century'],
			firstLetterHint: 'c',
			characterCount: 7,
			exactSpelling: true,
		},
	},
	{
		id: 'showcase-word-formation',
		type: 'word-formation',
		data: {
			mode: 'family',
			baseWord: 'create',
			fields: [
				{ id: 'noun', partOfSpeech: 'noun', answers: ['creation'] },
				{
					id: 'adjective',
					partOfSpeech: 'adjective',
					answers: ['creative'],
				},
			],
		},
	},
	{
		id: 'showcase-error-correction',
		type: 'error-correction',
		data: {
			mode: 'sentence-correction',
			category: 'word choice',
			original: 'This is an economic car to run.',
			answers: ['This is an economical car to run.'],
			explanation: 'Economical means inexpensive to operate.',
		},
	},
	{
		id: 'showcase-rewrite',
		type: 'rewrite',
		data: {
			mode: 'noun-to-verb',
			original: 'There was a significant increase in attendance.',
			instruction: 'Rewrite using a verb and an adverb.',
			acceptedAnswers: ['Attendance increased significantly.'],
			requiredFragments: ['increased', 'significantly'],
			targetWords: ['increase', 'significantly'],
			modelAnswer: 'Attendance increased significantly.',
		},
	},
	{
		id: 'showcase-pronunciation',
		type: 'pronunciation',
		data: {
			mode: 'sound-choice',
			question: 'Which sound begins “think”?',
			options: [
				{ id: 'voiceless', label: '/θ/' },
				{ id: 'voiced', label: '/ð/' },
			],
			correctOptionId: 'voiceless',
			stimulus: {
				type: 'audio',
				src: SILENT_AUDIO,
				transcript: 'think',
				maxReplays: 2,
			},
		},
	},
	{
		id: 'showcase-dictation',
		type: 'dictation',
		data: {
			mode: 'phrase',
			instruction: 'Listen and type the phrase.',
			audio: SILENT_AUDIO,
			answer: 'renewable energy',
			maxReplays: 3,
		},
	},
	{
		id: 'showcase-speaking-response',
		type: 'speaking-response',
		data: {
			mode: 'cue-card',
			prompt: 'Describe a useful device you own.',
			promptBullets: ['what it is', 'how you use it', 'why it is useful'],
			prepSeconds: 60,
			speakingSeconds: 120,
			targetVocabulary: ['device', 'access', 'user-friendly'],
			notesEnabled: true,
		},
	},
	{
		id: 'showcase-writing-response',
		type: 'writing-response',
		data: {
			mode: 'task1-chart',
			prompt: 'Describe the most significant trends.',
			stimulus: {
				type: 'chart',
				alt: 'A chart placeholder for development testing',
				caption:
					'Replace with a configured chart image in course content.',
			},
			timerSeconds: 1200,
			recommendedMinimumWords: 150,
			targetVocabulary: ['increase', 'decline', 'remain stable', 'peak'],
			planningNotes: true,
			modelAnswer:
				'The main measure rose steadily before reaching a peak, while the secondary measure remained stable.',
		},
	},
];
