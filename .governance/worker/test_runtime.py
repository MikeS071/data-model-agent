import json
import os
from pathlib import Path
import select
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from runtime_observation import OwnedRuntime
import worker


class RuntimeFixture(unittest.TestCase):
    def setUp(self):
        scratch = Path(__file__).resolve().parents[1] / '.proof'
        scratch.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix='owned-runtime-', dir=scratch)
        self.root = Path(self.temp.name)
        self.children = []

    def tearDown(self):
        for child in self.children:
            if child.poll() is None: child.kill()
            child.communicate(timeout=2)
        self.temp.cleanup()

    def start(self, command, sandbox=False):
        reader, writer = os.pipe() if sandbox else (None, None)
        if sandbox: command[1:1] = ['--sync-fd', str(writer)]
        child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, start_new_session=True,
                                 pass_fds=(writer,) if sandbox else ())
        if sandbox: os.close(writer)
        self.children.append(child)
        observed = OwnedRuntime(child, self.root / f'observation-{child.pid}.json', reader)
        self.assertTrue(observed.save())
        return child, observed

    def ready(self, child):
        self.assertTrue(select.select([child.stdout], [], [], 2)[0], 'child readiness deadline')
        self.assertEqual(child.stdout.readline(), b'ready\n')


class RuntimeTests(RuntimeFixture):
    def test_normal_and_crash_are_native_terminal_observations_not_scope_success(self):
        for code in [0, 7]:
            child, observed = self.start(['python3', '-c', f'raise SystemExit({code})'])
            child.wait(timeout=2)
            with patch.object(child, 'kill', side_effect=AssertionError('reaped child signalled')):
                self.assertTrue(observed.finish())
                before = observed.path.read_bytes()
                self.assertTrue(observed.finish('CANCELLED'))
                self.assertEqual(before, observed.path.read_bytes())
            record = json.loads(before)
            self.assertEqual(record['lifecycle'], 'TERMINATED')
            self.assertEqual(record['process_exit_code'], code)
            self.assertIsNone(record['stop'])
            self.assertIsNotNone(record['completed_at'])
            self.assertNotIn('outcome', record)

    def test_cancel_and_deadline_stop_only_the_owned_child_once(self):
        for reason in ['CANCELLED', 'BUDGET_EXHAUSTED']:
            child, observed = self.start(['python3', '-c', 'import sys; print("ready",flush=True); sys.stdin.read()'])
            self.ready(child)
            with patch.object(child, 'kill', wraps=child.kill) as kill:
                self.assertTrue(observed.finish(reason))
                self.assertTrue(observed.finish(reason))
                self.assertEqual(kill.call_count, 1)
            record = json.loads(observed.path.read_text())
            self.assertEqual(record['stop']['kind'], reason)
            self.assertEqual(record['process_exit_code'], -9)
            self.assertEqual(record['lifecycle'], 'TERMINATED')

    def test_contradictory_or_unavailable_group_observation_is_unknown(self):
        for failure in [None, PermissionError()]:
            child, observed = self.start(['python3', '-c', 'pass'])
            child.wait(timeout=2)
            with patch('runtime_observation.os.killpg', return_value=None, side_effect=failure) as probe:
                self.assertFalse(observed.finish())
                probe.assert_called_once_with(child.pid, 0)
            self.assertEqual(json.loads(observed.path.read_text())['lifecycle'], 'UNKNOWN')

    def test_persistence_failure_cannot_be_reported_as_confirmed_disposal(self):
        child, observed = self.start(['python3', '-c', 'import sys; print("ready",flush=True); sys.stdin.read()'])
        self.ready(child)
        with patch('runtime_observation.os.replace', side_effect=OSError('fixture')):
            self.assertFalse(observed.finish('CANCELLED'))
        self.assertIsNotNone(child.returncode)
        self.assertEqual(observed.record['lifecycle'], 'UNKNOWN')
        self.assertIsNone(observed.record['completed_at'])
        self.assertFalse(observed.finish())

    def test_stop_without_wait_confirmation_remains_unknown(self):
        child, observed = self.start(['python3', '-c', 'import sys; print("ready",flush=True); sys.stdin.read()'])
        self.ready(child)
        with patch.object(child, 'kill') as stop, patch.object(child, 'wait', side_effect=subprocess.TimeoutExpired('fixture', 2)):
            self.assertFalse(observed.finish('CANCELLED'))
            self.assertFalse(observed.finish('CANCELLED'))
            self.assertEqual(stop.call_count, 1)
        self.assertIsNone(child.poll())
        self.assertEqual(json.loads(observed.path.read_text())['lifecycle'], 'UNKNOWN')

    def test_launcher_exit_without_sandbox_eof_is_not_termination(self):
        child, observed = self.start(['python3', '-c', 'pass'])
        child.wait(timeout=2)
        reader, writer = os.pipe()
        observed.sandbox_fd = reader
        try:
            self.assertFalse(observed.finish())
            self.assertFalse(observed.record['sandbox_closed'])
            self.assertEqual(observed.record['lifecycle'], 'UNKNOWN')
        finally: os.close(writer)


class HostIsolationTests(RuntimeFixture):
    def test_installed_bwrap_disposes_descendant_with_separate_session(self):
        work = self.root / 'work'; work.mkdir()
        common = self.root / 'git'; common.mkdir()
        home = self.root / 'home'; home.mkdir()
        command = worker.runtime_command(work, common, home, 'workspace-write')
        child_code = 'import os,signal; os.setsid(); print("ready",flush=True); signal.pause()'
        parent_code = f'import subprocess,signal; subprocess.Popen(["/usr/bin/python3","-c",{child_code!r}]); signal.pause()'
        command = command[:command.index('--')+1] + ['/usr/bin/python3', '-c', parent_code]
        child, observed = self.start(command, sandbox=True)
        self.ready(child)
        self.assertTrue(observed.finish('CANCELLED'))
        self.assertTrue(observed.record['sandbox_closed'])
        # The known descendant retains stdout even in its own session. EOF proves
        # that this fixture's descendant ended, independently of worker prose.
        self.assertTrue(select.select([child.stdout], [], [], 0)[0])
        child.communicate(timeout=2)
        self.assertEqual(json.loads(observed.path.read_text())['lifecycle'], 'TERMINATED')


if __name__ == '__main__': unittest.main()
