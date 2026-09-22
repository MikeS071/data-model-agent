#!/usr/bin/env python3
"""Build integrity metadata from a reviewed explicit path allowlist, never a tree copy."""
from pathlib import Path
import hashlib,json,os,re
ROOT=Path(__file__).resolve().parents[1]
paths=json.loads((ROOT/'.governance/release-inputs.json').read_text())
assert len(paths)==len(set(paths)) and paths==sorted(paths)
files=[]
for name in paths:
 assert name.startswith(('.governance/','.agents/skills/','tools/')) and '..' not in name.split('/')
 p=ROOT/name
 assert p.resolve()==p and p.is_file() and p.stat().st_mode & 0o777 in (0o644,0o755)
 data=p.read_bytes()
 assert not re.search(rb'(?:(?:ghp_|github_pat_|sk-or-v1-)[A-Za-z0-9]{20,}|postgres(?:ql)?://[^\s]+@)',data),name
 assert not any(x in name.split('/') for x in ('.git','.codex','apps','packages','data','__pycache__'))
 files.append({'path':name,'sha256':hashlib.sha256(data).hexdigest(),'mode':p.stat().st_mode & 0o777})
manifest={'schemaVersion':1,'version':'0.1.0-candidate.2','supported':{'os':'linux','node':'24.14.0','python':'3.12.3','git':'2.43.0','workerCodex':'0.149.1'},'files':files}
raw=(json.dumps(manifest,indent=2)+'\n').encode();(ROOT/'.governance/release.json').write_bytes(raw)
print(json.dumps({'version':manifest['version'],'files':len(files),'manifestSha256':hashlib.sha256(raw).hexdigest()}))
