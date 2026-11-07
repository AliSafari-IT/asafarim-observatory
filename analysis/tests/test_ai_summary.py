import io
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
import urllib.error

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from observatory_analysis.ai_summary import generate_summary, parse_response, SummaryError


def report():
    return {
        "snapshot_count": 2, "period_start": "2026-11-07T20:00:00Z", "period_end": "2026-11-07T21:00:00Z",
        "root": "/private/workspace", "sources": ["/private/workspace/history/snapshot-001.json"],
        "repositories": [{
            "name": "app", "status": "uncommitted changes", "observations": 2,
            "failed_observations": 0, "observed_branch_switches": 1,
            "observed_count_changes": 1, "peak_changed_files": 3,
            "latest_changed_files": 2, "latest_error": "private error contents",
            "source_code": "should never leave this machine",
        }],
    }


def response(content=None):
    if content is None:
        content = {"headline": "Two saved observations", "findings": [{"text": "app had one observed branch switch.", "evidence_ids": ["R001"]}]}
    return {"status": "completed", "output": [{"type": "message", "content": [{"type": "output_text", "text": json.dumps(content)}]}]}


class SummaryTests(unittest.TestCase):
    @patch.dict(os.environ, {"OPENAI_API_KEY": "test-key", "OBSERVATORY_OPENAI_MODEL": "gpt-5-mini"})
    def test_allowlisted_request_and_evidence(self):
        calls = []
        def opener(request, timeout):
            calls.append(request)
            self.assertEqual(request.full_url, "https://api.openai.com/v1/responses")
            self.assertEqual(timeout, 45)
            payload = json.loads(request.data)
            self.assertFalse(payload["store"])
            self.assertEqual(payload["text"]["format"]["type"], "json_schema")
            self.assertNotIn("/private/workspace", payload["input"])
            self.assertNotIn("private error contents", payload["input"])
            self.assertNotIn("should never leave", payload["input"])
            self.assertNotIn("test-key", request.data.decode())
            return io.BytesIO(json.dumps(response()).encode())
        result = generate_summary(report(), opener=opener)
        self.assertEqual(len(calls), 1)
        self.assertEqual(result["evidence"][0]["id"], "R001")
        self.assertEqual(result["sources"], ["snapshot-001.json"])
        self.assertEqual(result["model"], "gpt-5-mini")

    def test_missing_key_never_calls_provider(self):
        with patch.dict(os.environ, {"OPENAI_API_KEY": ""}):
            with self.assertRaisesRegex(SummaryError, "OPENAI_API_KEY"):
                generate_summary(report(), opener=lambda *args, **kwargs: self.fail("provider called"))

    def test_invalid_and_refused_results(self):
        cases = [
            {}, {"status": "incomplete", "output": []},
            {"status": "completed", "output": [{"type": "message", "content": [{"type": "refusal"}]}]},
            response({"headline": "Unknown evidence", "findings": [{"text": "A claim", "evidence_ids": ["invented"]}]}),
            response({"headline": "No evidence", "findings": [{"text": "A claim", "evidence_ids": []}]}),
            response({"headline": "", "findings": []}),
        ]
        for value in cases:
            with self.subTest(value=value), self.assertRaises(SummaryError):
                parse_response(value, {"R001"})

    @patch.dict(os.environ, {"OPENAI_API_KEY": "test-key"})
    def test_provider_error_is_safe_and_not_retried(self):
        calls = []
        def opener(*args, **kwargs):
            calls.append(1)
            raise urllib.error.HTTPError("https://api.openai.com/v1/responses", 401, "secret response", {}, io.BytesIO(b"sensitive provider body"))
        with self.assertRaises(SummaryError) as raised:
            generate_summary(report(), opener=opener)
        self.assertIn("401", str(raised.exception))
        self.assertNotIn("sensitive", str(raised.exception))
        self.assertEqual(len(calls), 1)


if __name__ == "__main__":
    unittest.main()
