import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalAudioRecorderService } from './local-audio-recorder.service';

describe('LocalAudioRecorderService', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('fails closed without a secure microphone context', async () => {
		const request = vi.fn();
		vi.stubGlobal('isSecureContext', false);
		vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: request } });
		const service = new LocalAudioRecorderService();

		await expect(service.start()).rejects.toThrow('HTTPS');
		expect(request).not.toHaveBeenCalled();
	});

	it('releases a microphone granted after the caller cancels', async () => {
		const stop = vi.fn();
		let grant!: (stream: MediaStream) => void;
		vi.stubGlobal('isSecureContext', true);
		vi.stubGlobal('navigator', {
			mediaDevices: {
				getUserMedia: () =>
					new Promise<MediaStream>((resolve) => {
						grant = resolve;
					}),
			},
		});
		vi.stubGlobal('MediaRecorder', class {});
		const service = new LocalAudioRecorderService();
		const opening = service.start();
		service.cancel();
		grant({ getTracks: () => [{ stop }] } as unknown as MediaStream);

		await expect(opening).rejects.toMatchObject({ name: 'AbortError' });
		expect(stop).toHaveBeenCalledOnce();
	});

	it('returns recording bytes that survive cancellation of the local playback URL', async () => {
		const stopTrack = vi.fn();
		const stream = { getTracks: () => [{ stop: stopTrack }] };
		class Recorder {
			state = 'recording';
			mimeType = 'audio/webm';
			ondataavailable: ((event: BlobEvent) => void) | null = null;
			onerror: ((event: Event) => void) | null = null;
			onstop: (() => void) | null = null;
			start(): void {}
			stop(): void {
				this.state = 'inactive';
				this.ondataavailable?.({ data: new Blob(['recording'], { type: this.mimeType }) } as BlobEvent);
				this.onstop?.();
			}
		}
		vi.stubGlobal('isSecureContext', true);
		vi.stubGlobal('navigator', {
			mediaDevices: { getUserMedia: vi.fn().mockResolvedValue(stream) },
		});
		vi.stubGlobal('MediaRecorder', Recorder);
		vi.stubGlobal('URL', {
			createObjectURL: vi.fn().mockReturnValue('blob:local'),
			revokeObjectURL: vi.fn(),
		});
		const service = new LocalAudioRecorderService();

		await service.start();
		const recording = await service.stop();
		expect(recording.url).toBe('blob:local');
		expect(recording.blob.type).toBe('audio/webm');
		expect(recording.blob.size).toBe(9);
		expect(URL.createObjectURL).toHaveBeenCalledWith(recording.blob);
		expect(stopTrack).toHaveBeenCalledOnce();
		service.cancel();
		expect(URL.revokeObjectURL).toHaveBeenCalledWith(recording.url);
		expect(recording.blob.size).toBe(9);
	});

	it('releases the microphone when stopping is interrupted', async () => {
		const stopTrack = vi.fn();
		const stream = { getTracks: () => [{ stop: stopTrack }] };
		class Recorder {
			state = 'recording';
			mimeType = 'audio/webm';
			ondataavailable: ((event: BlobEvent) => void) | null = null;
			onerror: ((event: Event) => void) | null = null;
			onstop: (() => void) | null = null;
			start(): void {}
			stop(): void {
				this.state = 'inactive';
				this.onerror?.(new Event('error'));
			}
		}
		vi.stubGlobal('isSecureContext', true);
		vi.stubGlobal('navigator', {
			mediaDevices: { getUserMedia: vi.fn().mockResolvedValue(stream) },
		});
		vi.stubGlobal('MediaRecorder', Recorder);
		const service = new LocalAudioRecorderService();

		await service.start();
		await expect(service.stop()).rejects.toThrow('interrupted');
		expect(stopTrack).toHaveBeenCalledOnce();
	});
});
