import type { AdaptiveConversationSlideData } from '../../slide-library.models';

const DATA_KEYS = [
	'mode', 'goal', 'openingPrompt', 'minimumTurns', 'maximumTurns',
	'responseSeconds', 'learnerLevel', 'targetVocabulary', 'questionConstraints',
] as const;
const QUESTION_KEYS = ['maximumWords', 'oneQuestionOnly', 'avoidAnswerDisclosure'] as const;
const LEARNER_LEVELS = ['beginner', 'elementary', 'intermediate', 'advanced'] as const;
const INVALID_DEFINITION = 'Invalid adaptive conversation definition.';
const UNSAFE_TEXT = /[\u0000-\u001f\u007f]|<\/?[a-z][^>]*>|<\|[^>]*\|>/iu;

function strictRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)
		|| Object.keys(value).some((key) => !keys.includes(key))) {
		throw new Error(INVALID_DEFINITION);
	}
	return value as Record<string, unknown>;
}

function boundedText(value: unknown, maximumLength: number): string {
	if (typeof value !== 'string' || value.length > maximumLength || UNSAFE_TEXT.test(value)) {
		throw new Error(INVALID_DEFINITION);
	}
	const result = value.trim();
	if (!result) throw new Error(INVALID_DEFINITION);
	return result;
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number {
	if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
		throw new Error(INVALID_DEFINITION);
	}
	return value;
}

export function parseAdaptiveConversation(value: unknown): AdaptiveConversationSlideData {
	const source = strictRecord(value, DATA_KEYS);
	if (source['mode'] !== 'guided-dialogue'
		|| !LEARNER_LEVELS.includes(source['learnerLevel'] as AdaptiveConversationSlideData['learnerLevel'])) {
		throw new Error(INVALID_DEFINITION);
	}
	const minimumTurns = boundedInteger(source['minimumTurns'], 2, 4);
	const maximumTurns = boundedInteger(source['maximumTurns'], 2, 4);
	if (minimumTurns > maximumTurns) throw new Error(INVALID_DEFINITION);
	const constraints = strictRecord(source['questionConstraints'], QUESTION_KEYS);
	const maximumWords = boundedInteger(constraints['maximumWords'], 1, 20);
	if (constraints['oneQuestionOnly'] !== true || constraints['avoidAnswerDisclosure'] !== true) {
		throw new Error(INVALID_DEFINITION);
	}
	const openingPrompt = boundedText(source['openingPrompt'], 240);
	if (!/\p{L}/u.test(openingPrompt) || !/^[^?]+\?$/u.test(openingPrompt)
		|| openingPrompt.split(/\s+/u).length > maximumWords) {
		throw new Error(INVALID_DEFINITION);
	}
	const vocabulary = source['targetVocabulary'] === undefined ? [] : source['targetVocabulary'];
	if (!Array.isArray(vocabulary) || vocabulary.length > 30) throw new Error(INVALID_DEFINITION);
	const targetVocabulary = vocabulary.map((target) => boundedText(target, 120));
	if (new Set(targetVocabulary.map((target) => target.toLowerCase())).size !== targetVocabulary.length) {
		throw new Error(INVALID_DEFINITION);
	}
	return {
		mode: 'guided-dialogue',
		goal: boundedText(source['goal'], 400),
		openingPrompt,
		minimumTurns,
		maximumTurns,
		responseSeconds: boundedInteger(source['responseSeconds'], 5, 30),
		learnerLevel: source['learnerLevel'] as AdaptiveConversationSlideData['learnerLevel'],
		targetVocabulary,
		questionConstraints: { maximumWords, oneQuestionOnly: true, avoidAnswerDisclosure: true },
	};
}
