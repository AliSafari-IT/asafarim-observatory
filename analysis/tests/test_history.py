import contextlib
from datetime import datetime, timezone
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from analyze import main
from observatory_analysis.history import load_history, summarize


class HistoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = str(Path(self.temp.name) / "repos")
        self.history = Path(self.temp.name) / "history"
        self.workspace = self.history / hashlib.sha256(self.root.encode()).hexdigest()
        self.workspace.mkdir(parents=True)

    def repo(self, name="app", branch="main", count=0, error=""):
        return {"name": name, "path": str(Path(self.root) / name), "branch": branch, "detached": False, "changed_files": count, **({"error": error} if error else {})}

    def save(self, sequence, records, **changes):
        timestamp = f"2026-11-07T20:00:{sequence:02d}Z"
        data = {"schema_version": 1, "root": self.root, "scanned_at": timestamp, "repositories": records, **changes}
        path = self.workspace / f"snapshot-{sequence:02d}.json"
        path.write_text(json.dumps(data), encoding="utf-8")
        return path

    def test_metrics_and_unknown_states(self):
        self.save(0, [self.repo(count=2), self.repo("removed"), self.repo("broken", error="git failed")])
        self.save(1, [self.repo(branch="feature", count=5), self.repo("broken", error="git failed")])
        self.save(2, [self.repo(error="git failed"), self.repo("broken", error="git failed")])
        self.save(3, [self.repo(branch="other", count=0), self.repo("added", count=1), self.repo("broken", error="git failed")])
        report = summarize(load_history(self.history, self.root), self.root)
        repos = {repo["name"]: repo for repo in report["repositories"]}
        app = repos["app"]
        self.assertEqual(report["snapshot_count"], 4)
        self.assertEqual(len(report["sources"]), 4)
        self.assertEqual(app["observations"], 4)
        self.assertEqual(app["failed_observations"], 1)
        self.assertEqual(app["observed_branch_switches"], 1)
        self.assertEqual(app["observed_count_changes"], 1)
        self.assertEqual(app["peak_changed_files"], 5)
        self.assertEqual(app["latest_changed_files"], 0)
        self.assertEqual(app["status"], "clean")
        self.assertEqual(repos["removed"]["status"], "absent")
        self.assertIsNone(repos["removed"]["latest_changed_files"])
        self.assertEqual(repos["added"]["status"], "uncommitted changes")
        self.assertEqual(repos["broken"]["status"], "unavailable")
        self.assertEqual(repos["broken"]["failed_observations"], 4)
        self.assertIsNone(repos["broken"]["peak_changed_files"])
        self.assertIsNone(repos["broken"]["latest_changed_files"])

    def test_absence_interrupts_transitions(self):
        self.save(0, [self.repo(branch="main", count=2)])
        self.save(1, [])
        self.save(2, [self.repo(branch="feature", count=3)])
        app = summarize(load_history(self.history, self.root), self.root)["repositories"][0]
        self.assertEqual(app["observations"], 2)
        self.assertEqual(app["observed_branch_switches"], 0)
        self.assertEqual(app["observed_count_changes"], 0)

    def test_sort_by_timestamp_and_ignore_temporary_files(self):
        self.save(0, [], scanned_at="2026-11-07T20:00:02Z")
        self.save(1, [], scanned_at="2026-11-07T20:00:01Z")
        (self.workspace / ".snapshot-incomplete.tmp").write_text("{")
        scans = load_history(self.history, self.root)
        self.assertEqual(scans[0].scanned_at, datetime(2026, 11, 7, 20, 0, 1, tzinfo=timezone.utc))
        self.assertEqual(len(scans), 2)

    def test_invalid_history_fails_without_partial_summary(self):
        cases = [
            {"schema_version": 2}, {"schema_version": True}, {"root": "/wrong-root"},
            {"scanned_at": "invalid"}, {"scanned_at": "2026-11-07T20:00:00"},
            {"repositories": None}, {"repositories": [None]},
            {"repositories": [self.repo(), self.repo()]},
            {"repositories": [{**self.repo(), "changed_files": True}]},
            {"repositories": [{**self.repo(), "changed_files": -1}]},
            {"repositories": [{**self.repo(), "path": "/wrong"}]},
            {"repositories": [{**self.repo(), "branch": ""}]},
        ]
        for changes in cases:
            with self.subTest(changes=changes):
                self.save(0, [self.repo()], **changes)
                with self.assertRaises(ValueError):
                    load_history(self.history, self.root)
        path = self.save(0, [])
        path.write_text("{")
        with self.assertRaisesRegex(ValueError, "Invalid snapshot"):
            load_history(self.history, self.root)

    def test_cli_json_and_missing_history(self):
        args = ["--root", self.root, "--history", str(self.history), "--format", "json"]
        with contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(io.StringIO()) as err:
            self.assertEqual(main(args), 1)
        self.assertEqual(out.getvalue(), "")
        self.assertIn("-save", err.getvalue())
        self.save(0, [self.repo()])
        with contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(io.StringIO()) as err:
            self.assertEqual(main(args), 0)
        self.assertEqual(json.loads(out.getvalue())["snapshot_count"], 1)
        self.assertIn("baseline", err.getvalue())

    def test_cli_table_escapes_repository_names(self):
        self.save(0, [self.repo(name="app\nname")])
        with contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(main(["--root", self.root, "--history", str(self.history)]), 0)
        self.assertIn('"app\\nname"', out.getvalue())
        self.assertNotIn("app\nname", out.getvalue())

    def test_go_collector_compatibility(self):
        binary = Path(__file__).resolve().parents[2] / "bin/observatory"
        if not binary.exists():
            self.skipTest("build the Go CLI first or run scripts/check.sh")
        Path(self.root).mkdir()
        checkout = Path(self.root) / "app"
        subprocess.run(["git", "init", "-b", "main", str(checkout)], check=True, capture_output=True)
        (checkout / "untracked.txt").write_text("new file")
        subprocess.run([str(binary), "-root", self.root, "-history", str(self.history), "-save"], check=True, capture_output=True)
        scans = load_history(self.history, self.root)
        self.assertEqual(len(scans), 1)
        report = summarize(scans, self.root)
        self.assertEqual(report["repositories"][0]["latest_changed_files"], 1)
        self.assertEqual(report["repositories"][0]["status"], "uncommitted changes")


if __name__ == "__main__":
    unittest.main()
