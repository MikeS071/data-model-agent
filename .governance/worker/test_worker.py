from datetime import datetime, timedelta, timezone
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from dispatch import tool_digest

spec = importlib.util.spec_from_file_location('worker', Path(__file__).with_name('worker.py'))
w = importlib.util.module_from_spec(spec); spec.loader.exec_module(w)

class WorkerTests(unittest.TestCase):
    def test_tracked_imports_do_not_block_a_scoped_code_task(self):
        imports = self.repo / 'data/imports'; imports.mkdir(parents=True)
        private = imports / 'synthetic.txt'; private.write_text('synthetic-private-marker')
        w.git(self.repo, 'add', 'data'); w.git(self.repo, 'commit', '-qm', 'synthetic import fixture')
        self.run_worker(lambda work: (work/'sum.py').write_text('def add(a, b):\n    return a + b\n'))
        self.assertEqual(json.loads(self.result().read_text())['code'], 0)
        self.assertEqual(private.read_text(), 'synthetic-private-marker')
        self.assert_cleaned()

    def test_worker_view_hides_git_and_imports(self):
        imports = self.repo / 'data/imports'; imports.mkdir(parents=True)
        (imports / 'synthetic.txt').write_text('synthetic-private-marker')
        home = Path(self.tmp.name)/'view-home'; home.mkdir()
        with patch.object(w.shutil, 'which', side_effect=lambda name: '/usr/bin/'+name):
            cmd = w.runtime_command(self.repo, self.repo/'.git', home, 'workspace-write')
        self.assertIn('--skip-git-repo-check', cmd)
        mounts = [cmd[i+1:i+3] for i, value in enumerate(cmd) if value == '--ro-bind']
        self.assertNotIn([str(self.repo/'.git'), str(self.repo/'.git')], mounts)
        self.assertIn([str(home/'empty-project-config'), str(imports)], mounts)
        self.assertIn([str(home/'empty-project-config'), str(self.repo/'.git')], mounts)

    def test_import_symlink_is_rejected_before_sandbox_launch(self):
        (self.repo/'data').mkdir(); (self.repo/'data/imports').symlink_to(self.tmp.name)
        home = Path(self.tmp.name)/'view-home'; home.mkdir()
        with patch.object(w.shutil, 'which', side_effect=lambda name: '/usr/bin/'+name), self.assertRaises(w.Failure) as error:
            w.runtime_command(self.repo, self.repo/'.git', home, 'workspace-write')
        self.assertEqual(error.exception.code, 28)

    def setUp(self):
        scratch = Path(__file__).resolve().parents[1] / '.proof'
        scratch.mkdir(exist_ok=True)
        self.tmp = tempfile.TemporaryDirectory(prefix='worker-contract-', dir=scratch)
        self.repo = Path(self.tmp.name) / 'repo'; self.repo.mkdir()
        self.previous = Path.cwd(); os.chdir(self.repo)
        w.git(self.repo, 'init', '-q', '--initial-branch=chore/lead')
        w.git(self.repo, 'remote', 'add', 'origin', 'https://github.com/ExampleOrg/sample.git')
        w.git(self.repo, 'config', 'user.name', 'Synthetic Test')
        w.git(self.repo, 'config', 'user.email', 'worker@example.test')
        (self.repo / 'sum.py').write_text('def add(a, b):\n    return a - b\n')
        (self.repo / 'test_sum.py').write_text('from sum import add\nassert add(2, 3) == 5\n')
        (self.repo/'.governance').mkdir()
        self.config = {'schemaVersion': 1, 'agents': {'enabled': True, 'maxDevelopmentSubagents': 2}}
        (self.repo/'.governance/config.json').write_text(json.dumps(self.config))
        (self.repo/'.governance/project.json').write_text(json.dumps({'schemaVersion':1,'repository':'ExampleOrg/sample','branchPrefixes':['chore']}))
        w.git(self.repo, 'add', 'sum.py', 'test_sum.py', '.governance/config.json', '.governance/project.json')
        w.git(self.repo, 'commit', '-qm', 'fixture')
        config = Path(self.tmp.name) / 'worker.toml'
        config.write_text('''model_provider = "fixture"\nmodel = "example/model"\nmodel_reasoning_effort = "medium"\nmodel_verbosity = "low"\n\n[model_providers.fixture]\nname = "Fixture"\nbase_url = "https://api.example.invalid/v1"\nwire_api = "responses"\nrequest_max_retries = 0\nstream_max_retries = 0\nenv_key = "MODEL_API_KEY"\n''')
        self.worker_profile = w.load_worker_config(config)
        self.env = patch.dict(os.environ, {'MODEL_API_KEY': 'synthetic-not-a-credential'})
        self.env.start()
        self.count = 0
        (self.repo/'.codex/delegations').mkdir(parents=True, mode=0o700)
    def tearDown(self):
        self.env.stop(); os.chdir(self.previous); self.tmp.cleanup()
    def prepare_scope(self, scopes=None):
        self.count += 1
        scope = {'version': 2, 'revision': 1, 'intent': 'Correct addition without changing the main checkout',
                 'intentSource': 'synthetic S1 fixture', 'boundaries': 'sum and new only',
                 'assumptions': ['The local fixture is authoritative.'], 'exclusions': ['No external actions.'],
                 'documents': {'slug': 'synthetic-worker',
                               'request': {'path': 'docs/features/synthetic-worker/request.md', 'revision': 1},
                               'design': {'path': 'docs/features/synthetic-worker/design.md', 'revision': 1,
                                          'requestRevision': 1, 'decisions': ['D-001']}},
                 'source': {'ref': f'chore/fixture-{self.count}', 'sha': w.git(self.repo, 'rev-parse', 'HEAD').decode().strip()},
                 'criteria': [{'id': 'SUM', 'outcome': 'add(2, 3) returns 5', 'method': 'python3 -B test_sum.py'}]}
        authority = {'intent': 'Controlled local test, no inference', 'source': 'test fixture'}
        out = self.repo/'.codex/delegations'
        w.write_json(out/'authority.json', authority)
        activation = {'version': 1, 'id': f'fixture-{self.count}', 'toolSource': w.git(w.HERE, 'rev-parse', 'HEAD').decode().strip(), 'toolDigest': tool_digest(),
                      'configDigest': w.sha256(w.encoded(self.config)), 'approved': 2,
                      'expiresAt': (datetime.now(timezone.utc)+timedelta(hours=1)).isoformat(), 'maxSeconds': 10, 'maxAttempts': 2,
                      'authority': w.sha256(w.encoded(authority)), 'tasks': [{'id': 'sum', 'scopeDigest': w.contract('scope', scope)['digest'],
                      'scopes': scopes or ['sum.py', 'new.py'], 'leadWorktree': str(self.repo), 'sourceSha': scope['source']['sha'], 'workerRef': scope['source']['ref']}]}
        w.write_json(out/'activation.json', activation)
        return scope

    def run_worker(self, edit=None, code=0, final=None, timeout=2, scope=None, attempt=1):
        scope = scope or self.prepare_scope()
        claim = {'completed': [{'id': 'SUM', 'proof': 'sha256:'+'b'*64}], 'remaining': [], 'defects': [],
                 'verification': 'passed', 'blocked': False, 'executionFailed': False, 'reportedOutcome': 'SCOPE_VERIFIED'}
        if final is None: final = json.dumps(claim)
        # Replace only the external invocation command, retaining Popen, observation,
        # admission, result validation, cleanup and patch generation in the actual runner.
        def command(work, common, home, mode, sync_fd=None):
            self.assertNotEqual(work, self.repo)
            self.assertEqual(w.git(work, 'rev-parse', 'HEAD'), w.git(self.repo, 'rev-parse', 'HEAD'))
            if edit: edit(work)
            self.assertIn('a - b', (self.repo/'sum.py').read_text())
            script = 'import json,sys;sys.stdin.read();print(json.dumps({"type":"item.completed","item":{"type":"agent_message","text":'+repr(final)+'}}));print(json.dumps({"type":"turn.completed"}));sys.exit('+str(code)+')'
            return ['python3', '-c', script]
        with patch.object(w, 'runtime_command', side_effect=command):
            w.delegate(['sum.py', 'new.py'], 'Fix add and test it', timeout, scope, 'sum', attempt, self.worker_profile)

    def test_three_corrections_require_reconciled_predecessors_and_stable_task_identity(self):
        scope = self.prepare_scope()
        activation_path = self.repo/'.codex/delegations/activation.json'
        activation = json.loads(activation_path.read_text())
        activation['maxAttempts'] = 4
        w.write_json(activation_path, activation)
        def attempt(number, operator):
            before = set((self.repo/'.codex/delegations').glob('worker-*/result.json'))
            self.run_worker(lambda work: (work/'sum.py').write_text(f'def add(a, b):\n    return a {operator} b\n'),
                            scope=scope, attempt=number)
            result, = set((self.repo/'.codex/delegations').glob('worker-*/result.json')) - before
            return result
        first = attempt(1, '*')
        self.decide(first, 'verified-applied')
        with self.assertRaises(w.Failure) as error: attempt(2, '*')
        self.assertEqual(error.exception.code, 29)
        self.decide(first)
        with self.assertRaises(w.Failure) as error: attempt(3, '+')
        self.assertEqual(error.exception.code, 29)  # Cannot skip attempt 2.
        second = attempt(2, '*')
        with self.assertRaises(w.Failure) as error: attempt(3, '+')
        self.assertEqual(error.exception.code, 29)  # Pending patch needs lead disposition.
        self.decide(second)
        activation['maxAttempts'] = 2
        w.write_json(activation_path, activation)
        with self.assertRaises(w.Failure) as error: attempt(3, '+')
        self.assertEqual(error.exception.code, 23)
        activation['maxAttempts'] = 4
        w.write_json(activation_path, activation)
        third = attempt(3, '*')
        self.assertEqual(json.loads(third.read_text())['contract']['assignment']['attemptId'], 'fixture-1.sum.3')
        self.decide(third)
        activation['id'] = 'fixture-2'
        w.write_json(activation_path, activation)
        with self.assertRaises(w.Failure) as error: attempt(1, '+')
        self.assertEqual(error.exception.code, 29)  # New activation cannot reset a task's retry count.
        fourth = attempt(4, '+')
        self.assertEqual(json.loads(fourth.read_text())['contract']['assignment']['attemptId'], 'fixture-2.sum.4')
        with self.assertRaises(w.Failure) as error: attempt(5, '+')
        self.assertEqual(error.exception.code, 2)
        w.apply(fourth.with_name('result.patch'))
        subprocess.run(['python3', '-B', 'test_sum.py'], check=True)
        self.assert_cleaned()

    def decide(self, result, decision='rejected'):
        patch_file = result.with_name('result.patch')
        w.write_json(result.with_name('decision.json'), {'decision': decision, 'patchProof': 'sha256:'+w.digest(patch_file.read_bytes()), 'leadProof': 'sha256:'+'c'*64})

    def result(self):
        return next((self.repo / '.codex/delegations').glob('worker-*/result.json'))
    def assert_cleaned(self):
        self.assertEqual(w.git(self.repo, 'worktree', 'list', '--porcelain').count(b'worktree '), 1)
        self.assertFalse(list((self.repo / '.codex/worker-worktrees').glob('*')))
    def test_usage_is_explicit_numeric_and_secret_safe(self):
        self.assertEqual(w.usage_record({}), dict.fromkeys(['input_tokens', 'output_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'reasoning_output_tokens', 'cost_usd']))
        event = {'usage': {'input_tokens': 100, 'output_tokens': 12, 'cached_input_tokens': 50, 'cache_write_input_tokens': 10, 'reasoning_output_tokens': 7, 'cost_usd': 0.002, 'private': 'PRIVATE'}}
        self.assertEqual(w.usage_record(event), {'input_tokens': 100, 'output_tokens': 12, 'cached_input_tokens': 50, 'cache_write_input_tokens': 10, 'reasoning_output_tokens': 7, 'cost_usd': 0.002})
        for value in ['PRIVATE', True, -1, float('nan'), float('inf')]:
            self.assertTrue(all(v is None for v in w.usage_record({'usage': dict.fromkeys(w.usage_record({}), value)}).values()))
        self.assertIsNone(w.usage_record({'usage': {'input_tokens': 1.5}})['input_tokens'])
    def test_public_name_and_compatibility_help(self):
        root = Path(__file__).resolve().parents[2]
        output = subprocess.check_output([str(root/'tools/delegate-worker'), '--help'])
        self.assertIn(b'tools/delegate-worker', output)

    def test_patch_apply_and_independent_test(self):
        before = subprocess.run(['python3', '-B', 'test_sum.py'], capture_output=True)
        self.assertNotEqual(before.returncode, 0)
        self.run_worker(lambda work: (work/'sum.py').write_text('def add(a, b):\n    return a + b\n'))
        self.assert_cleaned()
        p = self.result().with_name('result.patch')
        w.git(self.repo, 'apply', '--check', str(p)); w.apply(p)
        subprocess.run(['python3', '-B', 'test_sum.py'], check=True)

    def test_actual_child_scope_binding_native_release_and_lead_acceptance(self):
        scope = self.prepare_scope()
        def command(work, common, home, mode, sync_fd=None):
            # Only replace the external model command. The child really writes and
            # tests in its assigned cwd; it cannot report host source or runtime IDs.
            script = ('import os,sys,json,subprocess;from pathlib import Path;sys.stdin.read();'
                      'os.chdir('+repr(str(work))+');'
                      'Path("sum.py").write_text("def add(a, b):\\n    return a + b\\n");'
                      'subprocess.run([sys.executable,"-B","test_sum.py"],check=True);'
                      'claim={"completed":[{"id":"SUM","proof":"sha256:"+"b"*64}],"remaining":[],"defects":[],"verification":"passed","blocked":False,"executionFailed":False,"reportedOutcome":"SCOPE_VERIFIED"};'
                      'print(json.dumps({"type":"item.completed","item":{"type":"agent_message","text":json.dumps(claim)}}));'
                      'print(json.dumps({"type":"turn.completed"}))')
            return ['python3', '-c', script]
        with patch.object(w, 'runtime_command', side_effect=command):
            w.delegate(['sum.py', 'new.py'], 'Fix addition', 2, scope, 'sum', 1, self.worker_profile)
        report = json.loads(self.result().read_text())
        self.assertEqual(report['verdict']['outcome'], 'VERIFICATION_INCOMPLETE')
        self.assertFalse(report['verdict']['acceptedScope'])
        self.assertEqual(report['contract']['assignment']['source']['ref'], scope['source']['ref'])
        self.assertEqual(json.loads(self.result().with_name('admission.json').read_text())['release'], 'native-termination')
        self.assertIn('a - b', (self.repo/'sum.py').read_text())
        self.assert_cleaned()
        w.apply(self.result().with_name('result.patch'))
        subprocess.run(['python3', '-B', 'test_sum.py'], check=True)
        bundle = report['contract']
        bundle['leadReview'] = {'scopeDigest': bundle['assignment']['scopeDigest'], 'scopeRevision': 1,
            'sourceDigest': w.sha256(w.encoded(bundle['result']['source'])), 'criteria': [{'id': 'SUM', 'proof': 'sha256:'+'c'*64}],
            'intentProof': 'sha256:'+'d'*64, 'reviewedAt': w.now()}
        self.assertEqual(w.contract('result', bundle)['outcome'], 'SCOPE_VERIFIED')

    def test_mismatched_canonical_runner_blocks_before_dispatch(self):
        other = Path(self.tmp.name) / 'other'
        w.git(self.repo, 'worktree', 'add', '--detach', str(other), 'HEAD')
        try:
            runner = other / '.governance/worker/worker.py'; runner.parent.mkdir(parents=True, exist_ok=True)
            runner.write_text('different runner')
            scope = self.prepare_scope()
            with patch.object(w, 'invoke', side_effect=AssertionError('worker dispatched')), self.assertRaises(w.Failure):
                w.delegate(['sum.py', 'new.py'], 'fixture', 2, scope, 'sum', 1, self.worker_profile)
            self.assertEqual(runner.read_text(), 'different runner')
            self.assertFalse(list((self.repo/'.codex/delegations').glob('worker-*/result.patch')))
        finally:
            w.git(self.repo, 'worktree', 'remove', '--force', str(other))

    def test_missing_authority_pause_changed_scope_and_attempt_budget_block_before_child(self):
        scope = self.prepare_scope()
        path = self.repo/'.codex/delegations/activation.json'
        activation = json.loads(path.read_text())
        for changed, expected in [({}, 5), (dict(activation, authority='0'*64), 5),
                                  (dict(activation, configDigest='0'*64), 5), (dict(activation, maxAttempts=0), 23),
                                  (dict(activation, toolDigest='0'*64), 27)]:
            w.write_json(path, changed)
            with patch.object(w, 'invoke', side_effect=AssertionError('worker dispatched')), self.assertRaises(w.Failure) as error:
                w.delegate(['sum.py', 'new.py'], 'fixture', 2, scope, 'sum', 1, self.worker_profile)
            self.assertEqual(error.exception.code, expected)
        w.write_json(path, activation)
        bad = dict(scope, intent='different task')
        with self.assertRaises(w.Failure) as error: w.delegate(['sum.py', 'new.py'], 'fixture', 2, bad, 'sum', 1, self.worker_profile)
        self.assertEqual(error.exception.code, 27)
        self.assert_cleaned()

    def test_unreviewed_patch_blocks_overlapping_dispatch(self):
        self.run_worker(lambda work: (work/'sum.py').write_text('def add(a, b):\n    return a + b\n'))
        first = self.result().read_bytes()
        with self.assertRaises(w.Failure) as error: self.run_worker()
        self.assertEqual(error.exception.code, 29)
        self.assertEqual(self.result().read_bytes(), first)
    def test_overlapping_results_preserve_first_patch_and_reject_stale_second(self):
        self.run_worker(lambda work: (work/'sum.py').write_text('def add(a, b):\n    return a + b\n'))
        first = self.result().with_name('result.patch')
        existing = set((self.repo/'.codex/delegations').glob('worker-*/result.patch'))
        self.decide(self.result())
        self.run_worker(lambda work: (work/'sum.py').write_text('def add(a, b):\n    return a * b\n'))
        second, = set((self.repo/'.codex/delegations').glob('worker-*/result.patch')) - existing
        self.assertIn('a - b', (self.repo/'sum.py').read_text())
        w.apply(first)
        before = ((self.repo/'sum.py').read_bytes(), w.git(self.repo, 'write-tree'), w.git(self.repo, 'rev-parse', 'HEAD'))
        with self.assertRaises(w.Failure) as error: w.apply(second)
        self.assertEqual(error.exception.code, 3)
        self.assertEqual(before, ((self.repo/'sum.py').read_bytes(), w.git(self.repo, 'write-tree'), w.git(self.repo, 'rev-parse', 'HEAD')))
        w.git(self.repo, 'commit', '-am', 'accept first scoped result')
        before = ((self.repo/'sum.py').read_bytes(), w.git(self.repo, 'write-tree'), w.git(self.repo, 'rev-parse', 'HEAD'))
        with self.assertRaises(w.Failure) as error: w.apply(second)
        self.assertEqual(error.exception.code, 27)
        with self.assertRaises(subprocess.CalledProcessError): w.git(self.repo, 'apply', '--check', str(second))
        self.assertEqual(before, ((self.repo/'sum.py').read_bytes(), w.git(self.repo, 'write-tree'), w.git(self.repo, 'rev-parse', 'HEAD')))
        subprocess.run(['python3', '-B', 'test_sum.py'], check=True)
        self.assert_cleaned()
    def test_new_files_included(self):
        self.run_worker(lambda work: (work/'new.py').write_text('value = 1\n'))
        p = self.result().with_name('result.patch'); w.apply(p)
        self.assertEqual((self.repo/'new.py').read_text(), 'value = 1\n')
    def test_out_of_scope_new_file_rejected(self):
        with self.assertRaises(w.Failure) as e:
            self.run_worker(lambda work: (work/'outside.py').write_text('value = 1\n'))
        self.assertEqual(e.exception.code, 20); self.assert_cleaned()
        self.assertFalse(self.result().with_name('result.patch').exists())
    def test_failure_cannot_return_patch(self):
        with self.assertRaises(w.Failure) as e:
            self.run_worker(lambda work: (work/'sum.py').write_text('bad\n'), code=22)
        self.assertEqual(e.exception.code, 22); self.assert_cleaned()
        self.assertEqual(json.loads(self.result().read_text())['failure_stage'], 'execution')
        self.assertFalse(self.result().with_name('result.patch').exists())
    def test_functional_failure(self):
        claim = {'completed': [], 'remaining': ['SUM'], 'defects': ['D-1'], 'verification': 'failed', 'blocked': True, 'executionFailed': False, 'reportedOutcome': 'DEFECTS_UNRESOLVED'}
        with self.assertRaises(w.Failure) as e: self.run_worker(final=json.dumps(claim))
        self.assertEqual(e.exception.code,31)
        self.assertEqual(json.loads(self.result().read_text())['verdict']['outcome'], 'DEFECTS_UNRESOLVED')
        self.assert_cleaned()
    def test_malformed_final(self):
        with self.assertRaises(w.Failure) as e: self.run_worker(final='tests passed')
        self.assertEqual(e.exception.code,26)
    def test_unknown_outcome_type(self):
        with self.assertRaises(w.Failure) as e: self.run_worker(final='{"outcome":[]}')
        self.assertEqual(e.exception.code,26)
    def test_dirty_baseline(self):
        (self.repo/'sum.py').write_text('dirty\n')
        with self.assertRaises(w.Failure) as e: self.run_worker()
        self.assertEqual(e.exception.code,3)
    def test_scopes(self):
        for scope in ['*','**','../outside','/absolute','.codex/**','.governance/**','AGENTS.md']:
            with self.assertRaises(w.Failure): w.validate_scopes([scope])
        self.assertFalse(w.scope_ok('.governance/principles.md', ['.g*']))
        self.assertFalse(w.scope_ok('.governance/skills/principle-prove-it-works/SKILL.md', ['.g*']))
        self.assertTrue(w.scope_ok('docs/example.md', ['docs/*']))
    def test_no_patch(self):
        with self.assertRaises(w.Failure) as e: self.run_worker()
        self.assertEqual(e.exception.code,21)
    def test_symlink_rejected(self):
        with self.assertRaises(w.Failure) as e: self.run_worker(lambda work: (work/'new.py').symlink_to('/etc/passwd'))
        self.assertEqual(e.exception.code,20)
    def test_secret_rejected(self):
        with self.assertRaises(w.Failure) as e: self.run_worker(lambda work: (work/'new.py').write_text(os.environ['MODEL_API_KEY']))
        self.assertEqual(e.exception.code,28)
        self.assertFalse(self.result().with_name('result.patch').exists())
    def test_patch_tamper_rejected(self):
        self.run_worker(lambda work: (work/'new.py').write_text('value = 1\n'))
        p=self.result().with_name('result.patch'); p.write_bytes(p.read_bytes()+b'changed')
        with self.assertRaises(w.Failure) as e:w.apply(p)
        self.assertEqual(e.exception.code,26)
    def test_head_mismatch(self):
        self.run_worker(lambda work: (work/'new.py').write_text('value = 1\n'))
        w.git(self.repo,'commit','--allow-empty','-qm','new head')
        with self.assertRaises(w.Failure) as e:w.apply(self.result().with_name('result.patch'))
        self.assertEqual(e.exception.code,27)

    def test_lead_source_move_during_finalization_invalidates_result(self):
        original = w.git
        def move(root, *args):
            value = original(root, *args)
            if args[:2] == ('worktree', 'remove'):
                original(self.repo, 'commit', '--allow-empty', '-qm', 'concurrent lead source')
            return value
        with patch.object(w, 'git', side_effect=move), self.assertRaises(w.Failure) as error:
            self.run_worker(lambda work: (work/'sum.py').write_text('def add(a, b):\n    return a + b\n'))
        self.assertEqual(error.exception.code, 27)
        self.assertEqual(json.loads(self.result().read_text())['verdict']['validation'], 'HEAD_MISMATCH')
        self.assertFalse(self.result().with_name('result.patch').exists())
    def test_unknown_previous_worker_blocks_dispatch(self):
        self.run_worker(lambda work: (work/'new.py').write_text('value = 1\n'))
        result=self.result(); d=json.loads(result.read_text()); d['code']=25; d['lifecycle']='UNKNOWN';result.write_text(json.dumps(d))
        with self.assertRaises(w.Failure) as e:self.run_worker()
        self.assertEqual(e.exception.code,29)
    def test_uncertain_runtime_retains_source_home_and_blocks_next_writer(self):
        original = w.OwnedRuntime.finish
        def uncertain(runtime, reason):
            original(runtime, reason)
            runtime.record['lifecycle'] = 'UNKNOWN'
            runtime.save()
            return False
        with patch.object(w.OwnedRuntime, 'finish', uncertain), self.assertRaises(w.Failure) as error:
            self.run_worker(lambda work: (work/'sum.py').write_text('owned unfinished source\n'))
        self.assertEqual(error.exception.code, 25)
        result = self.result(); report = json.loads(result.read_text())
        self.assertEqual(report['lifecycle'], 'UNKNOWN')
        work = Path(report['contract']['assignment']['source']['worktree'])
        self.assertEqual((work/'sum.py').read_text(), 'owned unfinished source\n')
        self.assertTrue((result.parent/'home').is_dir())
        self.assertFalse(result.with_name('result.patch').exists())
        with self.assertRaises(w.Failure) as error: self.run_worker()
        self.assertEqual(error.exception.code, 29)

    def test_runtime_filesystem_boundary(self):
        run = Path(self.tmp.name)/'run'; run.mkdir()
        home=run/'home'; home.mkdir()
        imports=self.repo/'data/imports'; imports.mkdir(parents=True)
        private=imports/'synthetic.txt'; private.write_text('synthetic-private-marker')
        w.git(self.repo,'add','data'); w.git(self.repo,'commit','-qm','private synthetic fixture')
        work=Path(self.tmp.name)/'isolated'; w.git(self.repo,'worktree','add','-qb','chore/view',str(work))
        command=w.runtime_command(work,self.repo/'.git',home,'workspace-write')
        outside = Path(self.tmp.name)/'host-only.txt'; outside.write_text('synthetic host-only marker')
        script = ('from pathlib import Path; import subprocess; '
                  f'assert not Path({str(outside)!r}).exists(); '
                  'assert list(Path("data/imports").iterdir()) == []; '
                  'assert not Path("data/imports/synthetic.txt").exists(); '
                  f'assert not Path({str(self.repo / ".git")!r}).exists(); '
                  'assert subprocess.run(["git","show","HEAD:data/imports/synthetic.txt"],capture_output=True).returncode != 0; '
                  'Path("sum.py").write_text("def add(a, b):\\n    return a + b\\n"); '
                  'subprocess.run(["python3","-B","test_sum.py"],check=True)')
        command=command[:command.index('--')+1]+['python3','-c',script]
        subprocess.run(command,check=True,capture_output=True)
        self.assertEqual(private.read_text(),'synthetic-private-marker')
        self.assertIn('a - b',(self.repo/'sum.py').read_text())
        self.assertIn('a + b',(work/'sum.py').read_text())
        self.assertEqual(w.git(work,'rev-parse','HEAD'),w.git(self.repo,'rev-parse','HEAD'))
    def test_timeout_terminates_owned_process(self):
        run=Path(self.tmp.name)/'run';run.mkdir()
        command=['python3','-c','import time; time.sleep(30)']
        original = w.OwnedRuntime.finish
        handlers = {s: w.signal.getsignal(s) for s in [w.signal.SIGINT, w.signal.SIGTERM]}
        def finish(runtime, reason):
            for s in handlers: self.assertEqual(w.signal.getsignal(s), w.signal.SIG_IGN)
            os.kill(os.getpid(), w.signal.SIGTERM)  # This owned test process ignores the repeated stop.
            return original(runtime, reason)
        with patch.object(w,'runtime_command',return_value=command), patch.object(w.OwnedRuntime, 'finish', finish):
            code,_=w.invoke(self.repo,self.repo/'.git',run,'fixture'*8000,0.1,self.worker_profile)
        self.assertEqual(code,23)
        self.assertFalse((run/'home').exists())
        self.assertEqual(handlers, {s: w.signal.getsignal(s) for s in handlers})
    def test_malformed_events_fail_closed(self):
        run=Path(self.tmp.name)/'run';run.mkdir()
        command=['python3','-c', 'import json; print("[]"); print(json.dumps({"type":"turn.completed"}))']
        with patch.object(w,'runtime_command',return_value=command):
            code,_=w.invoke(self.repo,self.repo/'.git',run,'fixture',2,self.worker_profile)
        self.assertEqual(code,26)
    def test_logs_exclude_model_and_shell_text(self):
        run=Path(self.tmp.name)/'run';run.mkdir()
        command=['python3','-c', 'import json,os; print(json.dumps({"type":"item.completed","item":{"type":"agent_message","text":os.environ["MODEL_API_KEY"]}})); print(json.dumps({"type":"turn.completed"}))']
        with patch.object(w,'runtime_command',return_value=command):
            code,_=w.invoke(self.repo,self.repo/'.git',run,'fixture',2,self.worker_profile)
        self.assertEqual(code,0)
        self.assertNotIn(os.environ['MODEL_API_KEY'],(run/'worker.log').read_text())
    def test_explicit_env_file_loads_only_worker_key(self):
        env_file=Path(self.tmp.name)/'local.env'
        env_file.write_text('MODEL_API_KEY="synthetic-worker-key"\nOTHER_SECRET=do-not-import\n')
        def smoke(profile):
            self.assertEqual(os.environ['MODEL_API_KEY'],'synthetic-worker-key')
            self.assertNotIn('OTHER_SECRET',os.environ)
        with patch.dict(os.environ,{},clear=True), patch.object(w,'smoke',side_effect=smoke), patch.object(w.sys,'argv',['worker.py','smoke','--worker-config',str(self.worker_profile['path']),'--env-file',str(env_file)]):
            self.assertEqual(w.main(),0)
    def test_installer_preserves_user_configuration(self):
        home=Path(self.tmp.name)/'home';home.mkdir()
        initial='model = "existing-lead"\nmodel_reasoning_effort = "medium"\n'
        (home/'config.toml').write_text(initial)
        (self.repo/'.gitignore').write_text('/.codex/delegations/\n')
        with patch.dict(os.environ,{'CODEX_HOME':str(home)}): w.install()
        self.assertEqual((home/'config.toml').read_text(),initial)
        self.assertEqual(list(home.iterdir()),[home/'config.toml'])
        self.assertTrue((self.repo/'.codex/delegations').is_dir())
    def test_worker_configuration_is_explicit_and_reported(self):
        self.assertEqual(self.worker_profile['provider'], 'fixture')
        self.assertEqual(self.worker_profile['model'], 'example/model')
        example = w.HERE / 'worker.config.toml.example'
        with self.assertRaises(w.Failure) as error: w.load_worker_config(example)
        self.assertEqual(error.exception.code, 5)

        invalid = Path(self.tmp.name) / 'invalid.toml'
        invalid.write_text(self.worker_profile['bytes'].decode().replace('https://api.example.invalid/v1', 'http://api.example.test/v1'))
        with self.assertRaises(w.Failure) as error: w.load_worker_config(invalid)
        self.assertEqual(error.exception.code, 5)

    def test_isolated_home_receives_only_selected_worker_configuration(self):
        run=Path(self.tmp.name)/'config-run';run.mkdir()
        def command(work, common, home, mode, sync_fd=None):
            self.assertEqual((home/'config.toml').read_bytes(), self.worker_profile['bytes'])
            self.assertFalse(any(path.name.endswith('.config.toml') for path in home.iterdir()))
            return ['python3','-c','import json,sys;sys.stdin.read();print(json.dumps({"type":"turn.completed"}))']
        with patch.object(w,'runtime_command',side_effect=command):
            code,_=w.invoke(self.repo,self.repo/'.git',run,'fixture',2,self.worker_profile)
        self.assertEqual(code,0)

if __name__ == '__main__': unittest.main()
