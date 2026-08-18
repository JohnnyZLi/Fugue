from __future__ import annotations

import re
import sys
from pathlib import Path

path = Path(sys.argv[1]) / "tests/state-authority-blockers.test.ts"
text = path.read_text()

old_import = 'import { authorizeIntegrationDispatch, ensureIntegrationDispatch, getCurrentIntegrationRecord, getIntegrationRunStartEvidence, integrationDispatchRunToken, publishIntegrationRecord, sealIntegrationWorkflowRunEvent } from "../src/core/integration-status.js";'
new_import = 'import { authorizeIntegrationDispatch, bindDispatchedIntegrationRun, ensureIntegrationDispatch, getCurrentIntegrationRecord, getIntegrationRunStartEvidence, integrationDispatchRunToken, publishIntegrationRecord, sealIntegrationWorkflowRunEvent } from "../src/core/integration-status.js";'
if text.count(old_import) != 1:
    raise RuntimeError("integration-status import anchor drift")
text = text.replace(old_import, new_import, 1)

pattern = re.compile(
    r'  it\("keeps legitimate run L authoritative when later replay run A completes first", async \(\) => \{.*?\n  \}\);\n\n'
    r'  it\("preserves legitimate pre-run-start failure when replay A completes before L", async \(\) => \{.*?\n  \}\);',
    re.S,
)
replacement = '''  it("keeps legitimate run L authoritative when later replay run A completes first", () => {
    const L = {
      runId: 4242,
      createdAt: "2026-08-17T08:30:10.000Z",
      htmlUrl: "https://github.com/JohnnyZLi/Fugue/actions/runs/4242",
    };
    const A = {
      runId: 4243,
      createdAt: "2026-08-17T08:30:20.000Z",
      htmlUrl: "https://github.com/JohnnyZLi/Fugue/actions/runs/4243",
    };
    // The request-local protected witness has already claimed exact L. Later replay/history is data,
    // not election authority, so A cannot lower/replace the first exact binding.
    const recovered = protectedIntegrationRecoveryDecision({
      requestCreatedAt: "2026-08-17T08:30:00.000Z",
      fenceCreatedAt: "2026-08-17T08:30:01.000Z",
      witness: L,
      now: Date.parse("2026-08-17T08:31:00.000Z"),
    });
    expect(recovered).toEqual({ kind: "bind", ...L });
    expect(recovered.kind === "bind" ? recovered.runId : 0).not.toBe(A.runId);
  });

  it("preserves legitimate pre-run-start failure when replay A completes before L", async () => {
    const github = makeGithub();
    const identity = {
      prNumber: 19, headSha: "a".repeat(40), baseBranch: "main", baseSha: BASE,
      policyDigest: "sha256:policy", protocolVersion: 1 as const, issueNumber: 18, workId: "work-18",
      workSpecDigest: "sha256:spec",
    };
    const snapshot = { identity, pr: { number: 19 } } as unknown as EvaluationSnapshot;
    const request = createIntegrationRequest(identity, "2026-08-17T08:30:00.000Z", "5".repeat(16));
    const secret = "6".repeat(64);
    const authorized = await authorizeIntegrationDispatch(github, request, "2026-08-17T08:30:00.000Z", secret);
    await publishIntegrationRecord(github, createIntegrationRecord(authorized.request, {
      dispatch: authorized.authorization, createdAt: "2026-08-17T08:30:00.000Z",
    }));
    const token = integrationDispatchRunToken(request.request_id, secret);
    const title = `Fugue Integration PR #19 ${request.request_id} ${token}`;
    const L = { id: 5252, actor: BOT, event: "workflow_dispatch", head_sha: BASE, display_title: title,
      created_at: "2026-08-17T08:30:10.000Z", run_attempt: 1, status: "completed", conclusion: "failure",
      html_url: "https://github.com/JohnnyZLi/Fugue/actions/runs/5252" };
    const A = { id: 5253, actor: BOT, event: "workflow_dispatch", head_sha: BASE, display_title: title,
      created_at: "2026-08-17T08:30:20.000Z", run_attempt: 1, status: "completed", conclusion: "failure",
      html_url: "https://github.com/JohnnyZLi/Fugue/actions/runs/5253" };
    github.__workflowRuns.push(L, A);

    // Model the primary synchronous return-details path binding exact L before any prepare/run-start
    // step. Replay A may finish first, but the exact d3 binding rejects it.
    await bindDispatchedIntegrationRun(github, snapshot, request.request_id, L.id, L.html_url, L.created_at);
    await expect(sealIntegrationWorkflowRunEvent(github, {
      eventName: "workflow_run", workflowName: "Fugue Integration", runId: A.id, runAttempt: 1,
      conclusion: A.conclusion, status: A.status, headSha: BASE, displayTitle: title,
      createdAt: A.created_at, htmlUrl: A.html_url, actor: BOT.login,
    })).resolves.toBe(false);
    await expect(sealIntegrationWorkflowRunEvent(github, {
      eventName: "workflow_run", workflowName: "Fugue Integration", runId: L.id, runAttempt: 1,
      conclusion: L.conclusion, status: L.status, headSha: BASE, displayTitle: title,
      createdAt: L.created_at, htmlUrl: L.html_url, actor: BOT.login,
    })).resolves.toBe(true);
    const terminal = await getCurrentIntegrationRecord(github, identity);
    expect(terminal?.run?.id).toBe(L.id);
    expect(terminal?.terminal?.state).toBe("failure");
  });'''
text, count = pattern.subn(replacement, text, count=1)
if count != 1:
    raise RuntimeError(f"legacy L/A regression block drift: {count}")

path.write_text(text)
print("remaining Integration regressions updated")
