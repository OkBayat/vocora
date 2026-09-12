import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RuntimePlatformService } from '../platform/runtime-platform.service';
import { AdaptiveConversationApiService } from './adaptive-conversation-api.service';

describe('AdaptiveConversationApiService', () => {
  let api: AdaptiveConversationApiService; let http: HttpTestingController;
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting(),
      { provide: RuntimePlatformService, useValue: { apiUrl: (path: string) => `/host${path}`, requestHeaders: () => ({ 'X-Client': 'native' }) } },
    ] }); api = TestBed.inject(AdaptiveConversationApiService); http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());
  it('sends owner identifiers, revision preconditions and ordered PCM without a client rubric', async () => {
    const scope = { pathId: 'path/1', lessonId: 'lesson', exerciseId: 'exercise', slideId: 'slide', expectedPathContentVersion: 3 };
    const starting = api.start(scope, 'key'); const start = http.expectOne('/host/api/learning-paths/path%2F1/lessons/lesson/exercises/exercise/slides/slide/conversation-sessions');
    expect(start.request.method).toBe('POST'); expect(start.request.body).toEqual({ expectedPathContentVersion: 3, idempotencyKey: 'key' });
    expect(start.request.withCredentials).toBe(true); expect(start.request.headers.get('X-Client')).toBe('native'); start.flush({}); await starting;
    const allocating = api.record('session/1', 2, 'record-key'); const allocation = http.expectOne('/host/api/conversations/session%2F1/recordings');
    expect(allocation.request.body).toEqual({ expectedSessionRevision: 2, idempotencyKey: 'record-key' }); allocation.flush({}); await allocating;
    const pcm = new ArrayBuffer(16000); const sending = api.chunk('session/1', 'recording/1', 4, pcm);
    const chunk = http.expectOne('/host/api/conversations/session%2F1/recordings/recording%2F1/chunks?sequence=4');
    expect(chunk.request.body).toBe(pcm); expect(chunk.request.headers.get('Content-Type')).toBe('application/octet-stream'); chunk.flush({}); await sending;
  });
  it('reads question audio as an authenticated binary response from the owned turn endpoint', async () => {
    const playing = api.audio('session/1', 'turn/1'); const request = http.expectOne('/host/api/conversations/session%2F1/turns/turn%2F1/question-audio');
    expect(request.request.method).toBe('POST'); expect(request.request.body).toEqual({}); expect(request.request.responseType).toBe('blob');
    expect(request.request.withCredentials).toBe(true); expect(request.request.headers.get('X-Client')).toBe('native');
    const audio = new Blob(['question'], { type: 'audio/mpeg' }); request.flush(audio); expect(await playing).toBe(audio);
  });
});
