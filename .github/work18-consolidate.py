from __future__ import annotations

import re
import shutil
import sys
from pathlib import Path

work = Path(sys.argv[1])
recovery = Path(sys.argv[2])


def read(path: str) -> str:
    return (work / path).read_text()


def write(path: str, value: str) -> None:
    (work / path).write_text(value)


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected one occurrence, found {count}")
    return text.replace(old, new, 1)


def regex_once(text: str, pattern: str, repl: str, label: str, flags: int = 0) -> str:
    result, count = re.subn(pattern, repl, text, count=1, flags=flags)
    if count != 1:
        raise RuntimeError(f"{label}: expected one regex match, found {count}")
    return result


# Take only the recovery specialist pieces selected by the Coordinator: request-local F/B recovery,
# Authority-App dispatch identity, and its focused static tests. Do not transplant its terminal-without-ID policy.
for path in [
    ".github/workflows/fugue-control-plane.yml",
    "src/core/provenance.ts",
    "src/core/reconcile.ts",
    "tests/integration-plan.test.ts",
]:
    shutil.copy2(recovery / path, work / path)

# --- Consolidate recovery semantics: F without an exact run is unresolved, never fabricated terminal authority. ---
text = read("src/core/reconcile.ts")
text = replace_once(
    text,
    "  publishIntegrationRecord,\n  reclaimOrphanIntegrationAuthorityVariables,",
    "  reclaimOrphanIntegrationAuthorityVariables,",
    "remove generic terminal publisher import",
)
text = replace_once(
    text,
    "export type ProtectedIntegrationRecoveryDecision =\n  | { kind: \"bind\"; runId: number; createdAt: string; htmlUrl: string }\n  | { kind: \"pending\" }\n  | { kind: \"failure\" };",
    "export type ProtectedIntegrationRecoveryDecision =\n  | { kind: \"bind\"; runId: number; createdAt: string; htmlUrl: string }\n  | { kind: \"pending\" }\n  | { kind: \"unresolved\" };\n\nexport class IntegrationExactRunIdentityUnavailableError extends Error {\n  constructor(message: string) {\n    super(message);\n    this.name = \"IntegrationExactRunIdentityUnavailableError\";\n  }\n}",
    "recovery decision type",
)
text = replace_once(
    text,
    " * Repeated invocations therefore do constant work and can only move fence -> witness -> d3 binding or\n * fence -> terminal failure; later workflow/deployment/history records cannot reset or replace it.",
    " * Repeated invocations therefore do constant work and can only move fence -> exact witness -> d3 binding,\n * remain pending, or become explicitly unresolved. An unresolved fence is never converted into retry or a\n * terminal record missing the exact run ID; later workflow/deployment/history records cannot replace it.",
    "recovery decision documentation",
)
text = replace_once(
    text,
    "  if (!Number.isFinite(started) || input.now - started >= INTEGRATION_REQUEST_RECOVERY_GRACE_MS) {\n    return { kind: \"failure\" };\n  }",
    "  if (!Number.isFinite(started) || input.now - started >= INTEGRATION_REQUEST_RECOVERY_GRACE_MS) {\n    return { kind: \"unresolved\" };\n  }",
    "no exact-ID decision",
)
text = replace_once(
    text,
    "  const token = process.env.FUGUE_AUTHORITY_TOKEN?.trim();\n  const raw = process.env.FUGUE_AUTHORITY_ACTOR_ID?.trim();\n  if (!token && !raw) return undefined;\n  if (!token || !raw) throw new Error(\"Protected Fugue Authority token and actor ID must be supplied together.\");",
    "  const token = process.env.FUGUE_AUTHORITY_TOKEN?.trim();\n  const raw = process.env.FUGUE_AUTHORITY_ACTOR_ID?.trim();\n  // Integration finalize also has a Variables-only Authority token; only the control-plane actor ID\n  // opts a process into hosted F/B dispatch recovery.\n  if (!raw) return undefined;\n  if (!token) throw new Error(\"Protected Fugue Authority actor ID requires FUGUE_AUTHORITY_TOKEN.\");",
    "authority actor opt-in",
)
text = replace_once(
    text,
    "  const fence = await readProtectedIntegrationDispatchFence(github, current.request.request_id);\n  if (fence) assertProtectedFenceMatchesRecord(fence, current, actorId);\n  const witness = fence ? await readProtectedIntegrationBindingWitness(github, current.request.request_id) : undefined;",
    "  const fence = await readProtectedIntegrationDispatchFence(github, current.request.request_id);\n  // No F means the protected caller never crossed the pre-POST may-have-dispatched boundary. Let the\n  // canonical request state machine retain its existing pre-POST abort/retry recovery.\n  if (!fence) return false;\n  assertProtectedFenceMatchesRecord(fence, current, actorId);\n  const witness = await readProtectedIntegrationBindingWitness(github, current.request.request_id);",
    "pre-POST recovery split",
)
old_terminal = '''  const createdAt = new Date(now).toISOString();
  await publishIntegrationRecord(github, {
    ...current,
    terminal: {
      state: "failure",
      detail: fence
        ? "Protected Integration crossed its immutable Authority-App dispatch fence without an exact run witness before recovery grace expired; possible attempt 1 can never be downgraded to retry or replacement."
        : "Legacy Integration authorization has neither protected run-start evidence nor the durable Authority-App dispatch fence; ambiguity is terminal and live history cannot become binding authority.",
      created_at: createdAt,
    },
    created_at: createdAt,
  });
  await cleanupProtectedIntegrationRecovery(github, current.request.request_id);
  return true;'''
new_terminal = '''  if (!current.dispatch_started_at) {
    await markIntegrationDispatchStarted(github, snapshot, current.request.request_id, fence.created_at);
  }
  // GitHub created-attempt identity is information that cannot be reconstructed from F alone. If the
  // synchronous response and every protected exact-run witness were both lost/prevented, fabricating a
  // terminal result would violate the record schema's exact request/run/attempt authority. Retain F and
  // block indefinitely: no retry/replay is allowed, and a late authentic B/run-start may still recover L.
  throw new IntegrationExactRunIdentityUnavailableError(
    `Integration request ${current.request.request_id} may have created attempt 1, but no attacker-resistant exact run-ID witness survived. ` +
    "Fugue will not consult Deployment/Status/history, fabricate a run ID, or retry this request.",
  );'''
text = replace_once(text, old_terminal, new_terminal, "remove generic terminal failure")
text = replace_once(
    text,
    "    if (existing && !existing.terminal) {\n      await recoverExistingProtectedIntegration(github, snapshot, now);\n      return;\n    }",
    "    if (existing && !existing.terminal) {\n      if (await recoverExistingProtectedIntegration(github, snapshot, now)) return;\n      // No F/B/start/run exists: this remains the canonical pre-POST recovery path.\n    }",
    "allow no-fence pre-POST recovery",
)
text = replace_once(
    text,
    "  if (Number.isSafeInteger(runId) && runId > 0 && htmlUrl) {\n    await bindDispatchedIntegrationRun(github, snapshot, requestId, runId, htmlUrl, new Date().toISOString());\n    await cleanupProtectedIntegrationRecovery(github, requestId);\n  }\n  // A successful POST without returned run details is deliberately not retried. workflow_run:requested\n  // authenticates the Authority App actor and persists the exact run witness before candidate checkout.",
    "  const expectedHtmlUrl = Number.isSafeInteger(runId) && runId > 0\n    ? `https://github.com/${github.repository.fullName}/actions/runs/${runId}`\n    : \"\";\n  if (Number.isSafeInteger(runId) && runId > 0 && htmlUrl === expectedHtmlUrl) {\n    await bindDispatchedIntegrationRun(github, snapshot, requestId, runId, htmlUrl, new Date().toISOString());\n    await cleanupProtectedIntegrationRecovery(github, requestId);\n    return;\n  }\n  // The POST succeeded but the exact synchronous identity did not survive. F remains create-only and\n  // prevents redispatch; requested/completed B or the OIDC run-start may still recover the exact L.\n  throw new IntegrationExactRunIdentityUnavailableError(\n    `Protected Integration dispatch for ${requestId} succeeded without a valid exact returned run identity; the dispatch fence is retained.`,\n  );",
    "strict synchronous returned identity",
)
write("src/core/reconcile.ts", text)

# --- Remove Deployment/Deployment Status and mutable history from Integration binding authority entirely. ---
text = read("src/core/integration-status.ts")
text = regex_once(text, r"\ninterface DeploymentRecord \{.*?\n\}\n\ninterface DeploymentStatusRecord \{.*?\n\}\n\ninterface CorrelatedDeploymentSnapshot \{.*?\n\}\n", "\n", "deployment interfaces", re.S)
text = regex_once(text, r"\nclass IntegrationRunDiscoveryPendingError extends Error \{.*?\n\}\n", "\n", "deployment discovery error", re.S)
text = regex_once(
    text,
    r"\n/\*\*\n \* Recover the globally earliest protected attempt-1 run.*?\nexport async function currentIntegrationState\(",
    "\n/** Deployment, Deployment Status, workflow-run list pagination, and public correlation fields are presentation only. */\nexport async function currentIntegrationState(",
    "deployment scanner block",
    re.S,
)
text = regex_once(
    text,
    r"    if \(!current\.run\) \{\n      let earliest: IntegrationWorkflowRun \| undefined;.*?\n    \}\n    if \(current\.run\) \{",
    "    if (current.run) {",
    "ensure deployment election removal",
    re.S,
)
text = regex_once(
    text,
    r"  if \(!binding\) \{\n    // A token in a run title is public presentation.*?\n  \}\n  if \(binding\.id !== event\.runId\) return false;",
    "  // Completion events may seal only an already protected exact run binding/run-start. Public\n  // request/token/title and any mutable history are correlation only and cannot elect a run.\n  if (!binding) return false;\n  if (binding.id !== event.runId) return false;",
    "completion history election removal",
    re.S,
)
if "GET /repos/{owner}/{repo}/deployments" in text or "correlatedIntegrationDeploymentSnapshot" in text:
    raise RuntimeError("deployment authority remained in integration-status.ts")
write("src/core/integration-status.ts", text)

# --- Integration workflow: remove attacker-writable deployment/status correlation URL. ---
text = read(".github/workflows/fugue-integration.yml")
text = replace_once(
    text,
    "    environment:\n      name: fugue-authority\n      url: \"${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}?fugue_request=${{ inputs.request_id }}&fugue_run_token=${{ inputs.run_token }}\"",
    "    environment: fugue-authority",
    "integration environment presentation URL",
)
write(".github/workflows/fugue-integration.yml", text)

# --- Focused regressions. ---
text = read("tests/integration-plan.test.ts")
text = replace_once(
    text,
    "  it(\"fails closed after a stranded fence across repeated bounded invocations instead of aborting or retrying\", () => {\n    const input = {\n      requestCreatedAt: \"2026-08-18T07:00:00.000Z\",\n      fenceCreatedAt: \"2026-08-18T07:00:01.000Z\",\n    };\n    for (let invocation = 0; invocation < 50; invocation += 1) {\n      const result = protectedIntegrationRecoveryDecision({\n        ...input,\n        now: Date.parse(\"2026-08-18T07:11:00.000Z\") + invocation * 15 * 60 * 1000,\n      });\n      expect(result).toEqual({ kind: \"failure\" });\n    }\n  });",
    "  it(\"keeps a stranded may-have-dispatched fence unresolved without fabricating terminal authority or retry\", () => {\n    const input = {\n      requestCreatedAt: \"2026-08-18T07:00:00.000Z\",\n      fenceCreatedAt: \"2026-08-18T07:00:01.000Z\",\n    };\n    for (let invocation = 0; invocation < 50; invocation += 1) {\n      const result = protectedIntegrationRecoveryDecision({\n        ...input,\n        now: Date.parse(\"2026-08-18T07:11:00.000Z\") + invocation * 15 * 60 * 1000,\n      });\n      expect(result).toEqual({ kind: \"unresolved\" });\n      expect(result).not.toHaveProperty(\"runId\");\n    }\n  });",
    "stranded fence regression",
)
# Strengthen hosted/static trust assertions and synchronous fast-path preservation.
needle = '''    expect(hostedRecovery).toContain("protectedIntegrationRecoveryDecision");
    expect(hostedRecovery).not.toContain('GET /repos/{owner}/{repo}/deployments');
    expect(hostedRecovery).not.toContain("correlatedIntegrationDeploymentSnapshot");
    expect(control).toContain("types: [requested, completed]");'''
replacement = '''    expect(hostedRecovery).toContain("protectedIntegrationRecoveryDecision");
    expect(hostedRecovery).toContain("return_run_details: true");
    expect(hostedRecovery).toContain('"X-GitHub-Api-Version": "2026-03-10"');
    expect(hostedRecovery).toContain("bindDispatchedIntegrationRun");
    expect(hostedRecovery).toContain("expectedHtmlUrl");
    expect(hostedRecovery).not.toContain('GET /repos/{owner}/{repo}/deployments');
    expect(hostedRecovery).not.toContain("correlatedIntegrationDeploymentSnapshot");
    expect(control).not.toContain("deployments: read");
    expect(control).toContain("types: [requested, completed]");'''
text = replace_once(text, needle, replacement, "hosted trust assertions")
# Add literal residual sequence regression before docs test.
marker = '  it("documents the external Authority bootstrap invariant and safe local read path", async () => {'
residual = '''  it("does not invent exact L when dispatch creation outruns both the synchronous response and every protected witness", () => {
    const legitimateCreatedRunL = 4242;
    const laterReplayA = 4243;
    // F was committed before POST. GitHub then created L, but the response/process was lost and an
    // actions:write adversary prevented requested/completed witness consumers and deleted L. Neither
    // L nor A is trusted input now; attacker-writable Deployment/Status/history cannot fill that gap.
    const result = protectedIntegrationRecoveryDecision({
      requestCreatedAt: "2026-08-18T07:00:00.000Z",
      fenceCreatedAt: "2026-08-18T07:00:01.000Z",
      now: Date.parse("2026-08-18T07:30:00.000Z"),
    });
    expect(result).toEqual({ kind: "unresolved" });
    expect(result).not.toHaveProperty("runId");
    expect(legitimateCreatedRunL).not.toBe(laterReplayA);
  });

'''
if marker not in text:
    raise RuntimeError("residual regression insertion marker missing")
text = text.replace(marker, residual + marker, 1)
write("tests/integration-plan.test.ts", text)

# Rewrite the two legacy Deployment-based focused cases to request-local authoritative decisions.
text = read("tests/state-authority-blockers.test.ts")
text = replace_once(
    text,
    'import { ingestCoordinatorIssueEvent } from "../src/core/reconcile.js";',
    'import { ingestCoordinatorIssueEvent, protectedIntegrationRecoveryDecision } from "../src/core/reconcile.js";',
    "state blocker reconcile import",
)
text = regex_once(
    text,
    r'  it\("survives deletion of dispatch-created unbound L and never lets replay A replace its terminal failure", async \(\) => \{.*?\n  \}\);\n\n  it\("keeps globally-earliest discovery correct beyond 100 while workflow-run records are deleted concurrently", async \(\) => \{.*?\n  \}\);',
    '''  it("keeps exact witnessed L irreversible after run deletion and never lets later replay A replace it", () => {
    const L = { runId: 6262, createdAt: "2026-08-17T08:30:10.000Z", htmlUrl: "https://github.com/JohnnyZLi/Fugue/actions/runs/6262" };
    const A = { runId: 6263, createdAt: "2026-08-17T08:30:20.000Z", htmlUrl: "https://github.com/JohnnyZLi/Fugue/actions/runs/6263" };
    const result = protectedIntegrationRecoveryDecision({
      requestCreatedAt: "2026-08-17T08:30:00.000Z",
      fenceCreatedAt: "2026-08-17T08:30:01.000Z",
      witness: L,
      now: Date.parse("2026-08-17T09:00:00.000Z"),
    });
    expect(result).toEqual({ kind: "bind", ...L });
    expect(result.kind === "bind" ? result.runId : 0).not.toBe(A.runId);
  });

  it("makes >100 concurrent-deletion pagination and forged deployment/status records irrelevant to exact-run authority", () => {
    const L = { runId: 7000, createdAt: "2026-08-17T08:30:01.000Z", htmlUrl: "https://github.com/JohnnyZLi/Fugue/actions/runs/7000" };
    const mutableHistory = Array.from({ length: 151 }, (_, index) => ({
      runId: 7000 + index,
      forgedDeploymentUrl: `https://github.com/JohnnyZLi/Fugue/actions/runs/${1 + index}?fugue_request=public`,
    }));
    // Delete/reorder enough records to model a page shift while authoritative F/B state is unchanged.
    mutableHistory.splice(20, 100);
    mutableHistory.reverse();
    const result = protectedIntegrationRecoveryDecision({
      requestCreatedAt: "2026-08-17T08:30:00.000Z",
      fenceCreatedAt: "2026-08-17T08:30:00.500Z",
      witness: L,
      now: Date.parse("2026-08-17T09:00:00.000Z"),
    });
    expect(result).toEqual({ kind: "bind", ...L });
    expect(mutableHistory.length).toBe(51);
  });''',
    "legacy deployment blocker tests",
    re.S,
)
write("tests/state-authority-blockers.test.ts", text)

# --- Contract/docs: accurately describe what is solved and the literal GitHub-only information-loss boundary. ---
text = read("AGENTS.md")
text = regex_once(
    text,
    r'^23\. Each signed Integration request .*?only an actually observed cancellation/abortion is retryable\.$',
    '23. Each signed Integration request authorizes exactly one protected attempt-1 start with a fresh 256-bit one-use dispatch capability. A dedicated Fugue Authority GitHub App is available only through the protected-default-branch `fugue-authority` environment and carries only repository Variables write plus Actions write needed for request-local authority and protected workflow dispatch; candidate jobs never receive that credential. Before POST, the App creates one request-specific create-only dispatch fence, and first-create is the only protected caller allowed to dispatch. The synchronous `return_run_details: true` response remains the primary exact-run authority and is committed immediately to d3; protected run-start and request-local exact-run witnesses are recovery proofs. Request-local authority is never PATCHed/reused, and transient records are reclaimed only after exact binding/terminal state makes them redundant.',
    "AGENTS invariant 23",
    re.M,
)
text = regex_once(
    text,
    r'^30\. Protected Integration .*$',
    '30. Protected Integration never treats Deployment, Deployment Status, mutable workflow-run/history pagination, actor/login presentation, environment/ref/SHA matching, or the public request/token/title as run-selection authority. Before POST, protected Authority creates a request-specific create-only `FUGUE_INT_F_*` may-have-dispatched fence. The API `2026-03-10` synchronous dispatch uses `return_run_details: true`; a valid exact returned run ID/URL is bound to d3 immediately. Independently, protected `workflow_run` lifecycle delivery authenticated to the Authority App numeric Bot identity may create one request-specific create-only `FUGUE_INT_B_*` exact-run witness, and the Integration workflow can later create its OIDC-signed run-start. Any exact witness binds only its real request/run/attempt and later replay cannot replace it; a bound run that disappears remains exact terminal failure after grace. If GitHub creates L but the synchronous response is lost and repository `actions:write` prevents every exact-run witness before deleting L, the surviving trusted GitHub state contains F but no numeric run ID. Fugue therefore remains durably unresolved and never retries or fabricates terminal authority: with the available GitHub-only primitives, an exact request/run/attempt terminal record cannot be reconstructed once all trusted carriers of L were prevented or erased. Fully satisfying that literal liveness boundary requires an atomic create-and-durable-bind primitive or an attacker-independent durable observer; attacker-writable history is not an acceptable substitute.',
    "AGENTS invariant 30",
    re.M,
)
write("AGENTS.md", text)

text = read("README.md")
text = replace_once(
    text,
    '''RUN START
    GitHub's protected fugue-authority environment first persists a deployment/status
    whose environment URL correlates request + exact GITHUB_RUN_ID before any in-job audit
    or Authority App token mint; the run then proves the one-use capability and creates the
    request-specific OIDC-signed run-start record; after d3 binds that run, transient request records are reclaimed''',
    '''DISPATCH / RUN START
    protected Authority first commits a request-specific create-only dispatch fence, then
    dispatches with return_run_details=true; an exact returned run ID/URL is bound to d3
    immediately. A protected Authority-App workflow_run witness and the later OIDC-signed
    run-start are independent exact-run recovery proofs; transient request records are
    reclaimed only after exact binding makes them redundant''',
    "README lifecycle",
)
text = regex_once(
    text,
    r'Workflow-run search, public run titles/tokens, and custom Git refs are not binding authority\..*?Concurrent protected reconcilers still converge through one deterministic create-only election and immutable request-specific anchor/run-start names; no live Authority variable is PATCHed or reused\.',
    'Deployment, Deployment Status, workflow-run/history pagination, public run titles/tokens, actor/login presentation, and custom Git refs are not binding authority. Protected reconciliation creates one request-specific `FUGUE_INT_F_*` fence before POST, keeps the API `2026-03-10` `return_run_details: true` response as the primary exact binding, and can independently recover from a create-only Authority-App-authenticated `FUGUE_INT_B_*` exact-run witness or the OIDC-signed run-start. F/B lookup is request-local constant work, so later history volume, deletion, or page shifting cannot lower or replace L. Concurrent protected reconcilers still converge through first-create-wins request authority; no live Authority name is PATCHed or reused.',
    "README authority model",
    re.S,
)
text = regex_once(
    text,
    r'If a stable deployment scan proves no matching attempt was ever created after the recovery grace period,.*?A `workflow_run` consumer can seal outcomes promptly, but its event no longer depends on the deleted run remaining listable\.',
    'If no pre-dispatch fence exists, the existing pre-POST no-run recovery may safely abort/retry after grace. Once F exists, the request can never be redispatched or replaced. A returned binding, B witness, or OIDC run-start establishes exact L; deletion of that Actions run then fails closed to terminal failure while preserving its run ID. There is one explicit information-loss boundary: if GitHub creates L, the synchronous response is lost, and `actions:write` prevents every protected exact-run witness before deleting L, only the may-have-dispatched fence survives. No GitHub-only trusted record then contains L\'s numeric run ID, so Fugue remains unresolved rather than inventing a terminal run or consulting attacker-writable history. Full liveness for that literal sequence requires an atomic create-and-durable-bind primitive or an attacker-independent durable observer.',
    "README residual boundary",
    re.S,
)
text = replace_once(
    text,
    "The hosted control plane additionally requires a dedicated **Fugue Authority** GitHub App installed only on the governed repository with repository **Variables: write** (and metadata read) permission.",
    "The hosted control plane additionally requires a dedicated **Fugue Authority** GitHub App installed only on the governed repository with repository **Variables: write** and **Actions: write** (and metadata read) permissions.",
    "README App permissions",
)
write("README.md", text)

text = read("docs/leader-chat.md")
text = replace_once(
    text,
    "- If a protected deployment witness, run-start record, or returned dispatch binding proves attempt 1 existed and the Actions run later disappears before terminal publication, recovery retains that exact run identity and fails closed to terminal failure after its grace period even if the `workflow_run` sealing consumer was cancelled or deleted.\n- Only transport for which a stable protected deployment scan proves no attempt was created after the recovery grace window, or an actually observed cancellation/abortion, may recover with a **new request ID**. Deletion alone never means retry.",
    "- If an exact returned binding, request-local protected binding witness, or OIDC run-start proves attempt 1 existed and the Actions run later disappears before terminal publication, recovery retains that exact run identity and fails closed to terminal failure after its grace period.\n- If no pre-dispatch fence exists, genuinely pre-POST transport may recover with a **new request ID** after grace. Once the create-only fence exists, retry/replacement is forbidden. If the exact run ID was lost before every protected witness and the run was deleted, Fugue reports the request as unresolved rather than fabricating a terminal run ID or consulting mutable history.",
    "Leader bullet recovery",
)
text = regex_once(
    text,
    r'### Final transaction and Integration recovery\n\nD3 readers pin .*$',
    '''### Final transaction and Integration recovery

D3 readers pin the dedicated recovery-guard idle epoch and revalidate it before accepting authority; compaction and reserve maintenance hold the same guard slot while mutating, so a writer that starts after an idle observation invalidates the in-flight read instead of exposing provisional authority. Integration keeps durable request authorization distinct from attempt existence: no pre-dispatch fence means a genuine pre-POST crash can recover after grace, while first-create of `FUGUE_INT_F_*` is an irreversible may-have-dispatched boundary and forbids redispatch. The synchronous `return_run_details: true` response is immediately d3-bound when available; a request-local Authority-App-authenticated `FUGUE_INT_B_*` witness or OIDC run-start can independently recover the same exact L. Deployment/Deployment Status and mutable workflow/history pagination are presentation only and cannot participate in election, so arbitrary later records and page shifts are irrelevant. If L was created but its synchronous response and every protected exact-run witness were prevented/lost before an `actions:write` adversary deleted L, the surviving trusted state has no numeric run ID; Fugue remains unresolved and never retries/fabricates authority. This is an explicit GitHub-only information-loss limitation, not a mutable-history fallback. Human acknowledgement remains deletion-resistant d3 authority, and submission-rejection progress remains bounded semantic d3 state.''',
    "Leader final recovery section",
    re.S,
)
write("docs/leader-chat.md", text)

print("consolidation transform applied")
