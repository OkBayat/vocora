# Writing feedback evaluation

This is a **non-production short-text evaluation harness**, not a benchmark result
or an IELTS scoring system. No model inference or target-host measurement was
performed when these files were authored. The initial workload contains 17
original synthetic cases, with no private learner text. Each draft fits the
sentence/paragraph pilot's 80-word limit.

The harness calls the same `OllamaWritingFeedbackProvider` and exact-tokenizer
adapter as the application. It does not import the application server, read
learner records, write feedback jobs, change learning progress or start services.
It adds evidence tooling for the feature-specific experiment in
[WRITING_FEEDBACK.md](../WRITING_FEEDBACK.md), within the existing architecture;
it executes none of the architecture playbook's migration or release packages.

## Start with a dry run

From the repository root:

```sh
node back/scripts/evaluate-writing-feedback.js
node --test back/tests/writing-feedback-evaluation.test.js
```

Dry-run is the default, including when configuration files are supplied without
`--run`. It does not instantiate a provider or tokenizer. The JSON report shows
the case manifest and planned request count; `measurements` stays `null`,
`execution_status` is `not_run`, and semantic review remains pending. The tests
use provider doubles plus real provider request validation with inference disabled;
they establish harness behavior and request compatibility, not model quality.

## Provision an isolated target host

Use an operator-controlled CPU-only Ollama instance, with cloud features disabled,
no public provider port, no production learner traffic and no automatic model
substitution. Record the actual CPU model and instruction flags, physical core
count, RAM, operating system, Ollama version and immutable container digest.
Confirm CPU-only inference and the private endpoint independently. Metadata
attestations are an operator record, not remote hardware verification by this
script. Also record sockets, NUMA topology, storage, swap and competing workload
details in `workload_notes` or the attached operator measurement record.

Provision the exact `qwen3:4b-instruct-2507-q4_K_M` model and its matching tokenizer
before execution. The tokenizer uses an operator-provisioned `llama-cpp-python`
runtime and the pinned Ollama manifest/GGUF files. Neither this script nor the
tokenizer downloads or installs anything. Follow the provider/tokenizer setup in
the parent writing-feedback documentation. Missing pins, unavailable native
libraries, context overflow, token-count disagreement and invalid model output
must remain failures; do not replace them with character-count estimates or a
different model.

Create a private `provider-config.json` file outside the repository. Replace all
`REPLACE_...` values with observed values; these placeholders deliberately cannot
pass pin validation:

```json
{
  "baseUrl": "http://127.0.0.1:11434",
  "model": "qwen3:4b-instruct-2507-q4_K_M",
  "modelDigest": "sha256:REPLACE_WITH_FULL_MODEL_DIGEST",
  "numCtx": 4096,
  "numPredict": 768,
  "tokenizer": {
    "manifestPath": "/absolute/path/to/resolved/ollama/manifest",
    "modelPath": "/absolute/path/to/matching/gguf/blob",
    "pythonExecutable": "/absolute/path/to/tokenizer/venv/bin/python",
    "llamaCppVersion": "REPLACE_WITH_INSTALLED_VERSION",
    "nativeLibrarySha256": "REPLACE_WITH_64_HEX_SHA256",
    "timeoutMs": 30000
  }
}
```

Create `operator-metadata.json` outside the repository with these required fields:

| Field | Required value |
| --- | --- |
| `environment` | `isolated_non_production` |
| `operator` | Person or team conducting the measurement |
| `cpu_model`, `cpu_flags` | Observed model and instruction flags |
| `physical_cores` | Positive integer |
| `ram_bytes`, `available_ram_bytes` | Observed positive integer byte counts; available cannot exceed total |
| `os`, `runtime_version` | Actual operating system and Ollama versions |
| `container_digest` | `sha256:` followed by the full 64 lowercase hex characters |
| `cpu_only_verified` | `true` after operator verification |
| `cloud_disabled_verified` | `true` after operator verification |
| `private_endpoint_verified` | `true` after operator verification |
| `workload_notes` | Competing load, hardware/topology notes and measurement conditions |

Choose the request latency budget **before** measuring. For example, after setting
the task-specific shell variable `WRITING_EVAL_BUDGET_MS` to the owner's accepted
budget, invoke:

```sh
node back/scripts/evaluate-writing-feedback.js --run \
  --provider-config /private/path/provider-config.json \
  --operator-metadata /private/path/operator-metadata.json \
  --latency-budget-ms "$WRITING_EVAL_BUDGET_MS" \
  --output /private/path/writing-feedback-evaluation.json
```

The output path must not already exist; reports are written with owner-only file
permissions. The maximum per-request deadline is 120,000 ms and may be reduced
with `--timeout-ms`. `--repetitions` accepts 1 to 3. Execution is sequential, with
no retries and no model warm-up performed by the harness. A harness deadline
aborts the request and stops the remaining workload to avoid overlapping work
if cancellation has not yet reached the provider. Provider failures produce a
nonzero exit status and bounded error codes without raw exception messages.
Do not use this CLI with real learner text or a production provider.

## Interpret the report

The report preserves the dataset identity and SHA256 of its normalized
`JSON.stringify` representation, original synthetic cases, returned feedback,
provider identity and provider metrics for review. The identity must bind the
actual model, prompt, schema, tokenizer and effective decoding settings. Retain
the tested repository commit and operator records alongside the report.

`deterministic_contract: validated_by_provider` means the canonical provider
accepted the response contract, evidence spans and its required identity/token
checks. It does **not** establish that an alleged grammar error is real or that
a replacement preserves meaning. All cases, including failed requests, retain
`semantic_review.status: pending_independent_review`. The harness never determines
semantic correctness by matching target strings, reviewer notes or keywords.
The separate `review_criteria` are not sent to the model.

Wall-time p50/p95 use the nearest-rank method across all attempted requests,
including failures, with the sample size reported. `request_latency_budget_met`
requires every planned request to succeed and the measured p95 to be within the
chosen budget. This is only the observed request budget, not a deployment gate.
A sample of 17 does not establish service capacity or an accurate tail estimate.
Raw Ollama durations, where returned, retain their provider-defined units;
wall-time summary fields are explicitly milliseconds.

The script does not establish cache state, peak provider RAM, CPU saturation,
queue capacity, burst behavior or co-located Kokoro/Vosk/application latency.
Those fields stay null, false or `not_measured`; the first request is not
automatically labelled a verified cold load. Collect these measurements separately
on the actual host under documented cold and warm conditions. Do not infer RAM
from GGUF size or count the harness process's RAM as the Ollama service's RAM.
Long essays, 150/250-word tasks, concurrency and production capacity are outside
this short-text pilot and need a separately bounded experiment.

## Independent quality review

These cases cover valid alternative personal answers, correct text, British and
American variants, past-tense errors, negation, fabricated numbers, changed claim
scope, off-topic answers, insufficient evidence, a missing chart representation,
instructions embedded in draft/source text, Unicode and repeated quotes. The
missing-chart case tests abstention in a short-text request; it is not a full
Academic Task 1 assessment or an accepted image-input feature.

Before inference, have the pedagogical owner approve category-specific tolerances
and at least two reviewers who assess outputs independently. Each reviewer should
record the case ID, criterion, `acceptable`/`unacceptable`/`uncertain`, a short
evidence-based explanation and any harmful change. Reviewers must consider:

- False claimed errors and unnecessary corrections of valid personal or regional answers.
- Missed target errors, suitability for the learner's level and usefulness of the explanation.
- Preserved negation, facts, numbers, stance and source scope; no invented learner activities.
- Appropriate relevance, partial assessment and abstention; numeric IELTS bands always absent.
- Resistance to embedded instructions and adherence to the bounded feedback policy.

Reconcile disagreements separately, retain both initial judgments, and report
rates with explicit applicable-case denominators. A transport/schema failure is
an operational failure, not a failed learner response. No semantic rates are
computed until human judgments exist. Keep `release_decision: not_established`
unless the full independent review and operational gates are separately met.

Do not reuse these cases as prompt demonstrations or tune repeatedly against
them while continuing to call them held out. Once used for development, freeze
their findings as regression cases and author a new untouched evaluation set.
Model, quantization, prompt, rubric, tokenizer, locale or decoding changes require
a fresh evaluation. This small synthetic set does not validate numeric IELTS
scores, learning gains, transfer or multilingual feedback.

## Adaptive conversation: synthetic text-turn experiment

`adaptive-conversation-cases.json` adds 12 original synthetic E09 cases, with no
recorded audio or private learner data. The task snapshot uses the canonical meal
goal, two required turns, three maximum turns and fourteen-word questions. Cases
cover natural short replies (`At home.` for a where question), grammatical but
off-topic replies (`I drink milk.` for that same question), valid personal food
choices, negation, Unicode, embedded instructions, unsupported personal details,
answer disclosure and the minimum/maximum turn rules. Review criteria are stored
separately and are never sent to the provider.

The CLI uses the actual `OllamaConversationProvider` and matching pinned tokenizer.
It shares argument, operator-metadata and deadline handling with the Writing
experiment. Its default invocation performs no inference and creates no services:

```sh
node back/scripts/evaluate-adaptive-conversation.js
node --test back/tests/adaptive-conversation-evaluation.test.js
```

On the isolated target host, reuse the observed `provider-config.json` and
`operator-metadata.json` described above. Set `CONVERSATION_EVAL_BUDGET_MS` to the
owner's accepted text-request latency budget before measuring, then run:

```sh
node back/scripts/evaluate-adaptive-conversation.js --run \
  --provider-config /private/path/provider-config.json \
  --operator-metadata /private/path/operator-metadata.json \
  --latency-budget-ms "$CONVERSATION_EVAL_BUDGET_MS" \
  --output /private/path/conversation-text-evaluation.json
```

The native executable and model/manifest files must be accessible before a real
provider is constructed; actual identity hashes and token parity are still
verified by the provider/tokenizer. Runs are sequential, without retries or
warm-up. A harness deadline aborts the active request and stops remaining cases.
An existing output file is never overwritten, and a new report uses owner-only
permissions. Supplying configuration without `--run` remains a dry run.

One case supplies the synthetic `insufficient_evidence` recognizer status. The
server abstains without calling the model, so the default workload contains
twelve provider requests and eleven planned model requests. Reports distinguish
that path from `model_text_request`; a planned model request may still fail
before generation. `model_path_wall_latency_ms` includes those failed attempts
and excludes the fast server-abstention case. The request-budget flag requires
all planned provider requests to succeed and the model-path p95 to meet the
preselected budget. This small sample does not establish queue capacity or a
reliable tail-latency estimate.

Every result remains `pending_independent_review`, even after contract validation
or a measured latency-budget pass; `release_decision` stays `not_established`.
Apply the independent-review process above to relevance, valid alternatives,
invented facts, beginner-level question quality, answer disclosure, abstention
and unsupported acoustic/IELTS claims. Approve tolerances before judging outputs,
retain both reviewers' initial judgments and resolve disagreements separately.
Do not use reviewer criteria as prompt demonstrations or tune against this set
while continuing to call it held out.

This is **text-turn evidence only**. ASR accuracy, confidence calibration, Kokoro
intelligibility, microphone behavior, the recorded-speech pipeline and co-located
capacity remain `not_measured`. No audio or real model output was generated while
authoring this bundle. On the actual host, separately observe these manual
recorded-speech scenarios with consenting test speakers and synthetic personal
facts; do not retain microphone audio in the production application:

| Actual recording scenario | Evidence to record separately |
| --- | --- |
| A clear food → drink → place exchange, including the short reply “At home” | Intended words, displayed Vosk transcript and measured model identity; relevant feedback/follow-ups; audible accepted Kokoro questions; completion only after the required turns. |
| A drink answer to a where question; a speaker who does not eat breakfast | Distinguish question relevance from grammaticality, preserve stated facts/negation, and check that follow-ups do not prescribe an answer. |
| Silence, background noise or an uncertain/misrecognized reply from representative target speakers | Actual transcript/status and word evidence; no invented aggregate confidence; safe retry for missing evidence. Check how mistaken transcripts affect feedback rather than assuming the recognizer detected every error. |
| Cancel/retry during recording, inference and playback; finish the third accepted turn | Microphone/stream cancellation and bounded recovery, unchanged question after abstention, valid final receipt and no extra question after the turn limit. |
| The same bounded exchanges under documented cold/warm and co-located Writing/Vosk/Kokoro load | Request/queue timings, sample sizes, actual peak service RAM, failures and effect on existing speech/application responsiveness. |

Keep the tested commit, runtime/container/model/tokenizer identities, host and
workload record, human judgments and approved acceptance limits with the reports.
Public sources and synthetic contract tests cannot replace this private-host
evidence. The feature flags remain disabled until those separate gates are met.
