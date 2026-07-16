# Same-session spelling remediation

## Scope

This capability runs only in practice-oriented sessions:

- free practice for box 1 (`box1`)
- the initial test for explicitly selected new words (`new`)

The scheduled “today review” flow (`scheduled`) and all Leitner promotion, demotion, due-date, blocking, persistence, daily-statistics, and history rules remain unchanged. Remediation attempts and same-session rechecks are transient and are deliberately not persisted as Leitner assessments.

Sentence generation, cloze questions, and future-day review scheduling are outside this feature.

## Learner flow

After an incorrect primary answer:

1. Show the learner answer and the closest accepted spelling side by side.
2. Highlight inserted, omitted, replaced, or transposed graphemes and show one concise orthographic hint.
3. Remove the correct spelling from the DOM and ask for the complete spelling from memory.
4. If recall fails, require one accurate focused copy while the answer is visible.
5. Remove the answer again and require complete recall.
6. Schedule a transient recheck after three intervening practice cards.
7. If the first recheck recall fails, correct it through the same copy/recall cycle and schedule one final recheck after one intervening card.
8. Flush pending rechecks before a finite new-word session can finish.

The default policy caps the cycle at two rechecks. Policy values are constructor dependencies rather than hard-coded controller branches.

## Architecture

### Domain (`ui/practice-remediation.js`)

The domain module has no DOM, storage, API, speech, or Leitner dependency.

- `RemediationAttempt` is the aggregate/state machine. It owns valid transitions between `correction`, `recall`, `copy`, and `completed`.
- `SameSessionRecheckPolicy` decides whether another recheck is needed and its gap.
- `SameSessionRecheckQueue` is a session-scoped scheduler based on intervening primary practice cards.
- spelling comparison functions select the nearest accepted variant, calculate edit operations, detect adjacent transpositions, and create concise hints.

Invalid transitions fail explicitly. Snapshots and outcomes are immutable value objects at the module boundary.

### Browser adapter (`ui/practice-remediation-adapter.js`)

The adapter follows ports-and-adapters boundaries:

- `VocoraPracticeSessionPort` reads the current practice mode/word, delegates primary correctness to the existing app, controls pronunciation, and advances the existing card flow.
- `SpellingRemediationView` renders and removes learner-visible state. During recall, answer nodes are emptied rather than merely hidden.
- `PracticeRemediationController` orchestrates the domain, transient queue, existing app events, and view. Its dependencies can be replaced in tests or future implementations.

The adapter observes existing UI events in the capture phase. It lets the current app record the original primary answer first, then starts remediation in a microtask. Custom correction and recheck forms never submit through the existing answer form, so they cannot mutate Leitner state accidentally.

## Extension points

Future exercise types can be added without changing the aggregate invariants:

- inject a different `SameSessionRecheckPolicy`
- replace the session port when the practice runtime is modularized
- replace the view while retaining the domain state machine
- subscribe to the following DOM events for analytics or experimentation:
  - `vocora:spelling-remediation-started`
  - `vocora:spelling-remediation-completed`
  - `vocora:same-session-recheck-scheduled`
  - `vocora:same-session-recheck-started`

Events contain identifiers and outcome metadata but do not persist state by themselves.

## Invariants

- Scheduled review behavior is untouched.
- Only the original primary answer is recorded by the existing application.
- Remediation attempts and rechecks do not increment attempts, correct, wrong, history, or daily totals.
- The target spelling is absent from the remediation DOM during recall.
- A failed recall cannot skip the focused-copy step.
- A successful copy is always followed by another hidden-answer recall.
- Session exit clears all transient remediation state.
- Pending rechecks are never carried into another session or day.

## Tests

`ui/tests/test-practice-remediation.mjs` covers the pure domain, variants, edit feedback, transition guards, policy limits, and queue timing.

`ui/tests/test-practice-remediation-adapter.mjs` covers browser integration, true answer removal, separation from app metrics, three-card recheck timing, finite-session flushing, custom events, metadata restoration, and the scheduled-review exclusion.
