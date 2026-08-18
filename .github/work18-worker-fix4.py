from __future__ import annotations
import pathlib, sys
root=pathlib.Path(sys.argv[1])

def once(s,old,new,label):
    if s.count(old)!=1: raise SystemExit(f'{label}: {s.count(old)} matches')
    return s.replace(old,new,1)

p=root/'src/core/state.ts'; s=p.read_text()
s=once(s,
'''  if (injected) {
    if (injected.get(targetName) === targetValue) return true;
    if (injected.has(targetName) || injected.get(sourceName) !== expectedSourceValue) return false;
    injected.delete(sourceName);
    injected.set(targetName, targetValue);
    replaced = true;
  } else {
    const target = await getFugueAuthorityVariable(github, targetName);
    if (target !== undefined) return target === targetValue;
    if (await getFugueAuthorityVariable(github, sourceName) !== expectedSourceValue) return false;
    const response = await authorityRequest(github, `/actions/variables/${encodeURIComponent(sourceName)}`, {
      method: "PATCH",
      body: JSON.stringify({ name: targetName, value: targetValue }),
    });
    if (!response.ok && response.status !== 404 && response.status !== 409 && response.status !== 422) {
      throw new CanonicalWorkStateIntegrityError(
        `Unable to atomically replace protected Fugue authority variable ${sourceName} (${response.status}).`,
      );
    }
    replaced = await getFugueAuthorityVariable(github, targetName) === targetValue;
  }''',
'''  if (injected) {
    if (injected.get(targetName) === targetValue) {
      replaced = true;
    } else if (injected.has(targetName) || injected.get(sourceName) !== expectedSourceValue) {
      replaced = false;
    } else {
      injected.delete(sourceName);
      injected.set(targetName, targetValue);
      replaced = true;
    }
  } else {
    const target = await getFugueAuthorityVariable(github, targetName);
    if (target !== undefined) {
      replaced = target === targetValue;
    } else if (await getFugueAuthorityVariable(github, sourceName) !== expectedSourceValue) {
      replaced = false;
    } else {
      const response = await authorityRequest(github, `/actions/variables/${encodeURIComponent(sourceName)}`, {
        method: "PATCH",
        body: JSON.stringify({ name: targetName, value: targetValue }),
      });
      if (!response.ok && response.status !== 404 && response.status !== 409 && response.status !== 422) {
        throw new CanonicalWorkStateIntegrityError(
          `Unable to atomically replace protected Fugue authority variable ${sourceName} (${response.status}).`,
        );
      }
      replaced = await getFugueAuthorityVariable(github, targetName) === targetValue;
    }
  }''','guard early return release')
p.write_text(s)

p=root/'tests/state-authority-blockers.test.ts'; s=p.read_text()
s=once(s,
'''authorizeIntegrationDispatch, bindDispatchedIntegrationRun, getCurrentIntegrationRecord, publishIntegrationRecord, sealIntegrationWorkflowRunEvent''',
'''authorizeIntegrationDispatch, bindDispatchedIntegrationRun, getCurrentIntegrationRecord, getIntegrationRunStartEvidence, publishIntegrationRecord, sealIntegrationWorkflowRunEvent''',
'focused Integration import')
s=once(s,
'''  if (body.includes("<!-- fugue-durable-recovery")) return body.includes("token: test-proof");
  const key = body.match(/Fugue-Authority-Key: ([0-9a-f]{32})/i)?.[1];''',
'''  if (body.includes("<!-- fugue-durable-recovery") || body.includes("INTEGRATION DISPATCH — AUTHORIZED") ||
      body.includes("INTEGRATION RUN — STARTED")) return body.includes("token: test-proof");
  const key = body.match(/Fugue-Authority-Key: ([0-9a-f]{32})/i)?.[1];''','focused integration verifier')
p.write_text(s)
print('fixed guard lifecycle and Integration verifier/import')
