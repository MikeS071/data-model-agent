import json
import os
import select
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from admission import AdmissionError, AdmissionPool
from runtime_observation import OwnedRuntime


class AdmissionTests(unittest.TestCase):
    def setUp(self):
        scratch = Path(__file__).resolve().parents[1] / '.proof'
        scratch.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix='admission-', dir=scratch)
        self.root = Path(self.temp.name)
        directory = self.root / 'delegations'; directory.mkdir()
        self.pool = AdmissionPool(directory)
        self.children = []

    def tearDown(self):
        for child in self.children:
            if child.poll() is None: child.kill()
            child.communicate(timeout=2)
        self.temp.cleanup()

    def reserve(self, name, limit=2, roots=None, worktree=None):
        return self.pool.reserve(name, worktree or self.root / name, roots or [name], limit)

    def runtime(self, reservation):
        reader, writer = os.pipe()
        child = subprocess.Popen(['python3', '-c', 'import sys; sys.stdin.read()'],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 start_new_session=True, pass_fds=(writer,))
        os.close(writer)
        self.children.append(child)
        runtime = OwnedRuntime(child, reservation.run / 'runtime-observation.json', reader)
        self.assertTrue(runtime.save())
        reservation.bind(runtime)
        return runtime

    def test_capacity_expansion_pause_reduction_and_overlap(self):
        first = self.reserve('first', roots=['src/one'])
        second = self.reserve('second')
        with self.assertRaisesRegex(AdmissionError, 'CAPACITY_EXHAUSTED'): self.reserve('third')
        third = self.reserve('third', 3)
        with self.assertRaisesRegex(AdmissionError, 'SOURCE_CONFLICT'): self.reserve('overlap', 4, ['src/one/new.py'])
        with self.assertRaisesRegex(AdmissionError, 'SOURCE_CONFLICT'): self.reserve('same', 4, worktree=self.root/'first')
        with self.assertRaisesRegex(AdmissionError, 'CAPACITY_EXHAUSTED'): first.starting(0)
        first.starting(1)
        with self.assertRaisesRegex(AdmissionError, 'CAPACITY_EXHAUSTED'): second.starting(1)
        with self.assertRaisesRegex(AdmissionError, 'SOURCE_CONFLICT'): self.reserve('nested', 4, worktree=self.root/'first/subtree')
        self.assertEqual(len(self.pool.snapshot()), 3)
        self.assertTrue(third.cancel_queued())
        before = (third.run/'admission.json').read_bytes()
        self.assertFalse(third.cancel_queued())
        self.assertEqual(before, (third.run/'admission.json').read_bytes())
        with self.assertRaisesRegex(AdmissionError, 'INVALID_TRANSITION'): first.cancel_queued()
        with self.assertRaisesRegex(AdmissionError, 'ATTEMPT_REUSED'): self.reserve('third', 4)
        for value in [None, True, -1, 1.5, '2']:
            with self.assertRaisesRegex(AdmissionError, 'LIMIT_UNKNOWN'): self.reserve('invalid', value)
        with self.assertRaisesRegex(AdmissionError, 'UNSAFE_DIRECTORY'): self.reserve('unsafe', 4, worktree=self.root)
        for roots in [['../escape'], ['src/*'], [{}]]:
            with self.assertRaisesRegex(AdmissionError, 'INVALID_REQUEST'): self.reserve('invalid', 4, roots)

    def test_release_needs_owned_terminal_sandbox_and_is_exactly_once(self):
        first = self.reserve('first', 1)
        first.starting(1)
        with self.assertRaisesRegex(AdmissionError, 'TERMINATION_UNCONFIRMED'): first.release()
        runtime = self.runtime(first)
        with self.assertRaisesRegex(AdmissionError, 'TERMINATION_UNCONFIRMED'): first.release()
        other = self.reserve('other', 2)
        other.starting(2)
        with self.assertRaisesRegex(AdmissionError, 'RUNTIME_MISMATCH'): other.bind(runtime)
        self.assertTrue(runtime.finish('CANCELLED'))
        self.assertTrue(first.release())
        before = (first.run/'admission.json').read_bytes()
        self.assertFalse(first.release())
        self.assertEqual(before, (first.run/'admission.json').read_bytes())
        replacement = self.reserve('replacement', 2, ['first'], self.root/'first')
        self.assertTrue(replacement.cancel_queued())

    def test_lost_owner_does_not_reclaim_and_missing_or_malformed_state_blocks(self):
        first = self.reserve('first', 1)
        first.starting(1)
        restarted = AdmissionPool(self.pool.directory)
        self.assertTrue(restarted.snapshot()[0]['runtime_unverified'])
        with self.assertRaisesRegex(AdmissionError, 'CAPACITY_EXHAUSTED'):
            restarted.reserve('next', self.root/'next', ['next'], 1)
        path = first.run/'admission.json'; original = path.read_bytes()
        for contents in ['{', json.dumps({'phase': 'RELEASED'})]:
            path.write_text(contents)
            with self.assertRaisesRegex(AdmissionError, 'STATE_UNKNOWN'): restarted.snapshot()
        path.unlink()
        with self.assertRaisesRegex(AdmissionError, 'STATE_UNKNOWN'): self.reserve('next', 2)
        path.write_bytes(original)
        path.unlink(); path.symlink_to(first.run/'absent')
        with self.assertRaisesRegex(AdmissionError, 'STATE_UNKNOWN'): restarted.snapshot()

    def test_persistence_failure_keeps_reservation_and_unknown_cannot_release(self):
        first = self.reserve('first', 1); first.starting(1)
        runtime = self.runtime(first)
        with patch('runtime_observation.os.replace', side_effect=OSError('fixture')):
            self.assertFalse(runtime.finish('CANCELLED'))
        with self.assertRaisesRegex(AdmissionError, 'TERMINATION_UNCONFIRMED'): first.release()
        with self.assertRaisesRegex(AdmissionError, 'CAPACITY_EXHAUSTED'): self.reserve('next', 1)
        second = self.reserve('second', 2)
        with patch('admission.os.replace', side_effect=OSError('fixture')):
            with self.assertRaisesRegex(AdmissionError, 'STATE_UNKNOWN'): second.starting(2)
        self.assertEqual(json.loads((second.run/'admission.json').read_text())['phase'], 'QUEUED')
        self.assertTrue(second.cancel_queued())

    def test_competing_processes_cannot_both_reserve_the_last_slot(self):
        code = '''import sys
from pathlib import Path
from admission import AdmissionPool, AdmissionError
print('ready', flush=True)
sys.stdin.readline()
try:
    AdmissionPool(sys.argv[1]).reserve(sys.argv[2], Path(sys.argv[1]).parent/sys.argv[2], [sys.argv[2]], 1)
    print('reserved', flush=True)
except AdmissionError as error:
    print(error.code, flush=True)
'''
        children = []
        for name in ['a', 'b']:
            child = subprocess.Popen(['python3', '-B', '-c', code, str(self.pool.directory), name],
                                     cwd=Path(__file__).parent, stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            self.children.append(child); children.append(child)
            self.assertTrue(select.select([child.stdout], [], [], 2)[0], 'fixture readiness deadline')
            self.assertEqual(child.stdout.readline(), b'ready\n')
        for child in children: child.stdin.write(b'go\n'); child.stdin.flush()
        results = [child.communicate(timeout=2)[0].strip() for child in children]
        self.assertEqual(results.count(b'reserved'), 1)
        self.assertTrue(all(value in {b'reserved', b'BUSY', b'CAPACITY_EXHAUSTED'} for value in results))
        self.assertEqual(len(self.pool.snapshot()), 1)
