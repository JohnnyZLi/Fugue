from pathlib import Path

EXPECTED_HEAD = "a735d824b5b745e4dd30234d4fda6d6516dfbe94"

reconcile = Path("src/core/reconcile.ts")
text = reconcile.read_text()
old_cleanup = '''export async function cleanupTerminalProtectedIntegrationRecovery(
  github: FugueGitHub,
  snapshot: Awaited<ReturnType<typeof captureEvaluation>>,
): Promise<boolean> {
  const current = await getCurrentIntegrationRecord(github, snapshot.identity);
  if (!current || current.terminal?.state !== "identity_lost") return false;
  // Durable d3 terminal authority already exists. Every delete below is request-specific and idempotent;
  // a crash at any point can only leave redundant transient state for the next reconciliation to remove.
  await releaseIntegrationAuthorityVariable(github, current);
  await cleanupProtectedIntegrationRecovery(github, current.request.request_id);
  return true;
}'''
new_cleanup = '''export async function cleanupTerminalProtectedIntegrationRecovery(
  github: FugueGitHub,
  snapshot: Awaited<ReturnType<typeof captureEvaluation>>,
): Promise<boolean> {
  const current = await getCurrentIntegrationRecord(github, snapshot.identity);
  const durableCleanupAuthority = Boolean(current && (
    current.run || current.terminal?.state === "identity_lost"
  ));
  if (!current || !durableCleanupAuthority) return false;
  // Durable d3 run/terminal authority already exists. Every delete below is request-specific and idempotent;
  // a crash at any point can only leave redundant transient state for the next reconciliation to remove.
  // releaseIntegrationAuthorityVariable preserves F -> A -> B -> S -> C ordering with C last.
  await releaseIntegrationAuthorityVariable(github, current);
  await cleanupProtectedIntegrationRecovery(github, current.request.request_id);
  return true;
}'''
if old_cleanup not in text:
    raise SystemExit("cleanupTerminalProtectedIntegrationRecovery block not found")
text = text.replace(old_cleanup, new_cleanup, 1)

old_recovery = '''  if (current.terminal) {
    if (current.terminal.state === "identity_lost") {
      await releaseIntegrationAuthorityVariable(github, current);
      await cleanupProtectedIntegrationRecovery(github, current.request.request_id);
      return true;
    }
    await cleanupProtectedIntegrationRecovery(github, current.request.request_id);
    // A genuinely aborted no-fence transport remains the existing retryable case. The revised
    // no-retry rule is specific to identity_lost and must not suppress fresh-request recovery here.
    return current.terminal.state !== "aborted";
  }
  if (current.run) {
    await cleanupProtectedIntegrationRecovery(github, current.request.request_id);
    return true;
  }'''
new_recovery = '''  if (current.terminal) {
    if (current.terminal.state !== "aborted" || current.run) {
      // Durable terminal authority (known L or identity_lost) makes every request-local producer
      // transient. Resume the full F/A/B/S/C cleanup after any crash; C remains last.
      await releaseIntegrationAuthorityVariable(github, current);
      await cleanupProtectedIntegrationRecovery(github, current.request.request_id);
      return true;
    }
    // A genuinely aborted no-fence/no-attempt transport remains the sole retryable case.
    await cleanupProtectedIntegrationRecovery(github, current.request.request_id);
    return false;
  }
  if (current.run) {
    // Exact L is already durable in d3. Re-run the complete cleanup so delayed B/S publication
    // or a prior crash between deletion steps cannot strand A/B/C/F/S authority slots.
    await releaseIntegrationAuthorityVariable(github, current);
    await cleanupProtectedIntegrationRecovery(github, current.request.request_id);
    return true;
  }'''
if old_recovery not in text:
    raise SystemExit("recoverExistingProtectedIntegration terminal/run block not found")
reconcile.write_text(text.replace(old_recovery, new_recovery, 1))

tests = Path("tests/state-authority-blockers.test.ts")
t = tests.read_text()
old_import = 'import { authorizeIntegrationDispatch, bindDispatchedIntegrationRun, ensureIntegrationDispatch, getCurrentIntegrationRecord, getIntegrationRunStartEvidence, integrationDispatchRunToken, publishIntegrationRecord, sealIntegrationWorkflowRunEvent } from "../src/core/integration-status.js";'
new_import = 'import { authorizeIntegrationDispatch, bindDispatchedIntegrationRun, ensureIntegrationDispatch, getCurrentIntegrationRecord, getIntegrationRunStartEvidence, integrationCommitVariableName, integrationDispatchRunToken, integrationRunStartVariableName, publishIntegrationRecord, sealIntegrationWorkflowRunEvent } from "../src/core/integration-status.js";'
if old_import not in t:
    raise SystemExit("integration-status test import not found")
t = t.replace(old_import, new_import, 1)

addition = r'''

describe("durable known-run cleanup restart completeness", () => {
  async function seedBound(
    github: TestGithub,
    prNumber: number,
    nonce: string,
    runId: number,
  ): Promise<{ snapshot: EvaluationSnapshot; record: IntegrationRecord; names: string[] }> {
    const identity = {
      prNumber,
      headSha: prNumber.toString(16).padStart(40, "0"),
      baseBranch: "main",
      baseSha: BASE,
      policyDigest: "sha256:policy",
      protocolVersion: 1 as const,
      issueNumber: 5000 + prNumber,
      workId: `work-${5000 + prNumber}`,
      workSpecDigest: "sha256:revised-spec",
    };
    const snapshot = { identity, pr: { number: prNumber } } as unknown as EvaluationSnapshot;
    const request = createIntegrationRequest(identity, "2026-08-18T14:00:00.000Z", nonce);
    const secret = runId.toString(16).padStart(64, "0");
    const authorized = await authorizeIntegrationDispatch(github, request, "2026-08-18T14:00:00.000Z", secret);
    await publishIntegrationRecord(github, createIntegrationRecord(authorized.request, {
      dispatch: authorized.authorization,
      createdAt: "2026-08-18T14:00:00.000Z",
    }));
    github.__authorityVariables.delete(authorized.electionName);
    const htmlUrl = `https://github.com/JohnnyZLi/Fugue/actions/runs/${runId}`;
    const record = await bindDispatchedIntegrationRun(
      github, snapshot, request.request_id, runId, htmlUrl, "2026-08-18T14:00:02.000Z",
    );
    const recovery = protectedRecoveryNames(request.request_id);
    return {
      snapshot,
      record,
      names: [
        recovery.fence,
        record.dispatch!.anchor_name,
        recovery.binding,
        integrationRunStartVariableName(record.request),
        integrationCommitVariableName(record.request.request_id),
      ],
    };
  }

  function recreateTransientCut(github: TestGithub, names: string[], deletedPrefix: number): void {
    names.forEach((name, index) => github.__authorityVariables.set(name, `stale-${index}`));
    for (let index = 0; index < deletedPrefix; index += 1) github.__authorityVariables.delete(names[index]!);
  }

  it("resumes every F/A/B/S-before-C crash cut for a durable exact L without changing L", async () => {
    await withHostedAuthority(async () => {
      const github = makeGithub();
      const seeded = await seedBound(github, 301, "0000000000000301", 99301);
      for (const deletedPrefix of [1, 2, 3, 4]) {
        recreateTransientCut(github, seeded.names, deletedPrefix);
        await expect(cleanupTerminalProtectedIntegrationRecovery(github, seeded.snapshot)).resolves.toBe(true);
        expect(seeded.names.filter((name) => github.__authorityVariables.has(name))).toEqual([]);
        const durable = await getCurrentIntegrationRecord(github, seeded.snapshot.identity);
        expect(durable?.run?.id).toBe(99301);
        expect(durable?.terminal).toBeNull();
      }
    });
  });

  it("resumes every cleanup cut for terminal known-L failure and cancelled-as-error without retry", async () => {
    await withHostedAuthority(async () => {
      for (const [offset, state, detail] of [
        [0, "failure", "Protected attempt 1 failed."],
        [1, "error", "Protected attempt 1 completed cancelled; a known attempt is never retryable transport."],
      ] as const) {
        const github = makeGithub();
        const seeded = await seedBound(github, 310 + offset, `000000000000031${offset}`, 99410 + offset);
        const terminalAt = "2026-08-18T14:10:00.000Z";
        const terminal = await publishIntegrationRecord(github, {
          ...seeded.record,
          terminal: { state, detail, created_at: terminalAt },
          created_at: terminalAt,
        });
        for (const deletedPrefix of [1, 2, 3, 4]) {
          recreateTransientCut(github, seeded.names, deletedPrefix);
          github.__workflowRuns.splice(0);
          github.__comments.splice(0);
          github.__statuses.splice(0);
          await expect(cleanupTerminalProtectedIntegrationRecovery(github, seeded.snapshot)).resolves.toBe(true);
          expect(seeded.names.filter((name) => github.__authorityVariables.has(name))).toEqual([]);
          const durable = await getCurrentIntegrationRecord(github, seeded.snapshot.identity);
          expect(durable?.run?.id).toBe(terminal.run?.id);
          expect(durable?.terminal).toEqual(terminal.terminal);
          await expect(ensureIntegrationDispatch(github, seeded.snapshot, Date.parse("2026-08-18T15:00:00.000Z")))
            .resolves.toEqual({ request: terminal.request, dispatch: false });
        }
      }
    });
  });

  it("reclaims delayed S and B producers from durable binding alone after earlier cleanup completed", async () => {
    await withHostedAuthority(async () => {
      const github = makeGithub();
      const seeded = await seedBound(github, 320, "0000000000000320", 99520);
      github.__authorityVariables.set(seeded.names[3]!, "late-run-start");
      github.__authorityVariables.set(seeded.names[2]!, "late-binding-witness");
      github.__workflowRuns.splice(0);
      github.__comments.splice(0);
      github.__statuses.splice(0);
      await expect(recoverExistingProtectedIntegration(github, seeded.snapshot, Date.parse("2026-08-18T14:30:00.000Z")))
        .resolves.toBe(true);
      expect(seeded.names.filter((name) => github.__authorityVariables.has(name))).toEqual([]);
      expect((await getCurrentIntegrationRecord(github, seeded.snapshot.identity))?.run?.id).toBe(99520);
    });
  });

  it("does not exhaust Authority capacity across more than 64 interrupted known-run generations", async () => {
    await withHostedAuthority(async () => {
      const github = makeGithub();
      for (let index = 0; index < 65; index += 1) {
        const prNumber = 400 + index;
        const seeded = await seedBound(github, prNumber, index.toString(16).padStart(16, "0"), 99600 + index);
        recreateTransientCut(github, seeded.names, 3);
        await expect(cleanupTerminalProtectedIntegrationRecovery(github, seeded.snapshot)).resolves.toBe(true);
        expect(seeded.names.filter((name) => github.__authorityVariables.has(name))).toEqual([]);
      }
      const transient = [...github.__authorityVariables.keys()].filter((name) => /^FUGUE_INT_[ABCFS]_/.test(name));
      expect(transient).toEqual([]);
    });
  }, 30000);
});
'''
if 'describe("durable known-run cleanup restart completeness"' in t:
    raise SystemExit("known-run cleanup tests already present")
tests.write_text(t + addition)
