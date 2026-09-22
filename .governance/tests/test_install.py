import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('lifecycle', ROOT/'.governance/install.py')
i = importlib.util.module_from_spec(spec); spec.loader.exec_module(i)

class LifecycleTests(unittest.TestCase):
    def setUp(self):
        scratch = ROOT/'.governance/.proof'; scratch.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix='install-', dir=scratch)
        self.home = Path(self.temp.name)
        self.target = self.home/'project'; self.target.mkdir()
        subprocess.run(['git','init','-q','--initial-branch=chore/1-example', str(self.target)],check=True)
        self.sha = hashlib.sha256((ROOT/'.governance/release.json').read_bytes()).hexdigest()
        self.adapter = ROOT/'.governance/examples/adapter.json'
    def tearDown(self): self.temp.cleanup()
    def cli(self, *args, ok=True):
        result = subprocess.run(['python3',str(ROOT/'.governance/install.py'),*args,'--target',str(self.target)], capture_output=True,text=True)
        self.assertEqual(result.returncode,0 if ok else 2,result.stdout+result.stderr)
        return json.loads(result.stdout)
    def inputs(self, source=None, sha=None):
        args=['--adapter',str(self.adapter)]
        if source is not None: args.extend(['--release',str(source)])
        if sha is not None: args.extend(['--digest',sha])
        return args
    def install(self, source=None, sha=None):
        self.cli('plan',*self.inputs(source,sha))
        return self.cli('apply')
    def upgraded(self):
        package=self.home/'next'; package.mkdir()
        manifest=json.loads((ROOT/'.governance/release.json').read_text())
        for row in manifest['files']:
            dest=package/row['path'];dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(ROOT/row['path'],dest)
        p=package/'.governance/policy.md';p.write_text(p.read_text()+'\nReviewed release revision.\n')
        manifest['version']='0.1.0-candidate.3'
        for row in manifest['files']:row['sha256']=hashlib.sha256((package/row['path']).read_bytes()).hexdigest()
        raw=(json.dumps(manifest,indent=2)+'\n').encode();(package/'.governance/release.json').write_bytes(raw)
        return package
    def test_empty_and_existing_lifecycle(self):
        help_text=subprocess.run(['python3',str(ROOT/'.governance/install.py'),'--help'],capture_output=True,text=True,check=True).stdout
        for internal_option in ['--digest','--release','--plan']:
            self.assertNotIn(internal_option,help_text)
        for existing in [False,True]:
            with self.subTest(existing=existing):
                policy=b'# Existing stronger policy\nNo production operations.\n' if existing else b''
                if existing:(self.target/'AGENTS.md').write_bytes(policy)
                plan=self.cli('plan',*self.inputs())
                self.assertEqual(set(plan),{'schemaVersion','operation','state','target','releaseVersion','changes','next'})
                self.assertNotIn('digest',json.dumps(plan).lower())
                self.assertTrue(i.pending_plan(self.target).is_file())
                self.assertEqual((self.target/'AGENTS.md').read_bytes() if existing else b'',policy)
                self.assertEqual(self.cli('apply')['state'],'applied')
                self.assertEqual(self.cli('verify')['state'],'installed-files-verified')
                self.assertEqual(self.install()['state'],'no-op')
                invocation=subprocess.run([str(self.target/'tools/governance'),'config','validate','--config','.governance/config.json'],cwd=self.target,capture_output=True,text=True)
                self.assertEqual(invocation.returncode,0,invocation.stderr)
                self.assertEqual([json.loads(invocation.stdout)['result'][x] for x in ['state','configured','effective']],['paused',2,0])
                if not existing:
                    for test_file in ['actions.test.mjs','review.test.mjs']:
                        sample=subprocess.run(['node',str(self.target/'.governance/tests'/test_file)],cwd=self.target,capture_output=True,text=True)
                        self.assertEqual(sample.returncode,0,sample.stdout+sample.stderr)
                # Added local policy outside the owned block survives every lifecycle action.
                with (self.target/'AGENTS.md').open('ab') as f:f.write(b'\nAdditional user rule.\n')
                (self.target/'notes.txt').write_text('user-owned')
                package=self.upgraded();self.assertEqual(self.install(package)['state'],'applied')
                self.assertEqual(self.cli('verify')['version'],'0.1.0-candidate.3')
                self.assertEqual(self.cli('rollback')['version'],'0.1.0-candidate.2')
                self.cli('verify')
                self.cli('remove');self.cli('apply')
                self.assertEqual((self.target/'AGENTS.md').read_bytes(),policy+b'\nAdditional user rule.\n')
                self.assertEqual((self.target/'notes.txt').read_text(),'user-owned')
                self.assertFalse((self.target/'tools/governance').exists())
                self.assertTrue((self.target/'.git').is_dir())
                self.assertEqual(self.cli('rollback')['version'],'0.1.0-candidate.2')
                self.cli('verify')
                self.assertTrue((self.target/'AGENTS.md').read_bytes().startswith(policy))
                self.assertTrue((self.target/'AGENTS.md').read_bytes().endswith(b'\nAdditional user rule.\n'))
                shutil.rmtree(self.target);self.target.mkdir();subprocess.run(['git','init','-q',str(self.target)],check=True)
                shutil.rmtree(self.home/'next')
    def test_integrity_adapter_collision_and_symlink_refuse_without_writes(self):
        self.assertEqual(self.cli('plan',*self.inputs(sha='0'*64),ok=False)['error'],'release-digest-mismatch')
        copy=self.home/'adapter.json';shutil.copy2(self.adapter,copy);old=self.adapter;self.adapter=copy
        self.cli('plan',*self.inputs());copy.write_text(copy.read_text()+'\n')
        self.assertEqual(self.cli('apply',ok=False)['error'],'adapter-digest-mismatch');self.adapter=old
        package=self.upgraded();self.cli('plan',*self.inputs(package))
        policy=package/'.governance/policy.md';policy.write_text(policy.read_text()+'changed after review\n')
        self.assertEqual(self.cli('apply',ok=False)['error'],'release-file-mismatch:.governance/policy.md')
        bad=self.home/'bad.json';bad.write_text('{"private":"SYNTHETIC-DO-NOT-PRINT"}')
        self.adapter=bad
        self.assertEqual(self.cli('plan',*self.inputs(),ok=False)['error'],'adapter-invalid');self.adapter=old
        (self.target/'.governance').symlink_to(ROOT/'.governance',target_is_directory=True)
        self.assertIn('symlink-conflict',self.cli('plan',*self.inputs(),ok=False)['error']);(self.target/'.governance').unlink()
        (self.target/'tools').mkdir();(self.target/'tools/governance').write_text('user tool')
        self.assertEqual(self.cli('plan',*self.inputs(),ok=False)['error'],'unowned-conflict:tools/governance')
        self.assertFalse((self.target/'AGENTS.md').exists())
    def test_changed_owned_file_and_duplicate_skill_are_preserved(self):
        self.install();p=self.target/'.governance/policy.md';p.write_text(p.read_text()+'local change')
        self.assertEqual(self.cli('plan',*self.inputs(),ok=False)['error'],'locally-modified:.governance/policy.md')
        self.assertTrue(p.read_text().endswith('local change'))
        p.write_bytes((ROOT/'.governance/policy.md').read_bytes())
        duplicate=self.target/'.agents/skills/unrelated/SKILL.md';duplicate.parent.mkdir(parents=True);duplicate.write_text('---\nname: dev-stack-delivery\n---\n')
        self.assertIn('duplicate-skill',self.cli('plan',*self.inputs(),ok=False)['error'])
    def test_partial_apply_recovers_and_stale_plan_cannot_overwrite(self):
        package,manifest,files,observed=i.release(ROOT,self.sha)
        configured,adapter,adapter_digest=i.settings(package,self.adapter);files.update(configured)
        plan,tx=i.prepare(self.target,files,manifest['version'],observed)
        i.save_plan(self.target,i.plan_record(self.target,'install',plan,package,observed,adapter,adapter_digest))
        with self.assertRaisesRegex(i.Refusal,'injected-interruption'):i.mutate(self.target,tx,fail_after=1)
        self.assertTrue(i.control(self.target,'transaction.json').exists())
        self.assertIn('interrupted-install',self.cli('plan',*self.inputs(),ok=False)['error'])
        self.assertEqual(self.cli('recover')['state'],'recovered');self.cli('verify')
        self.assertFalse(i.control(self.target,'transaction.json').exists())
        self.assertFalse(i.pending_plan(self.target).exists())
        self.assertEqual(self.cli('apply',ok=False)['error'],'no-reviewed-plan; run plan first')

if __name__=='__main__':unittest.main()
