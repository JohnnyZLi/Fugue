from pathlib import Path

root = Path('work')

p = root / 'src/core/reconcile.ts'
s = p.read_text()
old = '''  if (current.terminal) {\n    if (current.terminal.state === "identity_lost") {\n      await releaseIntegrationAuthorityVariable(github, current);\n      await cleanupProtectedIntegrationRecovery(github, current.request.request_id);\n    }\n    return true;\n  }'''
new = '''  if (current.terminal) {\n    if (current.terminal.state === "identity_lost") {\n      await releaseIntegrationAuthorityVariable(github, current);\n      await cleanupProtectedIntegrationRecovery(github, current.request.request_id);\n      return true;\n    }\n    await cleanupProtectedIntegrationRecovery(github, current.request.request_id);\n    // A genuinely aborted no-fence transport remains the existing retryable case. The revised\n    // no-retry rule is specific to identity_lost and must not suppress fresh-request recovery here.\n    return current.terminal.state !== "aborted";\n  }'''
if s.count(old) != 1:
    raise SystemExit(f'expected terminal recovery block once, got {s.count(old)}')
p.write_text(s.replace(old, new, 1))

p = root / 'tests/state-authority-blockers.test.ts'
s = p.read_text()
test = r'''
  it("preserves hosted fresh-request recovery for a genuinely aborted no-fence transport", async () => {
    await withHostedAuthority(async () => {
      const github = makeGithub();
      const identity = {
        prNumber: 23, headSha: "3".repeat(40), baseBranch: "main", baseSha: BASE,
        policyDigest: "sha256:policy", protocolVersion: 1 as const, issueNumber: 18, workId: "work-18",
        workSpecDigest: "sha256:revised-spec",
      };
      const snapshot = { identity, pr: { number: 23 } } as unknown as EvaluationSnapshot;
      const request = createIntegrationRequest(identity, "2026-08-17T15:00:00.000Z", "3".repeat(16));
      const aborted = await publishIntegrationRecord(github, createIntegrationRecord(request, {
        terminal: { state: "aborted", detail: "provably no protected attempt-1 run was created", created_at: "2026-08-17T15:11:00.000Z" },
        createdAt: "2026-08-17T15:11:00.000Z",
      }));

      await expect(recoverExistingProtectedIntegration(
        github, snapshot, Date.parse("2026-08-17T15:12:00.000Z"),
      )).resolves.toBe(false);
      const next = await ensureIntegrationDispatch(github, snapshot, Date.parse("2026-08-17T15:12:00.000Z"));
      expect(next.dispatch).toBe(true);
      expect(next.request?.request_id).not.toBe(aborted.request.request_id);
      expect((await getCurrentIntegrationRecord(github, identity))?.request.request_id).toBe(next.request?.request_id);
    });
  });
'''
pos = s.rfind('\n});')
if pos < 0: raise SystemExit('final describe close not found')
s = s[:pos] + '\n' + test + s[pos:]
p.write_text(s)
print('aborted hosted recovery preservation fix applied')
