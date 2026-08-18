from __future__ import annotations
import pathlib, sys
root = pathlib.Path(sys.argv[1])

def once(text, old, new, label):
    n=text.count(old)
    if n!=1: raise SystemExit(f'{label}: expected 1 match, found {n}')
    return text.replace(old,new,1)

# d3: safely bootstrap the dedicated guard at a legacy/full namespace and retry transient epoch invalidation internally for publishers.
p=root/'src/core/state.ts'; s=p.read_text()
old='''  const initial = `${RECOVERY_MUTATION_GUARD_IDLE_VALUE}:${randomBytes(16).toString("hex")}`;
  if (!(await createFugueAuthorityVariable(github, RECOVERY_MUTATION_GUARD_IDLE, initial))) {
    current = await getFugueAuthorityVariable(github, RECOVERY_MUTATION_GUARD_IDLE);
    if (current !== undefined && !isRecoveryMutationGuardIdleValue(current)) {
      throw new CanonicalWorkStateIntegrityError("Protected recovery mutation guard idle slot has conflicting state.");
    }
    return current;
  }'''
new='''  const initial = `${RECOVERY_MUTATION_GUARD_IDLE_VALUE}:${randomBytes(16).toString("hex")}`;
  if (!(await createFugueAuthorityVariable(github, RECOVERY_MUTATION_GUARD_IDLE, initial))) {
    current = await getFugueAuthorityVariable(github, RECOVERY_MUTATION_GUARD_IDLE);
    if (current !== undefined) {
      if (!isRecoveryMutationGuardIdleValue(current)) {
        throw new CanonicalWorkStateIntegrityError("Protected recovery mutation guard idle slot has conflicting state.");
      }
      return current;
    }

    // A legacy namespace may already be at GitHub's 500-variable cap before the dedicated guard
    // slot existed. Bootstrap only from non-authoritative capacity: first an optional Fugue reserve,
    // otherwise one exact duplicate recovery leaf whose signed body still has another identical
    // source. Never consume an unrelated variable or a sole/greatest witness to create the guard.
    const reserves = (await listFugueAuthorityVariables(github, RECOVERY_RESERVE_PREFIX))
      .filter((entry) => entry.value === RECOVERY_RESERVE_VALUE)
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const reserve of reserves) {
      if (await replaceFugueAuthorityVariable(github, reserve.name, reserve.value, RECOVERY_MUTATION_GUARD_IDLE, initial)) {
        return initial;
      }
      current = await getFugueAuthorityVariable(github, RECOVERY_MUTATION_GUARD_IDLE);
      if (current && isRecoveryMutationGuardIdleValue(current)) return current;
    }

    const leaves = (await listFugueAuthorityVariables(github, RECOVERY_AUTHORITY_PREFIX))
      .filter((entry) => /^FUGUE_D3_[0-9A-F]{16}_[0-9A-F]{16}$/i.test(entry.name));
    const byValue = new Map<string, FugueAuthorityVariable[]>();
    for (const leaf of leaves) {
      const group = byValue.get(leaf.value) ?? [];
      group.push(leaf);
      byValue.set(leaf.value, group);
    }
    for (const group of [...byValue.values()].filter((items) => items.length > 1)) {
      group.sort((left, right) => left.name.localeCompare(right.name));
      const donor = group.at(-1)!;
      const survivor = group[0]!;
      if (await getFugueAuthorityVariable(github, survivor.name) !== survivor.value) continue;
      if (await replaceFugueAuthorityVariable(github, donor.name, donor.value, RECOVERY_MUTATION_GUARD_IDLE, initial)) {
        return initial;
      }
      current = await getFugueAuthorityVariable(github, RECOVERY_MUTATION_GUARD_IDLE);
      if (current && isRecoveryMutationGuardIdleValue(current)) return current;
    }
    return undefined;
  }'''
s=once(s,old,new,'guard bootstrap')

needle='''async function findRecoveryCursor(
  github: FugueGitHub,
  options: RecoveryIdentityOptions,
): Promise<{ variableName: string; cursor: RecoveryCursor } | undefined> {'''
# helper is placed before find function and calls it by function declaration hoisting.
helper='''async function findRecoveryCursorForPublisher(
  github: FugueGitHub,
  options: RecoveryIdentityOptions,
): Promise<{ variableName: string; cursor: RecoveryCursor } | undefined> {
  let lastPending: DurableProtocolRecoveryPendingError | undefined;
  for (let attempt = 0; attempt < RECOVERY_COMPACTION_RETRY_LIMIT; attempt += 1) {
    try { return await findRecoveryCursor(github, options); }
    catch (error) {
      if (!(error instanceof DurableProtocolRecoveryPendingError)) throw error;
      lastPending = error;
      await Promise.resolve();
    }
  }
  throw lastPending ?? new DurableProtocolRecoveryPendingError("Protected recovery authority remained busy during publication.");
}

'''+needle
s=once(s,needle,helper,'publisher reader retry helper')
# Internal publication sites: two in publishDurableProtocolRecord and three in writeRecoveryCursor.
# Keep external recoverDurableProtocolRecord on strict single-epoch semantics.
# Target context-specific snippets to avoid replacing the external reader.
s=once(s,'const previous = await findRecoveryCursor(github, recoveryIdentityOptions);','const previous = await findRecoveryCursorForPublisher(github, recoveryIdentityOptions);','publisher previous')
s=once(s,'const durable = await findRecoveryCursor(github, recoveryIdentityOptions);','const durable = await findRecoveryCursorForPublisher(github, recoveryIdentityOptions);','publisher durable')
s=once(s,'const current = await findRecoveryCursor(github, options);','const current = await findRecoveryCursorForPublisher(github, options);','write current')
s=once(s,'const latest = await findRecoveryCursor(github, options);','const latest = await findRecoveryCursorForPublisher(github, options);','write latest')
# Last occurrence in writeRecoveryCursor can be distinguished by error text after it.
s=once(s,'const durable = await findRecoveryCursor(github, options);\n  if (!durable || compareRecoveryProgress(durable.cursor, cursor) < 0) {','const durable = await findRecoveryCursorForPublisher(github, options);\n  if (!durable || compareRecoveryProgress(durable.cursor, cursor) < 0) {','write durable')
p.write_text(s)

# Integration: preserve the previously closed no-workflow-run-search boundary. The durable dispatch transition
# plus secret-authenticated workflow_run completion event recovers exact run identity; absent exact evidence remains pending, never retryable.
p=root/'src/core/integration-status.ts'; s=p.read_text()
start=s.index('async function recoverDispatchedIntegrationRun(')
end=s.index('\nexport async function ensureIntegrationDispatch(',start)
s=s[:start]+s[end+1:]
old='''    if (!current.run) {
      const recoveredRun = await recoverDispatchedIntegrationRun(github, current);
      if (recoveredRun) {
        current = await publishIntegrationRecord(github, {
          ...current,
          run: recoveredRun,
          created_at: new Date(now).toISOString(),
        });
      }
    }
    if (current.run) {'''
s=once(s,old,'    if (current.run) {','remove run search recovery call')
old='''      if (current.dispatch_started_at) {
        await publishIntegrationRecord(github, {
          ...current,
          terminal: {
            state: "failure",
            detail: "Protected Integration crossed its durable dispatch-creation boundary but exact attempt-1 binding is unavailable; ambiguity can never become retry.",
            created_at: new Date(now).toISOString(),
          },
          created_at: new Date(now).toISOString(),
        });
        return { request: current.request, dispatch: false };
      }'''
new='''      if (current.dispatch_started_at) {
        // Crossing the durable dispatch-creation boundary is irreversible. Without exact run-start,
        // returned-run binding, or the authenticated completion event we cannot prove whether GitHub
        // created the attempt, so remain pending forever rather than silently converting possible
        // attempt-1 failure into abort/retry. The workflow_run event can still seal the exact run ID.
        return { request: current.request, dispatch: false };
      }'''
s=once(s,old,new,'post-dispatch pending')
# currentIntegrationState final no-binding classification.
old='''  const created = Date.parse(request.created_at);
  if (!Number.isFinite(created)) return { state: "error", request };
  return now - created >= INTEGRATION_REQUEST_RECOVERY_GRACE_MS
    ? { state: "none", request }
    : { state: "pending", request };'''
new='''  if (record.dispatch_started_at) return { state: "pending", request };
  const created = Date.parse(request.created_at);
  if (!Number.isFinite(created)) return { state: "error", request };
  return now - created >= INTEGRATION_REQUEST_RECOVERY_GRACE_MS
    ? { state: "none", request }
    : { state: "pending", request };'''
s=once(s,old,new,'current state post-dispatch pending')
# Direct completion-event binding: verify secret-derived token from protected anchor, without listing runs.
old='''  if (!binding && match[3] && record.dispatch) {
    const recovered = await recoverDispatchedIntegrationRun(github, record);
    if (recovered && recovered.id !== event.runId) return false;
    if (recovered) {
      binding = recovered;
    } else {
      const anchorBody = await getFugueAuthorityVariable(github, record.dispatch.anchor_name);
      const anchor = anchorBody ? await verifyIntegrationDispatchAnchor(github, record, anchorBody) : undefined;
      if (!anchor || integrationDispatchRunToken(record.request.request_id, anchor.dispatch_secret) !== match[3]) return false;
      const eventCreated = Date.parse(event.createdAt);
      const minimumCreated = Math.max(Date.parse(record.request.created_at), Date.parse(record.dispatch_started_at ?? record.dispatch.authorized_at));
      if (!Number.isFinite(eventCreated) || !Number.isFinite(minimumCreated) || eventCreated < minimumCreated) return false;
      binding = { id: event.runId, attempt: 1, created_at: event.createdAt, html_url: event.htmlUrl };
    }
  }'''
new='''  if (!binding && match[3] && record.dispatch && record.dispatch_started_at) {
    const anchorBody = await getFugueAuthorityVariable(github, record.dispatch.anchor_name);
    const anchor = anchorBody ? await verifyIntegrationDispatchAnchor(github, record, anchorBody) : undefined;
    if (!anchor || integrationDispatchRunToken(record.request.request_id, anchor.dispatch_secret) !== match[3]) return false;
    const eventCreated = Date.parse(event.createdAt);
    const minimumCreated = Math.max(Date.parse(record.request.created_at), Date.parse(record.dispatch_started_at));
    if (!Number.isFinite(eventCreated) || !Number.isFinite(minimumCreated) || eventCreated < minimumCreated) return false;
    binding = { id: event.runId, attempt: 1, created_at: event.createdAt, html_url: event.htmlUrl };
  }'''
s=once(s,old,new,'direct event binding')
p.write_text(s)

# Docs: remove the implication that workflow-run listing is recovery authority.
for rel in ['AGENTS.md','README.md','docs/leader-chat.md']:
    p=root/rel; s=p.read_text()
    s=s.replace('The exact earliest matching run can be rebound after a control-plane crash, and its immutable completion event can seal the exact request/run before custom run-start publication when failure occurs during environment/App-token setup; ambiguity after the durable dispatch boundary fails terminal rather than becoming retry.',
                'The authenticated immutable `workflow_run` completion event can bind and seal the exact request/run after a control-plane crash before custom run-start publication; no workflow-run search becomes binding authority, and an unresolved request that crossed the durable dispatch boundary remains fail-closed/pending rather than becoming retry.')
    s=s.replace('uses a secret-derived run token to recover or seal the exact attempt-1 run after a control-plane crash, including failures before custom run-start evidence.',
                'uses a secret-derived run token so the authenticated completion event can bind and seal the exact attempt-1 run after a control-plane crash, including failures before custom run-start evidence; unresolved post-dispatch state never becomes retry.')
    p.write_text(s)

print('applied regression-driven refinement')
