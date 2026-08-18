from __future__ import annotations
import pathlib, re, sys

root = pathlib.Path(sys.argv[1])

def rw(path, fn):
    p=root/path; s=p.read_text(); n=fn(s); p.write_text(n)

def once(s, old, new, label):
    c=s.count(old)
    if c != 1: raise SystemExit(f'{label}: {c} matches')
    return s.replace(old,new,1)

# Guard recovery must not depend on a repository metadata mock, and no-reserve hard-cap
# paths retain the prior slot-preserving fallback while the dedicated reserve is available
# to fence normal final witness publication.
def fix_state(s: str) -> str:
    s=once(s,
'''  const current = await readRepositoryDefaultBranchIdentity(github);
  const age = Date.now() - Date.parse(guard.created_at);
  if (current.sha.toLowerCase() === guard.publisher_sha.toLowerCase() &&
      Number.isFinite(age) && age < RECOVERY_MUTATION_GUARD_GRACE_MS) {
    return true;
  }
  await rollbackGuardedRecoveryMutation(github, name, value, guard);''',
'''  let publisherStillCurrent = true;
  try { await assertRepositoryDefaultBranchRevision(github, guard.publisher_sha); }
  catch { publisherStillCurrent = false; }
  const age = Date.now() - Date.parse(guard.created_at);
  if (publisherStillCurrent && Number.isFinite(age) && age < RECOVERY_MUTATION_GUARD_GRACE_MS) return true;
  await rollbackGuardedRecoveryMutation(github, name, value, guard);''','guard metadata read')
    s=once(s,
'''  const guard = await acquireRecoveryMutationGuard(github, expectedPublisherSha, name, value);
  if (!guard) return false;
  try {
    await assertRepositoryDefaultBranchRevision(github, expectedPublisherSha);''',
'''  const guard = await acquireRecoveryMutationGuard(github, expectedPublisherSha, name, value);
  try {
    await assertRepositoryDefaultBranchRevision(github, expectedPublisherSha);''','guard create fallback')
    s=once(s,
'''  } finally {
    await releaseRecoveryMutationGuard(github, guard);
  }
}''',
'''  } finally {
    if (guard) await releaseRecoveryMutationGuard(github, guard);
  }
}''','guard create release')
    s=once(s,
'''  const guard = expectedPublisherSha
    ? await acquireRecoveryMutationGuard(github, expectedPublisherSha, targetName, targetValue, sourceName, expectedSourceValue)
    : undefined;
  if (expectedPublisherSha && !guard) return false;
  if (expectedPublisherSha) await assertRepositoryDefaultBranchRevision(github, expectedPublisherSha);''',
'''  const guard = expectedPublisherSha
    ? await acquireRecoveryMutationGuard(github, expectedPublisherSha, targetName, targetValue, sourceName, expectedSourceValue)
    : undefined;
  if (expectedPublisherSha) await assertRepositoryDefaultBranchRevision(github, expectedPublisherSha);''','guard replace fallback')
    # If a reserve was recreated after a stale reserve->witness rename, remove the recreation and restore exact source.
    s=once(s,
'''  if (sourceValue === undefined && targetValue === expectedTargetValue) {
    if (await replaceFugueAuthorityVariable(github, targetName, expectedTargetValue, sourceName, expectedSourceValue)) return;
    sourceValue = await getFugueAuthorityVariable(github, sourceName);
    targetValue = await getFugueAuthorityVariable(github, targetName);
  }
  if (sourceValue === expectedSourceValue && targetValue === expectedTargetValue) {
    // Another protected writer recreated the source after our provisional rename. The target is still
    // the exact provisional body, so remove only that stale duplicate and leave the recreated source.
    await deleteAuthorityVariableIfExact(github, targetName, expectedTargetValue);
    return;
  }''',
'''  if (sourceValue === undefined && targetValue === expectedTargetValue) {
    if (await replaceFugueAuthorityVariable(github, targetName, expectedTargetValue, sourceName, expectedSourceValue)) return;
    sourceValue = await getFugueAuthorityVariable(github, sourceName);
    targetValue = await getFugueAuthorityVariable(github, targetName);
  }
  if (sourceValue === expectedSourceValue && targetValue === expectedTargetValue) {
    if (sourceName.startsWith(RECOVERY_RESERVE_PREFIX) && expectedSourceValue === RECOVERY_RESERVE_VALUE) {
      await deleteAuthorityVariableIfExact(github, sourceName, expectedSourceValue);
      if (await replaceFugueAuthorityVariable(github, targetName, expectedTargetValue, sourceName, expectedSourceValue)) return;
    }
    // For a non-reserve source, preserve the exact concurrent recreation and remove only the stale duplicate target.
    await deleteAuthorityVariableIfExact(github, targetName, expectedTargetValue);
    return;
  }''','robust reserve rollback')
    return s
rw('src/core/state.ts',fix_state)

# Review recovery checks durable roles first and only scans comments for roles that need migration.
def fix_reviews(s: str) -> str:
    start=s.index('export async function currentReviewActivities(')
    end=s.index('\nexport async function currentQaAttestations(', start)
    replacement='''export async function currentReviewActivities(
  github: FugueGitHub,
  snapshot: EvaluationSnapshot,
): Promise<Map<QaRole, ReviewActivity>> {
  const activities = new Map<QaRole, ReviewActivity>();
  const unresolved: QaRole[] = [];
  for (const role of QA_ROLES) {
    const durable = await recoverReviewAuthority(github, snapshot, role);
    if (durable?.kind === "qa") {
      activities.set(role, resolveReviewActivity([], [durable]));
    } else if (durable?.kind === "review_start") {
      activities.set(role, resolveReviewActivity([durable], []));
    } else {
      unresolved.push(role);
    }
  }
  if (!unresolved.length) return activities;

  const { owner, repo } = github.repository;
  const comments = await github.octokit.paginate(github.octokit.rest.issues.listComments, {
    owner, repo, issue_number: snapshot.pr.number, per_page: 100,
  });
  const sessions = new Map<QaRole, ReviewStart[]>();
  const attestations = new Map<QaRole, QaAttestation[]>();
  for (const role of unresolved) { sessions.set(role, []); attestations.set(role, []); }
  for (const comment of comments) {
    if (!(await isTrustedProtocolComment(github, comment))) continue;
    let value: ReturnType<typeof parseAttestation>;
    try { value = parseAttestation(comment.body ?? ""); } catch { continue; }
    if (!value || !sameEvaluationIdentity(value.identity, snapshot.identity) || !unresolved.includes(value.role)) continue;
    if (value.kind === "review_start") sessions.get(value.role)?.push(value);
    if (value.kind === "qa") attestations.get(value.role)?.push(value);
  }
  for (const role of unresolved) {
    const migrated = resolveReviewActivity(sessions.get(role) ?? [], attestations.get(role) ?? []);
    const canonical = migrated.completed ?? migrated.active;
    if (canonical) await publishReviewAuthority(github, snapshot, canonical);
    activities.set(role, migrated);
  }
  return activities;
}'''
    return s[:start]+replacement+s[end:]
rw('src/core/reviews.ts',fix_reviews)

# Replace the provisional run-list fallback with exact protected dispatch-response binding.
def fix_integration_status(s: str) -> str:
    # Restore event sealing to require already durable binding or App run-start proof.
    pat=re.compile(r'''  const evidence = record\.run \? undefined : await getIntegrationRunStartEvidence\(github, record\);\n  let binding = record\.run \?\? \(evidence \? integrationRunBindingFromEvidence\(github, evidence\) : undefined\);\n  if \(!binding\) \{.*?\n  \}\n  if \(binding\.id !== event\.runId\) return false;''', re.S)
    repl='''  const evidence = record.run ? undefined : await getIntegrationRunStartEvidence(github, record);
  const binding = record.run ?? (evidence ? integrationRunBindingFromEvidence(github, evidence) : undefined);
  if (!binding || binding.id !== event.runId) return false;'''
    s,n=pat.subn(repl,s,count=1)
    if n!=1: raise SystemExit(f'integration seal restore: {n}')
    # Remove helper added by first patch.
    s,n=re.subn(r'''\nasync function isEarliestCausallyValidIntegrationRun\(.*?\n\}\n''','\n',s,count=1,flags=re.S)
    if n!=1: raise SystemExit(f'integration list helper remove: {n}')
    # Do not delete the dispatch anchor merely because the protected control plane has bound the run;
    # the workflow still needs it to mint run-start. Terminal or bindIntegrationRun releases it.
    s=once(s,
'''  if (current && sameIntegrationRecord(current, record)) {
    if (current.run || current.terminal) await releaseIntegrationAuthorityVariable(github, current);
    return current;
  }''',
'''  if (current && sameIntegrationRecord(current, record)) {
    if (current.terminal) await releaseIntegrationAuthorityVariable(github, current);
    return current;
  }''','integration idempotent release')
    s=once(s,
'''  if (normalized.run || normalized.terminal) await releaseIntegrationAuthorityVariable(github, normalized);
  return normalized;''',
'''  if (normalized.terminal) await releaseIntegrationAuthorityVariable(github, normalized);
  return normalized;''','integration publish release')
    # Existing run-start based binder releases after durable d3 bind.
    s=once(s,
'''  return publishIntegrationRecord(github, {
    ...current,
    run: integrationRunBindingFromEvidence(github, evidence),
    created_at: new Date().toISOString(),
  });
}

export async function getBoundIntegrationWorkflowRun''',
'''  const bound = await publishIntegrationRecord(github, {
    ...current,
    run: integrationRunBindingFromEvidence(github, evidence),
    created_at: new Date().toISOString(),
  });
  await releaseIntegrationAuthorityVariable(github, bound);
  return bound;
}

export async function bindDispatchedIntegrationRun(
  github: FugueGitHub,
  snapshot: EvaluationSnapshot,
  requestId: string,
  runId: number,
  htmlUrl: string,
  createdAt = new Date().toISOString(),
): Promise<IntegrationRecord> {
  if (!Number.isInteger(runId) || runId <= 0 || !htmlUrl) throw new Error("Protected Integration dispatch did not return a valid run identity.");
  const current = await getCurrentIntegrationRecord(github, snapshot.identity);
  if (!current || current.request.request_id !== requestId || current.terminal || !current.dispatch) {
    throw new Error(`Integration run ${runId} does not match an active authorized durable request ${requestId}.`);
  }
  if (current.run) {
    if (current.run.id !== runId) throw new Error(`Integration request ${requestId} is already bound to protected run ${current.run.id}.`);
    return current;
  }
  return publishIntegrationRecord(github, {
    ...current,
    run: { id: runId, attempt: 1, created_at: createdAt, html_url: htmlUrl },
    created_at: createdAt,
  });
}

export async function getBoundIntegrationWorkflowRun''','integration dispatch binder')
    return s
rw('src/core/integration-status.ts',fix_integration_status)

# Dispatch with the modern REST endpoint that returns exact workflow_run_id, then bind it durably.
def fix_reconcile(s: str) -> str:
    s=once(s,
'''  ensureIntegrationDispatch,
  sealIntegrationWorkflowRunEvent,''',
'''  ensureIntegrationDispatch,
  bindDispatchedIntegrationRun,
  sealIntegrationWorkflowRunEvent,''','reconcile integration import')
    old='''  await github.octokit.rest.actions.createWorkflowDispatch({
    owner,
    repo,
    workflow_id: "fugue-integration.yml",
    ref: policy.identity.baseBranch,
    inputs: { pr: prNumber, request_id: next.request.request_id, dispatch_secret: next.dispatchSecret, authority_anchor: next.authorityAnchor },
  });'''
    new='''  const dispatched = await github.octokit.request("POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches", {
    owner,
    repo,
    workflow_id: "fugue-integration.yml",
    ref: policy.identity.baseBranch,
    inputs: { pr: prNumber, request_id: next.request.request_id, dispatch_secret: next.dispatchSecret, authority_anchor: next.authorityAnchor },
    headers: { "X-GitHub-Api-Version": "2026-03-10" },
  });
  const data = dispatched.data as unknown as { workflow_run_id?: unknown; html_url?: unknown; run_url?: unknown };
  const runId = typeof data.workflow_run_id === "number" ? data.workflow_run_id : Number.NaN;
  const htmlUrl = typeof data.html_url === "string" ? data.html_url : typeof data.run_url === "string" ? data.run_url : "";
  if (!Number.isInteger(runId) || runId <= 0 || !htmlUrl) {
    throw new Error(`Protected Integration dispatch for request ${next.request.request_id} did not return its exact run identity.`);
  }
  await bindDispatchedIntegrationRun(github, snapshot, next.request.request_id, runId, htmlUrl, new Date().toISOString());'''
    return once(s,old,new,'dispatch bind')
rw('src/core/reconcile.ts',fix_reconcile)

# Focused test harness: add paginate, replace Integration test with direct dispatch binding.
def fix_tests(s: str) -> str:
    # Ensure paginate exists on mock root.
    marker='''    octokit: {
      rest: {'''
    if marker not in s: raise SystemExit('focused octokit marker missing')
    s=s.replace(marker,'''    octokit: {
      paginate: vi.fn(async (method: (args: Record<string, unknown>) => Promise<{ data: unknown }>, args: Record<string, unknown>) => (await method(args)).data),
      rest: {''',1)
    # Update import.
    s=s.replace('authorizeIntegrationDispatch, getCurrentIntegrationRecord, publishIntegrationRecord, sealIntegrationWorkflowRunEvent',
                'authorizeIntegrationDispatch, bindDispatchedIntegrationRun, getCurrentIntegrationRecord, publishIntegrationRecord, sealIntegrationWorkflowRunEvent')
    # Replace final focused Integration test body.
    start=s.index('  it("seals a genuine protected attempt-1 failure even when it completes before custom run-start evidence"')
    end=s.index('\n  });',start)+len('\n  });')
    new='''  it("seals a genuine protected attempt-1 failure even when it completes before custom run-start evidence", async () => {
    const github = makeGithub();
    const identity = {
      prNumber: 19, headSha: "a".repeat(40), baseBranch: "main", baseSha: BASE,
      policyDigest: "sha256:policy", protocolVersion: 1 as const, issueNumber: 18, workId: "work-18",
      workSpecDigest: "sha256:spec",
    };
    const snapshot = { identity, pr: { number: 19 } } as unknown as EvaluationSnapshot;
    const request = createIntegrationRequest(identity, "2026-08-17T08:30:00.000Z", "1".repeat(16));
    const authorized = await authorizeIntegrationDispatch(github, request, "2026-08-17T08:30:00.000Z", undefined);
    await publishIntegrationRecord(github, createIntegrationRecord(authorized.request, {
      dispatch: authorized.authorization, createdAt: "2026-08-17T08:30:00.000Z",
    }));
    await bindDispatchedIntegrationRun(
      github, snapshot, authorized.request.request_id, 4242,
      "https://github.com/JohnnyZLi/Fugue/actions/runs/4242", "2026-08-17T08:30:30.000Z",
    );
    expect(await getIntegrationRunStartEvidence(github, (await getCurrentIntegrationRecord(github, identity))!)).toBeUndefined();
    await expect(sealIntegrationWorkflowRunEvent(github, {
      eventName: "workflow_run", workflowName: "Fugue Integration", runId: 4242, runAttempt: 1,
      conclusion: "failure", status: "completed", headSha: BASE,
      displayTitle: `Fugue Integration PR #19 ${authorized.request.request_id}`,
      createdAt: "2026-08-17T08:31:00.000Z", htmlUrl: "https://github.com/JohnnyZLi/Fugue/actions/runs/4242",
      actor: "github-actions[bot]",
    })).resolves.toBe(true);
    const terminal = await getCurrentIntegrationRecord(github, identity);
    expect(terminal?.run?.id).toBe(4242);
    expect(terminal?.terminal?.state).toBe("failure");
  });'''
    s=s[:start]+new+s[end:]
    return s
rw('tests/state-authority-blockers.test.ts',fix_tests)

print('refined generated patch')
