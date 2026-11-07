"""Turn timestamped snapshots into evidence-backed repository summaries."""

from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path


@dataclass(frozen=True)
class Snapshot:
    source: Path
    scanned_at: datetime
    timestamp: str
    repositories: dict[str, dict]


def load_history(directory: Path, root: str) -> list[Snapshot]:
    """Load the same per-root history directory used by the Go collector.

    A corrupt observation stops analysis; silently omitting it would distort
    failure counts and apparent transitions between observations.
    """
    workspace = directory / hashlib.sha256(root.encode()).hexdigest()
    if not workspace.exists():
        raise ValueError("No saved snapshots for this root. Run Observatory with -save first.")
    snapshots = []
    for source in sorted(workspace.glob("snapshot-*.json")):
        if source.is_dir():
            continue
        try:
            data = json.loads(source.read_text(encoding="utf-8"))
            if (
                not isinstance(data, dict)
                or type(data.get("schema_version")) is not int
                or data["schema_version"] != 1
            ):
                raise ValueError("unsupported snapshot schema")
            if data.get("root") != root or not isinstance(data.get("repositories"), list):
                raise ValueError("invalid snapshot root or repositories")
            timestamp = data.get("scanned_at")
            if not isinstance(timestamp, str):
                raise ValueError("missing scan timestamp")
            scanned_at = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
            if scanned_at.tzinfo is None:
                raise ValueError("scan timestamp must include a timezone")
            repositories = {}
            for repo in data["repositories"]:
                _validate_repository(repo, root)
                if repo["name"] in repositories:
                    raise ValueError("duplicate repository name")
                repositories[repo["name"]] = repo
            snapshots.append(Snapshot(source, scanned_at, timestamp, repositories))
        except (ValueError, UnicodeError) as error:
            raise ValueError(f"Invalid snapshot {source.name}: {error}") from error
    if not snapshots:
        raise ValueError("No saved snapshots for this root. Run Observatory with -save first.")
    # Go filenames retain nanoseconds, which datetime truncates to microseconds.
    snapshots.sort(key=lambda scan: (scan.scanned_at, scan.source.name))
    return snapshots


def _validate_repository(repo: dict, root: str) -> None:
    if not isinstance(repo, dict):
        raise ValueError("repository must be an object")
    name = repo.get("name")
    if not isinstance(name, str) or not name or name in (".", "..") or Path(name).name != name:
        raise ValueError("invalid repository name")
    if repo.get("path") != str(Path(root) / name):
        raise ValueError("repository path does not match workspace root")
    if type(repo.get("changed_files")) is not int or repo["changed_files"] < 0:
        raise ValueError("changed_files must be a nonnegative integer")
    if type(repo.get("detached")) is not bool or not isinstance(repo.get("branch"), str):
        raise ValueError("missing branch or detached state")
    if not isinstance(repo.get("error", ""), str):
        raise ValueError("repository error must be text")
    if not repo.get("error") and not repo["branch"]:
        raise ValueError("successful observation must include a branch")


def summarize(snapshots: list[Snapshot], root: str) -> dict:
    """Count observations, not commits, productivity, or time spent working.

    Transitions count only adjacent successful observations. A failure or an
    absent checkout interrupts the sequence, since its state is unknown.
    """
    if not snapshots:
        raise ValueError("At least one snapshot is required.")
    names = sorted({name for scan in snapshots for name in scan.repositories})
    summaries = []
    for name in names:
        observed = [scan.repositories[name] for scan in snapshots if name in scan.repositories]
        successful = [repo for repo in observed if not repo.get("error")]
        switches = transitions = 0
        previous = None
        for scan in snapshots:
            current = scan.repositories.get(name)
            if current is None or current.get("error"):
                previous = None
                continue
            if previous is not None:
                switches += (current["branch"], current["detached"]) != (previous["branch"], previous["detached"])
                transitions += current["changed_files"] != previous["changed_files"]
            previous = current
        latest = snapshots[-1].repositories.get(name)
        if latest is None:
            status = "absent"
        elif latest.get("error"):
            status = "unavailable"
        else:
            status = "uncommitted changes" if latest["changed_files"] else "clean"
        latest_count = None
        if latest is not None and not latest.get("error"):
            latest_count = latest["changed_files"]
        summaries.append({
            "name": name,
            "status": status,
            "observations": len(observed),
            "failed_observations": len(observed) - len(successful),
            "observed_branch_switches": switches,
            "observed_count_changes": transitions,
            "peak_changed_files": max((repo["changed_files"] for repo in successful), default=None),
            "latest_changed_files": latest_count,
            "latest_error": latest.get("error") if latest is not None else None,
        })
    return {
        "schema_version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "root": root,
        "snapshot_count": len(snapshots),
        "period_start": snapshots[0].timestamp,
        "period_end": snapshots[-1].timestamp,
        "sources": [str(scan.source) for scan in snapshots],
        "repositories": summaries,
    }
