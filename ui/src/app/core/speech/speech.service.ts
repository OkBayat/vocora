import { Injectable } from "@angular/core";
import { clamp } from "../../domain/learning/learning-rules";
import { runtimeApiUrl, runtimeRequestHeaders } from "../platform/runtime-platform.service";

export interface SpeechPlaybackObserver {
	onStart?: () => void;
	onWordBoundary?: (charIndex: number, charLength: number) => void;
	onEnd?: () => void;
	onError?: () => void;
}

export type SpeechPlaybackMode = "normal" | "slow";

interface SpeechWordRange {
	charIndex: number;
	charLength: number;
	text: string;
}

const KOKORO_DIALOGUE_VOICES = [
	"af_heart",
	"bf_emma",
	"af_bella",
	"af_sky",
] as const;
const SLOW_PLAYBACK_MULTIPLIER = 0.85;

function speechWordRanges(text: string): SpeechWordRange[] {
	return [...text.matchAll(/\S+/gu)].map((match) => ({
		charIndex: match.index ?? 0,
		charLength: match[0].length,
		text: match[0],
	}));
}

function estimatedWordDurationMs(word: string, rate: number): number {
	const alphanumericLength = [...word].filter((character) =>
		/[\p{L}\p{N}]/u.test(character),
	).length;
	const punctuationPause = /[.!?]$/u.test(word)
		? 120
		: /[,;:]$/u.test(word)
			? 70
			: 0;
	return (
		(190 +
			Math.min(12, Math.max(1, alphanumericLength)) * 22 +
			punctuationPause) /
		rate
	);
}

function dialogueVoice(voiceIndex?: number): string | undefined {
	if (voiceIndex === undefined) return undefined;
	const normalizedVoiceIndex =
		Number.isSafeInteger(voiceIndex) && voiceIndex >= 0 ? voiceIndex : 0;
	return KOKORO_DIALOGUE_VOICES[
		normalizedVoiceIndex % KOKORO_DIALOGUE_VOICES.length
	];
}

@Injectable({ providedIn: "root" })
export class SpeechService {
	private playbackSequence = 0;
	private readonly fallbackTimers = new Set<ReturnType<typeof setTimeout>>();
	private readonly emittedBoundaryRanges = new Set<string>();
	private activeRequest: AbortController | null = null;
	private activeAudio: HTMLAudioElement | null = null;
	private activeObjectUrl: string | null = null;
	private backendPlaybackStartedSequence: number | null = null;
	private browserFallbackSequence: number | null = null;
	private boundarySequence: number | null = null;

	playServerAudio(load: () => Promise<Blob>, observer?: SpeechPlaybackObserver): boolean {
		if (typeof globalThis.Audio !== 'function' || typeof globalThis.URL?.createObjectURL !== 'function') return false;
		this.cancel();
		const sequence = ++this.playbackSequence;
		void load().then(async (blob) => {
			if (!this.isCurrent(sequence)) return;
			if (!blob.size || !blob.type.startsWith('audio/')) throw new Error('Audio is unavailable.');
			const url = globalThis.URL.createObjectURL(blob);
			this.activeObjectUrl = url;
			const audio = new Audio(url);
			this.activeAudio = audio;
			audio.onended = () => this.finishPlayback(sequence, observer);
			audio.onerror = () => this.failPlayback(sequence, observer);
			await audio.play();
			if (this.isCurrent(sequence)) observer?.onStart?.();
		}).catch(() => this.failPlayback(sequence, observer));
		return true;
	}

	speak(
		text: string,
		rate = 0.85,
		observer?: SpeechPlaybackObserver,
		voiceIndex?: number,
		mode: SpeechPlaybackMode = "normal",
	): boolean {
		const AudioConstructor = globalThis.Audio;
		const backendAvailable =
			typeof globalThis.fetch === "function" &&
			typeof AudioConstructor === "function" &&
			typeof globalThis.URL?.createObjectURL === "function" &&
			typeof globalThis.URL?.revokeObjectURL === "function";
		const browserFallbackAvailable =
			typeof globalThis.speechSynthesis?.speak === "function" &&
			typeof globalThis.SpeechSynthesisUtterance === "function";
		if (!backendAvailable && !browserFallbackAvailable) return false;

		this.cancel();
		const playbackSequence = ++this.playbackSequence;
		this.boundarySequence = playbackSequence;
		const selectedRate =
			mode === "slow"
				? Math.round(rate * SLOW_PLAYBACK_MULTIPLIER * 10_000) / 10_000
				: rate;
		const normalizedRate = clamp(selectedRate, 0.45, 1.2);
		if (!backendAvailable) {
			this.browserFallbackSequence = playbackSequence;
			const started = this.playBrowserSpeech(
				text,
				normalizedRate,
				voiceIndex,
				playbackSequence,
				observer,
			);
			if (!started) {
				this.browserFallbackSequence = null;
				this.playbackSequence += 1;
			}
			return started;
		}

		const request = new AbortController();
		this.activeRequest = request;
		void this.requestAndPlay(
			text,
			normalizedRate,
			voiceIndex,
			playbackSequence,
			request,
			AudioConstructor,
			observer,
		);
		return true;
	}

	cancel(): void {
		this.playbackSequence += 1;
		this.clearFallbackTimers();
		this.activeRequest?.abort();
		this.activeRequest = null;
		this.releaseAudio();
		this.backendPlaybackStartedSequence = null;
		this.browserFallbackSequence = null;
		this.boundarySequence = null;
		this.emittedBoundaryRanges.clear();
		globalThis.speechSynthesis?.cancel?.();
	}

	private async requestAndPlay(
		text: string,
		rate: number,
		voiceIndex: number | undefined,
		playbackSequence: number,
		request: AbortController,
		AudioConstructor: typeof Audio,
		observer?: SpeechPlaybackObserver,
	): Promise<void> {
		try {
			const voice = dialogueVoice(voiceIndex);
			const response = await globalThis.fetch(runtimeApiUrl("/api/tts/speech"), {
				method: "POST",
				headers: { "Content-Type": "application/json", ...runtimeRequestHeaders() },
				credentials: "include",
				body: JSON.stringify({
					text,
					speed: rate,
					format: "mp3",
					...(voice ? { voice } : {}),
				}),
				signal: request.signal,
			});
			if (!response.ok) throw new Error("Speech generation failed.");

			const audioBlob = await response.blob();
			if (!audioBlob.size) {
				throw new Error("Speech generation returned no audio.");
			}
			if (!this.isCurrent(playbackSequence)) return;
			if (this.activeRequest === request) this.activeRequest = null;

			const objectUrl = globalThis.URL.createObjectURL(audioBlob);
			this.activeObjectUrl = objectUrl;
			const audio = new AudioConstructor(objectUrl);
			audio.preload = "auto";
			this.activeAudio = audio;
			audio.onended = () =>
				this.finishPlayback(playbackSequence, observer);
			audio.onerror = () =>
				this.fallbackToBrowser(
					text,
					rate,
					voiceIndex,
					playbackSequence,
					observer,
				);

			await audio.play();
			if (!this.isCurrent(playbackSequence)) return;
			this.backendPlaybackStartedSequence = playbackSequence;
			observer?.onStart?.();
			if (this.isCurrent(playbackSequence)) {
				this.emitEstimatedWordBoundaries(
					text,
					rate,
					playbackSequence,
					observer,
				);
			}
		} catch {
			if (!request.signal.aborted) {
				this.fallbackToBrowser(
					text,
					rate,
					voiceIndex,
					playbackSequence,
					observer,
				);
			}
		}
	}

	private fallbackToBrowser(
		text: string,
		rate: number,
		voiceIndex: number | undefined,
		playbackSequence: number,
		observer?: SpeechPlaybackObserver,
	): void {
		if (
			!this.isCurrent(playbackSequence) ||
			this.browserFallbackSequence === playbackSequence
		)
			return;

		this.activeRequest = null;
		this.clearFallbackTimers();
		this.releaseAudio();
		const fallbackObserver =
			this.backendPlaybackStartedSequence === playbackSequence && observer
				? {
						onWordBoundary: observer.onWordBoundary,
						onEnd: observer.onEnd,
						onError: observer.onError,
					}
				: observer;
		this.backendPlaybackStartedSequence = null;
		this.browserFallbackSequence = playbackSequence;
		if (
			!this.playBrowserSpeech(
				text,
				rate,
				voiceIndex,
				playbackSequence,
				fallbackObserver,
			)
		) {
			this.failPlayback(playbackSequence, observer);
		}
	}

	private playBrowserSpeech(
		text: string,
		rate: number,
		voiceIndex: number | undefined,
		playbackSequence: number,
		observer?: SpeechPlaybackObserver,
	): boolean {
		const speechSynthesis = globalThis.speechSynthesis;
		const UtteranceConstructor = globalThis.SpeechSynthesisUtterance;
		if (
			typeof speechSynthesis?.speak !== "function" ||
			typeof UtteranceConstructor !== "function"
		)
			return false;

		const utterance = new UtteranceConstructor(text);
		utterance.lang = "en-GB";
		utterance.rate = rate;
		const voices = speechSynthesis.getVoices();
		if (voiceIndex === undefined) {
			utterance.voice =
				voices.find((voice) => /^en-GB/iu.test(voice.lang)) ??
				voices.find((voice) => /^en/iu.test(voice.lang)) ??
				null;
		} else {
			const normalizedVoiceIndex =
				Number.isSafeInteger(voiceIndex) && voiceIndex >= 0
					? voiceIndex
					: 0;
			utterance.pitch = [0.9, 1.1, 1, 1.2][normalizedVoiceIndex % 4];
			const englishVoices = voices
				.filter((voice) => /^en/iu.test(voice.lang))
				.sort((left, right) => {
					const leftKey = `${/^en-GB/iu.test(left.lang) ? 0 : 1}|${left.lang}|${left.name}|${left.voiceURI}`;
					const rightKey = `${/^en-GB/iu.test(right.lang) ? 0 : 1}|${right.lang}|${right.name}|${right.voiceURI}`;
					return leftKey.localeCompare(rightKey, "en");
				});
			utterance.voice =
				englishVoices.length > 0
					? englishVoices[normalizedVoiceIndex % englishVoices.length]
					: null;
		}

		let nativeBoundarySeen = false;
		utterance.onstart = () => {
			if (!this.isCurrent(playbackSequence)) return;
			observer?.onStart?.();
			if (!nativeBoundarySeen && this.isCurrent(playbackSequence)) {
				this.emitEstimatedWordBoundaries(
					text,
					rate,
					playbackSequence,
					observer,
				);
			}
		};
		utterance.onboundary = (event) => {
			if (!this.isCurrent(playbackSequence) || event.name === "sentence")
				return;
			nativeBoundarySeen = true;
			this.clearFallbackTimers();
			const words = speechWordRanges(text);
			const charIndex = Math.max(
				0,
				Number.isFinite(event.charIndex) ? event.charIndex : 0,
			);
			const containingWord = words.find(
				(word) =>
					charIndex >= word.charIndex &&
					charIndex < word.charIndex + word.charLength,
			);
			this.emitWordBoundary(
				playbackSequence,
				observer,
				charIndex,
				event.charLength > 0
					? event.charLength
					: (containingWord?.charLength ?? 1),
			);
		};
		utterance.onend = () => this.finishPlayback(playbackSequence, observer);
		utterance.onerror = () => this.failPlayback(playbackSequence, observer);

		try {
			speechSynthesis.speak(utterance);
			return true;
		} catch {
			return false;
		}
	}

	private emitEstimatedWordBoundaries(
		text: string,
		rate: number,
		playbackSequence: number,
		observer?: SpeechPlaybackObserver,
	): void {
		if (!observer?.onWordBoundary) return;
		const words = speechWordRanges(text);
		if (!words.length) return;

		this.emitWordBoundary(
			playbackSequence,
			observer,
			words[0].charIndex,
			words[0].charLength,
		);
		let delay = estimatedWordDurationMs(words[0].text, rate);
		for (let index = 1; index < words.length; index += 1) {
			const word = words[index];
			const timer = setTimeout(() => {
				this.fallbackTimers.delete(timer);
				if (this.isCurrent(playbackSequence)) {
					this.emitWordBoundary(
						playbackSequence,
						observer,
						word.charIndex,
						word.charLength,
					);
				}
			}, delay);
			this.fallbackTimers.add(timer);
			delay += estimatedWordDurationMs(word.text, rate);
		}
	}

	private emitWordBoundary(
		playbackSequence: number,
		observer: SpeechPlaybackObserver | undefined,
		charIndex: number,
		charLength: number,
	): void {
		const onWordBoundary = observer?.onWordBoundary;
		if (
			!this.isCurrent(playbackSequence) ||
			this.boundarySequence !== playbackSequence ||
			!onWordBoundary
		)
			return;
		const range = `${charIndex}:${charLength}`;
		if (this.emittedBoundaryRanges.has(range)) return;
		this.emittedBoundaryRanges.add(range);
		onWordBoundary(charIndex, charLength);
	}

	private finishPlayback(
		playbackSequence: number,
		observer?: SpeechPlaybackObserver,
	): void {
		if (!this.isCurrent(playbackSequence)) return;
		this.clearFallbackTimers();
		this.releaseAudio();
		this.backendPlaybackStartedSequence = null;
		this.browserFallbackSequence = null;
		this.boundarySequence = null;
		this.emittedBoundaryRanges.clear();
		this.playbackSequence += 1;
		observer?.onEnd?.();
	}

	private failPlayback(
		playbackSequence: number,
		observer?: SpeechPlaybackObserver,
	): void {
		if (!this.isCurrent(playbackSequence)) return;
		this.activeRequest = null;
		this.clearFallbackTimers();
		this.releaseAudio();
		this.backendPlaybackStartedSequence = null;
		this.browserFallbackSequence = null;
		this.boundarySequence = null;
		this.emittedBoundaryRanges.clear();
		this.playbackSequence += 1;
		observer?.onError?.();
	}

	private releaseAudio(): void {
		if (this.activeAudio) {
			this.activeAudio.onended = null;
			this.activeAudio.onerror = null;
			this.activeAudio.pause();
			this.activeAudio.currentTime = 0;
			this.activeAudio = null;
		}
		if (this.activeObjectUrl) {
			globalThis.URL.revokeObjectURL(this.activeObjectUrl);
			this.activeObjectUrl = null;
		}
	}

	private isCurrent(playbackSequence: number): boolean {
		return playbackSequence === this.playbackSequence;
	}

	private clearFallbackTimers(): void {
		for (const timer of this.fallbackTimers) clearTimeout(timer);
		this.fallbackTimers.clear();
	}
}
