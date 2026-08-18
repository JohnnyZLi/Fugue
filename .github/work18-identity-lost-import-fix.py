from pathlib import Path
p = Path('work/src/core/reconcile.ts')
s = p.read_text()
old = '''  markIntegrationDispatchStarted,\n  reclaimOrphanIntegrationAuthorityVariables,\n  releaseIntegrationAuthorityVariable,\n  sealIntegrationWorkflowRunEvent,'''
new = '''  markIntegrationDispatchStarted,\n  publishIntegrationRecord,\n  reclaimOrphanIntegrationAuthorityVariables,\n  releaseIntegrationAuthorityVariable,\n  sealIntegrationWorkflowRunEvent,'''
if s.count(old) != 1:
    raise SystemExit(f'expected transformed import exactly once, got {s.count(old)}')
p.write_text(s.replace(old, new, 1))
print('identity_lost import fix applied')
