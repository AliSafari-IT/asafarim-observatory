"""Run with python3 analysis/analyze.py --root /path/to/repos."""

import argparse
import json
import os
from pathlib import Path
import sys

from observatory_analysis import __version__
from observatory_analysis.history import load_history, summarize
from observatory_analysis.ai_summary import generate_summary


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="Summarize saved repository history. Run the Go collector with -save to refresh it."
    )
    parser.add_argument("--root", default=".", help="workspace root used by the Go collector")
    parser.add_argument("--history", type=Path, default=Path(".observatory/snapshots"), help="saved snapshot directory")
    parser.add_argument("--format", choices=("table", "json"), default="table")
    parser.add_argument("--ai-summary", action="store_true", help="request an OpenAI summary; requires OPENAI_API_KEY")
    parser.add_argument("--version", action="version", version=f"observatory-analysis {__version__}")
    args = parser.parse_args(argv)
    # Match Go filepath.Abs without resolving symlink aliases to another root.
    root = os.path.abspath(args.root)
    try:
        report = summarize(load_history(args.history, root), root)
        if args.ai_summary:
            print(json.dumps(generate_summary(report), indent=2))
            return 0
        if args.format == "json":
            print(json.dumps(report, indent=2))
        else:
            print(f"{report['snapshot_count']} snapshots: {report['period_start']} → {report['period_end']}")
            headers = (
                "REPOSITORY", "LATEST SAVED STATUS", "OBSERVED", "FAILED",
                "BRANCH SWITCHES", "COUNT CHANGES", "PEAK", "LATEST",
            )
            rows = [headers]
            for repo in report["repositories"]:
                rows.append((
                    json.dumps(repo["name"], ensure_ascii=True),
                    repo["status"],
                    str(repo["observations"]),
                    str(repo["failed_observations"]),
                    str(repo["observed_branch_switches"]),
                    str(repo["observed_count_changes"]),
                    display(repo["peak_changed_files"]),
                    display(repo["latest_changed_files"]),
                ))
            widths = [max(len(row[i]) for row in rows) for i in range(len(headers))]
            for row in rows:
                print("  ".join(value.ljust(width) for value, width in zip(row, widths)).rstrip())
        if report["snapshot_count"] == 1:
            print("One snapshot is a baseline; save more scans to observe transitions.", file=sys.stderr)
        return 0
    except (OSError, ValueError) as error:
        print(f"observatory-analysis: {error}", file=sys.stderr)
        return 1


def display(value) -> str:
    return "?" if value is None else str(value)


if __name__ == "__main__":
    sys.exit(main())
