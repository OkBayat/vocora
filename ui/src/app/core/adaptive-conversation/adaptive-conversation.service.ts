import { Injectable, inject } from '@angular/core';
import type { AdaptiveConversationController } from '../../shared/slide-exercise/adaptive-conversation-contracts';
import { PcmRecorderService } from '../shadowing-practice/pcm-recorder.service';
import { SpeechService } from '../speech/speech.service';
import { AdaptiveConversationApiService, type ConversationScope } from './adaptive-conversation-api.service';
import { AdaptiveConversationSession } from './adaptive-conversation-session';

@Injectable({ providedIn: 'root' })
export class AdaptiveConversationService {
  private readonly api = inject(AdaptiveConversationApiService);
  create(scope: ConversationScope, ensureStarted: () => Promise<boolean> = async () => true): AdaptiveConversationController {
    const displayed = { ...scope };
    return new AdaptiveConversationSession({
      history: () => this.api.history(displayed), start: key => this.api.start(displayed, key),
      read: id => this.api.read(id), record: (id, revision, key) => this.api.record(id, revision, key),
      chunk: (id, recording, sequence, pcm) => this.api.chunk(id, recording, sequence, pcm),
      finishRecording: (id, recording) => this.api.finishRecording(id, recording), cancelRecording: (id, recording) => this.api.cancelRecording(id, recording),
      retry: (id, turn) => this.api.retry(id, turn), audio: (id, turn) => this.api.audio(id, turn),
      finish: (id, revision) => this.api.finish(id, revision), cancel: id => this.api.cancel(id),
    }, new PcmRecorderService(), new SpeechService(), ensureStarted, () => crypto.randomUUID(), displayed.expectedPathContentVersion);
  }
}
