"""Internal reservation primitive; callers supply verified limits, never worker claims."""
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import re
import tempfile

from runtime_observation import OwnedRuntime


class AdmissionError(Exception):
    """Fixed diagnostics; no source paths or runtime output."""

    def __init__(self, code):
        self.code = code
        super().__init__(code)


def require(condition, code='STATE_UNKNOWN'):
    if not condition:
        raise AdmissionError(code)


def limit_value(value):
    require(type(value) is int and 0 <= value <= 2**53 - 1, 'LIMIT_UNKNOWN')
    return value


def roots_valid(roots):
    return (isinstance(roots, list) and bool(roots) and all(isinstance(r, str) for r in roots) and len(set(roots)) == len(roots)
            and all(re.fullmatch(r'[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*', r)
                    and not {'.', '..'}.intersection(r.split('/')) for r in roots))


def overlaps(left, right):
    return left == right or left.startswith(right + '/') or right.startswith(left + '/')


class AdmissionPool:
    def __init__(self, directory):
        self.directory = Path(directory).absolute()
        require(self.directory.is_dir() and self.directory.resolve() == self.directory, 'UNSAFE_DIRECTORY')

    @contextmanager
    def locked(self):
        try:
            fd = os.open(self.directory / '.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, 'a') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                yield
        except BlockingIOError:
            raise AdmissionError('BUSY') from None
        except (OSError, ValueError, TypeError, KeyError):
            raise AdmissionError('STATE_UNKNOWN') from None

    def records(self):
        rows = []
        for run in sorted(self.directory.glob('worker-*')):
            require(run.is_dir() and not run.is_symlink())
            path = run / 'admission.json'
            require(not path.is_symlink() and path.is_file() and path.stat().st_size <= 65536)
            row = json.loads(path.read_text())
            require(set(row) == {'version', 'attempt', 'worktree', 'roots', 'phase', 'runtime_id', 'release'})
            require(type(row['version']) is int and row['version'] == 1 and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,95}', row['attempt']))
            require(Path(row['worktree']).is_absolute() and str(Path(row['worktree']).resolve()) == row['worktree'])
            require(roots_valid(row['roots']) and row['phase'] in {'QUEUED', 'DISPATCHING', 'BOUND', 'RELEASED'})
            require(row['runtime_id'] is None or re.fullmatch(r'[a-f0-9]{32}', row['runtime_id']))
            require((row['release'] in {'never-dispatched', 'native-termination'}) if row['phase'] == 'RELEASED' else row['release'] is None)
            require((row['runtime_id'] is not None) if row['phase'] == 'BOUND' or row['release'] == 'native-termination' else row['runtime_id'] is None)
            rows.append((path, row))
        return rows

    def save(self, path, row):
        temporary = path.with_suffix('.pending')
        with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600), 'w') as stream:
            json.dump(row, stream, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)

    def snapshot(self):
        """Reservation state only: after restart, bound/dispatched runtime is unverified."""
        with self.locked():
            return [dict(row, runtime_unverified=row['phase'] in {'DISPATCHING', 'BOUND'}) for _, row in self.records()]

    def reserve(self, attempt, worktree, roots, effective_limit):
        require(isinstance(attempt, str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,95}', attempt), 'INVALID_REQUEST')
        require(roots_valid(roots), 'INVALID_REQUEST')
        worktree = str(Path(worktree).resolve())
        require(not self.directory.is_relative_to(worktree), 'UNSAFE_DIRECTORY')
        with self.locked():
            rows = [row for _, row in self.records()]
            limit = limit_value(effective_limit(rows) if callable(effective_limit) else effective_limit)
            require(all(row['attempt'] != attempt for row in rows), 'ATTEMPT_REUSED')
            active = [row for row in rows if row['phase'] != 'RELEASED']
            require(len(active) < limit, 'CAPACITY_EXHAUSTED')
            require(all(not overlaps(row['worktree'], worktree) and not any(overlaps(a, b) for a in row['roots'] for b in roots)
                        for row in active), 'SOURCE_CONFLICT')
            run = Path(tempfile.mkdtemp(prefix='worker-', dir=self.directory))
            self.save(run / 'admission.json', {'version': 1, 'attempt': attempt, 'worktree': worktree,
                      'roots': list(roots), 'phase': 'QUEUED', 'runtime_id': None, 'release': None})
            return Reservation(self, run)


class Reservation:
    def __init__(self, pool, run):
        self.pool, self.run, self.runtime = pool, run, None

    def update(self, change):
        with self.pool.locked():
            rows = self.pool.records()
            row = next((row for path, row in rows if path == self.run / 'admission.json'), None)
            require(row is not None)
            changed = change(row, [value for _, value in rows])
            if changed: self.pool.save(self.run / 'admission.json', row)
            return changed

    def starting(self, effective_limit):
        def change(row, rows):
            limit = limit_value(effective_limit(rows) if callable(effective_limit) else effective_limit)
            require(row['phase'] == 'QUEUED', 'INVALID_TRANSITION')
            require(sum(r['phase'] in {'DISPATCHING', 'BOUND'} for r in rows) < limit, 'CAPACITY_EXHAUSTED')
            row['phase'] = 'DISPATCHING'
            return True
        return self.update(change)

    def bind(self, runtime):
        require(isinstance(runtime, OwnedRuntime) and runtime.path.parent == self.run, 'RUNTIME_MISMATCH')
        def change(row, _):
            require(row['phase'] == 'DISPATCHING', 'INVALID_TRANSITION')
            row.update(phase='BOUND', runtime_id=runtime.record['runtime_id'])
            return True
        self.update(change)
        self.runtime = runtime

    def release(self):
        runtime = self.runtime
        require(runtime is not None and runtime.finished and runtime.record['lifecycle'] == 'TERMINATED'
                and runtime.record['sandbox_closed'] is True and runtime.process.returncode is not None,
                'TERMINATION_UNCONFIRMED')
        def change(row, _):
            require(row['runtime_id'] == runtime.record['runtime_id'], 'RUNTIME_MISMATCH')
            if row['phase'] == 'RELEASED': return False
            require(row['phase'] == 'BOUND', 'INVALID_TRANSITION')
            row.update(phase='RELEASED', release='native-termination')
            return True
        return self.update(change)

    def cancel_queued(self):
        def change(row, _):
            if row['phase'] == 'RELEASED' and row['release'] == 'never-dispatched': return False
            require(row['phase'] == 'QUEUED', 'INVALID_TRANSITION')
            row.update(phase='RELEASED', release='never-dispatched')
            return True
        return self.update(change)
