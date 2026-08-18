from __future__ import annotations
import pathlib, re, subprocess, sys, tempfile

source = pathlib.Path(sys.argv[1]).read_text()
# The global mutation guard makes concurrent reserve recreation defer while a revision-bound
# replacement is provisional. Keep the existing rollback primitive unchanged rather than layering
# a second source-recreation heuristic on top of it.
source, count = re.subn(
    r'\n    # If a reserve was recreated after a stale reserve->witness rename, remove the recreation and restore exact source\.\n    s=once\(s,.*?,\'robust reserve rollback\'\)\n',
    '\n',
    source,
    count=1,
    flags=re.S,
)
if count != 1:
    raise SystemExit(f'expected one robust rollback refinement block, found {count}')
# reconcile.ts uses a compact one-line integration-status import on this head.
old = '''    s=once(s,\n''' + "'''  ensureIntegrationDispatch,\\n  sealIntegrationWorkflowRunEvent,''',\n'''  ensureIntegrationDispatch,\\n  bindDispatchedIntegrationRun,\\n  sealIntegrationWorkflowRunEvent,''','reconcile integration import')"
new = '''    s=once(s,\n''' + "'''import { ensureIntegrationDispatch, reclaimOrphanIntegrationAuthorityVariables, sealIntegrationWorkflowRunEvent } from \\\"./integration-status.js\\\";''',\n'''import { bindDispatchedIntegrationRun, ensureIntegrationDispatch, reclaimOrphanIntegrationAuthorityVariables, sealIntegrationWorkflowRunEvent } from \\\"./integration-status.js\\\";''','reconcile integration import')"
if old not in source:
    raise SystemExit('expected reconcile import refinement source anchor')
source = source.replace(old, new, 1)
with tempfile.NamedTemporaryFile('w', suffix='.py', delete=False) as handle:
    handle.write(source)
    path = handle.name
subprocess.check_call([sys.executable, path, sys.argv[2]])
