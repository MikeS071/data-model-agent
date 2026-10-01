"""Coordinator-owned dispatch inputs; workers never supply authority or capacity."""
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

from admission import AdmissionPool, overlaps, require

HERE = Path(__file__).resolve().parent


def tool_digest():
    files = sorted(HERE.glob('*.py')) + sorted(HERE.glob('*.mjs')) + sorted(HERE.glob('*.toml'))
    files += [HERE.parents[1] / p for p in ['.governance/core/contracts.mjs', '.governance/core/scope.mjs',
               '.governance/core/project.mjs', '.governance/core/cost.mjs', '.governance/skills/bounded-worker/SKILL.md', '.governance/skills/worker-coordination/SKILL.md']]
    return sha256(b''.join(str(p.relative_to(HERE.parents[1])).encode() + b'\0' + p.read_bytes() + b'\0' for p in files))


def encoded(value):
    return json.dumps(value, separators=(',', ':'), ensure_ascii=False).encode()


def sha256(value):
    return hashlib.sha256(value).hexdigest()


def contract(action, value):
    result = subprocess.run(['node', str(HERE / 'contract.mjs'), action], input=encoded(value),
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=10)
    require(result.returncode == 0, 'CONTRACT_INVALID')
    return json.loads(result.stdout)


def private_json(path):
    path = Path(path)
    require(path.resolve() == path and path.is_file(), 'CONTROL_UNSAFE')
    st = path.stat()
    require(st.st_uid == os.getuid() and st.st_mode & 0o077 == 0 and st.st_size <= 65536, 'CONTROL_UNSAFE')
    return json.loads(path.read_text())


def write_json(path, value):
    temporary = path.with_suffix('.pending')
    with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600), 'w') as stream:
        json.dump(value, stream, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def literal_roots(scopes):
    roots = []
    for scope in scopes:
        prefix = re.split(r'[*?\[]', scope, maxsplit=1)[0]
        root = prefix.rsplit('/', 1)[0] if prefix != scope else scope
        require(bool(root) and (prefix == scope or '/' in prefix), 'SCOPE_TOO_BROAD')
        roots.append(root)
    return sorted(set(roots))


def resolved_patch(run):
    patch = run / 'result.patch'
    if not patch.exists(): return
    require((run / 'decision.json').is_file(), 'PATCH_UNRECONCILED')
    decision = private_json(run / 'decision.json')
    require(decision.get('patchProof') == 'sha256:' + sha256(patch.read_bytes())
            and decision.get('decision') in {'rejected', 'verified-applied'}
            and re.fullmatch(r'sha256:[a-f0-9]{64}', decision.get('leadProof', '')), 'PATCH_UNRECONCILED')


class Dispatch:
    def __init__(self, root, common, scope, task_id, attempt, scopes, seconds, git):
        self.git, self.root = git, root
        self.scope, self.scopes = scope, scopes
        self.scope_digest = contract('scope', scope)['digest']
        self.base = git(root, 'rev-parse', 'HEAD').decode().strip()
        require(scope['source']['sha'] == self.base, 'SOURCE_MISMATCH')
        self.ref = scope['source']['ref']
        require(re.fullmatch(r'[a-z][a-z0-9-]*/[A-Za-z0-9][A-Za-z0-9_./-]*', self.ref), 'SOURCE_MISMATCH')
        git(root, 'check-ref-format', '--branch', self.ref)
        remote = git(root, 'remote', 'get-url', 'origin').decode().strip().removesuffix('.git')
        project_path = root / '.governance/project.json'
        require(project_path.resolve() == project_path and project_path.is_file(), 'CONTROL_UNSAFE')
        self.project = contract('project', json.loads(project_path.read_text()))
        require(self.project == json.loads(git(root, 'show', self.base + ':.governance/project.json')), 'SOURCE_MISMATCH')
        self.repository = self.project['repository']
        require(self.ref.split('/')[0] in self.project['branchPrefixes'], 'SOURCE_MISMATCH')
        require(remote in {'https://github.com/' + self.repository, 'git@github.com:' + self.repository}, 'SOURCE_MISMATCH')
        # One pool for the Git repository, not one per calling branch. Never inside
        # the common Git directory, which the worker can read for source metadata.
        self.primary = common.parent
        require(git(self.primary, 'rev-parse', '--path-format=absolute', '--git-common-dir').decode().strip() == str(common), 'CONTROL_UNSAFE')
        self.directory = self.primary / '.codex/delegations'
        require(self.directory.resolve() == self.directory and self.directory.is_dir(), 'CONTROL_UNSAFE')
        require(self.directory.stat().st_uid == os.getuid() and self.directory.stat().st_mode & 0o077 == 0, 'CONTROL_UNSAFE')
        self.pool = AdmissionPool(self.directory)
        require(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,31}', task_id) and attempt in (1, 2, 3, 4), 'INVALID_REQUEST')
        self.task_id, self.attempt, self.seconds = task_id, attempt, seconds
        self.activation = private_json(self.directory / 'activation.json')
        require(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,31}', self.activation['id']), 'CONTROL_UNSAFE')
        self.attempt_id = f"{self.activation['id']}.{task_id}.{attempt}"
        self.work = self.primary / '.codex/worker-worktrees' / self.attempt_id
        require(self.work.resolve() == self.work and not self.work.exists(), 'CONTROL_UNSAFE')
        self.roots = literal_roots(scopes)
        self.reservation = None

    def limit(self, rows):
        """Re-read authority/pause/bounds under the admission lock, including at start."""
        active = private_json(self.directory / 'activation.json')
        require(active == self.activation, 'AUTHORITY_CHANGED')
        require(self.project == json.loads((self.root / '.governance/project.json').read_text()), 'SOURCE_MISMATCH')
        require(set(active) == {'version', 'id', 'toolSource', 'toolDigest', 'configDigest', 'approved', 'expiresAt', 'maxSeconds', 'maxAttempts', 'authority', 'tasks'}, 'CONTROL_UNSAFE')
        require(active['version'] == 1 and type(active['approved']) is int and active['approved'] >= 0, 'CONTROL_UNSAFE')
        require(type(active['maxSeconds']) is int and 1 <= self.seconds <= active['maxSeconds'] <= 1800, 'BUDGET_EXHAUSTED')
        require(type(active['maxAttempts']) is int and active['maxAttempts'] > 0, 'BUDGET_EXHAUSTED')
        expiry = datetime.fromisoformat(active['expiresAt'].replace('Z', '+00:00'))
        require(expiry.tzinfo is not None and (expiry - datetime.now(timezone.utc)).total_seconds() >= self.seconds, 'BUDGET_EXHAUSTED')
        require(self.git(HERE, 'rev-parse', 'HEAD').decode().strip() == active['toolSource'], 'SOURCE_MISMATCH')
        require(tool_digest() == active['toolDigest'], 'SOURCE_MISMATCH')
        authority = private_json(self.directory / 'authority.json')
        require(sha256(encoded(authority)) == active['authority'] and authority.get('intent') and authority.get('source'), 'AUTHORITY_UNKNOWN')
        tasks = active['tasks']
        require(isinstance(tasks, list) and len({t['id'] for t in tasks}) == len(tasks), 'CONTROL_UNSAFE')
        task = next((t for t in tasks if t['id'] == self.task_id), None)
        require(task == {'id': self.task_id, 'scopeDigest': self.scope_digest, 'scopes': self.scopes,
                         'leadWorktree': str(self.root), 'sourceSha': self.base, 'workerRef': self.ref}, 'ASSIGNMENT_MISMATCH')
        # Every existing checkout must use the same canonical runner and must not
        # silently abandon another pool's unresolved generic worker result.
        for line in self.git(self.root, 'worktree', 'list', '--porcelain').decode().splitlines():
            if not line.startswith('worktree '): continue
            checkout = Path(line[9:])
            runner = checkout / '.governance/worker/worker.py'
            require(not runner.exists() or runner.read_bytes() == (HERE / 'worker.py').read_bytes(), 'RUNNER_MISMATCH')
            old_pool = checkout / '.codex/delegations'
            if old_pool == self.directory: continue
            for old in old_pool.glob('worker-*'):
                require(old.resolve() == old and not (old / 'worktree').exists(), 'RUN_UNRECONCILED')
                receipt = json.loads((old / 'result.json').read_text())
                require(receipt.get('schemaVersion') == 2 and receipt.get('lifecycle') == 'TERMINATED', 'RUN_UNRECONCILED')
                # A pending patch needs a recorded lead disposition too.
                resolved_patch(old)
        for row in rows:
            if row['attempt'] == self.attempt_id: continue
            run = next(path.parent for path, value in self.pool.records() if value['attempt'] == row['attempt'])
            if any(overlaps(a, b) for a in row['roots'] for b in self.roots):
                require(row['phase'] == 'RELEASED' and (run / 'result.json').is_file(), 'SOURCE_CONFLICT')
                receipt = private_json(run / 'result.json')
                require(receipt.get('code') != 25, 'STATE_UNKNOWN')
                resolved_patch(run)
        # A fixed set of assignment attempts bounds paid calls; no automatic retry.
        used = sum(r['attempt'].startswith(active['id'] + '.') and r['attempt'] != self.attempt_id for r in rows)
        available = active['maxAttempts'] - used
        require(available > 0, 'BUDGET_EXHAUSTED')
        # Admission counts reserved seats too. Do not subtract those seats twice.
        remaining = available + sum(r['attempt'].startswith(active['id'] + '.') and r['attempt'] != self.attempt_id
                                    and r['phase'] != 'RELEASED' for r in rows)
        # The task/ref pair keeps its retry sequence even when an accepted scope
        # revision requires a fresh activation record.
        history = []
        for path, row in self.pool.records():
            if row['attempt'] == self.attempt_id:
                continue
            match = re.fullmatch(r'[A-Za-z0-9_-]+\.' + re.escape(self.task_id) + r'\.([1-4])', row['attempt'])
            if match:
                assignment = private_json(path.parent / 'assignment.json')
                if assignment['id'] == self.task_id and assignment['source']['ref'] == self.ref:
                    history.append((int(match.group(1)), path.parent, row))
        require(self.attempt == 1 if not history else self.attempt == max(item[0] for item in history) + 1, 'RETRY_NOT_READY')
        if history:
            previous = next((path for number, path, row in history
                             if number == self.attempt - 1 and row['phase'] == 'RELEASED'), None)
            require(previous is not None, 'RETRY_NOT_READY')
            receipt = private_json(previous / 'result.json')
            require(receipt['code'] != 0 or private_json(previous / 'decision.json')['decision'] == 'rejected', 'RETRY_NOT_READY')
        config_path = self.primary / '.governance/config.json'
        require(config_path.resolve() == config_path, 'CONTROL_UNSAFE')
        config = json.loads(config_path.read_text())
        bounds = {'configDigest': active['configDigest'], 'source': self.base, 'authorityProof': 'sha256:' + active['authority'],
                  'approved': active['approved'], 'runtime': len(os.sched_getaffinity(0)), 'budget': remaining}
        view = contract('config', {'config': config, 'limits': bounds})
        require(view['state'] == 'bounded' and view['effective'] > 0, 'DISPATCH_PAUSED')
        require(self.git(self.root, 'rev-parse', 'HEAD').decode().strip() == self.base, 'SOURCE_MISMATCH')
        self.capacity = view
        return view['effective']

    def reserve(self):
        self.reservation = self.pool.reserve(self.attempt_id, self.work, self.roots, self.limit)
        self.run = self.reservation.run
        self.assignment = {'id': self.task_id, 'attemptId': self.attempt_id, 'scopeDigest': self.scope_digest,
                           'scopeRevision': self.scope['revision'], 'runtimeId': None,
                           'source': {'repository': self.repository, 'worktree': str(self.work), 'ref': self.ref, 'sha': self.base}}
        write_json(self.run / 'scope.json', self.scope)
        write_json(self.run / 'assignment.json', self.assignment)
        write_json(self.run / 'capacity.json', self.capacity)
        return self.reservation

    def bind(self, runtime):
        self.reservation.bind(runtime)
        self.assignment['runtimeId'] = runtime.record['runtime_id']
        write_json(self.run / 'assignment.json', self.assignment)
