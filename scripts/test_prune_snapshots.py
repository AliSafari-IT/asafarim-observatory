import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('prune', Path(__file__).with_name('prune-snapshots.py'))
prune = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prune)


class RetentionTests(unittest.TestCase):
    def snapshot(self, base, name, day, namespace='a' * 64):
        path = base / namespace / ('snapshot-' + name + '.json')
        path.parent.mkdir(exist_ok=True)
        path.write_text(json.dumps({'schema_version': 1, 'scanned_at': f'2026-11-{day:02}T00:00:00Z', 'repositories': []}))
        return path

    def test_timestamp_order_and_namespace_isolation(self):
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            for day in range(1, 10):
                self.snapshot(base, str(20-day), day)
            self.snapshot(base, 'only', 1, 'b' * 64)
            summary = base / '.summaries'
            summary.mkdir()
            (summary / 'summary.json').write_text('{}')
            (base / ('a' * 64) / 'unrelated.json').write_text('{}')
            plan, retained = prune.deletion_plan([base])
            self.assertEqual(retained, 7)
            self.assertEqual(len(plan), 3)
            self.assertEqual({json.loads(p.read_text())['scanned_at'][8:10] for p in plan}, {'01', '02', '03'})
            self.assertTrue((summary / 'summary.json').exists())
            self.assertEqual(len(list((base / ('a' * 64)).glob('snapshot-*.json'))), 9)

    def test_invalid_candidate_aborts_before_deletion(self):
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            for day in range(1, 9):
                self.snapshot(base, str(day), day)
            self.snapshot(base, 'invalid', 9).write_text('{}')
            with self.assertRaises(KeyError):
                prune.deletion_plan([base])
            self.assertEqual(len(list((base / ('a' * 64)).glob('*.json'))), 9)

    def test_symlinks_refused_and_keep_positive(self):
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            path = self.snapshot(base, 'one', 1)
            (path.parent / 'snapshot-link.json').symlink_to(path)
            with self.assertRaises(ValueError):
                prune.deletion_plan([base])
            with self.assertRaises(ValueError):
                prune.deletion_plan([base], 0)

    def test_multiple_histories_have_independent_retention(self):
        with tempfile.TemporaryDirectory() as folder:
            histories = [Path(folder) / 'laptop', Path(folder) / 'vps']
            for base in histories:
                base.mkdir()
                for day in range(1, 9):
                    self.snapshot(base, str(day), day)
            plan, retained = prune.deletion_plan(histories)
            self.assertEqual(len(plan), 4)
            self.assertEqual(retained, 12)
            for path in plan:
                path.unlink()
            self.assertEqual(prune.deletion_plan(histories), ([], 12))


if __name__ == '__main__':
    unittest.main()
