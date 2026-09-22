#!/usr/bin/env python3
"""Pinned project-local lifecycle. No downloads, providers, shell scripts or globals."""
import argparse
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

class Refusal(Exception):
    pass

def require(ok, reason):
    if not ok: raise Refusal(reason)

def digest(value):
    return hashlib.sha256(value).hexdigest()

def encoded(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode()

def root_path(value):
    path = Path(os.path.abspath(value))
    require(path.is_dir() and path.resolve() == path, 'target-missing-or-symlink')
    return path

def safe(root, name):
    require(isinstance(name, str) and name and '\\' not in name and not name.startswith('/'), 'unsafe-path')
    require(all(re.fullmatch(r'[A-Za-z0-9_.-]+', x) and x not in {'.', '..', '.git'} and not x.startswith('.env') for x in name.split('/')), 'unsafe-path')
    path = root / name
    for p in [path, *path.parents]:
        if p == root: break
        require(not p.is_symlink(), 'symlink-conflict:' + name)
    require(not path.exists() or path.is_file(), 'file-conflict:' + name)
    return path

def snapshot(root, name):
    path = safe(root, name)
    if not path.exists(): return None
    return {'data': base64.b64encode(path.read_bytes()).decode(), 'mode': path.stat().st_mode & 0o777}

def blob(data, mode=0o644):
    return {'data': base64.b64encode(data).decode(), 'mode': mode}

def content(row):
    return base64.b64decode(row['data'], validate=True)

def control(root, name):
    return safe(root, '.governance-artifacts/install/' + name)

def read_json(path):
    return json.loads(path.read_bytes())

def atomic(path, data, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True)
    pending = path.with_name(path.name + '.pending')
    # Explicit recovery may reuse only the exact interrupted bytes.
    if pending.exists():
        require(not pending.is_symlink() and pending.read_bytes() == data, 'pending-file-conflict')
    else:
        fd = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data); stream.flush(); os.fsync(stream.fileno())
    os.chmod(pending, mode); os.replace(pending, path)
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try: os.fsync(fd)
    finally: os.close(fd)

def tools():
    require(sys.version_info >= (3, 12) and sys.platform == 'linux', 'requires-linux-python-3.12')
    for argv, minimum in [(['node', '--version'], (24, 14)), (['git', '--version'], (2, 43))]:
        run = subprocess.run(argv, capture_output=True, text=True, check=False)
        parts = tuple(map(int, re.findall(r'\d+', run.stdout)[:2]))
        require(run.returncode == 0 and parts >= minimum, 'unsupported-tool:' + argv[0])

def release(path, expected=None):
    root = root_path(path); manifest_path = safe(root, '.governance/release.json')
    raw = manifest_path.read_bytes(); observed = digest(raw)
    if expected is not None: require(observed == expected, 'release-digest-mismatch')
    manifest = json.loads(raw)
    require(set(manifest) == {'schemaVersion', 'version', 'files', 'supported'} and manifest['schemaVersion'] == 1, 'release-schema-invalid')
    require(re.fullmatch(r'\d+\.\d+\.\d+(?:-[a-z0-9.]+)?', manifest['version']), 'release-version-invalid')
    require(isinstance(manifest['files'], list) and manifest['files'], 'release-empty')
    files = {}
    for row in manifest['files']:
        require(set(row) == {'path', 'sha256', 'mode'} and row['path'] not in files, 'release-entry-invalid')
        name = row['path']
        require(name.startswith(('.governance/', '.agents/skills/', 'tools/')), 'release-ownership-invalid')
        require(row['mode'] in (0o644, 0o755), 'release-mode-invalid')
        p = safe(root, name); data = p.read_bytes()
        require(digest(data) == row['sha256'] and p.stat().st_mode & 0o777 == row['mode'], 'release-file-mismatch:' + name)
        files[name] = blob(data, row['mode'])
    files['.governance/release.json'] = blob(raw)
    return root, manifest, files, observed

def settings(package, path, expected=None):
    source = Path(os.path.abspath(path))
    require(source.is_file() and not source.is_symlink() and source.resolve() == source, 'adapter-invalid')
    raw = source.read_bytes(); observed = digest(raw)
    if expected is not None: require(observed == expected, 'adapter-digest-mismatch')
    script = '''import {inspectDelivery} from './.governance/core/delivery.mjs';
import {inspectVerification} from './.governance/core/verification.mjs';
let text=''; for await (const chunk of process.stdin) text+=chunk;
const value=JSON.parse(text);
if(JSON.stringify(Object.keys(value).sort())!==JSON.stringify(['delivery','verification'])) throw Error();
inspectDelivery(value.delivery); inspectVerification(value.verification);
'''
    run = subprocess.run(['node', '--input-type=module', '-e', script], cwd=package, input=raw, capture_output=True)
    require(run.returncode == 0, 'adapter-invalid')
    value = json.loads(raw)
    files = {'.governance/project.json': blob(encoded(value['delivery']['project'])), '.governance/delivery.json': blob(encoded(value['delivery'])), '.governance/verification.json': blob(encoded(value['verification']))}
    return files, source, observed

AGENTS = '\n<!-- dev-stack:begin -->\nRead `.governance/skills/session-initialisation/SKILL.md` at task entry and `.governance/policy.md` for delivery. Existing stronger local policy and direct user instructions retain precedence. The kit grants no merge, provider, credential or worker activation authority.\n<!-- dev-stack:end -->\n'
IGNORE = '\n# dev-stack:begin\n/.governance-artifacts/\n/.codex/delegations/\n/.codex/worker-worktrees/\n/.governance/.proof/\n/.governance/**/__pycache__/\n# dev-stack:end\n'

def state(root):
    p = control(root, 'state.json')
    result = read_json(p) if p.exists() else {'version': None, 'releaseDigest': None, 'owned': {}}
    require(set(result) == {'version', 'releaseDigest', 'owned'}, 'installed-state-invalid')
    return result

def prepare(root, files, version, release_digest, removing=False):
    old = state(root); owned = {}; changes = []
    expected_names = {re.search(rb'^name: ([a-z0-9-]+)$', content(value), re.M).group(1).decode()
                      for name, value in files.items() if name.startswith('.agents/skills/') and name.endswith('/SKILL.md')}
    for found in (root / '.agents/skills').glob('*/SKILL.md'):
        name = found.relative_to(root).as_posix()
        if name in files: continue
        data = safe(root, name).read_bytes()
        match = re.search(rb'^name: ([a-z0-9-]+)$', data, re.M)
        require(not match or match.group(1).decode() not in expected_names, 'duplicate-skill:' + name)

    for name in sorted(set(files) | set(old['owned']) | {'AGENTS.md', '.gitignore'}):
        actual = snapshot(root, name); previous = old['owned'].get(name)
        if name in {'AGENTS.md', '.gitignore'}:
            block = AGENTS if name == 'AGENTS.md' else IGNORE
            prior = content(previous['blob']).decode() if previous else None
            text = content(actual).decode() if actual else ''
            if prior is not None:
                require(text.count(prior) == 1, 'managed-policy-conflict:' + name)
                updated = text.replace(prior, '' if removing else block)
            else:
                require('dev-stack:begin' not in text or removing, 'unowned-policy-marker:' + name)
                updated = text if removing else text + block
            desired = blob(updated.encode(), actual['mode'] if actual else 0o644) if updated else None
            if not removing: owned[name] = {'kind': 'block', 'blob': blob(block.encode())}
        else:
            if previous:
                require(actual == previous['blob'], 'locally-modified:' + name)
            elif actual is not None:
                require(False, 'unowned-conflict:' + name)
            desired = files.get(name)
            if desired is not None: owned[name] = {'kind': 'file', 'blob': desired}
        if desired != actual: changes.append({'path': name, 'before': actual, 'after': desired})
    new = {'version': version, 'releaseDigest': release_digest, 'owned': owned}
    unsigned = {'schemaVersion': 1, 'target': str(root), 'beforeStateDigest': digest(encoded(old)), 'afterStateDigest': digest(encoded(new)),
                'changes': [{'path': x['path'], 'before': digest(encoded(x['before'])), 'after': digest(encoded(x['after']))} for x in changes]}
    plan = dict(unsigned, planDigest=digest(encoded(unsigned)), state='no-op' if not changes and old == new else 'review-required')
    return plan, {'plan': plan, 'beforeState': old, 'afterState': new, 'changes': changes}

def pending_plan(root):
    return control(root, 'plan.json')

def plan_record(root, operation, plan, package=None, release_digest=None, adapter=None, adapter_digest=None):
    return {
        'schemaVersion': 1,
        'operation': operation,
        'target': str(root),
        'release': str(package) if package is not None else None,
        'releaseDigest': release_digest,
        'adapter': str(adapter) if adapter is not None else None,
        'adapterDigest': adapter_digest,
        'planDigest': plan['planDigest'],
    }

def inspect_plan_record(root, record):
    require(set(record) == {'schemaVersion', 'operation', 'target', 'release', 'releaseDigest', 'adapter', 'adapterDigest', 'planDigest'}, 'reviewed-plan-invalid')
    require(record['schemaVersion'] == 1 and record['target'] == str(root) and record['operation'] in {'install', 'remove'}, 'reviewed-plan-invalid')
    require(re.fullmatch(r'[a-f0-9]{64}', record['planDigest'] or '') is not None, 'reviewed-plan-invalid')
    identity = [record['release'], record['releaseDigest'], record['adapter'], record['adapterDigest']]
    if record['operation'] == 'install':
        require(all(isinstance(value, str) and value for value in identity), 'reviewed-plan-invalid')
        require(all(re.fullmatch(r'[a-f0-9]{64}', value) for value in [record['releaseDigest'], record['adapterDigest']]), 'reviewed-plan-invalid')
    else: require(identity == [None, None, None, None], 'reviewed-plan-invalid')
    return record

def save_plan(root, record):
    inspect_plan_record(root, record)
    atomic(pending_plan(root), encoded(record))

def load_plan(root):
    path = pending_plan(root)
    require(path.exists(), 'no-reviewed-plan; run plan first')
    return inspect_plan_record(root, read_json(path))

def plan_view(plan, tx, operation, version):
    changes = []
    for row in tx['changes']:
        action = 'create' if row['before'] is None else 'remove' if row['after'] is None else 'update'
        changes.append({'path': row['path'], 'action': action})
    return {'schemaVersion': 1, 'operation': operation, 'state': plan['state'], 'target': plan['target'],
            'releaseVersion': version, 'changes': changes,
            'next': 'Review these paths and actions, then run apply with the same target'}

def materialize_plan(root, record):
    if record['operation'] == 'remove':
        plan, tx = prepare(root, {}, None, None, removing=True)
        version = None
    else:
        package, manifest, files, observed = release(record['release'], record['releaseDigest'])
        configured, adapter, adapter_digest = settings(package, record['adapter'], record['adapterDigest'])
        require(observed == record['releaseDigest'] and str(adapter) == record['adapter'] and adapter_digest == record['adapterDigest'], 'reviewed-plan-invalid')
        files.update(configured)
        plan, tx = prepare(root, files, manifest['version'], observed)
        version = manifest['version']
    require(plan['planDigest'] == record['planDigest'], 'stale-or-unapproved-plan')
    return plan, tx, version

def apply_transaction(root, tx, fail_after=None):
    # Preflight every file before any target write, including an interrupted apply.
    for row in tx['changes']:
        current = snapshot(root, row['path'])
        require(current in (row['before'], row['after']), 'recovery-conflict:' + row['path'])
    for index, row in enumerate(tx['changes']):
        path = safe(root, row['path'])
        require(snapshot(root, row['path']) in (row['before'], row['after']), 'concurrent-file-change')
        if row['after'] is None: path.unlink(missing_ok=True)
        else: atomic(path, content(row['after']), row['after']['mode'])
        if fail_after is not None and index + 1 == fail_after: raise Refusal('injected-interruption; run recover explicitly')
    atomic(control(root, 'state.json'), encoded(tx['afterState']))
    atomic(control(root, 'last.json'), encoded(tx))
    control(root, 'transaction.json').unlink()

def mutate(root, tx, fail_after=None):
    path = control(root, 'lock'); path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with open(path, 'a+b') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        require(not control(root, 'transaction.json').exists(), 'interrupted-install; run recover')
        require(state(root) == tx['beforeState'], 'stale-plan')
        for row in tx['changes']: require(snapshot(root, row['path']) == row['before'], 'stale-plan')
        atomic(control(root, 'transaction.json'), encoded(tx))
        apply_transaction(root, tx, fail_after)

def verify(root):
    require(not control(root, 'transaction.json').exists(), 'interrupted-install; run recover')
    current = state(root); require(current['version'] is not None, 'not-installed')
    for name, entry in current['owned'].items():
        actual = snapshot(root, name)
        require(actual is not None, 'missing-owned-file:' + name)
        if entry['kind'] == 'block': require(content(actual).count(content(entry['blob'])) == 1, 'managed-policy-conflict:' + name)
        else: require(actual == entry['blob'], 'locally-modified:' + name)
    return {'state': 'installed-files-verified', 'version': current['version'], 'ownedFiles': len(current['owned']),
            'applicationAcceptance': 'not-proven-by-install', 'workers': 'not-activated', 'manual': ['configure project verification and existing host capabilities', 'obtain scoped provider/worker authority before activation']}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['doctor', 'plan', 'apply', 'verify', 'remove', 'rollback', 'recover'])
    parser.add_argument('--target', required=True); parser.add_argument('--adapter')
    parser.add_argument('--release', help=argparse.SUPPRESS)
    parser.add_argument('--digest', help=argparse.SUPPRESS)
    args = parser.parse_args(); tools(); root = root_path(args.target)
    observed = subprocess.run(['git', '-C', str(root), 'rev-parse', '--show-toplevel'], capture_output=True, text=True)
    require(observed.returncode == 0 and observed.stdout.strip() == str(root), 'target-must-be-git-root')
    if args.command == 'doctor': return {'state': 'host-tools-supported', 'target': str(root), 'installed': state(root)['version'], 'providerSetup': 'not-observed'}
    if args.command == 'verify': return verify(root)
    if args.command == 'recover':
        path = control(root, 'lock'); require(path.exists(), 'no-recovery-lock')
        with open(path, 'a+b') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            tx = read_json(control(root, 'transaction.json')); require(tx['plan']['target'] == str(root), 'foreign-transaction')
            require(state(root) in (tx['beforeState'], tx['afterState']), 'recovery-state-conflict')
            apply_transaction(root, tx)
            pending_plan(root).unlink(missing_ok=True)
        return {'state': 'recovered', 'next': 'verify installed files'}
    require(not control(root, 'transaction.json').exists(), 'interrupted-install; run recover')
    if args.command == 'rollback':
        require(not pending_plan(root).exists(), 'reviewed-plan-pending; apply-or-replan')
        prior = read_json(control(root, 'last.json')); require(prior['plan']['target'] == str(root) and state(root) == prior['afterState'], 'rollback-state-conflict')
        tx = {'plan': dict(prior['plan'], target=str(root)), 'beforeState': prior['afterState'], 'afterState': prior['beforeState'], 'changes': [dict(row, before=row['after'], after=row['before']) for row in prior['changes']]}
        # Preserve additions outside owned policy blocks when reversing an upgrade.
        for row in tx['changes']:
            if row['path'] in {'AGENTS.md', '.gitignore'}:
                actual = snapshot(root, row['path']); old_entry = tx['beforeState']['owned'].get(row['path']); new_entry = tx['afterState']['owned'].get(row['path'])
                if old_entry is None: continue  # Reversing removal requires the exact preserved snapshot.
                text = content(actual).decode() if actual else ''; old_block = content(old_entry['blob']).decode()
                require(old_block and text.count(old_block) == 1, 'rollback-policy-conflict')
                new_text = text.replace(old_block, content(new_entry['blob']).decode() if new_entry else '')
                row.update(before=actual, after=blob(new_text.encode(), actual['mode']) if new_text else None)
        mutate(root, tx); return {'state': 'rolled-back', 'version': tx['afterState']['version']}
    if args.command == 'apply':
        record = load_plan(root); plan, tx, version = materialize_plan(root, record)
        if plan['state'] != 'no-op': mutate(root, tx)
        pending_plan(root).unlink()
        return {'state': 'no-op' if plan['state'] == 'no-op' else 'applied', 'operation': record['operation'],
                'version': version, 'files': len(tx['changes'])}
    if args.command == 'remove':
        require(state(root)['version'] is not None, 'not-installed')
        plan, tx = prepare(root, {}, None, None, removing=True)
        save_plan(root, plan_record(root, 'remove', plan))
        return plan_view(plan, tx, 'remove', None)
    require(args.command == 'plan' and args.adapter, 'adapter-required')
    selected = args.release or str(Path(__file__).resolve().parents[1])
    package, manifest, files, release_digest = release(selected, args.digest)
    configured, adapter, adapter_digest = settings(package, args.adapter)
    files.update(configured)
    plan, tx = prepare(root, files, manifest['version'], release_digest)
    save_plan(root, plan_record(root, 'install', plan, package, release_digest, adapter, adapter_digest))
    return plan_view(plan, tx, 'install', manifest['version'])

if __name__ == '__main__':
    try: print(json.dumps(main(), sort_keys=True))
    except (Refusal, OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        # Do not echo unknown values, adapter content, credentials or subprocess output.
        error = sys.exc_info()[1]
        print(json.dumps({'state': 'blocked', 'error': str(error) if isinstance(error, Refusal) else 'invalid-or-unavailable-input'}))
        sys.exit(2)
