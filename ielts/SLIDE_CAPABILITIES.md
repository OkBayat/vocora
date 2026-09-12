# IELTS Reusable Slide Capability Audit

> Audit date: 2026-09-12. Runtime base:
> `17622311e2e383e812679dcf43916ee765b62bc8`.

This audit maps the IELTS curriculum to Vocora's shared JSON-driven slide
library. It does not authorize IELTS-specific components. A task uses an
existing family only when the learner action and server-verifiable evidence
match; otherwise the missing capability is implemented as a general reusable
interaction or remains in its owning application workflow.

## Audited sources

- `ielts/scripts/README-front.md`, especially sections 6, 7, 10, 12, 13, and 16;
- all 960 canonical objects in `ielts/data/lesson_plans.jsonl`;
- the published L0001 managed path in `back/data/learning-paths/ielts.json`;
- the Angular slide models, registry, components, fixtures, and tests;
- the backend slide-sequence definition and completion verifier;
- `docs/ADAPTIVE_CONVERSATION.md` and `ielts/WRITING_FEEDBACK.md`.

The 960 lesson plans currently use 15 authoring interaction names. The runtime
library already contained those 15 plus `word-formation`, `selection`, and
`number-input`. The audit found one missing learner interaction and two general
contract gaps; that base slice brought the registered reusable total to 19.
The course branch adds the complete adaptive-conversation workflow as the twentieth
registered interaction. Its real-model release gate remains open.

## Capability map

| IELTS learner action | Reusable owner | Audit result |
| --- | --- | --- |
| Learn a word, contrast, rule, warning, or model | `teaching-card` | Supported; remains presentation-only. |
| Select one or several answers | `choice` | Supported for scored single and multiple choice. |
| Judge True/False/Not Given or Yes/No/Not Given | `truth` | Supported with distinct modes. |
| Match headings, features, speakers, endings, or terms | `matching` | Supported, including many-to-one and deferred feedback configuration. |
| Classify language or evidence roles | `classification` | Supported. |
| Reconstruct chronology, process, or discourse order | `ordering` | Extended with complete `acceptedOrders` for source-supported alternatives. |
| Complete sentences | `cloze` | Supported with text, word-bank, and select input. |
| Complete a form, table, notes, flowchart, or timeline | `structured-completion` | Supported while preserving the shared structure. |
| Label marked positions on a map, plan, or diagram | `labeling` | New general slide. Positions, accessible labels, accepted answers, and optional word bank are JSON-owned and server-verified. |
| Give a concise source-based answer | `short-answer` | Extended with separate `supportingEvidence`; it is never concatenated into the scored answer. |
| Produce a verified morphological form | `word-formation` | Supported; content still requires an authoritative word-family bank. |
| Diagnose and repair an error | `error-correction` | Supported for a configured, defensible correction. |
| Perform a constrained transformation | `rewrite` | Supported for local exact transformations; open rewriting remains submitted production. |
| Notice or rehearse sound and stress | `pronunciation` | Supported; repetition is not an automatic pronunciation score. |
| Convert aural language to written form | `dictation` | Supported; not a substitute for broad listening comprehension. |
| Record an independent oral response | `speaking-response` | Supported as participation evidence with an authenticated recording artifact. Semantic and acoustic evaluation remain separate. |
| Answer a spoken question and respond to a generated follow-up | `adaptive-conversation` | Registered with owned recording, transcript, feedback, private question audio and server-issued completion evidence. Disabled pending model-quality and capacity evidence. |
| Write a sentence, paragraph, report, essay, or letter | `writing-response` | Supported as preserved submitted production. Semantic feedback remains separate. |
| Choose an unscored route or preference | `selection` | Supported; application-owned dynamic expansion stays outside JSON. |
| Choose an unscored bounded quantity | `number-input` | Supported; this is setup evidence, not a numeric test answer. |

## Not slide types

The following requirements are application or assessment orchestration and must
not become visual slide aliases:

- full IELTS Listening and Reading forms, sealed-item retirement, and delayed
  group feedback;
- weakest-skill placement, conditional repair routing, readiness projections,
  and full four-skill mock orchestration;
- calibrated Writing or Speaking evaluation;
- content licensing, complete recordings, transcript alignment, maps, diagrams,
  charts, answer rationales, and calibration data.

`adaptive-conversation` now includes the owned session state machine, PCM/ASR
boundary, Qwen result validation, Kokoro playback, persistence, authenticated APIs,
server-verifiable completion evidence, registry entry and UI states. L0001 E09 is
its optional first consumer. See `docs/ADAPTIVE_CONVERSATION.md` for the implemented
contract and unmeasured release gates. Configuration does not enable the service.

## Authoring boundary

Runtime lesson content remains JSON-driven, with a separate complete Markdown
teaching companion for every lesson. `k2-lesson-exercise-design` provides the
provisional planning envelope; its historical catalog is not the runtime registry.
`k2-exercise-builder` owns exact runtime data and validates spatial labels,
multiple complete orders, separate short-answer evidence and adaptive-conversation
configuration. Neither skill may invent an IELTS-only type or provider/model
fields in lesson JSON. Vocabulary and spelling are placed only where the lesson
objective justifies them, following the user's explicit course override.
