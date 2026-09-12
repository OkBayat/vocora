"""Contract checks for runtime IELTS content and its lesson companion files."""
import copy
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[3]
VALIDATOR = ROOT / "ielts/scripts/validate_runtime_course.py"


def lesson_fixture(number):
    lesson_id = f"ielts-l{number:04d}"
    return {
        "id": lesson_id,
        "title": f"L{number:04d} — Food and meals",
        "position": number,
        "source": {
            "kind": "collection-section", "collectionId": "ielts",
            "sectionTitle": f"L{number:04d} — Food and meals",
        },
        "exercises": [
            {
                "id": f"{lesson_id}-intake", "position": 10,
                "type": "vocabulary.intake", "schemaVersion": 1,
                "required": True, "completionPolicy": "vocabulary-intake",
                "config": {"scope": {"kind": "lesson-source"}, "presentation": "slides"},
            },
            {
                "id": f"{lesson_id}-practice", "position": 20,
                "type": "slides.sequence", "schemaVersion": 1,
                "required": True, "completionPolicy": "slide-sequence",
                "config": {"slides": [
                    {"id": f"{lesson_id}-question", "type": "short-answer", "data": {
                        "question": "Which food is made of small grains?", "answers": ["rice"],
                    }},
                    {"id": f"{lesson_id}-summary", "type": "summary",
                     "terminal": True, "data": {"title": "Practice complete"}},
                ]},
            },
        ],
    }


class RuntimeCourseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.course_path = self.root / "course.json"
        self.lessons_dir = self.root / "lessons"
        self.lessons_dir.mkdir()
        self.course = {
            "schemaVersion": 1, "managedIdPrefix": "ielts-",
            "path": {"id": "ielts-learning-path", "collectionId": "ielts",
                     "title": "Vocora IELTS Academic", "mode": "finite", "status": "published"},
            "lessons": [lesson_fixture(1), lesson_fixture(2)],
        }
        self.write_course()
        self.write_companions()

    def write_course(self):
        self.course_path.write_text(json.dumps(self.course, ensure_ascii=False), encoding="utf-8")

    def write_companions(self):
        for lesson in self.course["lessons"]:
            lesson_id = lesson["id"].removeprefix("ielts-").upper()
            digest = hashlib.sha256(json.dumps(
                lesson, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
            ).encode("utf-8")).hexdigest()
            (self.lessons_dir / f"{lesson_id}.md").write_text(
                f"# Food and meals\n\n**Lesson ID:** {lesson_id}\n"
                "**Target level:** Foundation\n**CEFR:** A1/A2 instructional level\n"
                "**IELTS Band:** Approximately 3 at entry; no score prediction\n"
                "**Primary skills:** Listening, speaking\n"
                "**Supporting skills:** Reading, writing\n"
                "**Main language focus:** Food nouns and simple statements\n"
                "**Prerequisites:** Familiarity with the English alphabet\n\n"
                f"<!-- runtime-lesson-sha256: {digest} -->\n\n"
                "## Learning content\nRice is a food. We eat rice.\n",
                encoding="utf-8",
            )

    def run_validator(self):
        result = subprocess.run(
            [sys.executable, str(VALIDATOR), "--course", str(self.course_path),
             "--lessons-dir", str(self.lessons_dir)],
            cwd=self.root, capture_output=True, text=True, check=False,
        )
        self.assertNotIn("Traceback", result.stdout + result.stderr)
        output = result.stdout if result.returncode == 0 else result.stderr
        self.assertTrue(output.strip().startswith("{"), output)
        return result.returncode, json.loads(output)

    def assert_invalid(self, expected):
        self.write_course()
        code, report = self.run_validator()
        self.assertEqual(code, 1)
        self.assertEqual(report["status"], "invalid")
        self.assertIn(expected.lower(), report["error"].lower())

    def test_valid_runtime_course_accepts_native_intake_and_reports_counts(self):
        code, report = self.run_validator()
        self.assertEqual(code, 0, report)
        self.assertEqual(report["status"], "valid")
        self.assertEqual((report["lessons"], report["exercises"], report["slides"]), (2, 4, 4))
        self.assertEqual(report["lesson_hash_gate"], "passed")

    def test_missing_lesson_companion_is_rejected(self):
        (self.lessons_dir / "L0002.md").unlink()
        self.assert_invalid("L0002.md")

    def test_lesson_edit_requires_updated_companion_hash(self):
        self.course["lessons"][0]["exercises"][1]["config"]["slides"][0]["data"]["answers"] = ["bread"]
        self.assert_invalid("runtime-lesson-sha256 mismatch")

    def test_course_formatting_does_not_change_lesson_hash(self):
        self.course_path.write_text(json.dumps(self.course, indent=4, sort_keys=True), encoding="utf-8")
        code, report = self.run_validator()
        self.assertEqual(code, 0, report)

    def test_missing_hash_is_rejected(self):
        path = self.lessons_dir / "L0001.md"
        path.write_text("\n".join(line for line in path.read_text().splitlines()
                                  if "runtime-lesson-sha256" not in line), encoding="utf-8")
        self.assert_invalid("runtime-lesson-sha256")

    def test_metadata_must_be_in_top_block(self):
        path = self.lessons_dir / "L0001.md"
        content = path.read_text().replace("**CEFR:** A1/A2 instructional level\n", "")
        path.write_text(content + "\nCEFR: A1/A2\n", encoding="utf-8")
        self.assert_invalid("CEFR")

    def test_empty_metadata_cannot_consume_the_next_field(self):
        path = self.lessons_dir / "L0001.md"
        path.write_text(path.read_text().replace("**CEFR:** A1/A2 instructional level", "**CEFR:**"), encoding="utf-8")
        self.assert_invalid("CEFR")

    def test_companion_cannot_claim_another_lesson_identity(self):
        path = self.lessons_dir / "L0001.md"
        path.write_text(path.read_text().replace("**Lesson ID:** L0001", "**Lesson ID:** L0002"), encoding="utf-8")
        self.assert_invalid("Lesson ID must be L0001")

    def test_duplicate_lesson_and_exercise_ids_are_rejected(self):
        original = copy.deepcopy(self.course)
        for kind in ("lesson", "exercise"):
            with self.subTest(kind=kind):
                self.course = copy.deepcopy(original)
                if kind == "lesson":
                    self.course["lessons"][1]["id"] = self.course["lessons"][0]["id"]
                else:
                    self.course["lessons"][1]["exercises"][0]["id"] = self.course["lessons"][0]["exercises"][0]["id"]
                self.assert_invalid(f"duplicate {kind} id")

    def test_duplicate_slide_ids_across_lessons_are_rejected(self):
        first, second = self.course["lessons"]
        second["exercises"][1]["config"]["slides"][0]["id"] = first["exercises"][1]["config"]["slides"][0]["id"]
        self.write_companions()
        self.assert_invalid("duplicate slide id")

    def test_slide_id_cannot_reuse_an_exercise_identity(self):
        exercise = self.course["lessons"][0]["exercises"][1]
        exercise["config"]["slides"][0]["id"] = exercise["id"]
        self.write_companions()
        self.assert_invalid("duplicate slide id")

    def test_invalid_slide_uses_canonical_validator_error(self):
        del self.course["lessons"][0]["exercises"][1]["config"]["slides"][0]["data"]["answers"]
        self.write_companions()
        self.assert_invalid("Short answer answers")

    def test_unsupported_exercise_cannot_bypass_slide_validation(self):
        self.course["lessons"][0]["exercises"][0]["type"] = "vocabulary-intake"
        self.write_companions()
        self.assert_invalid("unsupported exercise type")

    def test_intake_requires_its_completion_policy(self):
        self.course["lessons"][0]["exercises"][0]["completionPolicy"] = "slide-sequence"
        self.write_companions()
        self.assert_invalid("vocabulary-intake")

    def test_production_placeholders_are_rejected_with_content_location(self):
        self.course["lessons"][0]["exercises"][1]["config"]["slides"][0]["data"]["question"] = "TODO: write the question"
        self.write_companions()
        self.assert_invalid("placeholder at course.lessons[0].exercises[1].config.slides[0].data.question")

    def test_authoring_brief_text_is_rejected_without_a_placeholder_flag(self):
        self.course["lessons"][1]["exercises"][1]["config"]["slides"][0]["data"]["question"] = (
            "AUTHORING BRIEF L0002-R: Write a reading text about daily meals."
        )
        self.write_companions()
        self.assert_invalid("placeholder at course.lessons[1].exercises[1].config.slides[0].data.question")

    def test_malformed_json_has_actionable_error_without_traceback(self):
        self.course_path.write_text("{ broken", encoding="utf-8")
        code, report = self.run_validator()
        self.assertEqual(code, 1)
        self.assertIn("course.json", report["error"])
        self.assertIn("line 1", report["error"])


if __name__ == "__main__":
    unittest.main()
