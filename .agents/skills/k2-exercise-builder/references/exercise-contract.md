# Runtime Exercise Contract

Load this reference after the exercise objective and evidence requirement are known. Repository source remains authoritative:

- `ui/src/app/domain/collection-learning-path/slide-sequence-exercise.ts` parses the sequence.
- `ui/src/app/shared/slide-exercise/slide-content-registry.ts` registers renderers and default chrome.
- `ui/src/app/shared/slide-exercise/library/slide-library.models.ts` defines reusable slide data.
- `back/src/domain/collection-learning-path/SlideSequenceExercise.js` validates definitions and completion evidence.

## Canonical envelope

The `adaptive-conversation` interaction uses the application-owned
`back/src/domain/adaptive-conversation/ConversationDefinition.js` contract and
the workflow documented in `docs/ADAPTIVE_CONVERSATION.md`. Its `data` contains
the communicative goal, opening question, level, turn/time bounds, question
constraints and optional vocabulary targets. Do not configure provider names,
system prompts, rubrics or answer keys. The validator invokes that runtime parser through
Node with a bounded timeout; it fails if the parser cannot run. The slide's
submitted evidence contains an owned `conversationEvidenceId`, verified by the
learning-path application. A numeric model signal or client turn count cannot
complete the interaction. Provider availability must be established before a
required lesson uses this interaction.

Use application-owned camelCase field names:

```json
{
  "id": "stable-exercise-id",
  "type": "slides.sequence",
  "schemaVersion": 1,
  "completionPolicy": "slide-sequence",
  "config": {
    "slides": [
      {
        "id": "stable-slide-id",
        "type": "selection",
        "data": {
          "mode": "single",
          "question": "Choose one option.",
          "options": [
            { "id": "first", "label": "First option" },
            { "id": "second", "label": "Second option", "description": "Optional supporting detail." }
          ]
        }
      },
      {
        "id": "finish",
        "type": "summary",
        "terminal": true,
        "data": {},
        "chrome": {
          "header": { "visible": false },
          "footer": {
            "primary": { "id": "finish", "label": "Finish", "behavior": "emit" },
            "secondary": false
          }
        }
      }
    ]
  }
}
```

The sequence needs at least two slides, unique slide IDs, and exactly one terminal slide in the final position. The skill validator additionally requires that final slide to be `summary` so authored exercises follow one predictable completion pattern.

## Shared slide data

All reusable slides may declare `instruction`, `stimulus`, and `explanation` where the component supports them. Stimulus types are `text`, `audio`, `dialogue`, `image`, `chart`, and `diagram`; use their exact fields from `slide-library.models.ts`. A `dialogue` stimulus accepts one or more spoken turns, so it also owns a single generated utterance that needs the shared speech playback path. Never invent an asset URL.

Options are objects with a stable `id`, visible `label`, and optional `description`. Answer fields use an `id`, one or more `answers`, and optional constraints such as `wordLimit`, `caseSensitive`, `punctuationSensitive`, or `exactSpelling`.

### Teaching-card Markdown

New `teaching-card` slides put instructional content in one non-empty
`markdown` string. The constrained renderer supports paragraphs, explicit line
breaks, `###` and `####` headings, `**bold**`, `*italic*`, numbered lists, and
bullet lists. Raw HTML, links, images, tables, and arbitrary Markdown extensions
are not part of this contract. The renderer escapes raw HTML before rendering.

Legacy `blocks` configurations remain supported so existing courses continue to
load. Configure exactly one of `markdown` or `blocks`; new or materially revised
teaching cards use `markdown`.

Every `teaching-card` is instructional content rather than a scored response,
so its slide object must hide header progress with:

```json
{
  "chrome": {
    "header": { "progress": null }
  }
}
```

## Chrome and evidence

Registry defaults normally own buttons:

- scored slides use a disabled `Check` action until answerable;
- `selection` uses a disabled `Continue` action until at least one option is selected;
- speaking and writing use a disabled `Submit` action until answerable;
- presentation slides normally use shell navigation.

Use `chrome` only for deliberate changes such as a finish-only terminal summary. Scored slides emit `answered`; unscored decision and open-production slides emit `submitted`. A submitted event proves completion, not correctness.

Every `teaching-card` must set `chrome.header.progress` to `null`, which hides
progress on that instructional card. When the card is also the first slide, the
sequence runtime excludes that leading setup slide from later progress labels
and totals. A non-leading card still counts toward the sequence total even
though its own progress is hidden. A non-teaching leading setup slide may use
the same override only when it also should not count toward exercise progress.

## Selection versus choice

Use `selection` when the learner chooses a preference, path, category, or configuration and no option is correct. Set `mode` to `single` or `multiple`. It emits `selectedOptionIds` and must not contain `correctOptionId`, `correctOptionIds`, or `answers`.

## Dynamic selection expansion

Use dynamic expansion when a selection chooses the shape of a sequence but the
number or content of its activity slides comes from an authoritative runtime
query. Add an application-registered `expansionId` to the selection data:

```json
{
  "id": "practice-mode",
  "type": "selection",
  "data": {
    "mode": "single",
    "question": "Select a practice mode",
    "expansionId": "house-one-practice",
    "options": [
      { "id": "vocabulary-dictation", "label": "Vocabulary Dictation" },
      { "id": "sentence-completion", "label": "Sentence Completion" }
    ]
  }
}
```

The exercise JSON stores only this stable identifier. Never put a function,
Angular service, dependency-injection token, or preloaded runtime object in the
slide data. The owning application parent supplies `selectionExpansion` in the
runtime `ExerciseContext`. The selection sends `{ expansionId, slideId,
selectedOptionIds }` to that handler; the handler queries its source and returns
`{ slides }`. The selection then inserts those slides immediately after itself
through the parent deck controller and advances only after insertion succeeds.

When a standalone expanded sequence must persist a session before reporting
completion, its application parent may also supply `sequenceCompletion` in the
runtime `ExerciseContext`. The sequence awaits that handler with the recorded
slide results before emitting its completed outcome, and keeps completion
retryable if persistence fails. This callback is runtime application behavior;
never serialize it into exercise or slide JSON.

When standalone learner progress must be durable before the sequence ends, the
application parent may additionally supply `slideResult`. The runtime invokes
that handler as soon as each first slide result is recorded, deduplicates
successful delivery by slide ID, and retries only failed or still-pending
delivery before completion. The application handler remains responsible for
domain-level idempotency such as treating retry slides for the same vocabulary
item as one first attempt. `sequenceCompletion` may then close the session
without resending successfully persisted item results.

Every returned slide must use a registered catalog type, have a unique stable
non-terminal ID, and be fully configured from authoritative source data. The
configured terminal `summary` remains last because the deck insertion contract
places generated slides before it. If the handler is absent, returns no slides,
cannot cover every required source item, or would need to invent content, keep
the selection open and report the failure. The handler and its source query are
application behavior and require focused application tests; the static exercise
validator only verifies the non-empty `expansionId` and JSON envelope.

For a persisted Learning Path exercise, use expansion only after the backend
completion owner can reconstruct and verify the generated slide set and its
answers. The current generic backend verifier does not infer arbitrary dynamic
slides from a frontend handler. A standalone parent may own completion locally,
as Practice Words does; otherwise stop instead of publishing unverifiable
completion evidence.

Use `choice` when options form an assessment question. Configure `correctOptionIds`; its result is graded by the backend.

## Numeric setup input

Use `number-input` for one unscored bounded numeric setting. Configure finite
`min`, `max`, `step`, and `initialValue` values, with the default inside the
inclusive range. It emits `{ value }`. When that value determines a
runtime-sized path, configure `expansionId`; the application parent supplies a
matching `numberInputExpansion` handler that returns registered non-terminal
slides before the component advances. Keep services and callbacks out of JSON.

## Spatial labeling

Use `labeling` only when a learner must connect an answer to a marked location
on a map, plan, or diagram. Configure `mode: map|plan|diagram`, a non-empty
`question`, an image or diagram `stimulus`, and one or more `targets`. Each
target has a stable `id`, an accessible `label`, a visible `markerLabel`,
`xPercent` and `yPercent` coordinates from 0 through 100, and the normal answer
field contract. Use `inputMode: word-bank` with at least two unique `wordBank`
options when the source supplies a label list; otherwise use text entry.

Do not substitute `structured-completion` when spatial location is itself the
evidence. Conversely, do not use `labeling` for a form, table, or flowchart whose
answer fields are structurally related but not positioned on an image.

## Multiple valid orders

`ordering.correctOrderIds` remains the primary answer and backward-compatible
default. When the source permits more than one complete order, provide
`acceptedOrders` as unique arrays, each containing every configured item exactly
once and including `correctOrderIds`. Do not add speculative permutations merely
to make an item easier.

## Short-answer supporting evidence

Use `evidencePrompt` when the learner should separately cite a source span or
explain the answer. Set `evidenceRequired: true` only when submission requires
that supporting response. The backend still scores `answer` against its own
accepted-answer key and preserves `supportingEvidence` as separate learner
evidence; it never concatenates the two fields or treats prose length as proof.

## Rewrite locality

Use `rewrite` only for a short, unambiguous correction whose exact model and
accepted answers differ from `original` by one or two word insertions,
deletions, substitutions, or word-order edits. Give a direct instruction that
identifies the intended grammar or vocabulary target. An inline alternative
such as `He go/goes to the gym every day.` may be used when additional support
is helpful; the accepted answer is `He goes to the gym every day.`

Good local corrections include `Tom play football every Saturday.` to `Tom
plays football every Saturday.`, or `She always is late.` to `She is always
late.` Do not ask learners to infer a substantially different sentence such as
changing `Tom's normal Saturday activity is football.` into `Tom plays football
every Saturday.` Use `writing-response` for open paraphrase or restructuring.

Every runtime-ready rewrite authored through this skill provides non-empty
`modelAnswer` and exact `acceptedAnswers`. Do not use `requiredFragments` as the
scoring contract because unrelated text could contain the same fragments.

## Validation boundary

`validate-exercise.py` checks deterministic structure and the minimum safe contract. It cannot establish factual correctness, distractor quality, teaching value, or source fidelity. Those remain agent-owned and must be reviewed against the supplied source while authoring.
