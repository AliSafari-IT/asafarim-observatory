#!/usr/bin/env python3
"""Prune validated snapshot candidates only. Default mode makes no changes."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import sys

VERSION = '0.1.0'
NAMESPACE = re.compile(r'^[0-9a-f]{64}$')


def deletion_plan(histories, keep=6):
    if keep < 1:
        raise ValueError('Keep at least one snapshot')
    planned = []
    retained = 0
    for history in histories:
        base = Path(history)
        if base.is_symlink() or not base.is_dir():
            raise ValueError('History must be an existing real directory')
        for directory in sorted(base.iterdir()):
            if not NAMESPACE.fullmatch(directory.name):
                continue
            if directory.is_symlink() or not directory.is_dir():
                raise ValueError('Invalid namespace directory')
            snapshots = []
            for path in directory.glob('snapshot-*.json'):
                if path.is_symlink() or not path.is_file():
                    raise ValueError('Invalid snapshot candidate')
                if path.stat().st_size > 8 * 1024 * 1024:
                    raise ValueError('Snapshot exceeds size limit')
                value = json.loads(path.read_text())
                stamp = datetime.fromisoformat(value['scanned_at'].replace('Z', '+00:00'))
                if stamp.tzinfo is None or stamp.utcoffset().total_seconds() != 0:
                    raise ValueError('Snapshot timestamp must be UTC')
                if value.get('schema_version') != 1 or not isinstance(value.get('repositories'), list):
                    raise ValueError('Invalid snapshot envelope')
                snapshots.append((stamp.astimezone(timezone.utc), path.name, path))
            snapshots.sort(reverse=True)
            retained += min(keep, len(snapshots))
            planned.extend(item[2] for item in snapshots[keep:])
    return planned, retained


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--version', action='version', version=VERSION)
    parser.add_argument('--history', action='append', required=True)
    parser.add_argument('--keep', type=int, default=6)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    try:
        planned, retained = deletion_plan(args.history, args.keep)
        if args.apply:
            for path in planned:
                path.unlink()
        print(json.dumps({'version': VERSION, 'applied': args.apply,
                          'removed' if args.apply else 'would_remove': len(planned),
                          'retained': retained}))
    except (ValueError, KeyError, TypeError, AttributeError, OSError):
        print('Snapshot retention failed; check history validity and permissions.', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
