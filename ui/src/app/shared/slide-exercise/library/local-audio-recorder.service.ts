import { Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class LocalAudioRecorderService {
	private stream: MediaStream | null = null;
	private recorder: MediaRecorder | null = null;
	private chunks: Blob[] = [];
	private objectUrl = '';
	private generation = 0;

	supported(): boolean {
		return Boolean(
			globalThis.isSecureContext &&
			typeof navigator.mediaDevices?.getUserMedia === 'function' &&
			typeof globalThis.MediaRecorder === 'function',
		);
	}

	async start(): Promise<void> {
		this.cancel();
		const generation = this.generation;
		if (!this.supported())
			throw new Error(
				'Recording requires HTTPS (or localhost) and a supported browser.',
			);
		try {
			const stream = await navigator.mediaDevices.getUserMedia({
				audio: true,
			});
			if (generation !== this.generation) {
				stream.getTracks().forEach((track) => track.stop());
				throw new DOMException('Recording cancelled.', 'AbortError');
			}
			this.stream = stream;
			this.chunks = [];
			this.recorder = new MediaRecorder(this.stream);
			this.recorder.ondataavailable = (event) => {
				if (event.data.size) this.chunks.push(event.data);
			};
			this.recorder.start();
		} catch (error) {
			this.releaseStream();
			const name = error instanceof DOMException ? error.name : '';
			if (name === 'NotAllowedError')
				throw new Error('Microphone permission was denied.');
			if (name === 'NotFoundError')
				throw new Error('No microphone was found.');
			throw error;
		}
	}

	async stop(): Promise<{ blob: Blob; url: string }> {
		const recorder = this.recorder;
		if (!recorder || recorder.state === 'inactive')
			throw new Error('No recording is active.');
		let blob: Blob;
		try {
			blob = await new Promise<Blob>((resolve, reject) => {
				recorder.onstop = () =>
					resolve(
						new Blob(this.chunks, {
							type: recorder.mimeType || 'audio/webm',
						}),
					);
				recorder.onerror = () =>
					reject(new Error('Recording was interrupted.'));
				recorder.stop();
			});
		} finally {
			this.releaseStream();
		}
		if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
		this.objectUrl = URL.createObjectURL(blob);
		return { blob, url: this.objectUrl };
	}

	cancel(): void {
		this.generation += 1;
		if (this.recorder?.state === 'recording') this.recorder.stop();
		this.releaseStream();
		this.chunks = [];
		if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
		this.objectUrl = '';
	}

	private releaseStream(): void {
		this.stream?.getTracks().forEach((track) => track.stop());
		this.stream = null;
		this.recorder = null;
	}
}
