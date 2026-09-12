import type { WritingFeedbackContext } from '../writing-feedback-contracts';

export type SlideInteractionState =
	'idle' | 'answered-correct' | 'answered-incorrect' | 'revealed';

export interface TextStimulusSection {
	readonly id: string;
	readonly title?: string;
	readonly content: string;
}

export interface TextStimulus {
	readonly type: 'text';
	readonly content: string;
	readonly sections?: readonly TextStimulusSection[];
}

export interface AudioStimulus {
	readonly type: 'audio';
	readonly src: string;
	readonly transcript?: string;
	readonly maxReplays?: number;
}

export interface DialogueStimulusTurn {
	readonly speaker: string;
	readonly text: string;
	readonly voiceIndex?: number;
}

export interface DialogueStimulus {
	readonly type: 'dialogue';
	readonly turns: readonly DialogueStimulusTurn[];
	readonly maxReplays?: number;
}

export interface ImageStimulus {
	readonly type: 'image';
	readonly src: string;
	readonly alt: string;
	readonly caption?: string;
}

export interface ChartStimulus {
	readonly type: 'chart';
	readonly imageSrc?: string;
	readonly alt?: string;
	readonly caption?: string;
}

export interface DiagramStimulus {
	readonly type: 'diagram';
	readonly imageSrc: string;
	readonly alt: string;
	readonly caption?: string;
}

export type SlideStimulus =
	| TextStimulus
	| AudioStimulus
	| DialogueStimulus
	| ImageStimulus
	| ChartStimulus
	| DiagramStimulus;

export interface SlideTypeData {
	readonly instruction?: string;
	readonly stimulus?: SlideStimulus;
	readonly explanation?: string;
}

export interface TeachingBlock {
	readonly kind:
		'word' | 'comparison' | 'correction' | 'patterns' | 'example' | 'note';
	readonly title?: string;
	readonly content: string;
	readonly secondary?: string;
}

export interface TeachingCardData extends SlideTypeData {
	readonly mode: 'word' | 'usage' | 'contrast' | 'rule' | 'warning' | 'tip';
	readonly title: string;
	readonly markdown?: string;
	readonly blocks?: readonly TeachingBlock[];
}

export interface SlideOption {
	readonly id: string;
	readonly label: string;
	readonly description?: string;
}

export type SelectionSlideMode = 'single' | 'multiple';

export interface SelectionSlideData extends SlideTypeData {
	readonly mode: SelectionSlideMode;
	readonly question: string;
	readonly options: readonly SlideOption[];
	readonly expansionId?: string;
}

export interface NumberInputSlideData extends SlideTypeData {
	readonly question: string;
	readonly label?: string;
	readonly min: number;
	readonly max: number;
	readonly step: number;
	readonly initialValue: number;
	readonly expansionId?: string;
}

export interface SpeechPlaybackConfig {
	readonly text: string;
	readonly autoplay?: boolean;
	readonly replay?: boolean;
}

export type ChoiceSlideMode =
	| 'single'
	| 'multiple'
	| 'meaning'
	| 'part-of-speech'
	| 'synonym'
	| 'antonym'
	| 'correct-spelling'
	| 'best-word'
	| 'odd-one-out';

export interface ChoiceSlideData extends SlideTypeData {
	readonly mode?: ChoiceSlideMode;
	readonly question: string;
	readonly options: readonly SlideOption[];
	readonly correctOptionIds: readonly string[];
	readonly speech?: SpeechPlaybackConfig;
}

export type TruthSlideMode =
	| 'true-false'
	| 'true-false-not-given'
	| 'yes-no-not-given'
	| 'agree-disagree';

export interface TruthSlideData extends SlideTypeData {
	readonly mode: TruthSlideMode;
	readonly statement: string;
	readonly correctOptionId: string;
	readonly options?: readonly SlideOption[];
}

export interface MatchingPair {
	readonly id: string;
	readonly left: string;
	readonly right: string;
	readonly rightId?: string;
}

export interface MatchingSlideData extends SlideTypeData {
	readonly mode?:
		| 'definition'
		| 'synonym'
		| 'antonym'
		| 'collocation'
		| 'word-family'
		| 'person-opinion'
		| 'sentence-ending'
		| 'heading-section'
		| 'term-example';
	readonly pairs: readonly MatchingPair[];
	readonly shuffleRight?: boolean;
	readonly feedbackMode?: 'immediate' | 'on-complete';
	readonly allowManyToOne?: boolean;
}

export interface ClassificationCategory extends SlideOption {}

export interface ClassificationItem extends SlideOption {
	readonly correctCategoryId: string;
}

export interface ClassificationSlideData extends SlideTypeData {
	readonly mode?:
		| 'positive-negative'
		| 'formal-informal'
		| 'countable-uncountable'
		| 'part-of-speech'
		| 'possible-impossible'
		| 'linking-word-function'
		| 'letter-language-function'
		| 'sound'
		| 'custom';
	readonly categories: readonly ClassificationCategory[];
	readonly items: readonly ClassificationItem[];
}

export interface OrderingItem extends SlideOption {}

export interface OrderingSlideData extends SlideTypeData {
	readonly mode?:
		'sequence' | 'chronology' | 'severity' | 'adjective-order' | 'process';
	readonly items: readonly OrderingItem[];
	readonly correctOrderIds: readonly string[];
	readonly acceptedOrders?: readonly (readonly string[])[];
}

export interface LabelingTarget extends AnswerField {
	readonly label: string;
	readonly markerLabel: string;
	readonly xPercent: number;
	readonly yPercent: number;
}

export interface LabelingSlideData extends SlideTypeData {
	readonly mode: 'map' | 'plan' | 'diagram';
	readonly question: string;
	readonly inputMode?: 'text' | 'word-bank';
	readonly wordBank?: readonly string[];
	readonly targets: readonly LabelingTarget[];
}

export interface AnswerField {
	readonly id: string;
	readonly label?: string;
	readonly answers: readonly string[];
	readonly definitions?: readonly string[];
	readonly wordLimit?: number;
	readonly caseSensitive?: boolean;
	readonly punctuationSensitive?: boolean;
	readonly exactSpelling?: boolean;
}

export interface ClozeSlideData extends SlideTypeData {
	readonly content: string;
	readonly inputMode?: 'text' | 'word-bank' | 'select';
	readonly showOptions?: boolean;
	readonly speech?: Pick<SpeechPlaybackConfig, 'text'>;
	readonly blanks: readonly AnswerField[];
	readonly wordBank?: readonly string[];
}

export interface StructuredCompletionCell {
	readonly text?: string;
	readonly fieldId?: string;
}

export interface StructuredCompletionRow {
	readonly id: string;
	readonly cells: readonly StructuredCompletionCell[];
}

export interface StructuredCompletionSlideData extends SlideTypeData {
	readonly title?: string;
	readonly layout: 'form' | 'table' | 'notes' | 'flowchart' | 'timeline';
	readonly fields: readonly AnswerField[];
	readonly columns?: readonly string[];
	readonly rows?: readonly StructuredCompletionRow[];
}

export interface ShortAnswerSlideData extends SlideTypeData {
	readonly question: string;
	readonly answers: readonly string[];
	readonly firstLetterHint?: string;
	readonly characterCount?: number;
	readonly exactSpelling?: boolean;
	readonly evidencePrompt?: string;
	readonly evidenceRequired?: boolean;
}

export interface WordFormationField extends AnswerField {
	readonly partOfSpeech: string;
}

export interface WordFormationSlideData extends SlideTypeData {
	readonly mode?:
		| 'family'
		| 'target-part-of-speech'
		| 'prefix'
		| 'suffix'
		| 'negative-form'
		| 'base-word'
		| 'transitive-intransitive';
	readonly baseWord: string;
	readonly fields: readonly WordFormationField[];
}

export interface ErrorCorrectionSlideData extends SlideTypeData {
	readonly mode?:
		| 'select-and-replace'
		| 'inline-edit'
		| 'sentence-correction'
		| 'paragraph-correction';
	readonly category?: string;
	readonly original: string;
	readonly answers: readonly string[];
}

export interface RewriteSlideData extends SlideTypeData {
	readonly mode?:
		| 'paraphrase'
		| 'target-grammar'
		| 'target-vocabulary'
		| 'sentence-transformation'
		| 'noun-to-verb'
		| 'verb-to-noun'
		| 'formalize'
		| 'linking-word'
		| 'synonym-replacement';
	readonly original: string;
	readonly acceptedAnswers?: readonly string[];
	readonly requiredFragments?: readonly string[];
	readonly targetWords?: readonly string[];
	readonly modelAnswer?: string;
}

export interface PronunciationSlideData extends SlideTypeData {
	readonly mode:
		| 'phoneme-match'
		| 'sound-choice'
		| 'word-stress'
		| 'listen-and-identify'
		| 'ipa-match'
		| 'repeat';
	readonly question: string;
	readonly word?: string;
	readonly options?: readonly SlideOption[];
	readonly correctOptionId?: string;
	readonly speech?: Pick<SpeechPlaybackConfig, 'text'>;
	readonly recording?: {
		readonly itemId: string;
		readonly promptId: string;
	};
}

export interface DictationSlideData extends SlideTypeData {
	readonly mode?: 'word' | 'phrase' | 'sentence';
	readonly audio?: string;
	readonly speech?: SpeechPlaybackConfig;
	readonly answer: string;
	readonly definition?: string;
	readonly acceptedAnswers?: readonly string[];
	readonly maxReplays?: number;
	readonly punctuationSensitive?: boolean;
	readonly caseSensitive?: boolean;
}

export interface SpeakingResponseSlideData extends SlideTypeData {
	readonly mode: 'part1' | 'cue-card' | 'part3' | 'vocabulary-production';
	readonly prompt: string;
	readonly promptBullets?: readonly string[];
	readonly prepSeconds?: number;
	readonly speakingSeconds?: number;
	readonly targetVocabulary?: readonly string[];
	readonly notesEnabled?: boolean;
}

export interface WritingResponseSlideData extends SlideTypeData {
	readonly writingFeedback?: WritingFeedbackContext;
	readonly wordLimit?: number;
	readonly mode:
		| 'sentence'
		| 'paragraph'
		| 'task1-chart'
		| 'task1-process'
		| 'task2-essay'
		| 'general-letter';
	readonly prompt: string;
	readonly timerSeconds?: number;
	readonly recommendedMinimumWords?: number;
	readonly targetVocabulary?: readonly string[];
	readonly planningNotes?: boolean;
	readonly modelAnswer?: string;
	readonly register?: 'formal' | 'informal' | 'neutral';
}

export interface AdaptiveConversationSlideData {
	readonly mode: 'guided-dialogue';
	readonly goal: string;
	readonly openingPrompt: string;
	readonly minimumTurns: number;
	readonly maximumTurns: number;
	readonly responseSeconds: number;
	readonly learnerLevel: 'beginner' | 'elementary' | 'intermediate' | 'advanced';
	readonly targetVocabulary: readonly string[];
	readonly questionConstraints: {
		readonly maximumWords: number;
		readonly oneQuestionOnly: true;
		readonly avoidAnswerDisclosure: true;
	};
}

export const REUSABLE_SLIDE_TYPES = [
	'teaching-card',
	'selection',
	'number-input',
	'choice',
	'truth',
	'matching',
	'classification',
	'ordering',
	'labeling',
	'cloze',
	'structured-completion',
	'short-answer',
	'word-formation',
	'error-correction',
	'rewrite',
	'pronunciation',
	'dictation',
	'speaking-response',
	'writing-response',
	'adaptive-conversation',
] as const;

export type ReusableSlideType = (typeof REUSABLE_SLIDE_TYPES)[number];
