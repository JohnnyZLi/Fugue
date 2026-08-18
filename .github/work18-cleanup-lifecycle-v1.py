from pathlib import Path

EXPECTED = "e8ebca4f528c7e8657e6418448f551004e77fbaa"

def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise SystemExit(f"missing anchor: {label}")
    if text.count(old) != 1:
        raise SystemExit(f"non-unique anchor: {label} ({text.count(old)})")
    return text.replace(old, new, 1)

# ---- src/core/integration-status.ts ----
p = Path("src/core/integration-status.ts")
s = p.read_text()

anchor = '''export type IntegrationRunStartEvidence = z.infer<typeof integrationRunStartSchema>;
type IntegrationDispatchAnchor = z.infer<typeof integrationDispatchAnchorSchema>;
'''
insert = '''export type IntegrationRunStartEvidence = z.infer<typeof integrationRunStartSchema>;
type IntegrationDispatchAnchor = z.infer<typeof integrationDispatchAnchorSchema>;

const historicalIntegrationFenceSchema = z.object({
  version: z.literal(1),
  kind: z.literal("integration_dispatch_fence"),
  request_id: z.string().regex(/^int-[0-9a-f]{16}-[0-9a-f]{16}$/),
  pr_number: z.number().int().positive(),
  head_sha: z.string().regex(/^[0-9a-f]{40}$/i),
  base_sha: z.string().regex(/^[0-9a-f]{40}$/i),
  anchor_name: z.string().regex(/^FUGUE_INT_A_\\d{10}_[0-9A-F]{16}$/),
  secret_digest: z.string().regex(/^[0-9a-f]{64}$/i),
  run_token: z.string().regex(/^[0-9a-f]{24}$/i),
  authority_actor_id: z.number().int().positive(),
  created_at: z.string().min(1),
});

const historicalIntegrationBindingWitnessSchema = z.object({
  version: z.literal(1),
  kind: z.literal("integration_binding_witness"),
  request_id: z.string().regex(/^int-[0-9a-f]{16}-[0-9a-f]{16}$/),
  pr_number: z.number().int().positive(),
  head_sha: z.string().regex(/^[0-9a-f]{40}$/i),
  base_sha: z.string().regex(/^[0-9a-f]{40}$/i),
  anchor_name: z.string().regex(/^FUGUE_INT_A_\\d{10}_[0-9A-F]{16}$/),
  run_token: z.string().regex(/^[0-9a-f]{24}$/i),
  authority_actor_id: z.number().int().positive(),
  run_id: z.number().int().positive(),
  run_attempt: z.literal(1),
  run_created_at: z.string().min(1),
  html_url: z.string().min(1),
});

type HistoricalIntegrationFence = z.infer<typeof historicalIntegrationFenceSchema>;
type HistoricalIntegrationBindingWitness = z.infer<typeof historicalIntegrationBindingWitnessSchema>;

type HistoricalIntegrationHintKind = "anchor" | "fence" | "binding" | "start" | "commit_exact" | "commit_identity_lost";
interface HistoricalIntegrationAuthorityHint {
  kind: HistoricalIntegrationHintKind;
  variableName: string;
  raw: string;
  requestId: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  anchorName: string;
  runId?: number;
  createdAt?: string;
  htmlUrl?: string;
  boundaryCreatedAt?: string;
  fenceDigest?: string;
}

const HISTORICAL_INTEGRATION_CLEANUP_BUDGET = 16;
const HISTORICAL_INTEGRATION_RECOVERY_SLICES = 4;

export interface CleanupAwareRunStartContext {
  requestId: string;
  prNumber: number;
  baseSha: string;
  anchorName: string;
  runId: number;
  runAttempt: number;
}

/**
 * Cleanup may remove every request-local transient after exact L is durable. The still-starting
 * workflow may treat that as benign only when the durable d3 record itself proves the exact request,
 * canonical evaluation, run ID, and attempt. Any mismatch remains fail-closed.
 */
export function matchesCleanupAwareDurableRunStartBinding(
  record: IntegrationRecord,
  context: CleanupAwareRunStartContext,
): boolean {
  if (!record.dispatch || !record.run || context.runAttempt !== 1 || record.run.attempt !== 1) return false;
  if (!sameEvaluationIdentity(record.identity, record.request.identity)) return false;
  const nonce = context.requestId.match(/^int-[0-9a-f]{16}-([0-9a-f]{16})$/)?.[1];
  if (!nonce) return false;
  let canonical: IntegrationRequest;
  try { canonical = createIntegrationRequest(record.identity, record.request.created_at, nonce); }
  catch { return false; }
  const expectedAnchor = `${INTEGRATION_ANCHOR_PREFIX}${String(context.prNumber).padStart(10, "0")}_${integrationRequestToken(context.requestId)}`;
  return canonical.request_id === context.requestId &&
    record.request.request_id === context.requestId &&
    record.identity.prNumber === context.prNumber &&
    record.identity.baseSha.toLowerCase() === context.baseSha.toLowerCase() &&
    record.dispatch.anchor_name === context.anchorName && context.anchorName === expectedAnchor &&
    record.run.id === context.runId;
}
'''
s = replace_once(s, anchor, insert, "historical schemas")

anchor = '''async function retireIntegrationElection(github: FugueGitHub, electionName: string): Promise<void> {
  await deleteFugueAuthorityVariable(github, electionName);
}
'''
helpers = r'''async function retireIntegrationElection(github: FugueGitHub, electionName: string): Promise<void> {
  await deleteFugueAuthorityVariable(github, electionName);
}

function parseHistoricalJson<T>(raw: string, schema: z.ZodType<T>): T | undefined {
  try { return schema.parse(JSON.parse(raw) as unknown); }
  catch { return undefined; }
}

async function historicalIntegrationAuthorityHint(
  github: FugueGitHub,
  variable: { name: string; value: string },
): Promise<HistoricalIntegrationAuthorityHint | undefined> {
  const { name, value } = variable;
  if (name.startsWith(INTEGRATION_ANCHOR_PREFIX)) {
    const anchor = await verifiedIntegrationAnchor(github, value);
    if (!anchor || anchor.anchor_name !== name) return undefined;
    return {
      kind: "anchor", variableName: name, raw: value,
      requestId: anchor.request.request_id, prNumber: anchor.request.identity.prNumber,
      headSha: anchor.request.identity.headSha, baseSha: anchor.request.identity.baseSha,
      anchorName: anchor.anchor_name,
    };
  }
  if (name.startsWith(INTEGRATION_DISPATCH_FENCE_PREFIX)) {
    const fence = parseHistoricalJson(value, historicalIntegrationFenceSchema);
    if (!fence || integrationDispatchFenceName(fence.request_id) !== name || !Number.isFinite(Date.parse(fence.created_at))) return undefined;
    return {
      kind: "fence", variableName: name, raw: value,
      requestId: fence.request_id, prNumber: fence.pr_number, headSha: fence.head_sha, baseSha: fence.base_sha,
      anchorName: fence.anchor_name, createdAt: fence.created_at,
    };
  }
  if (name.startsWith(INTEGRATION_BINDING_WITNESS_PREFIX)) {
    const witness = parseHistoricalJson(value, historicalIntegrationBindingWitnessSchema);
    if (!witness || integrationBindingWitnessName(witness.request_id) !== name ||
        !Number.isFinite(Date.parse(witness.run_created_at))) return undefined;
    return {
      kind: "binding", variableName: name, raw: value,
      requestId: witness.request_id, prNumber: witness.pr_number, headSha: witness.head_sha, baseSha: witness.base_sha,
      anchorName: witness.anchor_name, runId: witness.run_id, createdAt: witness.run_created_at, htmlUrl: witness.html_url,
    };
  }
  if (name.startsWith(INTEGRATION_RUN_START_PREFIX)) {
    let start: IntegrationRunStartEvidence | null;
    try { start = parseIntegrationRunStart(value); } catch { start = null; }
    if (!start) return undefined;
    const expectedName = `${INTEGRATION_RUN_START_PREFIX}${String(start.pr_number).padStart(10, "0")}_${integrationRequestToken(start.request_id)}`;
    const timestamp = Date.parse(start.created_at);
    if (name !== expectedName || !Number.isFinite(timestamp)) return undefined;
    try {
      if (!(await verifyProtocolPublicationBodyAtRevision(github, value, start.base_sha, timestamp))) return undefined;
    } catch { return undefined; }
    return {
      kind: "start", variableName: name, raw: value,
      requestId: start.request_id, prNumber: start.pr_number, headSha: start.head_sha, baseSha: start.base_sha,
      anchorName: start.anchor_name, runId: start.run_id, createdAt: start.created_at,
      htmlUrl: `https://github.com/${github.repository.fullName}/actions/runs/${start.run_id}`,
    };
  }
  if (name.startsWith(INTEGRATION_COMMIT_PREFIX)) {
    let parsed: unknown;
    try { parsed = JSON.parse(value) as unknown; } catch { return undefined; }
    const result = integrationCommitSchema.safeParse(parsed);
    if (!result.success || integrationCommitVariableName(result.data.request_id) !== name) return undefined;
    const commit = result.data;
    return commit.kind === "integration_exact_run_commit"
      ? {
          kind: "commit_exact", variableName: name, raw: value,
          requestId: commit.request_id, prNumber: commit.pr_number, headSha: commit.head_sha, baseSha: commit.base_sha,
          anchorName: commit.anchor_name, runId: commit.run_id, createdAt: commit.run_created_at, htmlUrl: commit.html_url,
        }
      : {
          kind: "commit_identity_lost", variableName: name, raw: value,
          requestId: commit.request_id, prNumber: commit.pr_number, headSha: commit.head_sha, baseSha: commit.base_sha,
          anchorName: commit.anchor_name, boundaryCreatedAt: commit.boundary_created_at,
          fenceDigest: commit.fence_digest, createdAt: commit.created_at,
        };
  }
  return undefined;
}

function historicalHintKey(hint: HistoricalIntegrationAuthorityHint): string {
  return `${hint.prNumber}:${hint.headSha.toLowerCase()}:${hint.baseSha.toLowerCase()}:${hint.requestId}`;
}

async function recoverHistoricalIntegrationRecord(
  github: FugueGitHub,
  hint: HistoricalIntegrationAuthorityHint,
): Promise<IntegrationRecord | undefined> {
  for (let attempt = 0; attempt < HISTORICAL_INTEGRATION_RECOVERY_SLICES; attempt += 1) {
    try {
      const recovered = await recoverDurableProtocolRecord(github, {
        storageSha: hint.headSha,
        publisherSha: hint.baseSha,
        scope: integrationScope(hint.prNumber),
        issueNumber: hint.prNumber,
        parse: parseIntegrationRecord,
        timestamp: (value) => Date.parse(value.created_at),
        order: (value) => value.created_at,
        validate: (value) => value.identity.prNumber === hint.prNumber &&
          value.identity.headSha.toLowerCase() === hint.headSha.toLowerCase() &&
          value.identity.baseSha.toLowerCase() === hint.baseSha.toLowerCase() &&
          sameEvaluationIdentity(value.identity, value.request.identity) &&
          value.request.request_id === hint.requestId && value.dispatch?.anchor_name === hint.anchorName,
      });
      if (recovered.record) return recovered.record.value;
      if (recovered.exhausted) return undefined;
    } catch (error) {
      if (!(error instanceof DurableProtocolRecoveryPendingError)) throw error;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return undefined;
}

function historicalFenceMatchesRecord(fence: HistoricalIntegrationFence, record: IntegrationRecord): boolean {
  return Boolean(record.dispatch) && fence.request_id === record.request.request_id &&
    fence.pr_number === record.identity.prNumber && fence.head_sha.toLowerCase() === record.identity.headSha.toLowerCase() &&
    fence.base_sha.toLowerCase() === record.identity.baseSha.toLowerCase() && fence.anchor_name === record.dispatch!.anchor_name &&
    fence.secret_digest.toLowerCase() === record.dispatch!.secret_digest.toLowerCase() && Number.isFinite(Date.parse(fence.created_at));
}

function historicalBindingMatchesRecord(witness: HistoricalIntegrationBindingWitness, record: IntegrationRecord): boolean {
  if (!record.dispatch || !record.run) return false;
  const expectedUrl = `https://github.com/${record.identity.prNumber ? "" : ""}`; // keep URL validation below repository-aware
  void expectedUrl;
  return witness.request_id === record.request.request_id && witness.pr_number === record.identity.prNumber &&
    witness.head_sha.toLowerCase() === record.identity.headSha.toLowerCase() &&
    witness.base_sha.toLowerCase() === record.identity.baseSha.toLowerCase() && witness.anchor_name === record.dispatch.anchor_name &&
    witness.run_id === record.run.id && witness.run_attempt === 1 && Number.isFinite(Date.parse(witness.run_created_at));
}

async function historicalTransientMatchesRecord(
  github: FugueGitHub,
  name: string,
  value: string,
  record: IntegrationRecord,
): Promise<boolean> {
  if (!record.dispatch) return false;
  if (name === integrationDispatchFenceName(record.request.request_id)) {
    const fence = parseHistoricalJson(value, historicalIntegrationFenceSchema);
    return Boolean(fence && historicalFenceMatchesRecord(fence, record));
  }
  if (name === record.dispatch.anchor_name) {
    const anchor = await verifiedIntegrationAnchor(github, value, record.identity);
    return Boolean(anchor && anchor.request.request_id === record.request.request_id && anchor.anchor_name === name);
  }
  if (name === integrationBindingWitnessName(record.request.request_id)) {
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
  if (name === integrationCommitVariableName(record.request.request_id)) {
    const context = integrationCommitContext(record)!;
    let commit: IntegrationCommit;
    try { commit = parseIntegrationCommit(value, context); } catch { return false; }
    if (commit.kind === "integration_exact_run_commit") return Boolean(record.run && commit.run_id === record.run.id);
    return record.terminal?.state === "identity_lost" &&
      commit.boundary_created_at === record.terminal.boundary_created_at &&
      commit.fence_digest.toLowerCase() === record.terminal.fence_digest.toLowerCase();
  }
  return false;
}

async function releaseVerifiedHistoricalIntegrationAuthority(
  github: FugueGitHub,
  record: IntegrationRecord,
): Promise<void> {
  if (!record.dispatch) return;
  // C remains last even for superseded identities. Each surviving slot is re-read and independently
  // validated against the historical d3 record immediately before deletion.
  const names = [
    integrationDispatchFenceName(record.request.request_id),
    record.dispatch.anchor_name,
    integrationBindingWitnessName(record.request.request_id),
    integrationRunStartVariableName(record.request),
    integrationCommitVariableName(record.request.request_id),
  ];
  for (const name of names) {
    const value = await getFugueAuthorityVariable(github, name);
    if (value === undefined) continue;
    if (await historicalTransientMatchesRecord(github, name, value, record)) {
      await deleteFugueAuthorityVariable(github, name);
    }
  }
}

async function reclaimHistoricalIntegrationAuthorityVariables(
  github: FugueGitHub,
  variables: Array<{ name: string; value: string }>,
  now: number,
  currentIdentities: IntegrationRequest["identity"][],
): Promise<void> {
  if (!currentIdentities.length) return;
  const hints = new Map<string, HistoricalIntegrationAuthorityHint[]>();
  for (const variable of variables) {
    const hint = await historicalIntegrationAuthorityHint(github, variable);
    if (!hint) continue;
    const key = historicalHintKey(hint);
    const group = hints.get(key) ?? [];
    group.push(hint);
    hints.set(key, group);
  }

  const currentRequests = new Map<string, string>();
  for (const identity of currentIdentities) {
    try {
      const current = await getCurrentIntegrationRecord(github, identity);
      if (current) currentRequests.set(`${identity.prNumber}:${identity.headSha}:${identity.baseSha}:${identity.workSpecDigest}`, current.request.request_id);
    } catch (error) {
      if (!(error instanceof DurableProtocolRecoveryPendingError)) throw error;
    }
  }

  let budget = HISTORICAL_INTEGRATION_CLEANUP_BUDGET;
  for (const key of [...hints.keys()].sort()) {
    if (budget <= 0) break;
    const group = hints.get(key)!;
    const hint = group[0]!;
    const record = await recoverHistoricalIntegrationRecord(github, hint);
    if (!record) continue;
    const currentIdentity = currentIdentities.find((candidate) => sameEvaluationIdentity(candidate, record.identity));
    const currentRequestId = currentIdentity
      ? currentRequests.get(`${currentIdentity.prNumber}:${currentIdentity.headSha}:${currentIdentity.baseSha}:${currentIdentity.workSpecDigest}`)
      : undefined;
    if (currentIdentity && currentRequestId === record.request.request_id) continue;
    budget -= 1;

    if (record.run || record.terminal) {
      await releaseVerifiedHistoricalIntegrationAuthority(github, record);
      continue;
    }

    const exactHints = group.filter((candidate) => candidate.runId !== undefined);
    const exactRunIds = new Set(exactHints.map((candidate) => candidate.runId!));
    if (exactRunIds.size === 1) {
      const exact = exactHints.find((candidate) => candidate.runId !== undefined)!;
      const expectedUrl = `https://github.com/${github.repository.fullName}/actions/runs/${exact.runId}`;
      if ((!exact.htmlUrl || exact.htmlUrl === expectedUrl) && exact.createdAt && Number.isFinite(Date.parse(exact.createdAt))) {
        await bindDispatchedIntegrationRun(
          github,
          { identity: record.identity } as EvaluationSnapshot,
          record.request.request_id,
          exact.runId!,
          expectedUrl,
          exact.createdAt,
        );
        continue;
      }
    }
    if (exactRunIds.size > 1) continue;

    const committedLost = group.find((candidate) => candidate.kind === "commit_identity_lost");
    const fenceHint = group.find((candidate) => candidate.kind === "fence");
    if (committedLost?.boundaryCreatedAt && committedLost.fenceDigest && committedLost.createdAt) {
      await publishIntegrationRecord(github, {
        ...record,
        dispatch_started_at: record.dispatch_started_at ?? committedLost.boundaryCreatedAt,
        run: null,
        terminal: {
          state: "identity_lost", attempt: 1,
          boundary_created_at: committedLost.boundaryCreatedAt,
          fence_digest: committedLost.fenceDigest,
          detail: "Historical protected may-have-dispatched request completed identity_lost serialization before evaluation drift; scavenging finishes the durable terminal transition without retry.",
          created_at: committedLost.createdAt,
        },
        created_at: committedLost.createdAt,
      });
      continue;
    }
    if (fenceHint?.createdAt && now - Date.parse(fenceHint.createdAt) >= INTEGRATION_REQUEST_RECOVERY_GRACE_MS) {
      const fence = parseHistoricalJson(fenceHint.raw, historicalIntegrationFenceSchema);
      if (fence && historicalFenceMatchesRecord(fence, record)) {
        const terminalAt = new Date(Math.max(now, Date.parse(record.created_at) + 1)).toISOString();
        await publishIntegrationRecord(github, {
          ...record,
          dispatch_started_at: record.dispatch_started_at ?? fence.created_at,
          run: null,
          terminal: {
            state: "identity_lost", attempt: 1,
            boundary_created_at: fence.created_at,
            fence_digest: `sha256:${createHash("sha256").update(fenceHint.raw, "utf8").digest("hex")}`,
            detail: "Historical protected may-have-dispatched request lost every exact run witness across evaluation drift; it is terminal identity_lost and cannot become retryable transport.",
            created_at: terminalAt,
          },
          created_at: terminalAt,
        });
      }
      continue;
    }

    // No protected may-have-dispatched fence/serialized exception and no exact witness: the obsolete
    // evaluation can release verified pre-POST transients, but scavenging never publishes retryable aborted.
    if (!record.dispatch_started_at && !fenceHint) await releaseVerifiedHistoricalIntegrationAuthority(github, record);
  }
}
'''
s = replace_once(s, anchor, helpers, "historical helpers")

old = '''export async function reclaimOrphanIntegrationAuthorityVariables(
  github: FugueGitHub,
  now = Date.now(),
): Promise<void> {
'''
new = '''export async function reclaimOrphanIntegrationAuthorityVariables(
  github: FugueGitHub,
  now = Date.now(),
  currentIdentities: IntegrationRequest["identity"][] = [],
): Promise<void> {
'''
s = replace_once(s, old, new, "reclaim signature")

old = '''    if (current?.request.request_id === anchor.request.request_id && !current.terminal) {
      await deleteFugueAuthorityVariable(github, variable.name);
      continue;
    }
    await deleteFugueAuthorityVariable(github, variable.name);
    await deleteFugueAuthorityVariable(github, anchor.anchor_name);
'''
new = '''    if (current?.request.request_id === anchor.request.request_id) {
      // Election is redundant once request d3 exists, but defer A/F/B/S/C to exact current/historical
      // lifecycle cleanup so C-last ordering and per-slot validation are preserved.
      await deleteFugueAuthorityVariable(github, variable.name);
      continue;
    }
    await deleteFugueAuthorityVariable(github, variable.name);
    await deleteFugueAuthorityVariable(github, anchor.anchor_name);
'''
s = replace_once(s, old, new, "election defer")

old = '''    if (current?.request.request_id === anchor.request.request_id && !current.terminal) continue;
    await deleteFugueAuthorityVariable(github, name);
  }
}
'''
new = '''    if (current?.request.request_id === anchor.request.request_id) continue;
    await deleteFugueAuthorityVariable(github, name);
  }

  await reclaimHistoricalIntegrationAuthorityVariables(github, variables, now, currentIdentities);
}
'''
s = replace_once(s, old, new, "historical reclaim call")

old = '''  await reclaimOrphanIntegrationAuthorityVariables(github, timestamp);
'''
new = '''  await reclaimOrphanIntegrationAuthorityVariables(github, timestamp, [request.identity]);
'''
s = replace_once(s, old, new, "authorize current identity")

p.write_text(s)

# ---- src/core/reconcile.ts ----
p = Path("src/core/reconcile.ts")
s = p.read_text()

helper_anchor = '''export async function reconcileRepository(
  github: FugueGitHub,
  options: ReconcileOptions = {},
): Promise<ReconcileResult> {
'''
helper_insert = '''function currentIntegrationEvaluationIdentities(state: Awaited<ReturnType<typeof reconstructState>>) {
  return state.works.flatMap((work) => work.pr ? [{
    prNumber: work.pr.number,
    headSha: work.pr.headSha,
    baseBranch: state.policy.identity.baseBranch,
    baseSha: state.policy.identity.baseSha,
    policyDigest: state.policy.identity.policyDigest,
    protocolVersion: state.policy.identity.protocolVersion,
    issueNumber: work.issueNumber,
    workId: work.metadata.work_id,
    workSpecDigest: work.workSpecDigest,
  }] : []);
}

export async function reconcileRepository(
  github: FugueGitHub,
  options: ReconcileOptions = {},
): Promise<ReconcileResult> {
'''
s = replace_once(s, helper_anchor, helper_insert, "reconcile identity helper")

old = '''  const initial = await reconstructState(github);
  const selected = selectWorks(initial.works, options);
'''
new = '''  const initial = await reconstructState(github);
  await reclaimOrphanIntegrationAuthorityVariables(github, Date.now(), currentIntegrationEvaluationIdentities(initial));
  const selected = selectWorks(initial.works, options);
'''
s = replace_once(s, old, new, "repository historical reclaim")

old = '''    const state = await reconstructState(github);
    const work = state.works.find((candidate) => candidate.issueNumber === issueNumber);
'''
new = '''    const state = await reconstructState(github);
    await reclaimOrphanIntegrationAuthorityVariables(github, Date.now(), currentIntegrationEvaluationIdentities(state));
    const work = state.works.find((candidate) => candidate.issueNumber === issueNumber);
'''
s = replace_once(s, old, new, "work historical reclaim")
p.write_text(s)

# ---- .github/workflows/fugue-integration.yml ----
p = Path(".github/workflows/fugue-integration.yml")
s = p.read_text()

old = '''          const variable = await read(`/actions/variables/${anchorName}`);
          const anchor = parseBlock(String(variable.value ?? ''), '<!-- fugue-integration-dispatch-anchor');
'''
new = r'''          function stableSort(value) {
            if (Array.isArray(value)) return value.map(stableSort);
            if (value && typeof value === 'object') {
              return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stableSort(v)]));
            }
            return value;
          }
          function yamlScalar(raw) {
            const value = String(raw ?? '').trim();
            if (value === 'null') return null;
            if (value === 'true') return true;
            if (value === 'false') return false;
            if (/^-?\d+$/.test(value)) return Number(value);
            if (value.startsWith('"') && value.endsWith('"')) {
              try { return JSON.parse(value); } catch { return value.slice(1, -1); }
            }
            if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
            return value;
          }
          function yamlSection(yaml, key) {
            const lines = yaml.split('\n');
            const index = lines.findIndex((line) => line === `${key}:`);
            if (index < 0) return null;
            const result = [];
            for (let i = index + 1; i < lines.length; i += 1) {
              if (lines[i] && !lines[i].startsWith(' ')) break;
              result.push(lines[i]);
            }
            return result;
          }
          function yamlField(lines, key, indent = 2) {
            if (!lines) return undefined;
            const prefix = `${' '.repeat(indent)}${key}:`;
            const line = lines.find((candidate) => candidate.startsWith(prefix));
            if (!line) return undefined;
            return yamlScalar(line.slice(prefix.length));
          }
          function parseIntegrationRecordBody(body) {
            const start = body.indexOf('<!-- fugue-integration-record');
            if (start < 0) return null;
            const end = body.indexOf('-->', start);
            if (end < 0) return null;
            const yaml = body.slice(start + '<!-- fugue-integration-record'.length, end).trim();
            const identityLines = yamlSection(yaml, 'identity');
            const requestLines = yamlSection(yaml, 'request');
            const dispatchLines = yamlSection(yaml, 'dispatch');
            const runLines = yamlSection(yaml, 'run');
            if (!identityLines || !requestLines || !dispatchLines || !runLines) return null;
            const identityKeys = ['prNumber', 'headSha', 'baseBranch', 'baseSha', 'policyDigest', 'protocolVersion', 'issueNumber', 'workId', 'workSpecDigest'];
            const identity = Object.fromEntries(identityKeys.map((key) => [key, yamlField(identityLines, key, 2)]));
            const requestIdentity = Object.fromEntries(identityKeys.map((key) => [key, yamlField(requestLines, key, 4)]));
            return {
              identity,
              request: {
                request_id: yamlField(requestLines, 'request_id', 2),
                created_at: yamlField(requestLines, 'created_at', 2),
                identity: requestIdentity,
              },
              dispatch: { anchor_name: yamlField(dispatchLines, 'anchor_name', 2) },
              run: {
                id: yamlField(runLines, 'id', 2),
                attempt: yamlField(runLines, 'attempt', 2),
              },
              created_at: yamlScalar(yaml.split('\n').find((line) => line.startsWith('created_at:'))?.slice('created_at:'.length) ?? ''),
            };
          }
          async function durableExactBindingAfterCleanup() {
            const cursorBodies = [];
            for (let page = 1; page <= 5; page += 1) {
              const response = await read(`/actions/variables?per_page=100&page=${page}`);
              const variables = Array.isArray(response.variables) ? response.variables : [];
              for (const candidate of variables) {
                const name = String(candidate.name ?? '');
                const value = String(candidate.value ?? '');
                if (name.startsWith('FUGUE_D3_')) cursorBodies.push(value);
                if (name.startsWith('FUGUE_D3P_')) {
                  try {
                    const pack = JSON.parse(value);
                    if (pack?.kind === 'durable_recovery_pack' && Array.isArray(pack.entries)) {
                      for (const entry of pack.entries) if (typeof entry === 'string') cursorBodies.push(entry);
                    }
                  } catch { /* malformed protected pack is not fallback authority */ }
                }
              }
              if (variables.length < 100) break;
            }
            const matches = [];
            for (const cursorBody of cursorBodies) {
              if (!cursorBody.includes('<!-- fugue-publisher-proof')) continue;
              let cursor;
              try { cursor = parseBlock(cursorBody, '<!-- fugue-durable-recovery'); } catch { continue; }
              if (!cursor || cursor.version !== 1 || cursor.kind !== 'durable_recovery' || cursor.commit_witness !== true ||
                  cursor.scope !== `integration/${prNumber}` || cursor.publisher_sha?.toLowerCase() !== baseSha.toLowerCase() ||
                  typeof cursor.best_body_b64 !== 'string' || !cursor.best_manifest ||
                  !Array.isArray(cursor.best_manifest.status_ids) || cursor.best_manifest.status_ids.length !== cursor.best_manifest.chunk_count ||
                  typeof cursor.best_manifest.proof !== 'string' || !cursor.best_manifest.proof ||
                  typeof cursor.best_manifest.authority_order_b64 !== 'string') continue;
              let bestBody;
              let order;
              try {
                bestBody = Buffer.from(cursor.best_body_b64, 'base64url').toString('utf8');
                order = Buffer.from(cursor.best_manifest.authority_order_b64, 'base64url').toString('utf8');
              } catch { continue; }
              const record = parseIntegrationRecordBody(bestBody);
              if (!record?.run || record.request?.request_id !== requestId || record.identity?.prNumber !== prNumber ||
                  record.identity?.baseSha?.toLowerCase() !== baseSha.toLowerCase() || record.dispatch?.anchor_name !== anchorName ||
                  record.run.id !== runId || record.run.attempt !== runAttempt || record.created_at !== order ||
                  JSON.stringify(record.identity) !== JSON.stringify(record.request.identity)) continue;
              const nonce = requestId.match(/^int-[0-9a-f]{16}-([0-9a-f]{16})$/)?.[1];
              if (!nonce) continue;
              const canonicalDigest = createHash('sha256').update(JSON.stringify(stableSort(record.identity)), 'utf8').digest('hex').slice(0, 16);
              const canonicalRequestId = `int-${canonicalDigest}-${nonce}`;
              const expectedAnchor = `FUGUE_INT_A_${String(prNumber).padStart(10, '0')}_${createHash('sha256').update(requestId, 'utf8').digest('hex').slice(0, 16).toUpperCase()}`;
              if (canonicalRequestId !== requestId || expectedAnchor !== anchorName || cursor.storage_sha?.toLowerCase() !== record.identity.headSha?.toLowerCase()) continue;
              matches.push({ order, body: bestBody });
            }
            if (!matches.length) return false;
            matches.sort((a, b) => a.order.localeCompare(b.order));
            const greatest = matches.at(-1);
            const conflicts = matches.filter((candidate) => candidate.order === greatest.order && candidate.body !== greatest.body);
            if (conflicts.length) throw new Error('Conflicting equal-order durable Integration authority cannot authorize cleanup-aware run-start no-op.');
            return true;
          }

          const variable = await read(`/actions/variables/${anchorName}`, true);
          if (!variable) {
            if (await durableExactBindingAfterCleanup()) process.exit(0);
            throw new Error('Protected Integration request anchor is missing without matching durable d3 exact-run authority.');
          }
          const anchor = parseBlock(String(variable.value ?? ''), '<!-- fugue-integration-dispatch-anchor');
'''
s = replace_once(s, old, new, "workflow d3 fallback")

old = '''          if (!fenceVariable) process.exit(0);
'''
new = '''          if (!fenceVariable) {
            if (await durableExactBindingAfterCleanup()) process.exit(0);
            throw new Error('Protected Integration dispatch fence is missing without matching durable d3 exact-run authority.');
          }
'''
s = replace_once(s, old, new, "workflow missing fence")

old = '''          if (!fenceAfterCommit || !anchorAfterCommit) {
            await deleteVariable(commitName);
            process.exit(0);
          }
'''
new = '''          if (!fenceAfterCommit || !anchorAfterCommit) {
            await deleteVariable(commitName);
            if (await durableExactBindingAfterCleanup()) process.exit(0);
            throw new Error('Protected Integration prerequisites disappeared without matching durable d3 exact-run authority.');
          }
'''
s = replace_once(s, old, new, "workflow post-C cleanup")
p.write_text(s)

# ---- AGENTS.md invariant 30 ----
p = Path("AGENTS.md")
s = p.read_text()
old = 'Request-specific F/B/C/anchor/run-start state is reclaimed only after durable terminal authority commits; cleanup is bounded, idempotent, request-local, and resumed by later reconciliation without changing terminal authority.'
new = 'Durable exact-L binding or durable terminal authority makes request-local F/A/B/S/C transient state reclaimable; cleanup remains C-last, bounded, idempotent, and restart-complete even after candidate head/evaluation drift. A still-starting exact L tolerates already-completed cleanup only when protected durable d3 authority independently proves the same canonical request/evaluation, run ID, and attempt 1; missing transient authority without that exact d3 proof fails closed. Historical cleanup validates each surviving protected transient against its historical d3 identity before deletion, never makes historical evidence current again, and never reclassifies an ambiguous may-have-dispatched request as retryable aborted.'
s = replace_once(s, old, new, "AGENTS invariant 30")
p.write_text(s)

# ---- tests/integration-plan.test.ts ----
p = Path("tests/integration-plan.test.ts")
s = p.read_text()
s = replace_once(
    s,
    '  createIntegrationRequest,\n  integrationPlanSchema,',
    '  createIntegrationRecord,\n  createIntegrationRequest,\n  integrationPlanSchema,',
    "integration plan create record import",
)
s = replace_once(
    s,
    'import { protectedIntegrationRecoveryDecision } from "../src/core/reconcile.js";\n',
    'import { protectedIntegrationRecoveryDecision } from "../src/core/reconcile.js";\nimport { matchesCleanupAwareDurableRunStartBinding } from "../src/core/integration-status.js";\n',
    "cleanup match import",
)

anchor = '''  it("pins reconciliation to workflow_sha and prevents issue-event pending replacement", async () => {
'''
test = r'''  it("allows cleanup-aware run-start no-op only for exact durable d3 request/evaluation/run/attempt", () => {
    const request = createIntegrationRequest(identity, "2026-08-18T18:00:00.000Z", "1234567890abcdef");
    const anchorName = `FUGUE_INT_A_${String(identity.prNumber).padStart(10, "0")}_${require("node:crypto").createHash("sha256").update(request.request_id, "utf8").digest("hex").slice(0, 16).toUpperCase()}`;
    const record = createIntegrationRecord(request, {
      dispatch: { secret_digest: "1".repeat(64), authorized_at: "2026-08-18T18:00:00.000Z", anchor_name: anchorName },
      run: { id: 7001, attempt: 1, created_at: "2026-08-18T18:00:01.000Z", html_url: "https://github.com/JohnnyZLi/Fugue/actions/runs/7001" },
      createdAt: "2026-08-18T18:00:01.000Z",
    });
    const context = { requestId: request.request_id, prNumber: identity.prNumber, baseSha: identity.baseSha, anchorName, runId: 7001, runAttempt: 1 };
    expect(matchesCleanupAwareDurableRunStartBinding(record, context)).toBe(true);
    expect(matchesCleanupAwareDurableRunStartBinding({ ...record, run: null }, context)).toBe(false);
    expect(matchesCleanupAwareDurableRunStartBinding(record, { ...context, runId: 7002 })).toBe(false);
    expect(matchesCleanupAwareDurableRunStartBinding(record, { ...context, requestId: request.request_id.replace(/.$/, "1") })).toBe(false);
    const wrongEvaluation = { ...record, identity: { ...record.identity, headSha: "f".repeat(40) } } as typeof record;
    expect(matchesCleanupAwareDurableRunStartBinding(wrongEvaluation, context)).toBe(false);
    expect(matchesCleanupAwareDurableRunStartBinding(record, { ...context, runAttempt: 2 })).toBe(false);
  });

  it("uses only committed durable d3 Authority witnesses for cleanup-aware run-start fallback", async () => {
    const workflow = await readFile(".github/workflows/fugue-integration.yml", "utf8");
    expect(workflow).toContain("durableExactBindingAfterCleanup");
    expect(workflow).toContain("FUGUE_D3_");
    expect(workflow).toContain("FUGUE_D3P_");
    expect(workflow).toContain("cursor.commit_witness !== true");
    expect(workflow).toContain("cursor.best_manifest.status_ids.length !== cursor.best_manifest.chunk_count");
    expect(workflow).toContain("canonicalRequestId !== requestId");
    expect(workflow).toContain("record.run.id !== runId || record.run.attempt !== runAttempt");
    expect(workflow).toContain("Protected Integration request anchor is missing without matching durable d3 exact-run authority");
    expect(workflow).toContain("Protected Integration dispatch fence is missing without matching durable d3 exact-run authority");
    const runStart = workflow.slice(workflow.indexOf("Commit protected Integration run-start evidence"), workflow.indexOf("- uses: actions/checkout@v4"));
    expect(runStart).not.toContain("deployments");
    expect(runStart).not.toContain("workflow-runs");
    expect(runStart).not.toContain("issues/comments");
  });

  it("pins reconciliation to workflow_sha and prevents issue-event pending replacement", async () => {
'''
s = replace_once(s, anchor, test, "integration fallback tests")
# Avoid CommonJS require in ESM test by adding createHash import.
s = 'import { createHash } from "node:crypto";\n' + s
s = s.replace('require("node:crypto").createHash("sha256")', 'createHash("sha256")')
p.write_text(s)

# ---- tests/state-authority-blockers.test.ts ----
p = Path("tests/state-authority-blockers.test.ts")
s = p.read_text()
old_import = 'import { authorizeIntegrationDispatch, bindDispatchedIntegrationRun, ensureIntegrationDispatch, getCurrentIntegrationRecord, getIntegrationRunStartEvidence, integrationCommitVariableName, integrationDispatchRunToken, integrationRunStartVariableName, publishIntegrationRecord, sealIntegrationWorkflowRunEvent } from "../src/core/integration-status.js";'
new_import = 'import { authorizeIntegrationDispatch, bindDispatchedIntegrationRun, ensureIntegrationDispatch, getCurrentIntegrationRecord, getIntegrationRunStartEvidence, integrationCommitVariableName, integrationDispatchRunToken, integrationRunStartVariableName, publishIntegrationRecord, reclaimOrphanIntegrationAuthorityVariables, sealIntegrationWorkflowRunEvent, serializeIntegrationRunStartEvidence } from "../src/core/integration-status.js";'
s = replace_once(s, old_import, new_import, "state blocker imports")

addition = r'''

describe("historical Integration transient cleanup across evaluation drift", () => {
  async function seedHistoricalBound(github: TestGithub, prNumber: number, headChar: string, nonce: string, runId: number) {
    const identity = {
      prNumber, headSha: headChar.repeat(40), baseBranch: "main", baseSha: BASE,
      policyDigest: "sha256:policy", protocolVersion: 1 as const, issueNumber: 7000 + prNumber,
      workId: `work-${7000 + prNumber}`, workSpecDigest: `sha256:spec-${headChar}`,
    };
    const snapshot = { identity, pr: { number: prNumber } } as unknown as EvaluationSnapshot;
    const request = createIntegrationRequest(identity, "2026-08-18T18:00:00.000Z", nonce);
    const secret = runId.toString(16).padStart(64, "0");
    const authorized = await authorizeIntegrationDispatch(github, request, "2026-08-18T18:00:00.000Z", secret);
    const anchorBody = github.__authorityVariables.get(authorized.authorization.anchor_name)!;
    await publishIntegrationRecord(github, createIntegrationRecord(authorized.request, {
      dispatch: authorized.authorization, createdAt: "2026-08-18T18:00:00.000Z",
    }));
    github.__authorityVariables.delete(authorized.electionName);
    const htmlUrl = `https://github.com/JohnnyZLi/Fugue/actions/runs/${runId}`;
    const record = await bindDispatchedIntegrationRun(github, snapshot, request.request_id, runId, htmlUrl, "2026-08-18T18:00:02.000Z");
    return { identity, snapshot, request, secret, anchorBody, record, runId, htmlUrl };
  }

  async function installValidHistoricalTransients(github: TestGithub, seeded: Awaited<ReturnType<typeof seedHistoricalBound>>) {
    const { record, request, secret, runId, htmlUrl, anchorBody } = seeded;
    const suffix = createHash("sha256").update(request.request_id, "utf8").digest("hex").slice(0, 32).toUpperCase();
    const runToken = integrationDispatchRunToken(request.request_id, secret);
    const fenceName = `FUGUE_INT_F_${suffix}`;
    const bindingName = `FUGUE_INT_B_${suffix}`;
    const commitName = integrationCommitVariableName(request.request_id);
    const startName = integrationRunStartVariableName(request);
    const fence = {
      version: 1, kind: "integration_dispatch_fence", request_id: request.request_id,
      pr_number: record.identity.prNumber, head_sha: record.identity.headSha, base_sha: record.identity.baseSha,
      anchor_name: record.dispatch!.anchor_name, secret_digest: record.dispatch!.secret_digest,
      run_token: runToken, authority_actor_id: 123456, created_at: "2026-08-18T18:00:01.000Z",
    };
    const binding = {
      version: 1, kind: "integration_binding_witness", request_id: request.request_id,
      pr_number: record.identity.prNumber, head_sha: record.identity.headSha, base_sha: record.identity.baseSha,
      anchor_name: record.dispatch!.anchor_name, run_token: runToken, authority_actor_id: 123456,
      run_id: runId, run_attempt: 1, run_created_at: record.run!.created_at, html_url: htmlUrl,
    };
    const start = await signProtocolBody(github, serializeIntegrationRunStartEvidence({
      version: 1, kind: "integration_run_start", request_id: request.request_id,
      pr_number: record.identity.prNumber, head_sha: record.identity.headSha, base_sha: record.identity.baseSha,
      secret_digest: record.dispatch!.secret_digest, anchor_name: record.dispatch!.anchor_name,
      run_id: runId, run_attempt: 1, created_at: record.run!.created_at,
    }));
    const commit = {
      version: 1, kind: "integration_exact_run_commit", request_id: request.request_id,
      pr_number: record.identity.prNumber, head_sha: record.identity.headSha, base_sha: record.identity.baseSha,
      anchor_name: record.dispatch!.anchor_name, run_id: runId, run_attempt: 1,
      run_created_at: record.run!.created_at, html_url: htmlUrl,
    };
    github.__authorityVariables.set(fenceName, JSON.stringify(fence));
    github.__authorityVariables.set(record.dispatch!.anchor_name, anchorBody);
    github.__authorityVariables.set(bindingName, JSON.stringify(binding));
    github.__authorityVariables.set(startName, start);
    github.__authorityVariables.set(commitName, JSON.stringify(commit));
    return [fenceName, record.dispatch!.anchor_name, bindingName, startName, commitName];
  }

  function currentIdentityFor(seeded: Awaited<ReturnType<typeof seedHistoricalBound>>, headChar: string) {
    return { ...seeded.identity, headSha: headChar.repeat(40), workSpecDigest: `sha256:spec-${headChar}` };
  }

  it("reclaims every H1 F/A/B/S-before-C crash cut after H2 drift while preserving H1 exact L", async () => {
    await withHostedAuthority(async () => {
      const github = makeGithub();
      const seeded = await seedHistoricalBound(github, 501, "1", "0000000000000501", 120501);
      const h2 = currentIdentityFor(seeded, "2");
      const before = await getCurrentIntegrationRecord(github, seeded.identity);
      for (const deletedPrefix of [1, 2, 3, 4]) {
        const names = await installValidHistoricalTransients(github, seeded);
        for (let index = 0; index < deletedPrefix; index += 1) github.__authorityVariables.delete(names[index]!);
        github.__workflowRuns.splice(0);
        github.__comments.splice(0);
        await reclaimOrphanIntegrationAuthorityVariables(github, Date.parse("2026-08-18T18:30:00.000Z"), [h2]);
        expect(names.filter((name) => github.__authorityVariables.has(name))).toEqual([]);
        expect(await getCurrentIntegrationRecord(github, seeded.identity)).toEqual(before);
      }
    });
  });

  it("reclaims historical known-L failure/error/cancelled-as-error and preserves terminal evidence", async () => {
    await withHostedAuthority(async () => {
      for (const [offset, state, detail] of [
        [0, "failure", "known attempt failed"],
        [1, "error", "known attempt errored"],
        [2, "error", "Protected attempt 1 completed cancelled; a known attempt is never retryable transport."],
      ] as const) {
        const github = makeGithub();
        const seeded = await seedHistoricalBound(github, 510 + offset, "3", `000000000000051${offset}`, 120510 + offset);
        const terminalAt = "2026-08-18T18:10:00.000Z";
        const terminal = await publishIntegrationRecord(github, {
          ...seeded.record, terminal: { state, detail, created_at: terminalAt }, created_at: terminalAt,
        });
        const names = await installValidHistoricalTransients(github, { ...seeded, record: terminal });
        github.__workflowRuns.splice(0);
        github.__comments.splice(0);
        github.__statuses.splice(0);
        await reclaimOrphanIntegrationAuthorityVariables(github, Date.parse("2026-08-18T18:30:00.000Z"), [currentIdentityFor(seeded, "4")]);
        expect(names.filter((name) => github.__authorityVariables.has(name))).toEqual([]);
        const durable = await getCurrentIntegrationRecord(github, seeded.identity);
        expect(durable?.run?.id).toBe(seeded.runId);
        expect(durable?.terminal).toEqual(terminal.terminal);
      }
    });
  });

  it("reclaims historical identity_lost without creating retryable aborted", async () => {
    await withHostedAuthority(async () => {
      const github = makeGithub();
      const identity = {
        prNumber: 520, headSha: "5".repeat(40), baseBranch: "main", baseSha: BASE,
        policyDigest: "sha256:policy", protocolVersion: 1 as const, issueNumber: 7520,
        workId: "work-7520", workSpecDigest: "sha256:spec-5",
      };
      const snapshot = { identity, pr: { number: 520 } } as unknown as EvaluationSnapshot;
      const request = createIntegrationRequest(identity, "2026-08-18T18:00:00.000Z", "0000000000000520");
      const secret = "5".repeat(64);
      const authorized = await authorizeIntegrationDispatch(github, request, "2026-08-18T18:00:00.000Z", secret);
      const anchorBody = github.__authorityVariables.get(authorized.authorization.anchor_name)!;
      const record = await publishIntegrationRecord(github, createIntegrationRecord(authorized.request, { dispatch: authorized.authorization, createdAt: "2026-08-18T18:00:00.000Z" }));
      github.__authorityVariables.delete(authorized.electionName);
      const fence = installProtectedFence(github, record, secret, "2026-08-18T18:00:01.000Z");
      await recoverExistingProtectedIntegration(github, snapshot, Date.parse("2026-08-18T18:11:00.000Z"));
      const terminal = (await getCurrentIntegrationRecord(github, identity))!;
      expect(terminal.terminal?.state).toBe("identity_lost");
      github.__authorityVariables.set(fence.names.fence, fence.raw);
      github.__authorityVariables.set(authorized.authorization.anchor_name, anchorBody);
      github.__authorityVariables.set(integrationCommitVariableName(request.request_id), JSON.stringify({
        version: 1, kind: "integration_identity_lost_commit", request_id: request.request_id,
        pr_number: identity.prNumber, head_sha: identity.headSha, base_sha: identity.baseSha,
        anchor_name: authorized.authorization.anchor_name, attempt: 1,
        boundary_created_at: terminal.terminal!.state === "identity_lost" ? terminal.terminal.boundary_created_at : "",
        fence_digest: terminal.terminal!.state === "identity_lost" ? terminal.terminal.fence_digest : "",
        created_at: terminal.terminal!.created_at,
      }));
      const names = [fence.names.fence, authorized.authorization.anchor_name, integrationCommitVariableName(request.request_id)];
      await reclaimOrphanIntegrationAuthorityVariables(github, Date.parse("2026-08-18T18:30:00.000Z"), [{ ...identity, headSha: "6".repeat(40), workSpecDigest: "sha256:spec-6" }]);
      expect(names.filter((name) => github.__authorityVariables.has(name))).toEqual([]);
      expect((await getCurrentIntegrationRecord(github, identity))?.terminal?.state).toBe("identity_lost");
    });
  });

  it("reclaims late historical B/S on the next pass and never touches the current active request", async () => {
    await withHostedAuthority(async () => {
      const github = makeGithub();
      const h1 = await seedHistoricalBound(github, 530, "7", "0000000000000530", 120530);
      const h2Identity = currentIdentityFor(h1, "8");
      const h2Request = createIntegrationRequest(h2Identity, "2026-08-18T18:20:00.000Z", "1000000000000530");
      const h2Secret = "8".repeat(64);
      const h2Authorized = await authorizeIntegrationDispatch(github, h2Request, "2026-08-18T18:20:00.000Z", h2Secret);
      const h2Record = await publishIntegrationRecord(github, createIntegrationRecord(h2Authorized.request, { dispatch: h2Authorized.authorization, createdAt: "2026-08-18T18:20:00.000Z" }));
      github.__authorityVariables.delete(h2Authorized.electionName);
      const h2Anchor = h2Record.dispatch!.anchor_name;
      const h2AnchorValue = github.__authorityVariables.get(h2Anchor);

      await reclaimOrphanIntegrationAuthorityVariables(github, Date.parse("2026-08-18T18:30:00.000Z"), [h2Identity]);
      const h1Names = await installValidHistoricalTransients(github, h1);
      // Simulate cleanup already passed F/A and a delayed B/S producer appearing afterward.
      github.__authorityVariables.delete(h1Names[0]!);
      github.__authorityVariables.delete(h1Names[1]!);
      github.__authorityVariables.delete(h1Names[4]!);
      await reclaimOrphanIntegrationAuthorityVariables(github, Date.parse("2026-08-18T18:31:00.000Z"), [h2Identity]);
      expect(github.__authorityVariables.has(h1Names[2]!)).toBe(false);
      expect(github.__authorityVariables.has(h1Names[3]!)).toBe(false);
      expect(github.__authorityVariables.get(h2Anchor)).toBe(h2AnchorValue);
      expect((await getCurrentIntegrationRecord(github, h2Identity))?.request.request_id).toBe(h2Request.request_id);
    });
  });

  it("does not exhaust transient capacity across more than 64 interrupted head-drift generations", async () => {
    await withHostedAuthority(async () => {
      const github = makeGithub();
      const currentIdentity = {
        prNumber: 540, headSha: "f".repeat(40), baseBranch: "main", baseSha: BASE,
        policyDigest: "sha256:policy", protocolVersion: 1 as const, issueNumber: 7540,
        workId: "work-7540", workSpecDigest: "sha256:spec-current",
      };
      for (let index = 0; index < 65; index += 1) {
        const headChar = (index % 15).toString(16);
        const seeded = await seedHistoricalBound(github, 540, headChar, index.toString(16).padStart(16, "0"), 121000 + index);
        const names = await installValidHistoricalTransients(github, seeded);
        github.__authorityVariables.delete(names[0]!);
        github.__authorityVariables.delete(names[1]!);
        github.__authorityVariables.delete(names[2]!);
        await reclaimOrphanIntegrationAuthorityVariables(github, Date.parse("2026-08-18T19:00:00.000Z") + index, [currentIdentity]);
        expect(names.filter((name) => github.__authorityVariables.has(name))).toEqual([]);
      }
      expect([...github.__authorityVariables.keys()].filter((name) => /^FUGUE_INT_[ABCFS]_/.test(name))).toEqual([]);
    });
  }, 30000);

  it("never turns a historical may-have-dispatched ambiguity into retryable aborted during scavenging", async () => {
    await withHostedAuthority(async () => {
      const github = makeGithub();
      const identity = {
        prNumber: 550, headSha: "9".repeat(40), baseBranch: "main", baseSha: BASE,
        policyDigest: "sha256:policy", protocolVersion: 1 as const, issueNumber: 7550,
        workId: "work-7550", workSpecDigest: "sha256:spec-9",
      };
      const request = createIntegrationRequest(identity, "2026-08-18T18:00:00.000Z", "0000000000000550");
      const secret = "9".repeat(64);
      const authorized = await authorizeIntegrationDispatch(github, request, "2026-08-18T18:00:00.000Z", secret);
      const record = await publishIntegrationRecord(github, createIntegrationRecord(authorized.request, { dispatch: authorized.authorization, createdAt: "2026-08-18T18:00:00.000Z" }));
      github.__authorityVariables.delete(authorized.electionName);
      installProtectedFence(github, record, secret, "2026-08-18T18:00:01.000Z");
      await reclaimOrphanIntegrationAuthorityVariables(github, Date.parse("2026-08-18T18:30:00.000Z"), [{ ...identity, headSha: "a".repeat(40), workSpecDigest: "sha256:spec-a" }]);
      const historical = await getCurrentIntegrationRecord(github, identity);
      expect(historical?.terminal?.state).toBe("identity_lost");
      expect(historical?.terminal?.state).not.toBe("aborted");
    });
  });
});
'''
if 'describe("historical Integration transient cleanup across evaluation drift"' not in s:
    s += addition
p.write_text(s)

# Ensure forbidden/removed out-of-scope files stay absent.
for forbidden in [Path("package-lock.json")]:
    pass
