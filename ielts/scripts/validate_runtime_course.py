#!/usr/bin/env python3
"""Check runtime IELTS contracts and companion hashes, not pedagogical quality.

Requires Python's standard library and Node, already used by the application.
The application parser owns course structure; the exercise-builder validator owns
slide contracts. Companion hashes detect runtime edits that require a fresh review
of the lesson explanation. They do not prove that the explanation teaches it well.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parents[2]
EXERCISE_VALIDATOR = ROOT / ".agents/skills/k2-exercise-builder/scripts/validate-exercise.py"
METADATA_FIELDS = (
    "Lesson ID", "Target level", "CEFR", "IELTS Band", "Primary skills",
    "Supporting skills", "Main language focus", "Prerequisites",
)
PLACEHOLDER = re.compile(
    r"\b(?:TODO|TBD|AUTHORING BRIEF|lorem ipsum|add more examples later|exercise goes here|sample question)\b",
    re.IGNORECASE,
)
HASH_MARKER = re.compile(r"<!--\s*runtime-lesson-sha256:\s*([0-9a-f]{64})\s*-->")
COURSE_PARSER = """
import { readFileSync } from 'node:fs';
try {
  const { parseFileManagedLearningPathSource, materializeLessonSourceScope } = await import(process.argv[1]);
  const { VOCABULARY_INTAKE_TYPE, resolveVocabularyIntakeScope } = await import(process.argv[2]);
  const course = parseFileManagedLearningPathSource(JSON.parse(readFileSync(0, 'utf8')));
  for (const lesson of course.lessons) {
    for (const exercise of lesson.exercises) {
      if (exercise.type !== VOCABULARY_INTAKE_TYPE) continue;
      // Only validate scope structure; actual collection-section resolution remains
      // the application importer's job and requires the collection source catalog.
      try {
        resolveVocabularyIntakeScope({ ...exercise, config: materializeLessonSourceScope(
          exercise.config, { kind: lesson.source.kind, ref: lesson.id }
        ) });
      } catch (error) {
        throw new Error(`${exercise.id}: ${error.message}`);
      }
    }
  }
  console.log(JSON.stringify({ status: 'valid' }));
} catch (error) {
  console.error(JSON.stringify({ status: 'invalid', error: error.message }));
  process.exitCode = 1;
}
"""


def reject_placeholders(value, location):
    if isinstance(value, dict):
        if value.get("_placeholder") is True or value.get("contract_status") == "placeholder":
            raise ValueError(f"Production placeholder at {location}; replace the authoring brief with runtime content.")
        for key, child in value.items():
            reject_placeholders(child, f"{location}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            reject_placeholders(child, f"{location}[{index}]")
    elif isinstance(value, str) and (match := PLACEHOLDER.search(value)):
        raise ValueError(f"Production placeholder at {location}: {match.group()!r}; finish this content.")


def run_validator(command, label, input_text=None):
    try:
        result = subprocess.run(
            command, input=input_text, capture_output=True, text=True, check=False, timeout=30,
        )
    except FileNotFoundError as error:
        raise ValueError(f"{label}: required executable or validator is missing: {error.filename}.") from error
    except subprocess.TimeoutExpired as error:
        raise ValueError(f"{label}: canonical validator exceeded 30 seconds.") from error
    if result.returncode:
        try:
            reason = json.loads(result.stderr or result.stdout)["error"]
        except (ValueError, KeyError, TypeError):
            reason = "canonical validator failed without a JSON diagnostic; check its executable and imports"
        raise ValueError(f"{label}: {reason}")


def validate_companion(lesson, lessons_dir):
    match = re.fullmatch(r"ielts-l([0-9]{4,})", lesson["id"])
    if not match or int(match.group(1)) == 0:
        raise ValueError(f"{lesson['id']}: managed IELTS lesson id must use ielts-l0001 style numbering.")
    lesson_id = f"L{match.group(1)}"
    companion = lessons_dir / f"{lesson_id}.md"
    try:
        content = companion.read_text(encoding="utf-8")
    except OSError as error:
        raise ValueError(f"{lesson['id']}: cannot read required lesson companion {companion}: {error.strerror}.") from error
    top = []
    for line in content.splitlines()[:40]:
        if re.match(r"^\s*#{2,6}\s", line):
            break
        top.append(re.sub(r"^\s*-\s+", "", line).replace("**", ""))
    for field in METADATA_FIELDS:
        values = re.findall(rf"^[ \t]*{re.escape(field)}:[ \t]*(\S[^\n]*)$", "\n".join(top), re.MULTILINE)
        if len(values) != 1:
            raise ValueError(f"{companion}: require one non-empty '{field}:' field in the top metadata block, before lesson sections.")
        if field == "Lesson ID" and values[0].strip() != lesson_id:
            raise ValueError(f"{companion}: Lesson ID must be {lesson_id}.")
    markers = HASH_MARKER.findall(content)
    if len(markers) != 1 or content.count("runtime-lesson-sha256:") != 1:
        raise ValueError(f"{companion}: require exactly one <!-- runtime-lesson-sha256: HASH --> comment with a lowercase SHA256 digest.")
    expected = hashlib.sha256(json.dumps(
        lesson, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
    ).encode("utf-8")).hexdigest()
    if markers[0] != expected:
        raise ValueError(
            f"{companion}: runtime-lesson-sha256 mismatch for {lesson['id']}; "
            f"review and synchronize the lesson explanation, then set the digest to {expected}."
        )
    reject_placeholders(content, str(companion))


def validate_course(course_path, lessons_dir):
    try:
        course = json.loads(course_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ValueError(f"Cannot read course {course_path}: {error}") from error
    run_validator(
        ["node", "--input-type=module", "--eval", COURSE_PARSER,
         (ROOT / "back/src/domain/collection-learning-path/FileManagedLearningPathSource.js").as_uri(),
         (ROOT / "back/src/domain/collection-learning-path/VocabularyIntake.js").as_uri()],
        str(course_path), json.dumps(course, ensure_ascii=False),
    )
    if course.get("managedIdPrefix") != "ielts-":
        raise ValueError(f"{course_path}: managedIdPrefix must be ielts- for this IELTS validator.")
    if not course["lessons"]:
        raise ValueError(f"{course_path}: the runtime IELTS course must contain at least one lesson.")
    reject_placeholders(course, "course")
    counts = {"lessons": len(course["lessons"]), "exercises": 0, "slides": 0}
    identifiers = {}

    def register_id(kind, identifier, owner):
        identifier = identifier.strip()
        if identifier in identifiers:
            raise ValueError(f"Duplicate {kind} id {identifier!r} in {owner}; first used by {identifiers[identifier]}.")
        identifiers[identifier] = owner

    for lesson in course["lessons"]:
        register_id("lesson", lesson["id"], "course")
        for exercise in lesson["exercises"]:
            register_id("exercise", exercise["id"], lesson["id"])
    with tempfile.TemporaryDirectory(prefix="vocora-ielts-validation-") as directory:
        exercise_path = Path(directory) / "exercise.json"
        for lesson in course["lessons"]:
            if not lesson["exercises"]:
                raise ValueError(f"{lesson['id']}: a runtime lesson must contain exercises.")
            for exercise in lesson["exercises"]:
                counts["exercises"] += 1
                if exercise["type"] == "vocabulary.intake":
                    continue
                if exercise["type"] != "slides.sequence":
                    raise ValueError(f"{exercise['id']}: unsupported exercise type {exercise['type']!r}; use vocabulary.intake or slides.sequence.")
                exercise_path.write_text(json.dumps(exercise, ensure_ascii=False), encoding="utf-8")
                run_validator(
                    [sys.executable, str(EXERCISE_VALIDATOR), "--input", str(exercise_path)],
                    exercise["id"],
                )
                for slide in exercise["config"]["slides"]:
                    register_id("slide", slide["id"], exercise["id"])
                    counts["slides"] += 1
            validate_companion(lesson, lessons_dir)
    return {"status": "valid", **counts, "lesson_hash_gate": "passed"}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--course", type=Path, default=ROOT / "back/data/learning-paths/ielts.json")
    parser.add_argument("--lessons-dir", type=Path, default=ROOT / "ielts/lessons")
    args = parser.parse_args(argv)
    try:
        report = validate_course(args.course, args.lessons_dir)
    except (OSError, UnicodeError, ValueError) as error:
        print(json.dumps({"status": "invalid", "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1
    print(json.dumps(report))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
