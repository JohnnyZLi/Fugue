from __future__ import annotations
import pathlib, re, subprocess, sys, tempfile

source = pathlib.Path(sys.argv[1]).read_text()
source, count = re.subn(
    r'\n    # If a reserve was recreated after a stale reserve->witness rename, remove the recreation and restore exact source\.\n    s=once\(s,.*?,\'robust reserve rollback\'\)\n',
    '\n', source, count=1, flags=re.S,
)
if count != 1:
    raise SystemExit(f'expected one robust rollback refinement block, found {count}')
old = """    s=once(s,
'''  ensureIntegrationDispatch,
  sealIntegrationWorkflowRunEvent,''',
'''  ensureIntegrationDispatch,
  bindDispatchedIntegrationRun,
  sealIntegrationWorkflowRunEvent,''','reconcile integration import')
"""
new = """    s=once(s,
'''import { ensureIntegrationDispatch, reclaimOrphanIntegrationAuthorityVariables, sealIntegrationWorkflowRunEvent } from \"./integration-status.js\";''',
'''import { bindDispatchedIntegrationRun, ensureIntegrationDispatch, reclaimOrphanIntegrationAuthorityVariables, sealIntegrationWorkflowRunEvent } from \"./integration-status.js\";''','reconcile integration import')
"""
if old not in source:
    raise SystemExit('expected reconcile import refinement source anchor')
source = source.replace(old, new, 1)
with tempfile.NamedTemporaryFile('w', suffix='.py', delete=False) as handle:
    handle.write(source)
    path = handle.name
subprocess.check_call([sys.executable, path, sys.argv[2]])
