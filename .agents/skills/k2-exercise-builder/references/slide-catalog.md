# Registered Slide Catalog

Select a slide from the learner action and evidence required. The 19 reusable families below are registered by the application. `message` and `summary` are flow-shell types, not reusable interaction families.

| Type | Learner action and evidence | Essential data | Important boundary |
| --- | --- | --- | --- |
| `teaching-card` | Read a word, contrast, rule, warning, or tip | `mode`, `title`, constrained `markdown`, and `chrome.header.progress: null`; legacy `blocks[]` remains readable | Markdown supports paragraphs, line breaks, `###`/`####` headings, bold, italic, numbered lists, and bullet lists. Configure exactly one content format. Presentation only; hide its progress indicator and do not treat it as mastery evidence. |
| `selection` | Choose one or several unscored preferences, paths, or settings | `mode: single|multiple`, `question`, at least two `options`; optional registered `expansionId` | No correct answer or scoring fields. Emits selected IDs. A dynamic expansion must be handled outside JSON by the owning application parent. |
| `number-input` | Enter one bounded numeric setting for an unscored runtime decision | `question`, `min`, `max`, `step`, `initialValue`; optional `label` and registered `expansionId` | Emits the validated numeric value. A dynamic expansion must be handled outside JSON by the owning application parent. |
| `choice` | Recognize one or several correct alternatives | `question`, `options`, `correctOptionIds`; optional recognition `mode` and `speech` | Options cue the answer; use recall slides when cues are inappropriate. |
| `truth` | Judge a statement | `mode`, `statement`, `correctOptionId`; optional `options` | Use not-given modes only when the source supports absence as evidence. |
| `matching` | Map related items | `pairs` with `id`, `left`, `right`; optional mode and feedback policy | Allow many-to-one only when the relation permits it. |
| `classification` | Assign items to explicit categories | at least two `categories`; `items` with `correctCategoryId` | Categories must be meaningful and item answers must reference them. |
| `ordering` | Reconstruct one or more explicitly defensible orders | `items`, `correctOrderIds`; optional complete `acceptedOrders` | Every accepted order must contain every item exactly once and include the primary key. Configure alternatives only when the source supports them. |
| `labeling` | Place written or word-bank labels at marked points on a shared map, plan, or diagram | `mode`, `question`, image/diagram `stimulus`, positioned `targets`; optional `inputMode` and `wordBank` | Use only when spatial position is evidence. Every marker needs an accessible field label, coordinates from 0 to 100, and server-owned accepted answers. |
| `cloze` | Fill gaps in meaningful context | `content`, `blanks`; optional `inputMode` and `wordBank` | Free text gives less support than word-bank or select modes. |
| `structured-completion` | Complete a form, table, notes, flowchart, or timeline | `layout`, `fields`; optional `columns` and `rows` | Preserve structure when layout carries meaning. |
| `short-answer` | Retrieve one brief answer without options | `question`, `answers`; optional hints, exact spelling, and `evidencePrompt` | `evidenceRequired` makes a separate supporting span/explanation mandatory; it does not merge that text into the scored answer. Hints reduce retrieval difficulty. |
| `word-formation` | Produce a derived form from a base | `baseWord`, `fields` with `partOfSpeech`; optional mode | Use matching when production is not required. |
| `error-correction` | Detect and replace faulty language | `original`, `answers`; optional mode and category | Accepted answers must not reject other valid corrections accidentally. |
| `rewrite` | Correct one or two local word-level errors in a supplied utterance | `original`, exact `acceptedAnswers`, and `modelAnswer`; optional target words | Keep the correction unambiguous and within one or two word edits. Use `writing-response` for open paraphrase or substantial restructuring. |
| `pronunciation` | Discriminate or repeat a spoken form | `mode`, `question`; optional word, options, and correct option | Repeat is practice, not automatic pronunciation-quality judgment. |
| `dictation` | Convert heard language into written form | `answer` and exactly one `audio` or `speech`; optional mode and constraints | Tests sound-to-form production, not broad comprehension. |
| `speaking-response` | Record an oral response | `mode`, `prompt`; optional bullets, timing, vocabulary, notes | Submission proves a recording exists; semantic evaluation is separate. |
| `writing-response` | Compose an extended written response | `mode`, `prompt`; optional timer, word target, vocabulary, model, register | Submission and word count do not prove semantic mastery. |
| `adaptive-conversation` | Answer an oral question and respond to an adaptive follow-up | `guided-dialogue`, goal, opening question, level, bounded turns/recording time and question constraints; optional vocabulary targets | Server-owned sessions preserve ASR and accepted turns. Completion requires an owned receipt, not client counts or a model score. Availability and provider failures remain distinct from learner performance. |

## Flow-shell types

- `message`: show non-interactive sequence content when a teaching card is not needed. It carries no mastery evidence.
- `summary`: end the exercise and emit its outcome. The final slide must be the only `terminal: true` slide. Configure chrome to show only Finish when no summary content is desired.

## Common compositions

- Unscored setup: `selection` -> activity slides -> `summary`; the activity slides may be inserted at runtime through a registered `expansionId` when their complete source set is known only after selection.
- Vocabulary form practice: `pronunciation` -> `dictation` -> `summary`.
- Meaning into recall: `teaching-card` -> `choice` or `matching` -> `cloze` or `short-answer` -> `summary`.
- Usage repair: `teaching-card` -> `error-correction` -> `rewrite` -> `summary`.
- Productive transfer: supported recall slides -> `speaking-response` or `writing-response` -> `summary`.
- Spatial comprehension: shared image/diagram `stimulus` -> `labeling` -> `summary`.

Compositions are examples, not mandatory templates. Every slide must be justified by the active objective and source.

## Unsupported capability rule

Do not create a new slide, component, or type from this workflow. If none of the entries above expresses the required interaction and evidence semantics, stop and report:

1. the required learner action;
2. the required evidence;
3. the closest existing types considered;
4. why each is semantically insufficient;
5. the missing reusable capability that would need separate product authorization.
