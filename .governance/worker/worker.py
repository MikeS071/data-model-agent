#!/usr/bin/env python3
"""Provider-neutral bounded implementation worker."""
import argparse
import fnmatch
import hashlib
import json
import math
import os
from pathlib import Path
import re
import selectors
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import tomllib
from urllib.parse import urlsplit
from runtime_observation import OwnedRuntime, now
from admission import AdmissionError
from dispatch import Dispatch, contract, encoded, sha256, write_json

HERE = Path(__file__).resolve().parent
CODES = {0: 'PATCH_READY_UNVERIFIED', 2: 'INVALID_REQUEST', 3: 'DIRTY_BASELINE',
         4: 'KEY_MISSING', 5: 'CONFIGURATION_BLOCKED', 6: 'RUNTIME_UNAVAILABLE',
         20: 'SCOPE_VIOLATION', 21: 'NO_PATCH', 22: 'EXECUTION_FAILED',
         23: 'BUDGET_EXHAUSTED', 24: 'CANCELLED', 25: 'CLEANUP_FAILED',
         26: 'INVALID_RESULT', 27: 'HEAD_MISMATCH', 28: 'SECRET_DETECTED',
         29: 'BUSY', 30: 'VERIFICATION_FAILED', 31: 'DEFECTS_UNRESOLVED', 32: 'BLOCKED', 33: 'VERIFICATION_INCOMPLETE'}

class Failure(Exception):
    def __init__(self, code, reason=None): self.code, self.reason = code, reason


def admission_failure(error):
    code = {'BUDGET_EXHAUSTED': 23, 'SOURCE_MISMATCH': 27, 'ASSIGNMENT_MISMATCH': 27,
            'INVALID_REQUEST': 2, 'SCOPE_TOO_BROAD': 2, 'CONTRACT_INVALID': 2,
            'CONTROL_UNSAFE': 5, 'AUTHORITY_UNKNOWN': 5, 'AUTHORITY_CHANGED': 5,
            'DISPATCH_PAUSED': 5}.get(error.code, 29)
    return Failure(code, error.code)

def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), '-c', 'core.hooksPath=/dev/null', *args], stderr=subprocess.DEVNULL)

def root_path():
    try: return Path(git(Path.cwd(), 'rev-parse', '--show-toplevel').decode().strip())
    except subprocess.CalledProcessError: raise Failure(2)

def clean(root):
    if git(root, 'status', '--porcelain', '--untracked-files=no'): raise Failure(3)

def digest(data): return hashlib.sha256(data).hexdigest()

def sensitive(path):
    p = Path(path)
    return (any(x in {'.git', '.codex', '.agents', '.governance', '.governance-artifacts', '.github', 'node_modules'} for x in p.parts)
            or p.as_posix().startswith(('tools/', 'scripts/', 'docs/agent/', 'docs/adr/'))
            or p.name == 'AGENTS.md' or p.name.startswith('.env') or 'data/imports' in p.as_posix() or p.suffix in {'.pem', '.key', '.p12'})

def scope_ok(path, scopes):
    return not sensitive(path) and any(fnmatch.fnmatchcase(path, s) for s in scopes)

def validate_scopes(scopes):
    for s in scopes:
        if s.startswith(('/', '-', '*', '?', '[')) or '..' in Path(s).parts or '\\' in s or sensitive(s): raise Failure(2)

def load_worker_config(path):
    """Validate one explicit, secret-free Codex worker configuration."""
    try:
        path = Path(path).expanduser().absolute()
        if path.is_symlink() or path.resolve() != path or not path.is_file(): raise Failure(5)
        status = path.stat()
        if status.st_uid != os.getuid() or status.st_size > 65536: raise Failure(5)
        data = path.read_bytes()
        config = tomllib.loads(data.decode())
    except Failure: raise
    except (OSError, UnicodeError, ValueError, TypeError): raise Failure(5) from None
    if set(config) != {'model_provider', 'model', 'model_reasoning_effort', 'model_verbosity', 'model_providers'}: raise Failure(5)
    provider_id, model = config['model_provider'], config['model']
    safe_id = r'[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}'
    if not isinstance(provider_id, str) or not re.fullmatch(safe_id, provider_id): raise Failure(5)
    if provider_id in {'openai', 'ollama', 'lmstudio'}: raise Failure(5)
    if not isinstance(model, str) or not re.fullmatch(safe_id, model): raise Failure(5)
    if config['model_reasoning_effort'] not in {'minimal', 'low', 'medium', 'high', 'xhigh'}: raise Failure(5)
    if config['model_verbosity'] not in {'low', 'medium', 'high'}: raise Failure(5)
    providers = config['model_providers']
    if not isinstance(providers, dict) or set(providers) != {provider_id}: raise Failure(5)
    provider = providers[provider_id]
    expected = {'name', 'base_url', 'wire_api', 'request_max_retries', 'stream_max_retries', 'env_key'}
    if not isinstance(provider, dict) or set(provider) != expected: raise Failure(5)
    if not isinstance(provider['name'], str) or not 1 <= len(provider['name']) <= 80: raise Failure(5)
    endpoint = urlsplit(provider['base_url']) if isinstance(provider['base_url'], str) else None
    if not endpoint or endpoint.scheme != 'https' or not endpoint.hostname or endpoint.username or endpoint.password or endpoint.query or endpoint.fragment: raise Failure(5)
    if provider['wire_api'] != 'responses' or provider['request_max_retries'] != 0 or provider['stream_max_retries'] != 0: raise Failure(5)
    credential = provider['env_key']
    if not isinstance(credential, str) or not re.fullmatch(r'[A-Z][A-Z0-9_]{0,63}', credential): raise Failure(5)
    return {'path': path, 'bytes': data, 'provider': provider_id, 'model': model, 'credential': credential}

def install():
    """Prepare only local artifacts; preserve every existing Desktop/user config."""
    root = root_path()
    root = Path(git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir').decode().strip()).parent
    out = root / '.codex/delegations'
    if out.is_symlink() or (root / '.codex').is_symlink(): raise Failure(5)
    try: git(root, 'check-ignore', str(out / 'installation-check'))
    except subprocess.CalledProcessError: raise Failure(5)
    out.mkdir(mode=0o700, parents=True, exist_ok=True)
    print('Repository bounded worker ready; supply explicit configuration before use.')

def runtime_command(work, common, worker_home, mode, sync_fd=None):
    """Expose isolated files, never repository Git history or private imports."""
    codex = shutil.which('codex')
    if not codex or not shutil.which('bwrap'): raise Failure(6)
    cmd = ['bwrap', '--die-with-parent', '--new-session', '--unshare-pid', '--unshare-ipc', '--unshare-uts']
    if sync_fd is not None: cmd += ['--sync-fd', str(sync_fd)]
    for d in ['/usr', '/bin', '/sbin', '/lib', '/lib64']:
        if Path(d).exists(): cmd += ['--ro-bind', d, d]
    cmd += ['--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/etc']
    for d in ['/etc/ssl/certs', '/etc/resolv.conf', '/etc/hosts', '/etc/nsswitch.conf', '/etc/passwd']:
        if Path(d).exists(): cmd += ['--ro-bind', d, d]
    resolved = Path(codex).resolve()
    # npm/nvm installs need their Node runtime. Never expose the user's entire home.
    if not str(resolved).startswith('/usr/'):
        node = Path(shutil.which('node') or '').resolve()
        prefix = node.parent.parent
        if not (prefix / 'bin/node').is_file() or not resolved.is_relative_to(prefix): raise Failure(6)
        cmd += ['--ro-bind', str(prefix), str(prefix)]
    empty = worker_home / 'empty-project-config'; empty.mkdir()
    git_mask = empty
    if not (work / '.git').is_dir():
        git_mask = worker_home / 'empty-git'; git_mask.touch()
    cmd += ['--bind', str(work), str(work), '--ro-bind', str(empty), str(work / '.codex'),
            '--ro-bind', str(git_mask), str(work / '.git')]
    imports = work / 'data/imports'
    if (work / 'data').is_symlink() or imports.is_symlink(): raise Failure(28)
    if imports.exists():
        if not imports.is_dir(): raise Failure(28)
        cmd += ['--ro-bind', str(empty), str(imports)]
    cmd += ['--bind', str(worker_home), '/worker-home', '--chdir', str(work)]
    cmd += ['--', codex, 'exec', '--strict-config', '--ephemeral',
            '--skip-git-repo-check', '--sandbox', mode, '-c', 'approval_policy="never"',
            '-c', 'shell_environment_policy.inherit="none"',
            '-c', 'shell_environment_policy.set.BOUNDED_WORKER_ACTIVE="1"',
            '-c', 'shell_environment_policy.set.PATH=' + json.dumps(str(Path(codex).parent) + ':/usr/bin:/bin'),
            '-c', 'sandbox_workspace_write.network_access=false',
            '--json']
    if mode == 'workspace-write': cmd += ['--output-schema', '/worker-home/result-schema.json']
    return cmd + ['-']

def usage_record(event):
    """Only explicit Codex-reported fields; no inferred totals, rates or raw payload."""
    usage = event.get('usage')
    if not isinstance(usage, dict): usage = {}
    result = {}
    for field in ['input_tokens', 'output_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'reasoning_output_tokens', 'cost_usd']:
        value = usage.get(field)
        valid = (type(value) is int or type(value) is float and math.isfinite(value)) and value >= 0
        if field != 'cost_usd': valid = valid and type(value) is int
        result[field] = value if valid else None
    return result

def result_schema():
    return {
        'type': 'object', 'additionalProperties': False,
        'required': ['completed', 'remaining', 'defects', 'verification', 'blocked', 'executionFailed', 'reportedOutcome'],
        'properties': {
            'completed': {'type': 'array', 'items': {'type': 'object', 'additionalProperties': False,
                'required': ['id', 'proof'], 'properties': {'id': {'type': 'string'}, 'proof': {'type': 'string'}}}},
            'remaining': {'type': 'array', 'items': {'type': 'string'}},
            'defects': {'type': 'array', 'items': {'type': 'string'}},
            'verification': {'type': 'string', 'enum': ['passed', 'failed', 'incomplete']},
            'blocked': {'type': 'boolean'}, 'executionFailed': {'type': 'boolean'},
            'reportedOutcome': {'type': 'string', 'enum': ['SCOPE_VERIFIED', 'DEFECTS_UNRESOLVED', 'VERIFICATION_FAILED', 'VERIFICATION_INCOMPLETE', 'BLOCKED', 'EXECUTION_FAILED']}}}


def invoke(work, common, run, prompt, seconds, profile, mode='workspace-write', dispatch=None):
    worker_home = run / 'home'; worker_home.mkdir(mode=0o700)
    # Deliberately no lead auth, MCPs, plugins, history, or user settings in the worker home.
    (worker_home / 'config.toml').write_bytes(profile['bytes'])
    (worker_home / 'result-schema.json').write_text(json.dumps(result_schema()))
    env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': '/worker-home',
           'CODEX_HOME': '/worker-home', profile['credential']: os.environ[profile['credential']],
           'LANG': 'C.UTF-8'}
    sync_read, sync_write = os.pipe()
    try:
        command = runtime_command(work, common, worker_home, mode, sync_fd=sync_write)
        if dispatch: dispatch.reservation.starting(dispatch.limit)
        proc = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                env=env, start_new_session=True, pass_fds=(sync_write,))
    except (OSError, Failure, AdmissionError) as error:
        os.close(sync_read)
        shutil.rmtree(worker_home)
        if isinstance(error, AdmissionError): raise admission_failure(error) from None
        raise Failure(6)
    finally: os.close(sync_write)
    runtime = OwnedRuntime(proc, run / 'runtime-observation.json', sandbox_fd=sync_read)
    def cancel(signum, frame): raise Failure(24)
    old_handlers = {s: signal.signal(s, cancel) for s in [signal.SIGINT, signal.SIGTERM]}
    completed = False; final = ''; total = 0; code = 0; malformed = 0
    usage_events = []; usage_truncated = False
    # Logs contain allowlisted event metadata only; never raw model text, shell output or headers.
    try:
        if not runtime.save(): raise Failure(25)
        if dispatch: dispatch.bind(runtime)
        sel = selectors.DefaultSelector()
        pending_prompt = memoryview(prompt.encode())
        os.set_blocking(proc.stdin.fileno(), False)
        sel.register(proc.stdin, selectors.EVENT_WRITE)
        for stream in [proc.stdout, proc.stderr]: sel.register(stream, selectors.EVENT_READ)
        buffers = {proc.stdout: b'', proc.stderr: b''}
        deadline = time.monotonic() + seconds
        with (run / 'worker.log').open('w') as log:
            while sel.get_map():
                if time.monotonic() >= deadline: raise Failure(23)
                for key, _ in sel.select(timeout=min(0.25, max(0, deadline-time.monotonic()))):
                    if key.fileobj is proc.stdin:
                        try: pending_prompt = pending_prompt[os.write(proc.stdin.fileno(), pending_prompt):]
                        except BlockingIOError: continue
                        if not pending_prompt:
                            sel.unregister(proc.stdin)
                            proc.stdin.close()
                        continue
                    chunk = os.read(key.fileobj.fileno(), 65536)
                    if not chunk: sel.unregister(key.fileobj); continue
                    total += len(chunk)
                    if total > 8_000_000: raise Failure(23)
                    buffers[key.fileobj] += chunk
                    while b'\n' in buffers[key.fileobj]:
                        line, buffers[key.fileobj] = buffers[key.fileobj].split(b'\n', 1)
                        try: event = json.loads(line)
                        except (ValueError, UnicodeError):
                            if key.fileobj is proc.stdout: code = 26; malformed += 1
                            continue
                        if not isinstance(event, dict):
                            code = 26; malformed += 1; continue
                        t = event.get('type')
                        item = event.get('item', {})
                        if not isinstance(item, dict):
                            code = 26; malformed += 1; continue
                        if t in ['thread.started', 'turn.started', 'turn.completed', 'turn.failed', 'error', 'item.started', 'item.completed']:
                            record = {'type': t}
                            if item.get('type') in ['command_execution', 'file_change', 'agent_message']: record['item_type'] = item['type']
                            log.write(json.dumps(record) + '\n'); log.flush()
                        if t == 'turn.completed':
                            completed = True
                            if len(usage_events) < 64: usage_events.append(usage_record(event))
                            else: usage_truncated = True
                        if t in ['turn.failed', 'error']: code = 22
                        if t == 'item.completed' and item.get('type') == 'agent_message': final = item.get('text', '')
            proc.wait(timeout=max(0.1, deadline-time.monotonic()))
        if proc.returncode or not completed: code = 22
    except subprocess.TimeoutExpired: code = 23
    except Failure as e: code = e.code
    except OSError: code = 22
    except AdmissionError: code = 25
    finally:
        # Repeated cancellation must not interrupt the bounded disposal observation.
        for s in old_handlers: signal.signal(s, signal.SIG_IGN)
        reason = {23: 'BUDGET_EXHAUSTED', 24: 'CANCELLED'}.get(code, 'CLEANUP')
        previous_code, code = code, 25
        try:
            disposed = runtime.finish(reason)
            if disposed:
                code = previous_code
                if dispatch: dispatch.reservation.release()
        except AdmissionError:
            code = 25
        finally:
            for s, handler in old_handlers.items(): signal.signal(s, handler)
        for stream in [proc.stdin, proc.stdout, proc.stderr]: stream.close()
        if disposed: shutil.rmtree(worker_home)
    try: parsed_final = json.loads(final)
    except (ValueError, TypeError): parsed_final = None
    diagnostics = {'execution_code': code, 'malformed_events': malformed, 'turn_completed': completed, 'final_is_json_object': isinstance(parsed_final, dict), 'final_has_outcome': isinstance(parsed_final, dict) and 'reportedOutcome' in parsed_final, 'final_text_length': len(final) if isinstance(final, str) else None}
    diagnostics.update(usage_source='codex-turn.completed', usage_events=usage_events,
                       usage_status='truncated' if usage_truncated else 'reported' if any(v is not None for row in usage_events for v in row.values()) else 'unavailable')
    (run / 'worker-diagnostics.json').write_text(json.dumps(diagnostics, indent=2))
    return code, final

def secret(data, profile):
    key = os.environ.get(profile['credential'], '').encode()
    return (bool(key) and key in data) or bool(re.search(rb'(sk-[A-Za-z0-9_-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)', data))

def delegate(scopes, task, seconds, scope, task_id, attempt, profile):
    if os.environ.get('BOUNDED_WORKER_ACTIVE'): raise Failure(2)
    if not scopes or len(encoded(scope)) + len(task.encode()) > 60000: raise Failure(2)
    if not os.environ.get(profile['credential']): raise Failure(4)
    if secret(encoded(scope) + task.encode(), profile): raise Failure(28)
    validate_scopes(scopes)
    root = root_path(); clean(root)
    base = git(root, 'rev-parse', 'HEAD').decode().strip()
    common = Path(git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir').decode().strip())
    # Tracked credentials still refuse dispatch. Imports are masked by the sandbox;
    # the worker cannot recover them from Git because no Git metadata is mounted.
    for f in git(root, 'ls-files', '-z').decode().split('\0'):
        if f and (Path(f).name.startswith('.env') and not f.endswith(('.example', '.sample')) or Path(f).suffix in {'.pem', '.key', '.p12'}): raise Failure(28)
    try:
        dispatch = Dispatch(root, common, scope, task_id, attempt, scopes, seconds, git)
        reservation = dispatch.reserve()
    except AdmissionError as error:
        raise admission_failure(error) from None
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        raise Failure(5, 'CONTROL_UNAVAILABLE') from None
    run, work = dispatch.run, dispatch.work
    code = 26; added = False; phase = 'worktree'; claim = None; patch = None; observed_source = None; observed_dirty = False
    report = {'schemaVersion': 2, 'base': base, 'model': profile['model'], 'provider': profile['provider'], 'scopes': scopes}
    try:
        work.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        git(root, 'worktree', 'add', '-b', dispatch.ref, str(work), base); added = True
        if root_path_from(work) != work or git(work, 'symbolic-ref', '--short', 'HEAD').decode().strip() != dispatch.ref: raise Failure(27)
        prompt = ('You are a bounded implementation worker. No delegation, commits, pushes, policy or provider changes. '
                  'Git metadata/history and private imports are intentionally unavailable in your file view. '
                  'The lead owns Git/source verification; use shell/file tools and scoped tests, not Git commands. '
                  'Only write within these globs: ' + json.dumps(scopes) +
                  '\nRead the scope below. Verify each criterion and the complete intent with focused checks. '
                  'Return only a bare JSON object, without Markdown fences, matching this exact schema: '
                  + json.dumps(result_schema()) + '\ncompleted contains criterion IDs and sha256 proof references; '
                  'remaining contains every unverified criterion ID. Report defects and failed/incomplete checks honestly. '
                  'Your SCOPE_VERIFIED is only a claim; independent lead review is required. No secrets in output. '
                  '\nWORKER POLICY\n' + (HERE.parents[1] / '.governance/skills/bounded-worker/SKILL.md').read_text() +
                  '\nSCOPE\n' + json.dumps(scope) + '\nTASK\n' + task)
        phase = 'execution'
        code, final = invoke(work, common, run, prompt, seconds, profile, dispatch=dispatch)
        if reservation.runtime and reservation.runtime.record['lifecycle'] == 'TERMINATED':
            # Do not let a worker redirect host-side Git commands to another repo.
            if root_path_from(work) != work or Path(git(work, 'rev-parse', '--path-format=absolute', '--git-common-dir').decode().strip()) != common: raise Failure(27)
            observed_source = dict(dispatch.assignment['source'], sha=git(work, 'rev-parse', 'HEAD').decode().strip(),
                                   ref=git(work, 'symbolic-ref', '--short', 'HEAD').decode().strip())
            observed_dirty = bool(git(work, 'status', '--porcelain', '--untracked-files=all'))
        if code: raise Failure(code)
        phase = 'result'
        try: claim = json.loads(final)
        except (ValueError, TypeError): raise Failure(26)
        if not isinstance(claim, dict) or set(claim) != {'completed', 'remaining', 'defects', 'verification', 'blocked', 'executionFailed', 'reportedOutcome'}: raise Failure(26)
        if not isinstance(claim['reportedOutcome'], str): raise Failure(26)
        if secret(encoded(claim), profile): raise Failure(28)
        # Include new files, including ignored files; reject unsafe paths before staging.
        phase = 'patch'
        if (root_path_from(work) != work or git(work, 'rev-parse', 'HEAD').decode().strip() != base
                or git(work, 'symbolic-ref', '--short', 'HEAD').decode().strip() != dispatch.ref): raise Failure(27)
        changed = set(filter(None, git(work, 'diff', '--name-only', '-z', base).decode().split('\0')))
        changed.update(filter(None, git(work, 'ls-files', '--others', '-z').decode().split('\0')))
        if not changed:
            raise Failure({'BLOCKED': 32, 'DEFECTS_UNRESOLVED': 31, 'VERIFICATION_FAILED': 30, 'VERIFICATION_INCOMPLETE': 33}.get(claim.get('reportedOutcome'), 21))
        if any(secret(f.encode(), profile) or not scope_ok(f, scopes) for f in changed): raise Failure(20)
        for f in changed:
            p = work / f
            if p.is_symlink() or (p.exists() and not p.is_file()): raise Failure(20)
            if p.exists() and p.stat().st_size > 2_000_000: raise Failure(23)
            if p.exists() and secret(p.read_bytes(), profile): raise Failure(28)
        git(work, 'add', '-f', '--', *sorted(changed))
        patch = git(work, 'diff', '--cached', '--binary', '--no-ext-diff', '--no-renames', base)
        if not patch: raise Failure(21)
        if len(patch) > 2_000_000: raise Failure(23)
        if secret(patch, profile):
            patch = None
            raise Failure(28)
        clean(root)
        if git(root, 'rev-parse', 'HEAD').decode().strip() != base: raise Failure(27)
        (run / 'result.patch').write_bytes(patch)
        report.update(patch_sha256=digest(patch), changed_files=sorted(changed))
        code = 0
    except Failure as e: code = e.code
    except (OSError, subprocess.SubprocessError): code = 22
    finally:
        if added and code != 25:
            try:
                git(root, 'worktree', 'remove', '--force', str(work))
                if work.exists() or str(work).encode() in git(root, 'worktree', 'list', '--porcelain'): raise Failure(25)
                if git(root, 'rev-parse', dispatch.ref).decode().strip() == base:
                    git(root, 'branch', '-D', dispatch.ref)
            except (OSError, subprocess.SubprocessError, Failure): code = 25; phase = 'cleanup'
        elif added:
            phase = 'runtime-cleanup'
        if reservation.runtime is None:
            try: reservation.cancel_queued()
            except AdmissionError: code = 25
        if code: (run / 'result.patch').unlink(missing_ok=True)
        # Host identity and observations wrap bounded claims; no worker-provided
        # source, runtime or lead review can enter the authoritative envelope.
        runtime = reservation.runtime
        native = runtime.record if runtime else None
        result = {'schemaVersion': 2, 'assignmentId': task_id, 'attemptId': dispatch.attempt_id,
                  'scopeDigest': dispatch.scope_digest, 'scopeRevision': scope['revision'],
                  'source': dict(observed_source, dirty=observed_dirty, patchProof='sha256:' + digest(patch) if patch else None) if observed_source else None,
                  'completed': [], 'remaining': [c['id'] for c in scope['criteria']], 'defects': [],
                  'verification': 'incomplete', 'blocked': False, 'executionFailed': code == 22,
                  'reportedOutcome': 'EXECUTION_FAILED' if code == 22 else 'VERIFICATION_INCOMPLETE'}
        if claim is not None and code not in (26, 28): result.update(claim)
        if code == 22: result.update(executionFailed=True, reportedOutcome='EXECUTION_FAILED')
        observation = None
        if native:
            stop = native['stop']
            observation = {'assignmentId': task_id, 'attemptId': dispatch.attempt_id, 'runtimeId': native['runtime_id'],
                           'state': native['lifecycle'], 'observedAt': native['observed_at'], 'proof': 'sha256:' + sha256(encoded(native)),
                           'completedAt': native['completed_at'], 'stop': None}
            if stop and stop['kind'] in ('CANCELLED', 'BUDGET_EXHAUSTED'):
                observation['stop'] = dict(stop, causality='effective' if native['completed_at'] and stop['at'] < native['completed_at'] else 'unknown', proof=observation['proof'])
        try: current_head = git(root, 'rev-parse', 'HEAD').decode().strip()
        except (OSError, subprocess.SubprocessError): current_head = None
        bundle = {'project': dispatch.project, 'scope': scope, 'assignment': dispatch.assignment, 'result': result, 'observation': observation, 'leadReview': None, 'currentHead': current_head}
        try: verdict = contract('result', bundle)
        except (AdmissionError, OSError, ValueError, subprocess.SubprocessError):
            code = 26
            verdict = {'validation': 'INVALID_RESULT', 'lifecycle': 'UNKNOWN', 'outcome': None, 'acceptedScope': False}
        if code == 0:
            if verdict['validation'] != 'VALID': code = 27 if verdict['validation'] == 'HEAD_MISMATCH' else 26
            elif verdict['outcome'] != 'VERIFICATION_INCOMPLETE': code = verdict['outcomeCode'] or 26
            elif claim['reportedOutcome'] != 'SCOPE_VERIFIED': code = 33
        if verdict['validation'] == 'INVALID_RESULT':
            bundle['result'] = None  # Never retain arbitrary malformed worker text.
        if code: (run / 'result.patch').unlink(missing_ok=True)
        if code == 25: verdict['lifecycle'] = 'UNKNOWN'
        report.update(failure_stage=phase if code else None, code=code, result=CODES[code],
                      lifecycle=verdict['lifecycle'], contract=bundle, verdict=verdict)
        write_json(run / 'result.json', report)
        print('Result:', run / 'result.json')
        if code == 0: print('Patch:', run / 'result.patch')
    if code: raise Failure(code)


def root_path_from(path):
    return Path(git(path, 'rev-parse', '--show-toplevel').decode().strip())


def apply(patch):
    root = root_path(); clean(root)
    patch = Path(patch).resolve()
    try:
        report = json.loads(patch.with_name('result.json').read_text())
        data = patch.read_bytes()
        if report.get('schemaVersion') != 2 or report['code'] != 0 or report['lifecycle'] != 'TERMINATED' or report['patch_sha256'] != digest(data): raise Failure(26)
        bundle = report['contract']
        if bundle['result']['source']['patchProof'] != 'sha256:' + digest(data): raise Failure(26)
        verdict = contract('result', dict(bundle, leadReview=None, currentHead=git(root, 'rev-parse', 'HEAD').decode().strip()))
        if verdict['validation'] == 'HEAD_MISMATCH': raise Failure(27)
        if verdict['validation'] != 'VALID' or verdict['lifecycle'] != 'TERMINATED': raise Failure(26)
        validate_scopes(report['scopes'])
        actual_files = [entry.split('\t', 2)[2] for entry in git(root, 'apply', '--numstat', '-z', str(patch)).decode().split('\0') if entry]
        if set(actual_files) != set(report['changed_files']) or any(not scope_ok(f, report['scopes']) for f in actual_files): raise Failure(20)
        if git(root, 'rev-parse', 'HEAD').decode().strip() != report['base']: raise Failure(27)
        git(root, 'apply', '--check', str(patch))
        git(root, 'apply', str(patch))
    except (OSError, ValueError, KeyError, subprocess.SubprocessError): raise Failure(26)
    print('Applied. Lead must independently review and run relevant tests/build/lint/typecheck.')

def smoke(profile):
    if not os.environ.get(profile['credential']): raise Failure(4)
    root = root_path()
    # Smoke does not expose the real repo to inference.
    with tempfile.TemporaryDirectory(prefix='worker-smoke-', dir=root) as name:
        repo = Path(name); git(repo, 'init', '-q')
        run = repo / 'run'; run.mkdir()
        code, final = invoke(repo, repo / '.git', run,
                             'Do not edit files. Reply with exactly: bounded worker ready', 90, profile, 'read-only')
        if code: raise Failure(code)
        if not isinstance(final, str) or final.strip() != 'bounded worker ready': raise Failure(26)
    print('Bounded worker ready')

def main():
    parser = argparse.ArgumentParser()
    subs = parser.add_subparsers(dest='action', required=True)
    d = subs.add_parser('delegate', usage='tools/delegate-worker --worker-config FILE --scope-record FILE --task-id ID --scope PATH [--attempt 1|2|3] [--timeout SECONDS] -- TASK', description='Return an unverified patch; never apply or merge automatically. The model/provider are explicit configuration; no fallback is permitted.')
    d.add_argument('--worker-config', type=Path, required=True, help='Explicit secret-free Codex config containing the selected provider and model')
    d.add_argument('--scope', action='append', required=True)
    d.add_argument('--scope-record', type=Path, required=True, help='Original intent, stable criteria and owned worker ref/source')
    d.add_argument('--task-id', required=True, help='Task in the coordinator activation record')
    d.add_argument('--attempt', type=int, choices=[1, 2, 3], default=1)
    d.add_argument('--env-file', type=Path, help='Read only the configured provider credential from an explicitly selected existing file')
    d.add_argument('--timeout', type=int, default=600, help='Wall-time seconds, 1..1800; not a monetary cap')
    d.add_argument('task', nargs='+')
    a = subs.add_parser('apply'); a.add_argument('patch')
    smoke_parser = subs.add_parser('smoke')
    smoke_parser.add_argument('--worker-config', type=Path, required=True)
    smoke_parser.add_argument('--env-file', type=Path)
    subs.add_parser('install')
    args = parser.parse_args()
    os.umask(0o077)
    try:
        profile = load_worker_config(args.worker_config) if args.action in {'delegate', 'smoke'} else None
        credential = profile['credential'] if profile else None
        if getattr(args, 'env_file', None) and not os.environ.get(credential):
            try:
                pattern = r'^\s*(?:export\s+)?' + re.escape(credential) + r'\s*=\s*(.*)$'
                matches = [re.match(pattern, line) for line in args.env_file.read_text().splitlines()]
                values = [shlex.split(m.group(1), comments=True) for m in matches if m]
                if len(values) != 1 or len(values[0]) != 1 or not values[0][0]: raise Failure(4)
                os.environ[credential] = values[0][0]
            except (OSError, ValueError): raise Failure(4)
        if args.action == 'delegate':
            if not 1 <= args.timeout <= 1800: raise Failure(2)
            delegate(args.scope, ' '.join(args.task), args.timeout, json.loads(args.scope_record.read_text()), args.task_id, args.attempt, profile)
        elif args.action == 'apply': apply(args.patch)
        elif args.action == 'smoke': smoke(profile)
        else: install()
    except Failure as e:
        print(json.dumps({'code': e.code, 'result': CODES[e.code], 'reason': e.reason}), file=sys.stderr); return e.code
    except (OSError, ValueError, KeyError, TypeError, AdmissionError):
        print(json.dumps({'code': 5, 'result': CODES[5]}), file=sys.stderr); return 5
    return 0

if __name__ == '__main__': sys.exit(main())
