"""Native observations for an already owned Popen child, never an arbitrary PID."""
from datetime import datetime, timezone
import json
import os
import select
import subprocess
import time
import uuid


def now():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


class OwnedRuntime:
    def __init__(self, process, path, sandbox_fd=None):
        self.process, self.path = process, path
        self.sandbox_fd = sandbox_fd
        self.finished = False
        self.persistence_failed = False
        self.record = {'schema_version': 1, 'runtime_id': uuid.uuid4().hex,
                       'pid': process.pid, 'lifecycle': 'RUNNING', 'started_at': now(),
                       'observed_at': None, 'completed_at': None,
                       'process_exit_code': None, 'sandbox_closed': None, 'stop': None}

    def save(self):
        self.record['observed_at'] = now()
        temporary = self.path.with_suffix('.pending')
        try:
            with temporary.open('w') as stream:
                json.dump(self.record, stream, indent=2)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.path)
            return True
        except OSError:
            self.persistence_failed = True
            self.record.update(lifecycle='UNKNOWN', completed_at=None)
            return False

    def finish(self, reason='CLEANUP'):
        """Observe disposal once. A stop request or unavailable group is not success."""
        if self.finished:
            return self.record['lifecycle'] == 'TERMINATED'
        self.finished = True
        disposed = False
        deadline = time.monotonic() + 2
        try:
            if self.process.poll() is None:
                self.record.update(lifecycle='STOP_REQUESTED', stop={'kind': reason, 'at': now()})
                self.save()
                # Popen retains/reaps its own child. Never killpg a reaped/reused PID.
                self.process.kill()
            self.process.wait(timeout=max(0, deadline - time.monotonic()))
            self.record['process_exit_code'] = self.process.returncode
            # bwrap's namespace keeper retains --sync-fd; the command cannot close it.
            if self.sandbox_fd is not None:
                ready = select.select([self.sandbox_fd], [], [], max(0, deadline - time.monotonic()))[0]
                self.record['sandbox_closed'] = bool(ready) and os.read(self.sandbox_fd, 1) == b''
                if not self.record['sandbox_closed']: raise OSError('sandbox lifetime unconfirmed')
            # Surviving group evidence is also contradictory, never reclaimed.
            try:
                os.killpg(self.process.pid, 0)
            except ProcessLookupError:
                disposed = True
        except (OSError, subprocess.TimeoutExpired):
            pass
        finally:
            if self.sandbox_fd is not None:
                os.close(self.sandbox_fd)
                self.sandbox_fd = None
        if disposed and not self.persistence_failed:
            self.record.update(lifecycle='TERMINATED', completed_at=now())
        else:
            self.record.update(lifecycle='UNKNOWN', completed_at=None)
        saved = self.save()
        return saved and self.record['lifecycle'] == 'TERMINATED'
