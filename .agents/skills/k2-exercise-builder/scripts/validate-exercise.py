#!/usr/bin/env python3
"""Validate a runtime-ready Vocora slides.sequence exercise object."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import subprocess
import sys
from typing import Any

SCHEMA_VERSION = 1
SLIDE_TYPES = {
    "message", "summary", "teaching-card", "selection", "number-input", "choice", "truth",
    "matching", "classification", "ordering", "labeling", "cloze", "structured-completion",
    "short-answer", "word-formation", "error-correction", "rewrite",
    "pronunciation", "dictation", "speaking-response", "writing-response", "adaptive-conversation",
}
ENUM_FIELDS = {
    "teaching-card": {
        "mode": ({"word", "usage", "contrast", "rule", "warning", "tip"}, True),
    },
    "selection": {"mode": ({"single", "multiple"}, True)},
    "choice": {
        "mode": ({
            "single", "multiple", "meaning", "part-of-speech", "synonym",
            "antonym", "correct-spelling", "best-word", "odd-one-out",
        }, False),
    },
    "truth": {
        "mode": ({
            "true-false", "true-false-not-given", "yes-no-not-given",
            "agree-disagree",
        }, True),
    },
    "matching": {
        "mode": ({
            "definition", "synonym", "antonym", "collocation", "word-family",
            "person-opinion", "sentence-ending", "heading-section", "term-example",
        }, False),
        "feedbackMode": ({"immediate", "on-complete"}, False),
    },
    "classification": {
        "mode": ({
            "positive-negative", "formal-informal", "countable-uncountable",
            "part-of-speech", "possible-impossible", "linking-word-function",
            "letter-language-function", "sound", "custom",
        }, False),
    },
    "ordering": {
        "mode": ({"sequence", "chronology", "severity", "adjective-order", "process"}, False),
    },
    "labeling": {
        "mode": ({"map", "plan", "diagram"}, True),
        "inputMode": ({"text", "word-bank"}, False),
    },
    "cloze": {"inputMode": ({"text", "word-bank", "select"}, False)},
    "structured-completion": {
        "layout": ({"form", "table", "notes", "flowchart", "timeline"}, True),
    },
    "word-formation": {
        "mode": ({
            "family", "target-part-of-speech", "prefix", "suffix", "negative-form",
            "base-word", "transitive-intransitive",
        }, False),
    },
    "error-correction": {
        "mode": ({
            "select-and-replace", "inline-edit", "sentence-correction",
            "paragraph-correction",
        }, False),
    },
    "rewrite": {
        "mode": ({
            "paraphrase", "target-grammar", "target-vocabulary",
            "sentence-transformation", "noun-to-verb", "verb-to-noun", "formalize",
            "linking-word", "synonym-replacement",
        }, False),
    },
    "pronunciation": {
        "mode": ({
            "phoneme-match", "sound-choice", "word-stress", "listen-and-identify",
            "ipa-match", "repeat",
        }, True),
    },
    "dictation": {"mode": ({"word", "phrase", "sentence"}, False)},
    "speaking-response": {
        "mode": ({"part1", "cue-card", "part3", "vocabulary-production"}, True),
    },
    "writing-response": {
        "mode": ({
            "sentence", "paragraph", "task1-chart", "task1-process", "task2-essay",
            "general-letter",
        }, True),
        "register": ({"formal", "informal", "neutral"}, False),
    },
}
TEACHING_BLOCK_KINDS = {"word", "comparison", "correction", "patterns", "example", "note"}


def validate_conversation(data: dict) -> None:
    """Use the application-owned definition parser rather than duplicate its policy."""
    module = Path(__file__).resolve().parents[4] / "back/src/domain/adaptive-conversation/ConversationDefinition.js"
    script = (
        f"import {{ parseConversationDefinition }} from {json.dumps(module.as_uri())};"
        "let input=''; for await (const chunk of process.stdin) input+=chunk;"
        "try { parseConversationDefinition(JSON.parse(input)); }"
        "catch { process.stderr.write('Invalid adaptive conversation definition.'); process.exitCode=1; }"
    )
    try:
        result = subprocess.run(
            ["node", "--input-type=module", "-e", script], input=json.dumps(data),
            text=True, capture_output=True, timeout=5, check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise ValueError("Conversation runtime contract could not be validated.") from error
    if result.returncode != 0:
        raise ValueError("Conversation runtime contract rejected this definition.")


def word_tokens(value: str) -> list[str]:
    return re.findall(r"[a-z0-9]+(?:'[a-z0-9]+)?", value.casefold())


def word_edit_distance(left: str, right: str) -> int:
    source = word_tokens(left)
    target = word_tokens(right)
    row = list(range(len(target) + 1))
    for source_index, source_word in enumerate(source, start=1):
        next_row = [source_index]
        for target_index, target_word in enumerate(target, start=1):
            next_row.append(min(
                next_row[target_index - 1] + 1,
                row[target_index] + 1,
                row[target_index - 1] + (source_word != target_word),
            ))
        row = next_row
    return row[-1]


def record(value: Any, label: str) -> dict:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object.")
    return value


def text(source: dict, key: str, label: str) -> str:
    value = source.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} is required.")
    return value.strip()


def validate_enum_fields(slide_type: str, data: dict) -> None:
    for field, (allowed, required) in ENUM_FIELDS.get(slide_type, {}).items():
        if field not in data and not required:
            continue
        value = text(data, field, f"{slide_type} {field}")
        if value not in allowed:
            raise ValueError(f"{slide_type} {field} is unsupported: {value}.")


def array(source: dict, key: str, label: str, minimum: int = 1) -> list:
    value = source.get(key)
    if not isinstance(value, list) or len(value) < minimum:
        raise ValueError(f"{label} must contain at least {minimum} item(s).")
    return value


def string_array(source: dict, key: str, label: str, minimum: int = 1) -> list[str]:
    values = array(source, key, label, minimum)
    if any(not isinstance(value, str) or not value.strip() for value in values):
        raise ValueError(f"{label} must contain non-empty strings.")
    normalized = [value.strip() for value in values]
    if len(set(normalized)) != len(normalized):
        raise ValueError(f"{label} must not contain duplicates.")
    return normalized


def normalize_answer(value: str, field: dict) -> str:
    normalized = " ".join(value.strip().split())
    exact_spelling = field.get("exactSpelling") is True
    if not exact_spelling and field.get("punctuationSensitive") is not True:
        normalized = re.sub(r"[.,!?;:]+$", "", normalized).strip()
    if not exact_spelling and field.get("caseSensitive") is not True:
        normalized = normalized.lower()
    return normalized


def answer_matches(value: str, field: dict, answers: list[str]) -> bool:
    word_limit = field.get("wordLimit")
    if word_limit is not None and len(value.strip().split()) > word_limit:
        return False
    actual = normalize_answer(value, field)
    return any(normalize_answer(answer, field) == actual for answer in answers)


def validate_options(data: dict, minimum: int = 2) -> list[str]:
    options = array(data, "options", "options", minimum)
    ids = []
    for candidate in options:
        option = record(candidate, "option")
        ids.append(text(option, "id", "Option id"))
        text(option, "label", "Option label")
        if "description" in option and (not isinstance(option["description"], str) or not option["description"].strip()):
            raise ValueError("Option description must be a non-empty string when present.")
    if len(set(ids)) != len(ids):
        raise ValueError("Option ids must be unique.")
    return ids


def validate_answer_fields(data: dict, key: str) -> None:
    for candidate in array(data, key, key):
        field = record(candidate, "answer field")
        text(field, "id", "Answer field id")
        string_array(field, "answers", "Answer field answers")


def finite_number(data: dict, key: str) -> float:
    value = data.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"Number input {key} must be a finite number.")
    number = float(value)
    if number == float("inf") or number == float("-inf") or number != number:
        raise ValueError(f"Number input {key} must be a finite number.")
    return number


def validate_slide_data(slide_type: str, data: dict) -> None:
    validate_enum_fields(slide_type, data)
    if slide_type in {"message", "summary"}:
        return
    if slide_type == "teaching-card":
        text(data, "title", "Teaching card title")
        has_markdown = "markdown" in data
        has_blocks = "blocks" in data
        if has_markdown == has_blocks:
            raise ValueError("Teaching card requires exactly one markdown or blocks content format.")
        if has_markdown:
            text(data, "markdown", "Teaching card markdown")
            return
        for candidate in array(data, "blocks", "Teaching card blocks"):
            block = record(candidate, "teaching block")
            kind = text(block, "kind", "Teaching block kind")
            if kind not in TEACHING_BLOCK_KINDS:
                raise ValueError(f"Teaching block kind is unsupported: {kind}.")
            text(block, "content", "Teaching block content")
        return
    if slide_type == "selection":
        mode = text(data, "mode", "Selection mode")
        if mode not in {"single", "multiple"}:
            raise ValueError("Selection mode must be single or multiple.")
        text(data, "question", "Selection question")
        validate_options(data)
        if "expansionId" in data:
            text(data, "expansionId", "Selection expansionId")
        if any(key in data for key in ("correctOptionId", "correctOptionIds", "answers")):
            raise ValueError("Selection slides must not define correctness fields.")
        return
    if slide_type == "number-input":
        text(data, "question", "Number input question")
        minimum = finite_number(data, "min")
        maximum = finite_number(data, "max")
        step = finite_number(data, "step")
        initial = finite_number(data, "initialValue")
        if maximum < minimum:
            raise ValueError("Number input max must be greater than or equal to min.")
        if step <= 0:
            raise ValueError("Number input step must be greater than zero.")
        if initial < minimum or initial > maximum:
            raise ValueError("Number input initialValue must be within min and max.")
        if "expansionId" in data:
            text(data, "expansionId", "Number input expansionId")
        return
    if slide_type == "choice":
        text(data, "question", "Choice question")
        option_ids = validate_options(data)
        correct_ids = string_array(data, "correctOptionIds", "Choice correctOptionIds")
        if any(value not in option_ids for value in correct_ids):
            raise ValueError("Choice correctOptionIds must reference configured options.")
        return
    if slide_type == "truth":
        text(data, "statement", "Truth statement")
        text(data, "correctOptionId", "Truth correctOptionId")
        return
    if slide_type == "matching":
        for candidate in array(data, "pairs", "Matching pairs"):
            pair = record(candidate, "matching pair")
            text(pair, "id", "Matching pair id")
            text(pair, "left", "Matching pair left value")
            text(pair, "right", "Matching pair right value")
        return
    if slide_type == "classification":
        validate_options({"options": array(data, "categories", "Classification categories", 2)})
        for candidate in array(data, "items", "Classification items"):
            item = record(candidate, "classification item")
            text(item, "id", "Classification item id")
            text(item, "label", "Classification item label")
            text(item, "correctCategoryId", "Classification correctCategoryId")
        return
    if slide_type == "ordering":
        option_ids = validate_options({"options": array(data, "items", "Ordering items", 2)})
        correct_ids = string_array(data, "correctOrderIds", "Ordering correctOrderIds", 2)
        if set(correct_ids) != set(option_ids):
            raise ValueError("Ordering correctOrderIds must list every configured item exactly once.")
        accepted_orders = data.get("acceptedOrders", [correct_ids])
        if not isinstance(accepted_orders, list) or not accepted_orders:
            raise ValueError("Ordering acceptedOrders must contain at least one order.")
        normalized_orders = []
        for index, candidate in enumerate(accepted_orders):
            if not isinstance(candidate, list):
                raise ValueError(f"Ordering acceptedOrders[{index}] must be an array.")
            accepted = [value.strip() for value in candidate if isinstance(value, str) and value.strip()]
            if len(accepted) != len(candidate) or len(accepted) != len(option_ids) or set(accepted) != set(option_ids):
                raise ValueError("Every accepted ordering must list every configured item exactly once.")
            normalized_orders.append(tuple(accepted))
        if len(set(normalized_orders)) != len(normalized_orders):
            raise ValueError("Ordering acceptedOrders must not contain duplicates.")
        if tuple(correct_ids) not in normalized_orders:
            raise ValueError("Ordering acceptedOrders must include correctOrderIds.")
        return
    if slide_type == "labeling":
        text(data, "question", "Labeling question")
        stimulus = record(data.get("stimulus"), "Labeling stimulus")
        stimulus_type = text(stimulus, "type", "Labeling stimulus type")
        if stimulus_type == "diagram":
            text(stimulus, "imageSrc", "Labeling diagram source")
        elif stimulus_type == "image":
            text(stimulus, "src", "Labeling image source")
        else:
            raise ValueError("Labeling requires an image or diagram stimulus.")
        text(stimulus, "alt", "Labeling stimulus alternative text")
        target_ids = []
        target_answers = []
        targets = array(data, "targets", "Labeling targets")
        for candidate in targets:
            target = record(candidate, "labeling target")
            target_ids.append(text(target, "id", "Labeling target id"))
            text(target, "label", "Labeling target label")
            text(target, "markerLabel", "Labeling target marker label")
            target_answers.append((target, string_array(target, "answers", "Labeling target answers")))
            if "wordLimit" in target and (
                isinstance(target["wordLimit"], bool)
                or not isinstance(target["wordLimit"], int)
                or target["wordLimit"] < 1
            ):
                raise ValueError("Labeling target wordLimit must be a positive integer.")
            for key in ("xPercent", "yPercent"):
                value = target.get(key)
                if isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0 or value > 100:
                    raise ValueError("Labeling target coordinates must be between 0 and 100.")
        if len(set(target_ids)) != len(target_ids):
            raise ValueError("Labeling target ids must be unique.")
        if data.get("inputMode", "text") == "word-bank":
            word_bank = string_array(data, "wordBank", "Labeling wordBank", 2)
            if any(
                not any(answer_matches(option, target, answers) for option in word_bank)
                for target, answers in target_answers
            ):
                raise ValueError("Every labeling target needs an accepted answer in the word bank.")
        return
    if slide_type == "cloze":
        text(data, "content", "Cloze content")
        validate_answer_fields(data, "blanks")
        return
    if slide_type == "structured-completion":
        if text(data, "layout", "Structured completion layout") not in {"form", "table", "notes", "flowchart", "timeline"}:
            raise ValueError("Structured completion layout is unsupported.")
        validate_answer_fields(data, "fields")
        return
    if slide_type == "short-answer":
        text(data, "question", "Short answer question")
        string_array(data, "answers", "Short answer answers")
        if "evidenceRequired" in data and not isinstance(data["evidenceRequired"], bool):
            raise ValueError("Short answer evidenceRequired must be a boolean.")
        if data.get("evidenceRequired") is True:
            text(data, "evidencePrompt", "Short answer evidencePrompt")
        return
    if slide_type == "word-formation":
        text(data, "baseWord", "Word formation baseWord")
        validate_answer_fields(data, "fields")
        return
    if slide_type == "error-correction":
        text(data, "original", "Error correction original")
        string_array(data, "answers", "Error correction answers")
        return
    if slide_type == "rewrite":
        original = text(data, "original", "Rewrite original")
        model_answer = text(data, "modelAnswer", "Rewrite modelAnswer")
        accepted_answers = string_array(data, "acceptedAnswers", "Rewrite acceptedAnswers")
        if "requiredFragments" in data:
            raise ValueError("Rewrite slides use exact acceptedAnswers, not requiredFragments.")
        for answer in {model_answer, *accepted_answers}:
            distance = word_edit_distance(original, answer)
            if distance < 1 or distance > 2:
                raise ValueError("Rewrite answers must require exactly one or two word edits.")
        return
    if slide_type == "pronunciation":
        text(data, "mode", "Pronunciation mode")
        text(data, "question", "Pronunciation question")
        return
    if slide_type == "dictation":
        text(data, "answer", "Dictation answer")
        has_audio = isinstance(data.get("audio"), str) and bool(data["audio"].strip())
        has_speech = isinstance(data.get("speech"), dict) and isinstance(data["speech"].get("text"), str) and bool(data["speech"]["text"].strip())
        if has_audio == has_speech:
            raise ValueError("Dictation requires exactly one audio or speech source.")
        return
    if slide_type == "speaking-response":
        text(data, "mode", "Speaking response mode")
        text(data, "prompt", "Speaking response prompt")
        return
    if slide_type == "writing-response":
        text(data, "mode", "Writing response mode")
        text(data, "prompt", "Writing response prompt")
        return
    if slide_type == "adaptive-conversation":
        validate_conversation(data)


def validate_slide_chrome(slide_type: str, slide: dict) -> None:
    if slide_type != "teaching-card":
        return
    chrome = slide.get("chrome")
    header = chrome.get("header") if isinstance(chrome, dict) else None
    if (
        not isinstance(header, dict)
        or "progress" not in header
        or header["progress"] is not None
    ):
        raise ValueError("Teaching card chrome.header.progress must be null.")


def validate_exercise(value: Any) -> dict:
    exercise = record(value, "Exercise")
    text(exercise, "id", "Exercise id")
    if exercise.get("type") != "slides.sequence":
        raise ValueError("Exercise type must be slides.sequence.")
    if exercise.get("schemaVersion") != 1:
        raise ValueError("Exercise schemaVersion must be 1.")
    if exercise.get("completionPolicy") != "slide-sequence":
        raise ValueError("Exercise completionPolicy must be slide-sequence.")
    config = record(exercise.get("config"), "Exercise config")
    slides = array(config, "slides", "slides.sequence slides", 2)
    ids = []
    types = []
    for candidate in slides:
        slide = record(candidate, "Slide")
        slide_id = text(slide, "id", "Slide id")
        slide_type = text(slide, "type", "Slide type")
        if slide_type not in SLIDE_TYPES:
            raise ValueError(f"Unsupported slide type: {slide_type}")
        data = record(slide.get("data", {}), f"{slide_type} data")
        validate_slide_data(slide_type, data)
        validate_slide_chrome(slide_type, slide)
        ids.append(slide_id)
        types.append(slide_type)
    if len(set(ids)) != len(ids):
        raise ValueError("Slide ids must be unique.")
    terminal = [index for index, slide in enumerate(slides) if slide.get("terminal") is True]
    if terminal != [len(slides) - 1]:
        raise ValueError("slides.sequence requires exactly one terminal final slide.")
    if types[-1] != "summary":
        raise ValueError("The terminal final slide must use summary.")
    return {"schema_version": SCHEMA_VERSION, "status": "valid", "exercise_id": exercise["id"], "slide_types": types}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        result = validate_exercise(json.loads(args.input.read_text(encoding="utf-8")))
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as error:
        print(json.dumps({"schema_version": SCHEMA_VERSION, "status": "invalid", "error": str(error)}, indent=2), file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
