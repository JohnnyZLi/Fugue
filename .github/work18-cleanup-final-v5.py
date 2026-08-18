from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        if new in text:
            return text
        raise SystemExit(f"missing anchor: {label}")
    if text.count(old) != 1:
        raise SystemExit(f"non-unique anchor: {label} ({text.count(old)})")
    return text.replace(old, new, 1)


path = Path("src/core/integration-status.ts")
text = path.read_text()

text = replace_once(
    text,
    '''async function reclaimHistoricalIntegrationAuthorityVariables(
  github: FugueGitHub,
  variables: Array<{ name: string; value: string }>,
  now: number,
  currentIdentities: IntegrationRequest["identity"][],
): Promise<void> {
  if (!currentIdentities.length) return;
''',
    '''async function reclaimHistoricalIntegrationAuthorityVariables(
  github: FugueGitHub,
  variables: Array<{ name: string; value: string }>,
  now: number,
  currentIdentities: IntegrationRequest["identity"][],
): Promise<void> {
''',
    "historical helper empty-set guard",
)

old_current_requests = '''  const currentRequests = new Map<string, string>();
  for (const identity of currentIdentities) {
    try {
      const current = await getCurrentIntegrationRecord(github, identity);
      if (current) currentRequests.set(JSON.stringify([identity.prNumber, identity.headSha.toLowerCase(), identity.baseBranch, identity.baseSha.toLowerCase(), identity.policyDigest, identity.protocolVersion, identity.issueNumber, identity.workId, identity.workSpecDigest]), current.request.request_id);
    } catch (error) {
      if (!(error instanceof DurableProtocolRecoveryPendingError)) throw error;
    }
  }

'''
if old_current_requests in text:
    text = text.replace(old_current_requests, "", 1)

text = replace_once(
    text,
    '''    const currentIdentity = currentIdentities.find((candidate) => sameEvaluationIdentity(candidate, record.identity));
    const currentRequestId = currentIdentity
      ? currentRequests.get(JSON.stringify([currentIdentity.prNumber, currentIdentity.headSha.toLowerCase(), currentIdentity.baseBranch, currentIdentity.baseSha.toLowerCase(), currentIdentity.policyDigest, currentIdentity.protocolVersion, currentIdentity.issueNumber, currentIdentity.workId, currentIdentity.workSpecDigest]))
      : undefined;
    if (currentIdentity && currentRequestId === record.request.request_id) continue;
''',
    '''    const currentIdentity = currentIdentities.find((candidate) => sameEvaluationIdentity(candidate, record.identity));
    // Any request under the current exact evaluation remains request-local lifecycle state, even if
    // its d3 recovery is temporarily pending. Only evaluation drift can make a request historical.
    if (currentIdentity) continue;
''',
    "current exact evaluation skip",
)

text = replace_once(
    text,
    '''export async function reclaimOrphanIntegrationAuthorityVariables(
  github: FugueGitHub,
  now = Date.now(),
  currentIdentities: IntegrationRequest["identity"][] = [],
): Promise<void> {''',
    '''export async function reclaimOrphanIntegrationAuthorityVariables(
  github: FugueGitHub,
  now = Date.now(),
  currentIdentities?: IntegrationRequest["identity"][],
): Promise<void> {''',
    "resolved current identities argument",
)

text = replace_once(
    text,
    '  await reclaimHistoricalIntegrationAuthorityVariables(github, variables, now, currentIdentities);\n',
    '  if (currentIdentities !== undefined) await reclaimHistoricalIntegrationAuthorityVariables(github, variables, now, currentIdentities);\n',
    "resolved historical cleanup call",
)

text = replace_once(
    text,
    '''function historicalBindingMatchesRecord(witness: HistoricalIntegrationBindingWitness, record: IntegrationRecord): boolean {
  if (!record.dispatch || !record.run) return false;
  return witness.request_id === record.request.request_id && witness.pr_number === record.identity.prNumber &&
    witness.head_sha.toLowerCase() === record.identity.headSha.toLowerCase() &&
    witness.base_sha.toLowerCase() === record.identity.baseSha.toLowerCase() && witness.anchor_name === record.dispatch.anchor_name &&
    witness.run_id === record.run.id && witness.run_attempt === 1 && Number.isFinite(Date.parse(witness.run_created_at));
}
''',
    '''function historicalBindingMatchesRequest(
  github: FugueGitHub,
  witness: HistoricalIntegrationBindingWitness,
  record: IntegrationRecord,
): boolean {
  if (!record.dispatch) return false;
  return witness.request_id === record.request.request_id && witness.pr_number === record.identity.prNumber &&
    witness.head_sha.toLowerCase() === record.identity.headSha.toLowerCase() &&
    witness.base_sha.toLowerCase() === record.identity.baseSha.toLowerCase() && witness.anchor_name === record.dispatch.anchor_name &&
    witness.run_attempt === 1 && Number.isFinite(Date.parse(witness.run_created_at)) &&
    witness.html_url === `https://github.com/${github.repository.fullName}/actions/runs/${witness.run_id}`;
}
''',
    "historical binding request matcher",
)

text = replace_once(
    text,
    '''  if (name === integrationBindingWitnessName(record.request.request_id)) {
    const witness = parseHistoricalJson(value, historicalIntegrationBindingWitnessSchema);
    if (!witness || !historicalBindingMatchesRecord(witness, record)) return false;
    return witness.html_url === `https://github.com/${github.repository.fullName}/actions/runs/${record.run!.id}`;
  }
  if (name === integrationRunStartVariableName(record.request)) {
    if (!record.run) return false;
    let start: IntegrationRunStartEvidence | null;
    try { start = parseIntegrationRunStart(value); } catch { start = null; }
    if (!start || start.request_id !== record.request.request_id || start.pr_number !== record.identity.prNumber ||
        start.head_sha.toLowerCase() !== record.identity.headSha.toLowerCase() ||
        start.base_sha.toLowerCase() !== record.identity.baseSha.toLowerCase() ||
        start.secret_digest.toLowerCase() !== record.dispatch.secret_digest.toLowerCase() ||
        start.anchor_name !== record.dispatch.anchor_name || start.run_id !== record.run.id || start.run_attempt !== 1) return false;
    const timestamp = Date.parse(start.created_at);
    if (!Number.isFinite(timestamp)) return false;
    try { return await verifyProtocolPublicationBodyAtRevision(github, value, record.identity.baseSha, timestamp); }
    catch { return false; }
  }
''',
    '''  if (name === integrationBindingWitnessName(record.request.request_id)) {
    const witness = parseHistoricalJson(value, historicalIntegrationBindingWitnessSchema);
    if (!witness || !historicalBindingMatchesRequest(github, witness, record)) return false;
    // Durable identity_lost makes any later protected exact B for this request permanently stale.
    return record.terminal?.state === "identity_lost" || Boolean(record.run && witness.run_id === record.run.id);
  }
  if (name === integrationRunStartVariableName(record.request)) {
    let start: IntegrationRunStartEvidence | null;
    try { start = parseIntegrationRunStart(value); } catch { start = null; }
    if (!start || start.request_id !== record.request.request_id || start.pr_number !== record.identity.prNumber ||
        start.head_sha.toLowerCase() !== record.identity.headSha.toLowerCase() ||
        start.base_sha.toLowerCase() !== record.identity.baseSha.toLowerCase() ||
        start.secret_digest.toLowerCase() !== record.dispatch.secret_digest.toLowerCase() ||
        start.anchor_name !== record.dispatch.anchor_name || start.run_attempt !== 1) return false;
    const timestamp = Date.parse(start.created_at);
    if (!Number.isFinite(timestamp)) return false;
    try {
      if (!(await verifyProtocolPublicationBodyAtRevision(github, value, record.identity.baseSha, timestamp))) return false;
    } catch { return false; }
    // Durable identity_lost likewise makes a delayed protected S inert regardless of its numeric run.
    return record.terminal?.state === "identity_lost" || Boolean(record.run && start.run_id === record.run.id);
  }
''',
    "historical B/S terminal cleanup",
)

text = replace_once(
    text,
    '    if (commit.kind === "integration_exact_run_commit") return Boolean(record.run && commit.run_id === record.run.id);\n',
    '''    if (commit.kind === "integration_exact_run_commit") {
      return record.terminal?.state === "identity_lost" || Boolean(record.run && commit.run_id === record.run.id);
    }
''',
    "historical exact C terminal cleanup",
)

path.write_text(text)


test_path = Path("tests/state-authority-blockers.test.ts")
tests = test_path.read_text()
anchor = '''      github.__authorityVariables.set(integrationCommitVariableName(request.request_id), JSON.stringify({
        version: 1, kind: "integration_identity_lost_commit", request_id: request.request_id,
        pr_number: identity.prNumber, head_sha: identity.headSha, base_sha: identity.baseSha,
        anchor_name: authorized.authorization.anchor_name, attempt: 1,
        boundary_created_at: terminal.terminal!.state === "identity_lost" ? terminal.terminal.boundary_created_at : "",
        fence_digest: terminal.terminal!.state === "identity_lost" ? terminal.terminal.fence_digest : "",
        created_at: terminal.terminal!.created_at,
      }));
      const names = [fence.names.fence, authorized.authorization.anchor_name, integrationCommitVariableName(request.request_id)];
'''
replacement = '''      github.__authorityVariables.set(integrationCommitVariableName(request.request_id), JSON.stringify({
        version: 1, kind: "integration_identity_lost_commit", request_id: request.request_id,
        pr_number: identity.prNumber, head_sha: identity.headSha, base_sha: identity.baseSha,
        anchor_name: authorized.authorization.anchor_name, attempt: 1,
        boundary_created_at: terminal.terminal!.state === "identity_lost" ? terminal.terminal.boundary_created_at : "",
        fence_digest: terminal.terminal!.state === "identity_lost" ? terminal.terminal.fence_digest : "",
        created_at: terminal.terminal!.created_at,
      }));
      // Protected B/S writers may have passed earlier checks before terminal cleanup and reappear later.
      installProtectedBinding(github, terminal, fence.fence, 120520, "2026-08-18T18:12:00.000Z");
      const lateStart = await signProtocolBody(github, serializeIntegrationRunStartEvidence({
        version: 1, kind: "integration_run_start", request_id: request.request_id,
        pr_number: identity.prNumber, head_sha: identity.headSha, base_sha: identity.baseSha,
        secret_digest: terminal.dispatch!.secret_digest, anchor_name: terminal.dispatch!.anchor_name,
        run_id: 120521, run_attempt: 1, created_at: "2026-08-18T18:12:01.000Z",
      }));
      github.__authorityVariables.set(integrationRunStartVariableName(request), lateStart);
      const names = [
        fence.names.fence,
        authorized.authorization.anchor_name,
        fence.names.binding,
        integrationRunStartVariableName(request),
        integrationCommitVariableName(request.request_id),
      ];
'''
if anchor not in tests:
    if replacement not in tests:
        raise SystemExit("identity_lost late B/S regression anchor missing")
else:
    tests = tests.replace(anchor, replacement, 1)

test_path.write_text(tests)
