# Self-hosted Writing Feedback Plan

> Status: **disabled short-text implementation plus the original release plan**.
> Recorded: 2026-09-12. Repository baseline: `a96fe551421910d28890b01a17822544002b124b`.
> Scope: CPU-only local text feedback, Writing first; preserve Kokoro and current Shadowing.

Read [the implementation direction](IMPLEMENTATION.md), the [curriculum](README.md),
and the existing [architecture playbook](../ARCHITECTURE_PLAYBOOK.md) together.
This is a feature-specific addition, not a second repository architecture playbook.

## Current implementation: short-text formative feedback

The course-production branch implements the WF-02/WF-03/WF-04 short-text slice
under the existing Express/MySQL and Angular owners. It does not execute the
enterprise playbook's PostgreSQL, NestJS or TypeScript migration packages. The
new backend ESM JavaScript files follow the current application runtime; their
future language/framework migration belongs to WP-03/WP-07 rather than a second
runtime introduced for this feature.

The existing `writing-response` slide may opt into the generic `writingFeedback`
content contract. The server resolves its prompt, CEFR level, language objectives,
response expectations and optional exact source from the owned, started exercise.
It excludes the personal model answer from the evaluator's context. The first
pilot accepts sentence and paragraph tasks; its 80-word inference cap does not
claim support for full IELTS essays or numeric band estimates. L0001's two writing
tasks supply this context in the canonical course JSON.

The top-level slide `wordLimit` is an authored teaching target, separate from the
80-word provider admission limit. For example, L0001 asks for 20–40 words; a
41–80-word response can still receive feedback without losing the original target
from its task context. Above the pilot cap, the draft remains saved and feedback
is unavailable. Explicitly unassessed task coverage or source accuracy is shown
alongside available feedback, rather than implying that every dimension was checked.

An immutable draft and bounded planning notes are saved before inference. Each
revision has a new identity and may link to an owned earlier draft. The configured
slide distinguishes saving, saved, queued, processing, available feedback,
insufficient evidence and unavailable feedback. Selected, validated edits produce
a separate preview; they never replace the original. An explicit submission
without optional feedback can use the existing exercise-completion persistence
when feedback storage is unavailable; that path must not claim the draft is
durable before the exercise is finished.

### HTTP and persistence ownership

All operations authenticate through the existing account boundary, return private
`no-store` responses, and enforce ownership on the server. New request fields are
strictly bounded. `expectedPathContentVersion` is an optimistic precondition from
the displayed exercise, not a client-owned rubric or authoritative task context.
A stale version must fail before a draft is evaluated against changed instructions.

| Operation | Route |
| --- | --- |
| Save a new draft / list the current task's saved drafts | `POST` / `GET /api/learning-paths/:pathId/lessons/:lessonId/exercises/:exerciseId/slides/:slideId/writing-feedback` |
| Read an owned submission and feedback state | `GET /api/writing-feedback/:submissionId` |
| Retry unavailable feedback / cancel active feedback | `POST /api/writing-feedback/:submissionId/retry` / `cancel` |
| Delete the owned feedback submission | `DELETE /api/writing-feedback/:submissionId` |

Migration 024 adds submission, provider-lease and daily-quota tables. It changes
no existing progress tables or recorded correctness. The worker holds no database
transaction while calling the tokenizer or model. A global lease, idempotency,
bounded retries and conditional final writes protect accepted results across
concurrent requests, cancellation, deletion and restarts. Cancellation must retain
provider capacity until the underlying operation stops or its lease expires.

Trial limits are one active provider operation, eight queued/running jobs globally,
two per owner, twenty new feedback submissions per owner per UTC day, ten saved
drafts per writing slide and exercise run, and three provider attempts per draft.
The active provider slot and eight-global/two-owner queue are now shared with
adaptive conversation through `LocalTextInferenceWorker`; neither family owns a
second inference scheduler. The existing Writing worker facade delegates to that
same owner. Conversation has its own session quotas and retains its own prompt,
schema and result policy while using the pinned structured-text client.
Queue refusal preserves an otherwise accepted draft. Daily quota accounting
survives individual submission deletion. These are bounded trial settings, not
measured service capacity or a restriction on the number of course lessons.

Feedback copies expire after a configurable 1–90 days, with a 30-day trial default.
The worker purges expired feedback copies; ordinary completed learning-attempt
evidence remains owned by the existing learning-path lifecycle. Deleting a feedback
copy does not promise erasure of that separate learning history or backups. Review
the actual privacy/retention policy before a learner-facing rollout.

### Provider identity and tokenizer

The private provider verifies the exact model tag and full manifest digest before
and after inference. It records prompt/schema versions and hashes, decoding
settings and tokenizer identity. It sends no model tools or cloud fallback.
Only a validated result with anchored Unicode code-point spans reaches the UI.
Malformed, truncated, contradictory or ungrounded model output is unavailable
feedback, never a wrong learner answer.

`WritingFeedbackTokenizer` uses the same local GGUF vocabulary as the pinned
Ollama model. It renders the bounded `vocora-qwen-instruct-chatml-v1` prompt,
including the JSON schema, and counts it before sending that exact prompt through
Ollama's `raw: true` generate API. It rejects context overflow without truncation
and compares the actual `prompt_eval_count` with its count. The original Ollama
template hash remains provenance; the raw renderer has its own version. Its
subprocess receives private text on stdin, is killed on cancellation and must
close before its caller releases capacity.

The helper hashes the complete GGUF on each call and loads its vocabulary without
creating an inference context. Include this I/O and process startup in target-host
latency measurements. No installed tokenizer, native build, actual model inference
or token-count parity was verified in the authoring environment.

### Explicit pilot provisioning

Feedback defaults to `WRITING_FEEDBACK_ENABLED=false`. The normal application image
and deployment script do not install or select the tokenizer overlay. An operator
can inspect its installation plan without network access or writes:

```sh
python3 back/scripts/provision-writing-feedback-tokenizer.py \
  --venv /opt/writing-feedback --dry-run
```

The optional build requires CPython 3.11/3.12, venv, a C/C++ compiler, CMake >=3.21
and Ninja. The provisioner pins Python dependencies and the native source archive
checksum, disables GPU/native SIMD optimizations, checks a fresh native import,
and records the actual native-library hash and resolved packages. Compiler and
base-image differences still matter; this is not a bit-for-bit build guarantee.

With the normal non-production Compose environment configured, build the separate
pilot image without starting or deploying services:

```sh
docker compose -f docker-compose.yml -f docker-compose.writing-feedback.yml build app
docker run --rm --entrypoint cat leitner-ielts-app-writing-feedback \
  /opt/writing-feedback/tokenizer-build.json
```

The overlay mounts the existing Ollama model volume read-only. Set these values
from observed artifacts before enabling an isolated evaluation:

| Environment value | Source |
| --- | --- |
| `WRITING_FEEDBACK_MODEL_DIGEST` | `sha256:` plus the full pinned Ollama manifest digest |
| `WRITING_FEEDBACK_GGUF_PATH` | `/opt/vocora-models/models/blobs/sha256-...` for that manifest's model layer |
| `WRITING_FEEDBACK_TOKENIZER_LIBRARY_SHA256` | `native_library_sha256` in the tokenizer build record |
| `WRITING_FEEDBACK_OLLAMA_MANIFEST_PATH` | Read-only matching manifest; the overlay selects the exact candidate tag |
| `WRITING_FEEDBACK_TOKENIZER_PYTHON` | `/opt/writing-feedback/bin/python` |
| `WRITING_FEEDBACK_TOKENIZER_VERSION` | `0.3.16` |

The app user must be able to read the mounted files. Missing or changed identities
fail closed. No model pull or package install
occurs in a learner request. The optional Docker/native build was not executed in
the authoring environment, which has no Docker runtime or model artifacts.

Use [the original evaluation cases and operator guide](evaluation/README.md) for
the isolated target-host experiment. Its default command is a no-inference dry
run; actual execution requires explicit operator metadata and a preselected
latency budget. Synthetic contract tests do not satisfy WF-01's model-quality,
CPU, memory, concurrent-load or token-parity release gates. Adaptive conversation
is implemented behind its own disabled flag; its speech, feedback and follow-up
quality require separate evidence described in the existing conversation document.

The numbered sections below preserve the design rationale and release criteria.

## 1. What was inspected and what is still unknown

The `ielts/` directory contains the curriculum, stage copies, data, reference
packs, authoring/build scripts and package audit outputs. The uploaded curriculum
and `ielts/README.md` have the same Git blob identity:
`af9c35970987ae204ee865897eec54b65a3b12a3`.
The repository already has `ARCHITECTURE_PLAYBOOK.md`; it is left unchanged.

The relevant current boundaries are:

| Source | Observed behavior | Implication |
| --- | --- | --- |
| [Curriculum sections 10 and 13](README.md) | Semantic productive feedback is proposed; authoring objects are not runtime lessons | Add an evaluated feedback capability, not a claim that the bank is ready |
| [Slide completion verifier](../back/src/domain/collection-learning-path/SlideSequenceExercise.js) | Closed responses use configured keys; Writing submissions are checked as nonempty bounded text | Submission is not semantic correctness |
| [Writing response component](../ui/src/app/shared/slide-exercise/library/components/writing-response/writing-response-slide.component.ts) | Captures response/notes, word count and model-comparison state | Extend this family rather than inventing a Qwen-specific slide |
| [Exercise contract](../.agents/skills/k2-exercise-builder/references/exercise-contract.md) | Local `rewrite` corrections have a constrained exact-answer contract | Open paraphrases and summaries must not be graded through that contract |
| [TTS documentation](../docs/TTS.md) and [Compose](../docker-compose.yml) | Private CPU Kokoro service behind authenticated `POST /api/tts/speech` | Keep the existing provider and cache owner |
| [Shadowing documentation](../docs/SHADOWING.md) | Private Vosk recognition, expected-sentence coverage and bounded recording sessions | Preserve current practice; this is not general IELTS Speaking scoring |

This is a source/document review, not an execution of the application or a
benchmark on the owner's servers. Exact HP server model, CPU SKU/instructions,
allocated RAM, operating system, competing workloads and user concurrency are
unknown. No measured inference latency, RAM requirement or IELTS grading accuracy
is asserted here.

## 2. Selected model and verified upstream facts

Use **Qwen3-4B-Instruct-2507** as the initial candidate, served by **Ollama locally**.
The upstream model card identifies a 4.0B text-generation model, Apache-2.0
licensing and non-thinking-only operation [Q1]. This is not Qwen3-Omni, an ASR
model, a vision model or a TTS model.

The specific Ollama library entry verified for the experiment is:

```text
qwen3:4b-instruct-2507-q4_K_M
```

Its library listing reports a roughly **2.5 GB Q4_K_M artifact** [Q2]. That is
**not total runtime RAM**, and the upstream maximum context length is not a
recommended CPU deployment setting. Ollama documents a CPU-only Docker path,
structured JSON-schema outputs and controls for context/concurrency [O1-O4].

Before release, record the full resolved model digest, source/license identity,
quantization, chat template, Ollama version and container digest. A mutable tag
or its short displayed hash is not an immutable deployment record. Do not silently
substitute `qwen3:4b`, a thinking variant, another quantization or a cloud model.

The model is a **candidate**, not a claim that benchmark performance on general
language tasks validates Vocora corrections or IELTS bands. There is no paid
external inference API required by this design; local compute, power, storage,
maintenance and model acquisition still have costs.

## 3. Keep grading and feedback separate

Choose the assessment method from the task's required evidence, not its answer
length. A 40-word dictation may have a fixed key; a two-word personal answer may
not.

| Task | Owner of the result | AI role |
| --- | --- | --- |
| Exact-source answer, dictation, closed choice or bounded structured response | Existing deterministic domain validator | Optional explanation only; never override the key automatically |
| Narrow grammar transformation with a complete valid-answer contract | Deterministic validator | Optional formative help, separately labelled |
| Personal message, original paragraph, open explanation, paraphrase or summary | Stored response plus formative feedback | Task relevance, meaning preservation, language issues and limited corrections |
| Numeric IELTS-style estimate | Separately approved and calibrated assessment policy | Disabled in the initial release |

For “What did you do today?”, exercising, eating or programming can all be
relevant. A sample answer is not the only correct life history. Correct grammar
without inventing activities, changing a stance, or rewriting the learner into
an advanced speaker. For a source-based summary, supply the exact relevant source
and judge fidelity to it; do not substitute general knowledge.

Word count, ownership, valid task references and JSON/span validation remain
deterministic. Meaning, relevance, grammar diagnosis and suggested edits remain
fallible model judgments. Low temperature and structured decoding do not make
those judgments proofs. Do not use keyword presence, edit distance, or a model's
self-reported confidence as a mastery rule.

## 4. Proposed technical path

```text
Existing writing-response UI
    -> authenticated Vocora application boundary
    -> preserve original draft + authoritative task/content version
    -> deterministic admission/constraint checks
    -> bounded feedback job in the existing backend application
    -> private Ollama adapter -> pinned Qwen text model
    -> JSON schema + evidence/span validation
    -> save immutable feedback version
    -> learner reviews -> saves a separate revision -> fresh transfer task

Existing TTS callers -> existing backend TTS owner -> Kokoro (unchanged)
Existing Shadowing  -> existing recognition/coverage owner -> Vosk (unchanged)
```

Do not install a new agent framework, vector database, broker, Redis or general
microservice orchestration system for this feature. An Ollama process is an
inference dependency, like the existing speech providers, not a new owner of
learning rules. Start with one application/worker owner and one inference request
at a time; change concurrency only with measured capacity.

Place model calls behind a small provider port in the existing
Domain/Application/Infrastructure/HTTP layering. The application owns admission,
job state and persistence; the adapter owns Ollama's request/response details.
The browser never calls Ollama directly. Use current repository ports and the
active database; do not bundle a NestJS or PostgreSQL migration into this work.
Keep the eventual migration compatible with the existing architecture playbook.

The first implemented API must define authenticated request and result-query
operations with ownership checks, idempotency and a versioned response. Their
public paths are **not established by this document**; select them with the
actual route owner during implementation instead of documenting an invented
existing endpoint.

## 5. Task context and response contract

### 5.1 Server-owned request assembly

Accept an owned task/attempt reference, draft text and an idempotency key from the
client. Resolve the complete prompt, intended skill/level, output constraints,
allowed assistance and content version on the server. Never trust client-supplied
rubrics, correct answers, model names, provider URLs, user IDs or claimed scores.

For a personal task, do not supply an exact expected narrative. For a paraphrase
or summary, include its source and the required meaning/scope. For Academic Task
1, the text-only model needs an **author-verified textual data representation**:
values, labels, units, dates, relations and relevant comparisons. An image URL,
filename, or learner's own description is not adequate source evidence. If that
representation is absent, abstain from data/task-achievement assessment; bounded
language feedback may still be explicitly marked partial.

Preserve the original draft byte-for-byte with an ID/hash before sending it for
feedback. Record task/content, prompt, rubric, schema, model and decoding
versions. Planning notes, assistance and revisions must not overwrite the first
independent response. Persist only the minimum required context with the relevant
privacy/access policy; never copy sealed answer banks into logs or learner JSON.

### 5.2 Proposed model result

The following is an **illustrative model-output contract**, not an existing
runtime slide object, an actual inference result, or a validated model schema.
The implementation must create one strict JSON Schema and focused tests for it.
Backend-owned persistence and identity metadata wrap this result separately.

For a past-time task and the draft `Yesterday I go to the gym.`:

```json
{
  "schema_version": 1,
  "assessment_status": "feedback_available",
  "abstention_reason": null,
  "task_relevance": "on_topic",
  "task_comment": "You described an activity from yesterday.",
  "issues": [
    {
      "category": "grammar",
      "kind": "error",
      "quoted_text": "go",
      "occurrence": 1,
      "replacement": "went",
      "explanation": "Use the past form because the activity happened yesterday."
    }
  ],
  "revision_actions": ["Change the verb to its past form."],
  "not_assessed": ["ielts_band"],
  "ielts_band": null
}
```

Define positive enums and reject unknown properties. `assessment_status` is
`feedback_available` or `insufficient_evidence`; `task_relevance` is `on_topic`,
`partly_on_topic`, `off_topic` or `not_assessed`. Categories are `grammar`,
`spelling`, `punctuation`, `word_choice`, `coherence`, `task_coverage` or
`source_fidelity`. `kind` distinguishes a genuine claimed `error` from an optional
`suggestion`. Require `abstention_reason: null` for available feedback and a
nonempty reason for `insufficient_evidence`. Keep `ielts_band` null in this
release regardless of what the model attempts to return.

Initially request at most three prioritized issues and one or two revision
actions. A correct response may legitimately have no issues. An omission or
whole-response issue can use `quoted_text: null`, `occurrence: null` and
`replacement: null` with an explicit task-level explanation; never invent a
quote. These nullable cases must be explicit in the implemented schema.

The model supplies exact quotes, not trusted numeric offsets. The backend locates
the specified one-based non-overlapping occurrence in the immutable draft and
creates display spans using a single documented Unicode indexing convention.
Reject nonexistent quotes, ambiguous occurrence references and overlapping edits.
Do not silently repair fabricated evidence. These checks establish that evidence
is anchored, **not** that its linguistic diagnosis is true.

Generate a minimally corrected preview from validated, learner-selected edits;
keep it separate from the original. Do not send an entire highly polished rewrite
as the learner's improved score. Missing prompt parts and organization issues
normally need a revision instruction, not invented sentences. Escape all returned
text in the UI; model output is untrusted content, never executable HTML.

### 5.3 Initial prompt requirements

Keep a versioned server-owned instruction asking the model to evaluate the
provided task and draft as data, preserve meaning/voice, accept valid alternatives,
state insufficient context, avoid unnecessary edits, and return only the agreed
schema. Student text and source text are untrusted even when they contain
instructions to the model. No tools, network search, filesystem, commands or
access to other learners are enabled for this inference call.

Feedback starts in simple English appropriate to the task. Persian explanation
can be evaluated as a separate supported locale; do not assume translation
quality or allow it to change the English correction. Pin and test any locale
prompt separately.

## 6. Persistence, failure and UI semantics

Use a small durable job/feedback record behind current persistence ports so a
slow CPU request does not hold a learner submission open indefinitely. Introduce
additive schema only in the later implementation PR and only for the active DB
engine. Do not persist through a parallel JSON file store. A single bounded worker
can claim jobs using an atomic lease and finish with a compare-and-set guard;
expired work may be retried without creating a second final feedback record.

A proposed job lifecycle is `queued -> running -> succeeded`, with explicit
`failed` and `cancelled` terminals. Successful processing may contain model
abstention; that is not transport failure. Queue rejection leaves the saved draft
intact. Define timeout, lease duration, retry count/backoff and queue limits from
the accepted benchmark; do not leave them unbounded. Retry transient provider
failures at most within the configured bound; do not repeatedly prompt until a
preferred score appears. Malformed/truncated output is a failed feedback result,
not automatic learner failure or success.

Deduplicate on authenticated owner, attempt/draft version, task/content version,
feedback policy, model digest, prompt/rubric/schema version and locale. An explicit
re-evaluation under a new version makes a linked new record. Do not use a global
public text-only cache, and never show another learner's feedback on a hash hit.
Persist the validated result that was shown; do not recompute historical feedback
silently on page refresh.

The UI distinguishes **draft saved**, **feedback queued**, **processing**,
**feedback available**, **insufficient evidence**, **retryable failure** and
**cancelled**. It must not display “correct”, “mastered” or “IELTS 9” merely because
the model responded. Preserve draft recovery if the provider is unavailable.

Do not infer durable draft storage from the current component's local submitted
state. Before evaluation, the owning application must have persisted an owned
response artifact that can be read back. Later navigation/reload and expired
sessions must not erase the submitted text or allow cross-user result access.

Keep completion, feedback and mastery separate. Feedback failure/abstention does
not reset completed lessons or alter Leitner boxes, due dates or mistake totals.
Where a course gate actually requires assessed productive evidence, show that it
remains unverified; do not promote submission to mastery or silently bypass the
gate. Preserve first attempts, assisted repairs and fresh-transfer evidence.

## 7. CPU-only operation and acceptance experiment

### 7.1 No hardware promise from the server generation

Ollama documents CPU-only execution [O1], but “HP Gen8” does not establish that a
particular binary and CPU instruction set are compatible or fast enough. Record
CPU model/flags, sockets, physical cores, NUMA topology, OS/container versions,
free and committed RAM, swap, storage and concurrent app/Kokoro/Vosk load. Verify
the chosen Ollama build starts on that CPU and reports CPU inference. If it does
not, retain the draft-only path and record the compatibility failure; evaluate a
compatible runtime/build as a separately reviewed change, not a hidden fallback.

Model weights, KV cache, prompt/batch buffers and runtime overhead share system
RAM with Vocora, its database and the two speech services. The artifact's 2.5 GB
size does not establish an 8 GB or 16 GB deployment requirement or any latency.
Do not advertise “a few seconds” before measurements. Long prompts and generated
feedback can be slow even when the model loads successfully.

### 7.2 Isolated experiment settings

Begin with a pinned CPU-only Ollama image/runtime, no GPU devices or reservations,
a persistent model volume and **no public host port**. Restrict access to the
backend/worker network. For a local operator-only process, use loopback; for a
private container service, bind inside its private network without publishing the
port. Model downloads happen in provisioning, not inside learner requests.
Disable cloud features with `OLLAMA_NO_CLOUD=1` and deny unnecessary runtime
egress; verify the setting on the selected runtime version [O3].

The following are **initial trial values, not measured capacity or production
configuration**:

| Setting | Trial value / decision |
| --- | --- |
| Model | `qwen3:4b-instruct-2507-q4_K_M`, resolved digest recorded |
| `OLLAMA_NUM_PARALLEL` | `1` |
| `OLLAMA_MAX_LOADED_MODELS` | `1` |
| `OLLAMA_MAX_QUEUE` | `8`; the application admits work before this queue |
| Context | Explicit `num_ctx: 4096` for the first short-text pilot |
| Output | Explicit `num_predict: 768` for compact feedback |
| Response | `stream: false`, `format` set to the strict JSON Schema |
| Decoding | Trial `temperature: 0`; record all effective options |
| Keep-alive | Finite and measured; do not assume a permanently loaded model is free |

Ollama documents these output/context/concurrency mechanisms [O2-O5]. Upstream
Qwen recommends different general sampling defaults [Q1]; the low-temperature
trial is a Vocora experiment for bounded feedback, not an upstream quality
recommendation. It does not guarantee identical output across versions/hardware.

Budget the whole request: instructions, schema, task, source, draft and reserved
output. Preflight with the matching tokenizer before admission. Reject or route
an oversized task explicitly; never silently truncate the draft, prompt or source.
Increase limits only after memory and quality checks. If the response hits the
output limit or the JSON is incomplete, report feedback failure and preserve the
draft rather than hiding a partial answer.

Use the same CPU host and versioned representative payloads to measure cold-load
time, prompt evaluation, output generation, total/queue latency, peak process or
container RAM, CPU saturation, failures and JSON validity. Ollama returns timing
and token counts that can support these measurements [O4]. Check co-located app,
Kokoro and Vosk response times, not just the new worker's speed.

Test short responses, source-based 35-40-word summaries, paragraph responses and
150/250-word task-shaped inputs separately. A short-pilot success does not prove
capacity or assessment quality for a long essay. Evaluate sequential use and
bursts larger than the queue; report p50/p95 latency with the sample size and
workload. The product owner sets an acceptable latency budget before launch.
No performance results have been collected in this documentation change.

### 7.3 Graceful rollout and rollback

Default feedback off until the feasibility and quality gates pass. Enable a small
Writing cohort first. Provider readiness is a feature-level status: unavailable
feedback must not stop normal vocabulary practice or TTS. Apply per-owner rate
limits and resource limits; shed feedback load before destabilizing the database
or speech services. Include a rollback flag and the previous pinned provider
identity. Disabling feedback preserves saved drafts, results and learner history.
Do not include model weights or generated learner data in Git.

## 8. Quality, security and score release gates

Before showing formative feedback, evaluate the exact quantized model, prompt,
schema and context settings against reviewed examples across the intended levels.
Include already correct text, several different valid personal answers, minimal
grammar errors, British/American variants, negation, numbers, changed claim scope,
off-topic but grammatical answers, short/gibberish inputs, unsupported Task 1
images, prompt injection, misleading source instructions and multilingual text.
Measure harmful edits, meaning changes, false error claims, missed target errors,
source/relevance judgments, schema failure and abstention behavior. Define and
approve tolerances before interpreting the held-out results; do not claim that a
model's own confidence is a calibrated probability.

Use independent reviewers and a held-out dataset for the pedagogical judgments.
Deterministic fixtures prove the adapter contract and safeguards, not the quality
of real generated corrections. Evaluate whether revisions improve the targeted
capability and whether it transfers to a fresh task. Keep teaching examples and
sealed assessment content separate. Feedback is released only after the relevant
coherent attempt is submitted; do not expose corrections inside a sealed test.

Keep numeric IELTS estimates null until independently rated full responses,
criterion-level evidence, agreement/error analyses, subgroup checks and an
untouched evaluation set support that exact assessment policy. A 35-word response
is not a full IELTS Writing test. Model, quantization, prompt, rubric or locale
changes require re-evaluation. Do not convert an arbitrary 0-100 AI score into a
band or reward a correction as independent proficiency. These limits implement
curriculum sections 9 and 10, not a promise that this candidate will meet them.

Security requirements include exact owner checks for drafts/jobs/results,
request/body/token limits, strict JSON validation, escaped rendering, private
provider access and no direct model access to secrets, SQL or state-mutating
commands. Prompt separation is not a complete prompt-injection defense; tool
isolation and deterministic enforcement of allowed effects remain necessary.
Record operational metrics/version IDs without raw learner text in routine logs.
Use a documented retention/deletion policy covering drafts, results, job payloads
and backups. No external/cloud fallback or private-text training without a
separately approved policy and explicit user-facing disclosure.

## 9. Speaking and TTS: explicitly later

Keep the current Shadowing exercise, Vosk model and expected-sentence coverage
policy unchanged. Its documented 30-second, in-memory session contract is not a
ready-made persistent long-turn IELTS recording flow. Do not repurpose its
success percentage as a pronunciation grade.

A future separately scoped flow may preserve an owned audio artifact, obtain a
transcript with uncertainty, use Qwen for **text-level** feedback, and synthesize a
learner-requested corrected phrase through the existing Kokoro service. ASR errors
must not automatically become learner errors. A transcript omits acoustic and
timing evidence; full Speaking, pronunciation and fluency judgments remain out
of scope for this text model. Corrected TTS playback is a model example, not the
learner's own improved performance.

Before sending private learner text to the current shared TTS cache, resolve
retention, deletion and access requirements with that owner; do not assume the
existing content-addressed cache is already a per-learner recording store.
There is no Qwen3-Omni deployment or replacement of Kokoro in this plan.

## 10. Implementation verification checklist

The future implementation PRs must prove the following with unit, behavior,
contract and regression tests, plus separately reported model/hardware evaluation.
Follow `AGENTS.md`: do not create or run E2E/Playwright suites.

| Boundary | Required checks |
| --- | --- |
| Request/context | Cross-user denial; unknown/retired task; server-owned rubric/model; immutable draft; missing source/oversized input refusal |
| Provider adapter | Valid JSON; unknown fields/enums; absent evidence quotes; repeated quotes; Unicode spans; overlapping edits; truncated output; timeout/unavailable response |
| Worker/storage | Duplicate requests; bounded retry; stale lease; restart; cancel/delete race; owner isolation; one final record per job; no transaction held during inference |
| UI/components | Saved versus assessed state; reload recovery; no fabricated pass; minimal corrections; separate revisions; model text escaped; keyboard/mobile usability |
| Learning contracts | Existing closed grading unchanged; submission not mastery; no extra Leitner event, reset, promotion or reward from AI output |
| Feature operations | CPU-only startup; pinned digest; no public Ollama port; cloud disabled; load shedding; rollback preserves user data |
| Model quality | Alternative valid answers; meaning/negation preservation; unsupported-claim diagnosis; false corrections; abstention and instruction-injection cases |

Do not mark a test or benchmark passed because it is listed here. The documentation
PR changes none of these runtime contracts and supplies no model evaluation data.

## 11. References and evidential limits

Repository links above refer to the inspected architecture and owning source
paths; recheck them at each implementation slice. The original curriculum remains
the educational specification. The following primary upstream sources were
checked on 2026-09-12; they support availability/interfaces, not IELTS accuracy
or performance on an unspecified server.

- **Q1:** [Qwen3-4B-Instruct-2507 official model card](https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507/raw/main/README.md): model identity, text/non-thinking scope, license and upstream usage guidance.
- **Q2:** [Specific Ollama Q4_K_M library entry](https://ollama.com/library/qwen3:4b-instruct-2507-q4_K_M): exact candidate tag and artifact size.
- **O1:** [Ollama CPU-only Docker documentation](https://docs.ollama.com/docker): CPU deployment path, not a target-host benchmark.
- **O2:** [Ollama structured outputs](https://docs.ollama.com/capabilities/structured-outputs): JSON Schema via `format`; semantic correctness remains a separate check.
- **O3:** [Ollama FAQ](https://docs.ollama.com/faq): local-only setting, context, concurrency, queue behavior and memory considerations.
- **O4:** [Ollama chat API](https://docs.ollama.com/api/chat): provider request/response boundary and evaluation metrics.
- **O5:** [Ollama Modelfile parameters](https://docs.ollama.com/modelfile): generation/context parameter definitions; trial values in this plan are product decisions.
