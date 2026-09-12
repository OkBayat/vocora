# Adaptive Conversation Practice

> Status: **implemented reusable runtime interaction; disabled by default**.
> First consumer: optional IELTS L0001 exercise `ielts-l0001-e09-conversation`, position 90.
> Structural checks and implementation coverage do not establish model quality, target-host CPU capacity, or deployment readiness.

`adaptive-conversation` is registered in the shared slide library and validated by the Learning Path domain. A lesson configures the communicative goal and content bounds. The application owns microphone capture, transcription, queued text evaluation, follow-up questions, question audio, persistence and completion evidence. The interaction is reusable across courses; it does not implement an IELTS scoring policy.

Read this document with [Shadowing](SHADOWING.md), [TTS](TTS.md), the [architecture playbook](../ARCHITECTURE_PLAYBOOK.md), [Writing feedback](../ielts/WRITING_FEEDBACK.md), and the [IELTS implementation direction](../ielts/IMPLEMENTATION.md). These describe source implementation and operating requirements, not a claim that this feature has been enabled on a server.

## Implemented learning loop

1. The backend resolves an accessible, started Learning Path exercise and its server-managed conversation slide.
2. The learner reads or plays the current question. An authenticated request identifies the owned turn; the backend resolves its text and streams uncached Kokoro audio.
3. The existing `PcmRecorderService` captures 16 kHz mono PCM16. The browser sends ordered chunks through the authenticated backend to the private Vosk service.
4. The backend preserves the final transcript and its recognition provenance before queueing evaluation. The interface distinguishes provisional transcription, saved transcription and pending feedback.
5. The shared local text worker evaluates the current transcript against the current question and proposes a short follow-up. Writing feedback and conversation share the same worker, admission limits and database lease.
6. The backend validates the structured result, derives the narrow task-response signal, saves the accepted turn and creates the next question when needed.
7. After the configured minimum accepted turns, the learner can finish. The backend issues a server-verifiable completion receipt. Finishing records participation in practice, not mastery.

The browser does not supply an authoritative rubric, system prompt, provider URL, model, score or next question. It uses neither the browser `SpeechRecognition` API nor an embedded speech model. Provider failures and uncertain transcription do not mark an answer wrong.

## Reusable JSON contract

A conversation is one registered slide inside a normal `slides.sequence` exercise. The exercise still has its terminal summary; the conversation's server-issued receipt supplies this slide's submitted evidence.

The L0001 consumer uses:

```json
{
  "id": "ielts-l0001-e09-dialogue",
  "type": "adaptive-conversation",
  "data": {
    "mode": "guided-dialogue",
    "goal": "Answer short questions about morning meals: food, drinks and where you eat. Give one relevant detail at a time.",
    "openingPrompt": "What do you eat in the morning?",
    "minimumTurns": 2,
    "maximumTurns": 3,
    "responseSeconds": 30,
    "learnerLevel": "beginner",
    "targetVocabulary": [
      "bread", "rice", "water", "milk", "eat", "drink",
      "have breakfast", "drink water"
    ],
    "questionConstraints": {
      "maximumWords": 14,
      "oneQuestionOnly": true,
      "avoidAnswerDisclosure": true
    }
  }
}
```

`goal` is also shown to the learner, so it must read as learner-facing task copy. Provider instructions belong in the server-owned prompt.

`ConversationDefinition.js` rejects unsupported fields and modes, empty or oversized text, duplicate vocabulary, invalid bounds and markup. Its current bounds are:

| Setting | Accepted contract |
| --- | --- |
| Mode | `guided-dialogue` |
| Learner level | `beginner`, `elementary`, `intermediate`, `advanced` |
| Minimum/maximum turns | Each 2–4; minimum must not exceed maximum |
| Response duration | 5–30 seconds |
| Goal | At most 400 characters |
| Opening/generated question | At most 240 characters; ends in one question mark; within the authored word bound |
| Question word bound | 1–20; L0001 selects 14 |
| Vocabulary | At most 30 distinct items, each at most 120 characters |
| Question policies | `oneQuestionOnly` and `avoidAnswerDisclosure` must both be `true` |

The last two policies express required behavior. A punctuation/length validator cannot establish that a question asks only one semantic question, remains appropriate for a beginner, or avoids revealing an answer. Those properties require evaluation of actual generated content.

## Recognition evidence and model identity

The private speech service now exposes a versioned detailed result. `HttpSpeechRecognizer.chunkDetailed` returns `status: partial`; `finishDetailed` returns `transcribed` or `insufficient_evidence`. The envelope contains:

- `schemaVersion: 1`, `status`, and `text`;
- `confidence: null` at utterance level;
- `wordEvidence`, containing provider-reported `word`, `startSeconds`, `endSeconds` and `confidence` values;
- `providerIdentity`, containing `provider: vosk`, runtime version, optional configured model ID and measured model digest.

`speech/server.py` enables Vosk's `SetWords` and `SetPartialWords` when available. It accumulates committed words and preserves partial word evidence; it does not fabricate timings or confidence. Missing per-word confidence stays `null`. The service does not manufacture an utterance confidence from word confidences. Empty final recognition produces insufficient evidence.

At startup, the service computes the model digest from the actual model directory: hash each regular file, form sorted relative-path/file-hash pairs, then hash their compact UTF-8 JSON representation. Symlinks and empty model trees are rejected. If `VOSK_MODEL_DIGEST` is configured, startup verifies it against that measurement. `VOSK_MODEL_ID` is an optional label, not a substitute for the measured digest. The conversation saves the first accepted ASR identity and rejects a later identity change within that session.

Raw microphone chunks remain in memory and are not saved as recordings. The detailed transcript and provider-reported word evidence are persisted. They describe recognition, not pronunciation or fluency quality. The text model receives transcript text and recognition status with unavailable utterance confidence; it does not hear audio or infer acoustic scores from the word timestamps.

## Structured model result and server-derived signal

`OllamaConversationProvider` uses the shared private `OllamaStructuredTextClient`. The source-selected CPU pilot model is `qwen3:4b-instruct-2507-q4_K_M`. Its configured digest, GGUF/tokenizer identity and template checks are required even when only conversation is enabled. Configuration uses the existing `WRITING_FEEDBACK_*` local-model settings; the Writing feature flag remains independent.

The conversation prompt supplies the authored task, current question, bounded earlier turns and current transcript. It treats learner text as untrusted data, accepts valid personal alternatives, preserves negation and prohibits acoustic and IELTS assessment. No tools or external actions are exposed to the model.

The provider must return a closed JSON object such as:

```json
{
  "schemaVersion": 1,
  "assessmentStatus": "feedback_available",
  "taskResponse": "complete",
  "feedback": "You answered the food question.",
  "nextQuestion": "What do you drink in the morning?",
  "endConversation": false,
  "notAssessed": ["ielts_band", "pronunciation", "fluency"]
}
```

**The model schema does not contain a numeric score.** A model response with an extra `formativeTaskScore` field is invalid. After validation, `ConversationResult.js` applies the versioned server policy `formative-task-response-v1`:

| Model label | Server `formativeTaskScore` | Meaning |
| --- | --- | --- |
| `off_topic` | 0 | Did not answer this question |
| `partial` | 1 | Relevant but incomplete |
| `complete` | 2 | Supplied the requested detail |
| `not_assessed` | `null` | Insufficient evidence; no task score |

These labels concern the response to one question. They do not certify grammar, general English ability, pronunciation, fluency, an IELTS band, mastery or a Leitner review. A short reply such as “At home” may fully answer a place question; a grammatical statement about milk may miss that question. The interface presents the narrow scale alongside the signal and shows that IELTS band, pronunciation and fluency are not assessed.

For `insufficient_evidence`, validation requires `not_assessed`, no score, the exact current question repeated as `nextQuestion`, and `endConversation: false`. The learner may record again within the attempt bound. A successfully assessed off-topic answer counts as a practice turn; an unassessed answer does not. Practice completion is therefore independent of receiving a high task-response signal.

The application ignores an early ending before `minimumTurns`, ends question generation at `maximumTurns`, and accepts the model's ending suggestion only between those bounds. Separately, the learner may finish after the minimum when no recording or evaluation is active. A model ending suggestion does not itself create a completion receipt.

Unknown fields, invalid enums, inconsistent statuses, malformed or oversized questions, invalid output, truncation, identity mismatch and timeout are processing failures. Raw unvalidated model text is never spoken. Structural validation does not prove that free-text feedback is correct or that the proposed question is relevant; semantic acceptance still needs reviewed model examples.

## Shared inference worker and bounded capacity

`createLocalTextInferenceModule` constructs one shared client and `LocalTextInferenceWorker` for Writing and conversation. `MySqlLocalTextInferenceQueue` selects the oldest eligible job across both families. The existing `writing_feedback_gate` singleton now records `job_kind` and serializes claims across application processes. Inference runs after the claim transaction commits, rather than inside the HTTP request or database transaction.

The worker checks the saved evaluation profile, enforces timeout and cancellation, and saves results only with the matching live lease and selected recording. An expired lease becomes a retryable interruption. A process whose provider has not settled after abort keeps itself closed to another inference request while cleanup is unresolved; stale results cannot advance the conversation.

| Resource | Current bound |
| --- | --- |
| Queued/running Writing and conversation jobs combined | 8 total; 2 per owner |
| Active text inference | One shared database lease and one active operation per worker |
| Evaluation attempts | At most 3 per job; retry is explicit |
| Active conversation sessions | One per owner; 16 total |
| New conversation sessions | 5 per owner per UTC day |
| Active conversation lifetime | 30 minutes |
| Recording attempts | At most 3 per question |
| Active recording allocations | 8 per application process; private speech pool also has capacity 8 |
| PCM chunks | Non-empty even byte length; at most 32,000 bytes each; ordered sequence numbers |
| Total PCM for a question | At most `32,000 × responseSeconds` bytes |
| Recording operation deadline | Response duration plus 30 seconds |
| Question-audio generation | One per owner; 2 per application process |

A repeated most-recent chunk with identical bytes and sequence is idempotent; an altered or out-of-order chunk is rejected. Transcripts are saved before inference queue admission, so a full queue can be retried without losing the answer. A saved clear transcript is retried for feedback rather than silently replaced by a new recording. Cancellation, stale ownership/version state and interrupted recordings remain distinct from learner mistakes.

The shared text client defaults to a 4,096-token context, 768 output tokens, temperature 0 and CPU-only decoding. It verifies the model digest before and after inference, checks the Qwen family/quantization and template, counts the rendered prompt through the pinned tokenizer, reserves output capacity and checks reported prompt-token accounting. HTTP responses are bounded to 64 KiB and model text to 16 KiB. The configured inference timeout defaults to 120 seconds and accepts 1–180 seconds through application configuration. These limits are source policies; their presence is not a target-host speed benchmark.

## Private question audio

`ConversationQuestionAudio` resolves the requested question from an authenticated owned session and turn. It delegates directly to `KokoroTtsClient` using the configured private provider, MP3 format, `en-us`, a 240-character limit and a 2 MiB output bound. It does not pass learner-derived text through the general shared TTS cache or create a public artifact URL.

Audio is streamed without caching. Conversation routes send `Cache-Control: no-store`. Disconnect, cancellation and shutdown abort generation; the admission slot remains occupied until the stream closes or ends. The browser uses `SpeechService.playServerAudio`, so failure remains visible and can be retried explicitly; it does not silently switch to browser speech synthesis.

ASR, Ollama and conversation TTS use private-service transport checks. They reject disallowed origins and redirects and validate the private addresses used for the connection. There is no automatic cloud fallback. A TTS failure leaves the accepted question text and saved transcript intact.

## Persistence, retention and completion

Migration `025_adaptive_conversation.sql` extends the shared inference gate and adds `conversation_sessions`, `conversation_inference_jobs`, `conversation_completion_evidence` and `conversation_daily_quotas`. It builds on the existing Writing feedback persistence migration.

Sessions store the owner, path/lesson/exercise/slide identities, exercise-start timestamp, path/config content versions, evaluation profile, idempotency identity, expiry and versioned turn state. Inference jobs store the immutable input snapshot, result, provider/prompt/schema/tokenizer identities and available inference metrics. Accepted recording results remain separate from later attempts. Optimistic session revisions and transaction-owned state changes protect concurrent operations.

The persisted session states are `active`, `completed`, `cancelled` and `expired`. Turn states include `ready`, `recording`, `queued`, `evaluating`, `feedback_available` and `retryable_failure`. Playback and transcription progress are operations/UI states; they are not invented persisted `synthesizing` or `transcribing` session states.

`ADAPTIVE_CONVERSATION_RETENTION_DAYS` defaults to 30 and accepts 1–90 days. Active-session expiry stops new work after 30 minutes, separately from private-history retention. The worker performs bounded expiry cleanup, including while both learning features are disabled. Deleting a private session also removes its inference jobs. History, cancellation and deletion verify ownership.

Finishing is idempotent. It requires the configured minimum number of assessed practice turns, an active unexpired session and no recording/queued/evaluating current turn. The server creates a **text-free completion receipt**, scoped to owner, path, lesson, exercise, slide and exercise start, with the stored content version and accepted-turn count. The frontend submits only its `conversationEvidenceId`; Learning Path completion loads the owned receipt and verifies its scope and turn bounds instead of trusting a client score or boolean.

The text-free receipt survives deletion/expiry of private transcripts so completed progress does not depend on retaining conversation text. It is removed with the owning account. It records practice completion, not a language assessment result.

## Authenticated API

The task route base is:

`/api/learning-paths/:pathId/lessons/:lessonId/exercises/:exerciseId/slides/:slideId/conversation-sessions`

| Method | Operation | Request |
| --- | --- | --- |
| `POST` | Start/resume the owned task session | `expectedPathContentVersion`, `idempotencyKey` |
| `GET` | List saved sessions for that exercise start | No authoritative lesson configuration from the client |

Session operations use `/api/conversations/:sessionId`:

| Method and suffix | Operation | Request |
| --- | --- | --- |
| `GET /` | Read session, turns, feedback and availability | None |
| `POST /recordings` | Allocate current-turn recording | `expectedSessionRevision`, `idempotencyKey` |
| `POST /recordings/:recordingId/chunks?sequence=N` | Append ordered PCM; return partial transcript | Raw `application/octet-stream` body |
| `POST /recordings/:recordingId/finish` | Save final transcript and queue evaluation | Empty body |
| `DELETE /recordings/:recordingId` | Cancel an unaccepted recording | Empty body |
| `POST /turns/:turnId/retry` | Retry processing of the saved transcript | Empty body |
| `POST /turns/:turnId/question-audio` | Stream the owned question as MP3 | Empty body; no client-supplied text |
| `POST /finish` | Save completion and return receipt identity | `expectedSessionRevision` |
| `POST /cancel` | Cancel session and its active work | Empty body |
| `DELETE /` | Delete private session/history | Empty body |

These routes use authentication, owner checks and no-store responses. Private JSON requests have a 16 KiB parser limit; PCM has the separate chunk limit. The interface polls the session with bounded retry/polling behavior, preserves saved answers across refresh, and reports expired/content-changed/unavailable states. There is no claimed push subscription endpoint.

## First IELTS consumer and feature status

L0001 E09 is now a real managed-JSON consumer at position 90, following prepared vocabulary, sentence patterns, phrase recognition, listening and reading. Two short teaching cards distinguish food, drink and place questions before the adaptive slide. It requests two accepted turns with at most three and allows 30 seconds per recording. Its goal is the learner-facing text shown in the contract above. The educational explanation is in [L0001](../ielts/lessons/L0001.md).

The exercise is `required: false` while `ADAPTIVE_CONVERSATION_ENABLED` defaults to `false`. Learners can continue the required lesson without this optional service. The slide remains registered when disabled; the UI reports availability and allows access to retained history. It does not substitute a scripted exchange and call it adaptive conversation.

The opening exercises in this course are chosen for their educational need under the user's course-specific ordering override. Conversation does not impose an intake/dictation prerequisite rule on unrelated lessons; L0001's prior activities prepare the particular language used here.

`docker-compose.writing-feedback.yml` is an explicit pilot overlay shared with the local-text infrastructure. The normal deployment command does not select it. Enabling conversation requires valid pinned model/tokenizer configuration even if Writing remains disabled, plus configured private ASR and TTS providers. The presence of this overlay, a migration or a managed lesson entry is not evidence that any deployment or target-host benchmark has occurred.

## Verification scope and remaining quality work

Focused coverage exists for conversation definition/result parsing, ownership and task resolution, session/recording behavior, private audio, API boundaries, shared queue/worker leases, completion receipts, Vosk evidence, and Angular recording/transcript/feedback states. MySQL integration coverage exercises conversation persistence. The relevant owners include `back/tests/*conversation*.test.js`, `back/tests/local-text-inference-*.test.js`, `back/tests/integration/adaptive-conversation.mysql.test.js`, the adaptive-conversation Angular specs, and `speech/test_server.py`. A test file's presence is not a claim that it passed in every environment. The repository prohibits E2E and Playwright execution; no such evidence is claimed here.

Structural tests can establish bounded fields, accepted states, scope checks, token/byte limits and deterministic score mapping. They cannot establish that the local model consistently:

- accepts a short relevant answer and valid personal alternatives;
- preserves facts and negation without inventing corrections;
- separates task relevance from grammatical form;
- asks one relevant beginner-level follow-up without prescribing its answer;
- abstains appropriately on uncertain recognition;
- avoids unsupported acoustic or IELTS claims in free-text feedback.

Those properties still require reviewed runs against the exact configured model, tokenizer and prompt. The [evaluation guide](../ielts/evaluation/README.md) provides 12 original synthetic text-turn cases and a default-dry-run CLI using the actual provider. It keeps model-path timing separate from server abstention and leaves semantic judgment pending. It measures neither recognition nor playback; the guide separately describes recorded-speech scenarios for the isolated target host.

Target-CPU latency, memory, sustained queue capacity and interference among Vosk, Kokoro and text inference also remain unmeasured here. Keep the feature disabled pending that operating and semantic evaluation; this document does not declare the full Golden Lesson released or the course complete.
