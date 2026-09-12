import { Injectable, inject } from '@angular/core';
import type { ConversationChunk, ConversationEnvelope, ConversationHistory, ConversationRecording } from '../../shared/slide-exercise/adaptive-conversation-contracts';
import { ApiClientService } from '../http/api-client.service';

export interface ConversationScope { pathId: string; lessonId: string; exerciseId: string; slideId: string; expectedPathContentVersion: number; }
const segment = encodeURIComponent;
const sessionPath = (id: string) => `/api/conversations/${segment(id)}`;
const recordingPath = (id: string, recordingId: string) => `${sessionPath(id)}/recordings/${segment(recordingId)}`;
const taskPath = (scope: ConversationScope) => `/api/learning-paths/${segment(scope.pathId)}/lessons/${segment(scope.lessonId)}/exercises/${segment(scope.exerciseId)}/slides/${segment(scope.slideId)}/conversation-sessions`;

@Injectable({ providedIn: 'root' })
export class AdaptiveConversationApiService {
  private readonly api = inject(ApiClientService);
  history(scope: ConversationScope): Promise<ConversationHistory> { return this.api.get(taskPath(scope)); }
  start(scope: ConversationScope, idempotencyKey: string): Promise<ConversationEnvelope> {
    return this.api.post(taskPath(scope), { expectedPathContentVersion: scope.expectedPathContentVersion, idempotencyKey });
  }
  read(id: string): Promise<ConversationEnvelope> { return this.api.get(sessionPath(id)); }
  record(id: string, expectedSessionRevision: number, idempotencyKey: string): Promise<ConversationRecording> {
    return this.api.post(`${sessionPath(id)}/recordings`, { expectedSessionRevision, idempotencyKey });
  }
  chunk(id: string, recordingId: string, sequence: number, pcm: ArrayBuffer): Promise<ConversationChunk> {
    return this.api.post(`${recordingPath(id, recordingId)}/chunks?sequence=${sequence}`, pcm, { 'Content-Type': 'application/octet-stream' });
  }
  finishRecording(id: string, recordingId: string): Promise<ConversationEnvelope> { return this.api.post(`${recordingPath(id, recordingId)}/finish`, {}); }
  cancelRecording(id: string, recordingId: string): Promise<void> { return this.api.delete(recordingPath(id, recordingId)); }
  retry(id: string, turnId: string): Promise<ConversationEnvelope> { return this.api.post(`${sessionPath(id)}/turns/${segment(turnId)}/retry`, {}); }
  audio(id: string, turnId: string): Promise<Blob> { return this.api.postBlob(`${sessionPath(id)}/turns/${segment(turnId)}/question-audio`, {}); }
  finish(id: string, expectedSessionRevision: number): Promise<ConversationEnvelope> { return this.api.post(`${sessionPath(id)}/finish`, { expectedSessionRevision }); }
  cancel(id: string): Promise<ConversationEnvelope> { return this.api.post(`${sessionPath(id)}/cancel`, {}); }
}
