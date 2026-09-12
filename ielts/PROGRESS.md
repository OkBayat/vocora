# IELTS course production

Base: `codex/ielts-slide-system` at `436706ec851f76240602d243bc6acb471e8c219e`.
Working branch: `codex/ielts-production-course`. Keep one PR against that base.
Every reference to `learning-path` in the accepted production prompts means this
base branch. Do not move the work to `main` or create a second course PR.

## Current checkpoint

- Stage: S01, foundation. Current lesson: **L0001 Golden Lesson candidate**.
- Last fully production-ready lesson under the complete requested feedback and
  conversation contract: **none**. Do not report the whole course complete.
- L0001 authored checkpoint: 15 runtime exercises, including intake, and 110
  configured slides. The intake also generates its own vocabulary screens.
  Complete teaching source: [lessons/L0001.md](lessons/L0001.md).
- Next: resolve the Golden Lesson feedback/conversation gates below, validate
  the complete experience, then author L0002. Do not mass-generate later lessons
  while the reference implementation still has these gaps.
- The remaining 959 blueprint lessons are not runtime lessons and have no
  completed production teaching documents. No fixed lesson total is mandatory.

## Audit and source ownership

| Source | Actual role |
|---|---|
| `data/lesson_plans.jsonl`, indices, stage files and generated README | 960 provisional curriculum designs and authoring briefs; preserved research baseline |
| `examples/EX01.md` and other reference packs | Original authored teaching assets; not proof of complete runtime lessons |
| `back/data/learning-paths/ielts.json` | The file-managed JSON actually loaded by the application; currently contains L0001 |
| `back/data/collections/ielts.md` | L0001's eight-item vocabulary section; source for intake and Leitner |
| `lessons/L0001.md` | Complete human-readable educational companion for the current runtime lesson |
| `IMPLEMENTATION.md`, `WRITING_FEEDBACK.md`, `docs/ADAPTIVE_CONVERSATION.md` | Current implementation status, original direction and release gates; no claim of deployed feedback |

The expanded lesson preserves all original runtime lesson, exercise and slide
IDs and the eight-item vocabulary scope. Added listening at position 75 uses
the registered `dialogue` stimulus and `structured-completion` interaction.
Position 90/E09 now contains the registered adaptive conversation, preceded by
instruction on food, drink and place questions. It is optional while its service
is disabled; completing it still requires genuine server-issued practice evidence.
The original blueprint called E09 listening integration; the listening exercise
at position 75 supplies that separate comprehension objective.
Final mixed retrieval is at position 140. These counts are not templates for
later lessons.

## Golden Lesson changes

- Teach vocabulary categories, pronouns, statement order, phrases, text support
  and TRUE/FALSE/NOT GIVEN before testing them.
- Replace underdetermined meal gaps with meaning cues or genuine accepted
  alternatives. Comprehension permits capital-letter answers; the dedicated
  punctuation task requires exact capitals and its full stop.
- Use an original, hidden-script two-speaker listening form with grouped
  submission and a post-answer transcript. Kokoro is the primary existing
  speech path; browser synthesis remains the current runtime fallback.
- Add guided, independent and revised speaking/writing responses using distinct
  existing submission contracts. Checklists are explicitly self-review.
- Fix the sequence recording lifetime so recorder destruction cannot revoke
  the only copy before upload. Keep learner recordings out of course JSON.
- Add a validator that uses the actual course parser and exercise validator,
  checks globally unique identities and lesson Markdown, and rejects stale
  JSON/Markdown checksums. It does not assess teaching quality.

## Blocking release gates

1. **Qwen Writing:** the short-text backend, immutable draft/revision storage,
   strict provider, exact-tokenizer preflight and existing Writing slide integration
   are implemented behind a disabled feature flag. The canonical JSON contains
   educational task context for its two Writing responses. Synthetic tests verify
   contracts and failure behavior; the optional native image, real token parity
   and target-host output quality remain unverified. The 80-word pilot does not
   support full-length Academic Writing tasks or numeric IELTS estimates.
2. **Adaptive Speaking:** the reusable `adaptive-conversation` slide, owned
   session/API, persistence and PCM → Vosk → Qwen → Kokoro orchestration are
   implemented behind a disabled feature flag. E09 is the first consumer. Writing
   and conversation share one bounded text-inference queue and provider lease.
   Contract tests do not establish real recognition accuracy, relevant follow-up
   questions, correct feedback or acceptable target-host response times.
   Transcript-only feedback does not assess pronunciation or acoustic fluency.
3. **Quality evidence:** WF-01 requires actual target-CPU measurements and
   reviewed model outputs before a supported feedback pilot. The original
   17-case Writing harness and 12-case synthetic conversation text-turn harness
   are available in `ielts/evaluation/`; their default dry runs perform no
   inference. The conversation harness exercises 11 model-request paths and one
   server abstention; it does not measure ASR or TTS. The operator guide also
   specifies recorded-speech scenarios. No target-host benchmark or reviewed
   model output is available. Content validation cannot supply that evidence.

Do not add unused evaluator metadata, count submitted text as mastery, or claim
that disabled services have passed real-model evaluation. The accepted request permits the smallest
necessary generic extension; missing model measurements block enabling feedback,
not implementation and contract testing of disabled functionality. Release claims
still need working consumers and actual validation. The full Golden Lesson remains
in progress.

## Continuing authoring

Follow the existing curriculum and `k2-lesson-exercise-design` for source targets
and prerequisites, and `k2-exercise-builder` for every exact runtime exercise.
Use the current implementation playbook; do not create another architecture.

**User-authorized course override, 2026-09-12:** vocabulary intake is not required
to be the first exercise, and spelling/dictation is not required to be the second.
Include either activity only when the lesson's educational objective needs it,
and place it where its prerequisites and learning sequence justify it. This
explicit instruction supersedes the fixed-opening rule in the design skill and
generated blueprints for this course. It does not change vocabulary identity or
Leitner contracts. L0001 retains its current opening because learners need the
eight food/drink targets and their spoken/written forms before applying them;
later review, strategy and checkpoint lessons need no automatic intake/dictation.

The next content progression is L0002: use new food words in complete noun phrases,
including `a/an`, `a cup of tea` and `a glass of milk`. Teach the article and
container-phrase prerequisites before production. L0002–L0008 repeat the same
SVO specification in the blueprint; their role labels alone do not justify seven
repetitions of the same teaching sequence. Keep later lesson boundaries open to
the coverage audit, and teach `am/are` before expecting `hungry/thirsty` responses.

For each lesson: targeted research → instruction and practice → runtime JSON →
complete matching Markdown → content/answer review → validators and affected
tests → reviewed commit → push → next lesson. Keep the Markdown in the same
lesson commit. Use original examples. Record CEFR and IELTS labels separately.
Do not put podcast instructions or scripts in lesson teaching files.

Run from the repository root:

```bash
python3 ielts/scripts/validate_runtime_course.py
python3 -m unittest discover -s back/tests/tooling -p test_ielts_runtime_course.py
node --test back/tests/collection-learning-path-ielts-source.test.js
```

The Markdown integrity marker is SHA-256 of its lesson object encoded as UTF-8
with `json.dumps(lesson, ensure_ascii=False, sort_keys=True, separators=(',', ':'))`.
Refresh it only after reviewing the changed JSON and teaching file together.
Changing only the hash is not a content review. The legacy blueprint validator
still validates its historical package; it does not validate the runtime course.

Before resuming, read this checkpoint, the PR and recent commits. Continue on
the existing working branch. Preserve already published history and learner IDs.
