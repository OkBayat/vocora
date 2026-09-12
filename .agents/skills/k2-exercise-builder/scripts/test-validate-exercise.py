#!/usr/bin/env python3
"""Focused tests for the runtime exercise validator."""
from __future__ import annotations

import importlib.util
from pathlib import Path
import unittest

SCRIPT = Path(__file__).with_name("validate-exercise.py")
SPEC = importlib.util.spec_from_file_location("validate_exercise", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


def valid_exercise() -> dict:
    return {
        "id": "choose-mode",
        "type": "slides.sequence",
        "schemaVersion": 1,
        "completionPolicy": "slide-sequence",
        "config": {
            "slides": [
                {
                    "id": "mode",
                    "type": "selection",
                    "data": {
                        "mode": "single",
                        "question": "Choose a practice mode.",
                        "expansionId": "house-one-practice",
                        "options": [
                            {"id": "dictation", "label": "Vocabulary Dictation"},
                            {"id": "shadowing", "label": "Sentence Shadowing"},
                        ],
                    },
                },
                {"id": "finish", "type": "summary", "terminal": True, "data": {}},
            ]
        },
    }


class ExerciseValidatorTests(unittest.TestCase):
    def conversation_exercise(self, **changes) -> dict:
        exercise = valid_exercise()
        exercise["config"]["slides"][0] = {
            "id": "conversation", "type": "adaptive-conversation",
            "data": {
                "mode": "guided-dialogue", "goal": "Exchange information about meals.",
                "openingPrompt": "What do you eat in the morning?", "minimumTurns": 2,
                "maximumTurns": 3, "responseSeconds": 30, "learnerLevel": "beginner",
                "targetVocabulary": ["bread", "drink water"],
                "questionConstraints": {"maximumWords": 14, "oneQuestionOnly": True, "avoidAnswerDisclosure": True},
                **changes,
            },
        }
        return exercise

    def test_accepts_registered_bounded_conversation(self) -> None:
        result = MODULE.validate_exercise(self.conversation_exercise())
        self.assertEqual(result["slide_types"], ["adaptive-conversation", "summary"])

    def test_conversation_reuses_authoritative_runtime_constraints(self) -> None:
        for changes in [
            {"model": "external-model"}, {"minimumTurns": 1}, {"maximumTurns": 5},
            {"minimumTurns": 4, "maximumTurns": 3}, {"responseSeconds": 31},
            {"targetVocabulary": ["bread", "BREAD"]}, {"targetVocabulary": None},
            {"openingPrompt": "What do you eat? What do you drink?"},
            {"goal": "<script>run()</script>"}, {"mode": "ielts-part1"},
        ]:
            with self.subTest(changes=changes), self.assertRaisesRegex(ValueError, "Conversation runtime contract"):
                MODULE.validate_exercise(self.conversation_exercise(**changes))

    def test_accepts_runtime_ready_selection_sequence(self) -> None:
        result = MODULE.validate_exercise(valid_exercise())
        self.assertEqual(result["status"], "valid")
        self.assertEqual(result["slide_types"], ["selection", "summary"])

    def test_rejects_unknown_slide_type(self) -> None:
        exercise = valid_exercise()
        exercise["config"]["slides"][0]["type"] = "custom-picker"
        with self.assertRaisesRegex(ValueError, "Unsupported slide type"):
            MODULE.validate_exercise(exercise)

    def test_rejects_non_terminal_final_slide(self) -> None:
        exercise = valid_exercise()
        exercise["config"]["slides"][1].pop("terminal")
        with self.assertRaisesRegex(ValueError, "terminal final slide"):
            MODULE.validate_exercise(exercise)

    def test_rejects_selection_correctness_fields(self) -> None:
        exercise = valid_exercise()
        exercise["config"]["slides"][0]["data"]["correctOptionIds"] = ["dictation"]
        with self.assertRaisesRegex(ValueError, "must not define correctness"):
            MODULE.validate_exercise(exercise)

    def test_rejects_an_empty_selection_expansion_id(self) -> None:
        exercise = valid_exercise()
        exercise["config"]["slides"][0]["data"]["expansionId"] = "   "
        with self.assertRaisesRegex(ValueError, "Selection expansionId"):
            MODULE.validate_exercise(exercise)

    def test_accepts_a_bounded_number_input_expansion(self) -> None:
        exercise = valid_exercise()
        exercise["config"]["slides"][0] = {
            "id": "word-count",
            "type": "number-input",
            "data": {
                "question": "How many new words would you like to add?",
                "label": "Number of words",
                "min": 1,
                "max": 20,
                "step": 1,
                "initialValue": 10,
                "expansionId": "new-word-practice",
            },
        }
        result = MODULE.validate_exercise(exercise)
        self.assertEqual(result["slide_types"], ["number-input", "summary"])

    def test_rejects_an_out_of_range_number_input_default(self) -> None:
        exercise = valid_exercise()
        exercise["config"]["slides"][0] = {
            "id": "word-count",
            "type": "number-input",
            "data": {
                "question": "Choose a count.",
                "min": 1,
                "max": 5,
                "step": 1,
                "initialValue": 10,
            },
        }
        with self.assertRaisesRegex(ValueError, "initialValue"):
            MODULE.validate_exercise(exercise)

    def test_rejects_choice_without_answer_key(self) -> None:
        exercise = valid_exercise()
        exercise["config"]["slides"][0] = {
            "id": "answer",
            "type": "choice",
            "data": {
                "question": "Choose the answer.",
                "options": [{"id": "a", "label": "A"}, {"id": "b", "label": "B"}],
            },
        }
        with self.assertRaisesRegex(ValueError, "correctOptionIds"):
            MODULE.validate_exercise(exercise)

    def test_allows_ordering_answer_key_to_reorder_configured_items(self) -> None:
        exercise = valid_exercise()
        exercise["config"]["slides"][0] = {
            "id": "order",
            "type": "ordering",
            "data": {
                "items": [{"id": "later", "label": "Later"}, {"id": "first", "label": "First"}],
                "correctOrderIds": ["first", "later"],
            },
        }
        self.assertEqual(MODULE.validate_exercise(exercise)["status"], "valid")

    def test_accepts_multiple_complete_ordering_keys(self) -> None:
        MODULE.validate_slide_data(
            "ordering",
            {
                "items": [
                    {"id": "intro", "label": "Introduction"},
                    {"id": "reason", "label": "Reason"},
                    {"id": "example", "label": "Example"},
                ],
                "correctOrderIds": ["intro", "reason", "example"],
                "acceptedOrders": [
                    ["intro", "reason", "example"],
                    ["intro", "example", "reason"],
                ],
            },
        )

    def test_requires_multiple_ordering_keys_to_include_the_primary_key(self) -> None:
        with self.assertRaisesRegex(ValueError, "must include correctOrderIds"):
            MODULE.validate_slide_data(
                "ordering",
                {
                    "items": [
                        {"id": "intro", "label": "Introduction"},
                        {"id": "reason", "label": "Reason"},
                        {"id": "example", "label": "Example"},
                    ],
                    "correctOrderIds": ["intro", "reason", "example"],
                    "acceptedOrders": [["intro", "example", "reason"]],
                },
            )

    def test_accepts_a_positioned_labeling_interaction(self) -> None:
        exercise = valid_exercise()
        exercise["config"]["slides"][0] = {
            "id": "campus-map",
            "type": "labeling",
            "data": {
                "mode": "map",
                "question": "Label the campus map.",
                "stimulus": {
                    "type": "diagram",
                    "imageSrc": "/assets/maps/campus.svg",
                    "alt": "A campus map with numbered locations.",
                },
                "inputMode": "word-bank",
                "wordBank": ["library", "cafe", "station"],
                "targets": [
                    {
                        "id": "one",
                        "label": "Location 1",
                        "markerLabel": "1",
                        "xPercent": 20,
                        "yPercent": 35,
                        "answers": ["library"],
                    },
                    {
                        "id": "two",
                        "label": "Location 2",
                        "markerLabel": "2",
                        "xPercent": 75,
                        "yPercent": 60,
                        "answers": ["cafe"],
                    },
                ],
            },
        }

        self.assertEqual(MODULE.validate_exercise(exercise)["status"], "valid")

    def test_rejects_an_out_of_bounds_labeling_target(self) -> None:
        with self.assertRaisesRegex(ValueError, "between 0 and 100"):
            MODULE.validate_slide_data(
                "labeling",
                {
                    "mode": "diagram",
                    "question": "Label the part.",
                    "stimulus": {"type": "diagram", "imageSrc": "/diagram.svg", "alt": "Diagram."},
                    "targets": [
                        {
                            "id": "part",
                            "label": "Part A",
                            "markerLabel": "A",
                            "xPercent": 101,
                            "yPercent": 20,
                            "answers": ["valve"],
                        }
                    ],
                },
            )

    def test_labeling_word_bank_membership_honors_answer_sensitivity(self) -> None:
        base = {
            "mode": "diagram",
            "question": "Label the part.",
            "stimulus": {"type": "diagram", "imageSrc": "/diagram.svg", "alt": "Diagram."},
            "inputMode": "word-bank",
            "wordBank": ["library", "cafe"],
        }
        cases = [
            ({"answers": ["Library"], "caseSensitive": True}, "case-sensitive"),
            ({"answers": ["library."], "punctuationSensitive": True}, "punctuation-sensitive"),
        ]
        for answer_contract, label in cases:
            with self.subTest(label=label), self.assertRaisesRegex(
                ValueError,
                "accepted answer in the word bank",
            ):
                MODULE.validate_slide_data(
                    "labeling",
                    {
                        **base,
                        "targets": [{
                            "id": "part",
                            "label": "Part A",
                            "markerLabel": "A",
                            "xPercent": 50,
                            "yPercent": 50,
                            **answer_contract,
                        }],
                    },
                )

    def test_labeling_word_bank_membership_honors_word_limit(self) -> None:
        with self.assertRaisesRegex(ValueError, "accepted answer in the word bank"):
            MODULE.validate_slide_data(
                "labeling",
                {
                    "mode": "map",
                    "question": "Label the destination.",
                    "stimulus": {"type": "image", "src": "/map.svg", "alt": "Map."},
                    "inputMode": "word-bank",
                    "wordBank": ["train station", "cafe"],
                    "targets": [{
                        "id": "destination",
                        "label": "Destination",
                        "markerLabel": "1",
                        "xPercent": 50,
                        "yPercent": 50,
                        "answers": ["train station"],
                        "wordLimit": 1,
                    }],
                },
            )

    def test_accepts_target_grammar_rewrite_mode(self) -> None:
        exercise = valid_exercise()
        exercise["config"]["slides"][0] = {
            "id": "habit-rewrite",
            "type": "rewrite",
            "data": {
                "mode": "target-grammar",
                "original": "Tom play football every Saturday.",
                "instruction": "Correct one word.",
                "modelAnswer": "Tom plays football every Saturday.",
                "acceptedAnswers": ["Tom plays football every Saturday."],
            },
        }

        self.assertEqual(MODULE.validate_exercise(exercise)["status"], "valid")

    def test_rejects_rewrite_answers_that_need_more_than_two_word_edits(self) -> None:
        with self.assertRaisesRegex(ValueError, "one or two word edits"):
            MODULE.validate_slide_data(
                "rewrite",
                {
                    "mode": "target-grammar",
                    "original": "Tom's normal Saturday activity is football.",
                    "modelAnswer": "Tom plays football every Saturday.",
                    "acceptedAnswers": ["Tom plays football every Saturday."],
                },
            )

    def test_rejects_fragment_scoring_for_rewrite_slides(self) -> None:
        with self.assertRaisesRegex(ValueError, "exact acceptedAnswers"):
            MODULE.validate_slide_data(
                "rewrite",
                {
                    "original": "Tom play football every Saturday.",
                    "modelAnswer": "Tom plays football every Saturday.",
                    "acceptedAnswers": ["Tom plays football every Saturday."],
                    "requiredFragments": ["plays"],
                },
            )

    def test_rejects_every_unsupported_runtime_enum_value(self) -> None:
        for slide_type, fields in MODULE.ENUM_FIELDS.items():
            for field in fields:
                data = {
                    required_field: sorted(allowed)[0]
                    for required_field, (allowed, required) in fields.items()
                    if required
                }
                data[field] = "not-a-runtime-value"
                with self.subTest(slide_type=slide_type, field=field):
                    with self.assertRaisesRegex(ValueError, "unsupported"):
                        MODULE.validate_enum_fields(slide_type, data)

    def test_rejects_an_unsupported_teaching_block_kind(self) -> None:
        with self.assertRaisesRegex(ValueError, "Teaching block kind is unsupported"):
            MODULE.validate_slide_data(
                "teaching-card",
                {
                    "mode": "rule",
                    "title": "Rule",
                    "blocks": [{"kind": "unknown", "content": "Read."}],
                },
            )

    def test_accepts_markdown_only_teaching_cards(self) -> None:
        MODULE.validate_slide_data(
            "teaching-card",
            {
                "mode": "rule",
                "title": "Present simple",
                "markdown": "### Form\n- Use **does** with he, she and it.",
            },
        )

    def test_accepts_teaching_card_with_progress_removed_from_header(self) -> None:
        exercise = valid_exercise()
        exercise["config"]["slides"][0] = {
            "id": "rule",
            "type": "teaching-card",
            "data": {
                "mode": "rule",
                "title": "Present simple",
                "markdown": "### Form\n- Use **does** with he, she and it.",
            },
            "chrome": {"header": {"progress": None}},
        }

        self.assertEqual(MODULE.validate_exercise(exercise)["status"], "valid")

    def test_rejects_teaching_card_without_explicitly_hidden_progress(self) -> None:
        for chrome in (None, {}, {"header": {}}, {"header": {"progress": True}}):
            exercise = valid_exercise()
            slide = {
                "id": "rule",
                "type": "teaching-card",
                "data": {
                    "mode": "rule",
                    "title": "Present simple",
                    "markdown": "### Form\nUse the base verb.",
                },
            }
            if chrome is not None:
                slide["chrome"] = chrome
            exercise["config"]["slides"][0] = slide
            with self.subTest(chrome=chrome):
                with self.assertRaisesRegex(ValueError, "chrome.header.progress must be null"):
                    MODULE.validate_exercise(exercise)

    def test_requires_exactly_one_teaching_card_content_format(self) -> None:
        for data in (
            {"mode": "rule", "title": "Missing content"},
            {
                "mode": "rule",
                "title": "Duplicate content",
                "markdown": "### Rule\nUse the base verb.",
                "blocks": [{"kind": "note", "content": "Use the base verb."}],
            },
        ):
            with self.subTest(title=data["title"]):
                with self.assertRaisesRegex(ValueError, "exactly one"):
                    MODULE.validate_slide_data("teaching-card", data)

    def test_rejects_empty_teaching_card_content(self) -> None:
        for field, value, error in (
            ("markdown", "   ", "Teaching card markdown"),
            ("blocks", [], "Teaching card blocks"),
        ):
            with self.subTest(field=field):
                with self.assertRaisesRegex(ValueError, error):
                    MODULE.validate_slide_data(
                        "teaching-card",
                        {"mode": "rule", "title": "Empty content", field: value},
                    )


if __name__ == "__main__":
    unittest.main()
