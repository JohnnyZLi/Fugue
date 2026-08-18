from pathlib import Path
import re

root = Path('work')

def read(path): return (root / path).read_text()
def write(path, text): (root / path).write_text(text)
def replace_once(text, old, new, label):
    if text.count(old) != 1:
        raise SystemExit(f'{label}: expected exactly one match, got {text.count(old)}')
    return text.replace(old, new, 1)

# Durable Integration record vocabulary: identity_lost is the sole terminal outcome allowed without run.id.
p = 'src/core/integration-plan.ts'
s = read(p)
s = replace_once(s,
'''  z.object({\n    state: z.enum(["failure", "error", "aborted"]),\n    detail: z.string(),\n    created_at: z.string().min(1),\n  }),\n]);\n\nexport const integrationRecordSchema = z.object({''',
'''  z.object({\n    state: z.enum(["failure", "error", "aborted"]),\n    detail: z.string(),\n    created_at: z.string().min(1),\n  }),\n  z.object({\n    state: z.literal("identity_lost"),\n    attempt: z.literal(1),\n    boundary_created_at: z.string().min(1),\n    fence_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/i),\n    detail: z.string(),\n    created_at: z.string().min(1),\n  }),\n]);\n\nexport const integrationRecordSchema = z.object({''', 'integration terminal schema')
s = replace_once(s,
'''  terminal: integrationTerminalSchema.nullable(),\n  created_at: z.string().min(1),\n});''',
'''  terminal: integrationTerminalSchema.nullable(),\n  created_at: z.string().min(1),\n}).superRefine((value, context) => {\n  if (value.terminal?.state === "identity_lost" && value.run !== null) {\n    context.addIssue({\n      code: z.ZodIssueCode.custom,\n      path: ["run"],\n      message: "Terminal identity_lost must intentionally omit numeric run identity.",\n    });\n  }\n});''', 'identity_lost run exclusion')
write(p, s)

# State vocabulary and presentation.
p = 'src/core/integration-status.ts'
s = read(p)
s = replace_once(s,
'export type IntegrationState = "none" | "pending" | "success" | "failure" | "error" | "stale";',
'export type IntegrationState = "none" | "pending" | "success" | "failure" | "error" | "identity_lost" | "stale";',
'IntegrationState identity_lost')
s = replace_once(s,
'''  const label = record.terminal?.state === "success" ? "PASS" :\n    record.terminal?.state === "failure" ? "FAILED" :\n    record.terminal?.state === "error" ? "ERROR" :\n    record.terminal?.state === "aborted" ? "ABORTED" : record.run ? "BOUND" : "REQUESTED";''',
'''  const label = record.terminal?.state === "success" ? "PASS" :\n    record.terminal?.state === "failure" ? "FAILED" :\n    record.terminal?.state === "error" ? "ERROR" :\n    record.terminal?.state === "identity_lost" ? "IDENTITY LOST" :\n    record.terminal?.state === "aborted" ? "ABORTED" : record.run ? "BOUND" : "REQUESTED";''',
'identity_lost locator label')
write(p, s)

# Focused hosted recovery transition + cleanup.
p = 'src/core/reconcile.ts'
s = read(p)
s = replace_once(s,
'''  markIntegrationDispatchStarted,\n  reclaimOrphanIntegrationAuthorityVariables,\n  sealIntegrationWorkflowRunEvent,''',
'''  markIntegrationDispatchStarted,\n  reclaimOrphanIntegrationAuthorityVariables,\n  releaseIntegrationAuthorityVariable,\n  sealIntegrationWorkflowRunEvent,''',
'import releaseIntegrationAuthorityVariable')
s = replace_once(s,
'''export type ProtectedIntegrationRecoveryDecision =\n  | { kind: "bind"; runId: number; createdAt: string; htmlUrl: string }\n  | { kind: "pending" }\n  | { kind: "unresolved" };\n\nexport class IntegrationExactRunIdentityUnavailableError extends Error {\n  constructor(message: string) {\n    super(message);\n    this.name = "IntegrationExactRunIdentityUnavailableError";\n  }\n}\n\n/**\n * The hosted lost-bind state machine has no history cursor. Its complete authoritative input is the\n * request-local Authority fence plus, if GitHub created attempt 1, the create-only exact-run witness.\n * Repeated invocations therefore do constant work and can only move fence -> exact witness -> d3 binding,\n * remain pending, or become explicitly unresolved. An unresolved fence is never converted into retry or a\n * terminal record missing the exact run ID; later workflow/deployment/history records cannot replace it.\n */''',
'''export type ProtectedIntegrationRecoveryDecision =\n  | { kind: "bind"; runId: number; createdAt: string; htmlUrl: string }\n  | { kind: "pending" }\n  | { kind: "identity_lost" };\n\n/**\n * Hosted lost-bind recovery does constant request-local work: exact protected evidence wins immediately;\n * an F-only may-have-dispatched boundary waits through one bounded grace interval and then converges to the\n * sole run-ID-optional terminal outcome, identity_lost. It never consults mutable history, retries the\n * ambiguous request, or elects a later run.\n */''',
'recovery decision vocabulary')
s = replace_once(s, '    return { kind: "unresolved" };', '    return { kind: "identity_lost" };', 'decision terminal')
# Clean terminal recovery state on every exact-identity work reconciliation, even when workflow planning is blocked.
s = replace_once(s,
'''      const snapshot = await captureEvaluation(github, work.pr.number);\n      const submissions = await processCurrentSubmissions(github, snapshot);''',
'''      const snapshot = await captureEvaluation(github, work.pr.number);\n      await cleanupTerminalProtectedIntegrationRecovery(github, snapshot);\n      const submissions = await processCurrentSubmissions(github, snapshot);''',
'reconcile terminal cleanup hook')
# Add exported cleanup function immediately after request-local F/B cleanup.
s = replace_once(s,
'''async function cleanupProtectedIntegrationRecovery(github: FugueGitHub, requestId: string): Promise<void> {\n  await deleteFugueAuthorityVariable(github, integrationBindingWitnessName(requestId));\n  await deleteFugueAuthorityVariable(github, integrationDispatchFenceName(requestId));\n}\n\nfunction assertProtectedFenceMatchesRecord(''',
'''async function cleanupProtectedIntegrationRecovery(github: FugueGitHub, requestId: string): Promise<void> {\n  await deleteFugueAuthorityVariable(github, integrationBindingWitnessName(requestId));\n  await deleteFugueAuthorityVariable(github, integrationDispatchFenceName(requestId));\n}\n\nexport async function cleanupTerminalProtectedIntegrationRecovery(\n  github: FugueGitHub,\n  snapshot: Awaited<ReturnType<typeof captureEvaluation>>,\n): Promise<boolean> {\n  const current = await getCurrentIntegrationRecord(github, snapshot.identity);\n  if (!current || current.terminal?.state !== "identity_lost") return false;\n  // Durable d3 terminal authority already exists. Every delete below is request-specific and idempotent;\n  // a crash at any point can only leave redundant transient state for the next reconciliation to remove.\n  await releaseIntegrationAuthorityVariable(github, current);\n  await cleanupProtectedIntegrationRecovery(github, current.request.request_id);\n  return true;\n}\n\nfunction protectedIntegrationFenceDigest(fence: ProtectedIntegrationDispatchFence): string {\n  return `sha256:${createHash("sha256").update(JSON.stringify(fence), "utf8").digest("hex")}`;\n}\n\nfunction assertProtectedFenceMatchesRecord(''',
'cleanup helper')
# Replace the recovery function wholesale from signature through the next function declaration.
start = s.index('async function recoverExistingProtectedIntegration(')
end = s.index('\nasync function createProtectedIntegrationDispatchFence(', start)
new_recover = '''export async function recoverExistingProtectedIntegration(\n  github: FugueGitHub,\n  snapshot: Awaited<ReturnType<typeof captureEvaluation>>,\n  now: number,\n): Promise<boolean> {\n  const actorId = integrationAuthorityActorId();\n  if (actorId === undefined) return false;\n  let current = await getCurrentIntegrationRecord(github, snapshot.identity);\n  if (!current) return false;\n  if (current.terminal) {\n    if (current.terminal.state === "identity_lost") {\n      await releaseIntegrationAuthorityVariable(github, current);\n      await cleanupProtectedIntegrationRecovery(github, current.request.request_id);\n    }\n    return true;\n  }\n  if (current.run) {\n    await cleanupProtectedIntegrationRecovery(github, current.request.request_id);\n    return true;\n  }\n\n  const start = await getIntegrationRunStartEvidence(github, current);\n  if (start) {\n    await bindIntegrationRun(github, snapshot, current.request.request_id, start.run_id);\n    await cleanupProtectedIntegrationRecovery(github, current.request.request_id);\n    return true;\n  }\n\n  const fence = await readProtectedIntegrationDispatchFence(github, current.request.request_id);\n  // No F means the protected caller never crossed the may-have-dispatched boundary. The older\n  // provably-pre-POST path remains separate; identity_lost is reserved for an existing protected F.\n  if (!fence) return false;\n  assertProtectedFenceMatchesRecord(fence, current, actorId);\n  let witness = await readProtectedIntegrationBindingWitness(github, current.request.request_id);\n  if (witness) assertProtectedWitnessMatchesFence(witness, fence, github);\n\n  const decision = protectedIntegrationRecoveryDecision({\n    requestCreatedAt: current.request.created_at,\n    dispatchStartedAt: current.dispatch_started_at,\n    fenceCreatedAt: fence.created_at,\n    witness: witness ? { runId: witness.run_id, createdAt: witness.run_created_at, htmlUrl: witness.html_url } : undefined,\n    now,\n  });\n  if (decision.kind === "bind") {\n    await bindDispatchedIntegrationRun(\n      github, snapshot, current.request.request_id, decision.runId, decision.htmlUrl, decision.createdAt,\n    );\n    await cleanupProtectedIntegrationRecovery(github, current.request.request_id);\n    return true;\n  }\n  if (decision.kind === "pending") {\n    if (!current.dispatch_started_at) {\n      await markIntegrationDispatchStarted(github, snapshot, current.request.request_id, fence.created_at);\n    }\n    return true;\n  }\n\n  if (!current.dispatch_started_at) {\n    current = await markIntegrationDispatchStarted(github, snapshot, current.request.request_id, fence.created_at);\n  }\n\n  // Give every attacker-resistant exact-L source one final request-local read before committing the\n  // irreversible exception. Any genuine exact evidence observed here wins over identity_lost.\n  const finalStart = await getIntegrationRunStartEvidence(github, current);\n  if (finalStart) {\n    await bindIntegrationRun(github, snapshot, current.request.request_id, finalStart.run_id);\n    await cleanupProtectedIntegrationRecovery(github, current.request.request_id);\n    return true;\n  }\n  witness = await readProtectedIntegrationBindingWitness(github, current.request.request_id);\n  if (witness) {\n    assertProtectedWitnessMatchesFence(witness, fence, github);\n    await bindDispatchedIntegrationRun(\n      github, snapshot, current.request.request_id, witness.run_id, witness.html_url, witness.run_created_at,\n    );\n    await cleanupProtectedIntegrationRecovery(github, current.request.request_id);\n    return true;\n  }\n\n  const terminalAt = new Date(now).toISOString();\n  const terminal = await publishIntegrationRecord(github, {\n    ...current,\n    dispatch_started_at: current.dispatch_started_at ?? fence.created_at,\n    run: null,\n    terminal: {\n      state: "identity_lost",\n      attempt: 1,\n      boundary_created_at: fence.created_at,\n      fence_digest: protectedIntegrationFenceDigest(fence),\n      detail: "Protected dispatch may have created attempt 1, but the synchronous returned run identity and every attacker-resistant exact-run witness are unavailable; this request is terminal and requires explicit Human action for any fresh Integration.",\n      created_at: terminalAt,\n    },\n    created_at: terminalAt,\n  });\n  // Cleanup is strictly post-commit. If either delete crashes, the next work reconciliation sees the\n  // same irreversible d3 terminal and resumes these idempotent request-specific deletions.\n  await releaseIntegrationAuthorityVariable(github, terminal);\n  await cleanupProtectedIntegrationRecovery(github, terminal.request.request_id);\n  return true;\n}\n'''
s = s[:start] + new_recover + s[end:]
# A successful POST with a lost/malformed synchronous identity now remains pending for bounded F/B/start recovery.
s = replace_once(s,
'''  // The POST succeeded but the exact synchronous identity did not survive. F remains create-only and\n  // prevents redispatch; requested/completed B or the OIDC run-start may still recover the exact L.\n  throw new IntegrationExactRunIdentityUnavailableError(\n    `Protected Integration dispatch for ${requestId} succeeded without a valid exact returned run identity; the dispatch fence is retained.`,\n  );''',
'''  // The POST succeeded but the exact synchronous identity did not survive. F remains create-only and\n  // prevents redispatch; B/run-start may still recover exact L through grace, otherwise F converges to\n  // durable terminal identity_lost on a later reconciliation.\n  return;''',
'lost synchronous response handling')
s = replace_once(s,
'''  if (actorId !== undefined) {\n    const existing = await getCurrentIntegrationRecord(github, snapshot.identity);\n    if (existing && !existing.terminal) {\n      if (await recoverExistingProtectedIntegration(github, snapshot, now)) return;\n      // No F/B/start/run exists: this remains the canonical pre-POST recovery path.\n    }\n  }''',
'''  if (actorId !== undefined) {\n    const existing = await getCurrentIntegrationRecord(github, snapshot.identity);\n    if (existing && await recoverExistingProtectedIntegration(github, snapshot, now)) return;\n    // No F/B/start/run exists: this remains the canonical provably-pre-POST recovery path.\n  }''',
'dispatch existing recovery')
write(p, s)

# Workflow planning must fail closed and never report merge-ready for identity_lost.
p = 'src/core/workflow.ts'
s = read(p)
s = replace_once(s,
'''  if (observation.integration === "failure" || observation.integration === "error") {\n    return { kind: "blocked", reason: `Integration is ${observation.integration}; inspect durable evidence before retrying.` };\n  }''',
'''  if (observation.integration === "identity_lost") {\n    return { kind: "blocked", reason: "Integration attempt-1 identity is durably lost; explicit Human action is required to authorize a fresh Integration request." };\n  }\n  if (observation.integration === "failure" || observation.integration === "error") {\n    return { kind: "blocked", reason: `Integration is ${observation.integration}; inspect durable evidence before retrying.` };\n  }''',
'workflow identity_lost block')
write(p, s)

# AGENTS invariant 30: revised Human-approved exception, no mutable authority fallback.
p = 'AGENTS.md'
s = read(p)
old = re.search(r'^30\. Protected Integration .*?(?=^31\.)', s, flags=re.M|re.S)
if not old: raise SystemExit('AGENTS invariant 30 not found')
new = '''30. Protected Integration never treats Deployment, Deployment Status, mutable workflow-run/history pagination, actor/login presentation, environment/ref/SHA matching, or the public request/token/title as run-selection authority. Before POST, protected Authority creates a request-specific create-only `FUGUE_INT_F_*` may-have-dispatched fence. The API `2026-03-10` synchronous dispatch uses `return_run_details: true`; a valid exact returned run ID/URL is bound to d3 immediately. Independently, protected `workflow_run` lifecycle delivery authenticated to the Authority App numeric Bot identity may create one request-specific create-only `FUGUE_INT_B_*` exact-run witness, and the Integration workflow can later create its OIDC-signed run-start. Any surviving exact witness binds only its real request/run/attempt and always wins before terminalization; later replay cannot replace it, and a known bound run that disappears remains exact terminal failure after grace. If F exists but the synchronous response and every attacker-resistant exact-run witness are unavailable/destroyed through the bounded grace period, the revised protocol commits terminal `identity_lost`: exact request ID, attempt 1, exact evaluation identity, protected F-boundary digest/time, and outcome are durable, while numeric run ID is intentionally absent only for this outcome. `identity_lost` is irreversible, never PASS/merge-ready/retry/replacement/later-run election, and any fresh Integration requires explicit Human action/new request. Request-specific F/B/anchor/run-start state is reclaimed only after durable terminal authority commits; cleanup is idempotent and resumed by later reconciliation without changing terminal authority.\n'''
s = s[:old.start()] + new + s[old.end():]
write(p, s)

# README revised lifecycle and information-loss contract.
p = 'README.md'
s = read(p)
s = s.replace('''d3 durable Integration record on candidate head\n    exact request ID, one protected run ID / attempt 1, and terminal result''',
'''d3 durable Integration record on candidate head\n    exact request ID, attempt 1, and terminal result; numeric run ID is omitted only for terminal identity_lost''')
s = s.replace('''TERMINAL\n    protected Fugue commits PASS/failure/error to the d3 Integration record first\n    then writes presentation attestation comment / fugue/integration status''',
'''TERMINAL\n    protected Fugue commits PASS/failure/error or the sole run-ID-optional identity_lost outcome\n    to the d3 Integration record first, then writes presentation mirrors''')
old_para = '''If no pre-dispatch fence exists, the existing pre-POST no-run recovery may safely abort/retry after grace. Once F exists, the request can never be redispatched or replaced. A returned binding, B witness, or OIDC run-start establishes exact L; deletion of that Actions run then fails closed to terminal failure while preserving its run ID. There is one explicit information-loss boundary: if GitHub creates L, the synchronous response is lost, and `actions:write` prevents every protected exact-run witness before deleting L, only the may-have-dispatched fence survives. No GitHub-only trusted record then contains L's numeric run ID, so Fugue remains unresolved rather than inventing a terminal run or consulting attacker-writable history. Full liveness for that literal sequence requires an atomic create-and-durable-bind primitive or an attacker-independent durable observer.'''
new_para = '''If no pre-dispatch fence exists, the existing provably-pre-POST no-run recovery may safely abort/retry after grace. Once F exists, the ambiguous request can never be redispatched or replaced. A returned binding, B witness, or OIDC run-start establishes exact L and always wins before terminalization; deletion of that known Actions run then fails closed to terminal failure while preserving its run ID. If F survives but the synchronous response and every attacker-resistant exact-run witness are unavailable or destroyed through bounded grace—including the indistinguishable crash immediately before POST—the revised protocol commits terminal `identity_lost`. That protected d3 terminal carries the exact request/evaluation identity, attempt 1, and F-boundary digest/time, deliberately omits numeric run ID, is never PASS or merge-ready, never retries/elects a later run, and requires explicit Human action for any fresh Integration. Only after the terminal commit are request-specific F/B/anchor/run-start slots reclaimed, with idempotent reconciliation completing cleanup after crashes.'''
if old_para not in s: raise SystemExit('README information-loss paragraph not found')
s = s.replace(old_para, new_para)
s = s.replace('Integration additionally binds its exact request ID, protected workflow-run ID, and attempt 1.',
'''Integration additionally binds its exact request ID and attempt 1. Known-run outcomes also bind the protected workflow-run ID; terminal `identity_lost` is the sole intentional run-ID exception.''')
write(p, s)

# Leader recovery guidance: remove stale Deployment authority prose and permanent unresolved wedge.
p = 'docs/leader-chat.md'
s = read(p)
s = s.replace('''- The protected `prepare` job references `fugue-authority` with an environment URL carrying only the request ID, correlation token, and exact `GITHUB_RUN_ID`. GitHub persists the corresponding deployment/status before the first in-job environment audit or Authority App token mint, so attempt identity survives a crash plus shared Actions deletion before d3/run-start binding. The job then proves the capability and creates the request-specific OIDC-signed run-start record. Live Authority names are never PATCHed or reused; stale cleanup is request-specific, repository-wide reconciliation scavenges aged pre-d3 orphan anchors, and d3-bound/terminal requests reclaim only their own transient records.\n- Workflow-run enumeration is not binding authority. Lost-bind recovery derives the correlation token from the one-use protected anchor, requires two identical complete scans of the protected `fugue-authority` deployment history, and binds the globally lowest matching run ID. Later same-request flooding or deletion-shifted workflow-run pages therefore cannot change first-run identity.''',
'''- Before dispatch, protected Authority creates request-local create-only `FUGUE_INT_F_*` may-have-dispatched authority. The synchronous `return_run_details: true` response is the primary exact binding; request-local Authority-App `FUGUE_INT_B_*` and OIDC run-start evidence are independent protected exact-L recovery sources. Live Authority names are never PATCHed or reused.\n- Deployment/Deployment Status and workflow-run/history enumeration are never binding authority. Recovery reads only request-local protected exact evidence, so later same-request flooding, deletion, or page shifting cannot elect or replace L.''')
s = s.replace('''- If no pre-dispatch fence exists, genuinely pre-POST transport may recover with a **new request ID** after grace. Once the create-only fence exists, retry/replacement is forbidden. If the exact run ID was lost before every protected witness and the run was deleted, Fugue reports the request as unresolved rather than fabricating a terminal run ID or consulting mutable history.''',
'''- If no pre-dispatch fence exists, provably pre-POST transport may recover with a **new request ID** after grace. Once the create-only fence exists, automatic retry/replacement is forbidden. Exact B/run-start/returned evidence always binds L if it survives before terminalization. If F remains but exact run identity is unavailable through bounded grace, Fugue commits irreversible terminal `identity_lost` with request/evaluation identity, attempt 1, and F-boundary evidence but intentionally no numeric run ID. A fresh Integration then requires explicit Human action/new request.''')
s = s.replace('''If L was created but its synchronous response and every protected exact-run witness were prevented/lost before an `actions:write` adversary deleted L, the surviving trusted state has no numeric run ID; Fugue remains unresolved and never retries/fabricates authority. This is an explicit GitHub-only information-loss limitation, not a mutable-history fallback.''',
'''If F crosses the may-have-dispatched boundary but the synchronous response and every attacker-resistant exact-run witness are unavailable through grace, Fugue commits terminal `identity_lost` instead of wedging or consulting mutable history. That outcome never becomes PASS, retry, replacement, or later-run election; request-specific Authority slots are reclaimed only after the durable terminal commits, and crash recovery resumes cleanup without altering it.''')
write(p, s)

# Focused adversarial regressions.
p = 'tests/state-authority-blockers.test.ts'
s = read(p)
s = replace_once(s,
'import { ingestCoordinatorIssueEvent, protectedIntegrationRecoveryDecision } from "../src/core/reconcile.js";',
'import { cleanupTerminalProtectedIntegrationRecovery, ingestCoordinatorIssueEvent, protectedIntegrationRecoveryDecision, recoverExistingProtectedIntegration } from "../src/core/reconcile.js";',
'test reconcile imports')
s = replace_once(s,
'import { createIntegrationRecord, createIntegrationRequest } from "../src/core/integration-plan.js";',
'import { createIntegrationRecord, createIntegrationRequest, type IntegrationRecord } from "../src/core/integration-plan.js";',
'test IntegrationRecord import')
helper = r'''
const TEST_AUTHORITY_ACTOR_ID = 424242;

function protectedRecoveryNames(requestId: string): { fence: string; binding: string } {
  const suffix = createHash("sha256").update(requestId, "utf8").digest("hex").slice(0, 32).toUpperCase();
  return { fence: `FUGUE_INT_F_${suffix}`, binding: `FUGUE_INT_B_${suffix}` };
}

function installProtectedFence(
  github: TestGithub,
  record: IntegrationRecord,
  secret: string,
  createdAt: string,
): { raw: string; runToken: string; fence: Record<string, unknown>; names: { fence: string; binding: string } } {
  if (!record.dispatch) throw new Error("test request lacks dispatch authorization");
  const runToken = integrationDispatchRunToken(record.request.request_id, secret);
  const fence = {
    version: 1,
    kind: "integration_dispatch_fence",
    request_id: record.request.request_id,
    pr_number: record.identity.prNumber,
    head_sha: record.identity.headSha,
    base_sha: record.identity.baseSha,
    anchor_name: record.dispatch.anchor_name,
    secret_digest: record.dispatch.secret_digest,
    run_token: runToken,
    authority_actor_id: TEST_AUTHORITY_ACTOR_ID,
    created_at: createdAt,
  };
  const raw = JSON.stringify(fence);
  const names = protectedRecoveryNames(record.request.request_id);
  github.__authorityVariables.set(names.fence, raw);
  return { raw, runToken, fence, names };
}

function installProtectedBinding(
  github: TestGithub,
  record: IntegrationRecord,
  fence: Record<string, unknown>,
  runId: number,
  runCreatedAt: string,
): string {
  const names = protectedRecoveryNames(record.request.request_id);
  const htmlUrl = `https://github.com/JohnnyZLi/Fugue/actions/runs/${runId}`;
  github.__authorityVariables.set(names.binding, JSON.stringify({
    version: 1,
    kind: "integration_binding_witness",
    request_id: record.request.request_id,
    pr_number: record.identity.prNumber,
    head_sha: record.identity.headSha,
    base_sha: record.identity.baseSha,
    anchor_name: record.dispatch?.anchor_name,
    run_token: fence.run_token,
    authority_actor_id: TEST_AUTHORITY_ACTOR_ID,
    run_id: runId,
    run_attempt: 1,
    run_created_at: runCreatedAt,
    html_url: htmlUrl,
  }));
  return htmlUrl;
}

async function withHostedAuthority<T>(callback: () => Promise<T>): Promise<T> {
  const oldToken = process.env.FUGUE_AUTHORITY_TOKEN;
  const oldActor = process.env.FUGUE_AUTHORITY_ACTOR_ID;
  process.env.FUGUE_AUTHORITY_TOKEN = "test-authority-token";
  process.env.FUGUE_AUTHORITY_ACTOR_ID = String(TEST_AUTHORITY_ACTOR_ID);
  try { return await callback(); }
  finally {
    if (oldToken === undefined) delete process.env.FUGUE_AUTHORITY_TOKEN; else process.env.FUGUE_AUTHORITY_TOKEN = oldToken;
    if (oldActor === undefined) delete process.env.FUGUE_AUTHORITY_ACTOR_ID; else process.env.FUGUE_AUTHORITY_ACTOR_ID = oldActor;
  }
}
'''
# Insert helpers before the first describe block.
idx = s.find('describe(')
if idx < 0: raise SystemExit('describe not found')
s = s[:idx] + helper + '\n' + s[idx:]

tests = r'''
  it("terminalizes lost returned run identity as durable identity_lost and rejects later replay", async () => {
    await withHostedAuthority(async () => {
      const github = makeGithub();
      const identity = {
        prNumber: 19, headSha: "d".repeat(40), baseBranch: "main", baseSha: BASE,
        policyDigest: "sha256:policy", protocolVersion: 1 as const, issueNumber: 18, workId: "work-18",
        workSpecDigest: "sha256:revised-spec",
      };
      const snapshot = { identity, pr: { number: 19 } } as unknown as EvaluationSnapshot;
      const request = createIntegrationRequest(identity, "2026-08-17T10:00:00.000Z", "a".repeat(16));
      const secret = "b".repeat(64);
      const authorized = await authorizeIntegrationDispatch(github, request, "2026-08-17T10:00:00.000Z", secret);
      let record = await publishIntegrationRecord(github, createIntegrationRecord(authorized.request, {
        dispatch: authorized.authorization, createdAt: "2026-08-17T10:00:00.000Z",
      }));
      github.__authorityVariables.delete(authorized.electionName);
      const protectedFence = installProtectedFence(github, record, secret, "2026-08-17T10:00:01.000Z");

      // Model POST creating L, loss of the synchronous response/process, suppression of every
      // protected exact-run consumer, and Actions deletion of L before run-start. Only F survives.
      await expect(recoverExistingProtectedIntegration(
        github, snapshot, Date.parse("2026-08-17T10:05:00.000Z"),
      )).resolves.toBe(true);
      expect((await getCurrentIntegrationRecord(github, identity))?.terminal).toBeNull();

      await expect(recoverExistingProtectedIntegration(
        github, snapshot, Date.parse("2026-08-17T10:11:00.000Z"),
      )).resolves.toBe(true);
      record = (await getCurrentIntegrationRecord(github, identity))!;
      expect(record.run).toBeNull();
      expect(record.terminal).toMatchObject({
        state: "identity_lost",
        attempt: 1,
        boundary_created_at: "2026-08-17T10:00:01.000Z",
        fence_digest: `sha256:${createHash("sha256").update(protectedFence.raw, "utf8").digest("hex")}`,
      });
      expect(record.request.request_id).toBe(request.request_id);
      expect(record.identity).toEqual(identity);
      await expect(ensureIntegrationDispatch(github, snapshot, Date.parse("2026-08-17T10:30:00.000Z")))
        .resolves.toEqual({ request: record.request, dispatch: false });
      expect(github.__authorityVariables.has(protectedFence.names.fence)).toBe(false);
      expect(github.__authorityVariables.has(protectedFence.names.binding)).toBe(false);

      github.__comments.splice(0);
      github.__statuses.splice(0);
      github.__workflowRuns.splice(0);
      expect((await getCurrentIntegrationRecord(github, identity))?.terminal?.state).toBe("identity_lost");

      const A = {
        id: 99002, actor: BOT, event: "workflow_dispatch", head_sha: BASE,
        display_title: `Fugue Integration PR #19 ${request.request_id} ${protectedFence.runToken}`,
        created_at: "2026-08-17T10:20:00.000Z", run_attempt: 1, status: "completed", conclusion: "success",
        html_url: "https://github.com/JohnnyZLi/Fugue/actions/runs/99002",
      };
      github.__workflowRuns.push(A);
      await expect(sealIntegrationWorkflowRunEvent(github, {
        eventName: "workflow_run", workflowName: "Fugue Integration", runId: A.id, runAttempt: 1,
        conclusion: A.conclusion, status: A.status, headSha: BASE, displayTitle: A.display_title,
        createdAt: A.created_at, htmlUrl: A.html_url, actor: BOT.login,
      })).resolves.toBe(false);
      const afterReplay = await getCurrentIntegrationRecord(github, identity);
      expect(afterReplay?.run).toBeNull();
      expect(afterReplay?.terminal?.state).toBe("identity_lost");
    });
  });

  it("binds surviving protected exact L before identity_lost terminalization", async () => {
    await withHostedAuthority(async () => {
      const github = makeGithub();
      const identity = {
        prNumber: 20, headSha: "e".repeat(40), baseBranch: "main", baseSha: BASE,
        policyDigest: "sha256:policy", protocolVersion: 1 as const, issueNumber: 18, workId: "work-18",
        workSpecDigest: "sha256:revised-spec",
      };
      const snapshot = { identity, pr: { number: 20 } } as unknown as EvaluationSnapshot;
      const request = createIntegrationRequest(identity, "2026-08-17T11:00:00.000Z", "c".repeat(16));
      const secret = "d".repeat(64);
      const authorized = await authorizeIntegrationDispatch(github, request, "2026-08-17T11:00:00.000Z", secret);
      const record = await publishIntegrationRecord(github, createIntegrationRecord(authorized.request, {
        dispatch: authorized.authorization, createdAt: "2026-08-17T11:00:00.000Z",
      }));
      github.__authorityVariables.delete(authorized.electionName);
      const protectedFence = installProtectedFence(github, record, secret, "2026-08-17T11:00:01.000Z");
      const htmlUrl = installProtectedBinding(github, record, protectedFence.fence, 99101, "2026-08-17T11:00:02.000Z");

      await expect(recoverExistingProtectedIntegration(
        github, snapshot, Date.parse("2026-08-17T11:30:00.000Z"),
      )).resolves.toBe(true);
      const bound = await getCurrentIntegrationRecord(github, identity);
      expect(bound?.run).toMatchObject({ id: 99101, attempt: 1, html_url: htmlUrl });
      expect(bound?.terminal).toBeNull();
      expect(github.__authorityVariables.has(protectedFence.names.fence)).toBe(false);
      expect(github.__authorityVariables.has(protectedFence.names.binding)).toBe(false);
    });
  });

  it("converges an F-only pre-POST ambiguity deterministically instead of remaining unresolved", async () => {
    await withHostedAuthority(async () => {
      const github = makeGithub();
      const identity = {
        prNumber: 21, headSha: "1".repeat(40), baseBranch: "main", baseSha: BASE,
        policyDigest: "sha256:policy", protocolVersion: 1 as const, issueNumber: 18, workId: "work-18",
        workSpecDigest: "sha256:revised-spec",
      };
      const snapshot = { identity, pr: { number: 21 } } as unknown as EvaluationSnapshot;
      const request = createIntegrationRequest(identity, "2026-08-17T12:00:00.000Z", "e".repeat(16));
      const secret = "f".repeat(64);
      const authorized = await authorizeIntegrationDispatch(github, request, "2026-08-17T12:00:00.000Z", secret);
      const record = await publishIntegrationRecord(github, createIntegrationRecord(authorized.request, {
        dispatch: authorized.authorization, createdAt: "2026-08-17T12:00:00.000Z",
      }));
      github.__authorityVariables.delete(authorized.electionName);
      installProtectedFence(github, record, secret, "2026-08-17T12:00:01.000Z");

      for (let index = 0; index < 8; index += 1) {
        await expect(recoverExistingProtectedIntegration(
          github, snapshot, Date.parse("2026-08-17T12:05:00.000Z"),
        )).resolves.toBe(true);
        expect((await getCurrentIntegrationRecord(github, identity))?.terminal).toBeNull();
      }
      await expect(recoverExistingProtectedIntegration(
        github, snapshot, Date.parse("2026-08-17T12:11:00.000Z"),
      )).resolves.toBe(true);
      const firstTerminal = (await getCurrentIntegrationRecord(github, identity))!;
      expect(firstTerminal.terminal?.state).toBe("identity_lost");
      for (let index = 0; index < 12; index += 1) {
        await expect(recoverExistingProtectedIntegration(
          github, snapshot, Date.parse("2026-08-17T12:30:00.000Z") + index,
        )).resolves.toBe(true);
        expect(await getCurrentIntegrationRecord(github, identity)).toEqual(firstTerminal);
      }
    });
  });

  it("reclaims Authority slots across more than 64 sequential identity_lost requests", async () => {
    await withHostedAuthority(async () => {
      const github = makeGithub();
      for (let index = 0; index < 65; index += 1) {
        const identity = {
          prNumber: 100 + index,
          headSha: index.toString(16).padStart(40, "0"), baseBranch: "main", baseSha: BASE,
          policyDigest: "sha256:policy", protocolVersion: 1 as const, issueNumber: 1000 + index,
          workId: `work-${1000 + index}`, workSpecDigest: "sha256:revised-spec",
        };
        const snapshot = { identity, pr: { number: identity.prNumber } } as unknown as EvaluationSnapshot;
        const nonce = index.toString(16).padStart(16, "0");
        const request = createIntegrationRequest(identity, "2026-08-17T13:00:00.000Z", nonce);
        const secret = (index + 1).toString(16).padStart(64, "0");
        const authorized = await authorizeIntegrationDispatch(github, request, "2026-08-17T13:00:00.000Z", secret);
        const record = await publishIntegrationRecord(github, createIntegrationRecord(authorized.request, {
          dispatch: authorized.authorization, createdAt: "2026-08-17T13:00:00.000Z",
        }));
        github.__authorityVariables.delete(authorized.electionName);
        installProtectedFence(github, record, secret, "2026-08-17T13:00:01.000Z");
        await recoverExistingProtectedIntegration(github, snapshot, Date.parse("2026-08-17T13:11:00.000Z"));
        expect((await getCurrentIntegrationRecord(github, identity))?.terminal?.state).toBe("identity_lost");
        const transient = [...github.__authorityVariables.keys()].filter((name) =>
          /^FUGUE_INT_[ABFS]_/.test(name));
        expect(transient).toEqual([]);
      }
    });
  }, 30000);

  it("resumes crash-interrupted identity_lost cleanup without changing terminal authority", async () => {
    await withHostedAuthority(async () => {
      const github = makeGithub();
      const identity = {
        prNumber: 22, headSha: "2".repeat(40), baseBranch: "main", baseSha: BASE,
        policyDigest: "sha256:policy", protocolVersion: 1 as const, issueNumber: 18, workId: "work-18",
        workSpecDigest: "sha256:revised-spec",
      };
      const snapshot = { identity, pr: { number: 22 } } as unknown as EvaluationSnapshot;
      const request = createIntegrationRequest(identity, "2026-08-17T14:00:00.000Z", "1".repeat(16));
      const secret = "2".repeat(64);
      const authorized = await authorizeIntegrationDispatch(github, request, "2026-08-17T14:00:00.000Z", secret);
      let record = await publishIntegrationRecord(github, createIntegrationRecord(authorized.request, {
        dispatch: authorized.authorization, createdAt: "2026-08-17T14:00:00.000Z",
      }));
      github.__authorityVariables.delete(authorized.electionName);
      const protectedFence = installProtectedFence(github, record, secret, "2026-08-17T14:00:01.000Z");

      // Simulate a crash immediately after durable terminal commit, before F/B cleanup.
      const terminalAt = "2026-08-17T14:11:00.000Z";
      record = await publishIntegrationRecord(github, {
        ...record,
        dispatch_started_at: protectedFence.fence.created_at as string,
        run: null,
        terminal: {
          state: "identity_lost", attempt: 1,
          boundary_created_at: protectedFence.fence.created_at as string,
          fence_digest: `sha256:${createHash("sha256").update(protectedFence.raw, "utf8").digest("hex")}`,
          detail: "simulated post-commit cleanup crash", created_at: terminalAt,
        },
        created_at: terminalAt,
      });
      expect(github.__authorityVariables.has(protectedFence.names.fence)).toBe(true);
      const durableBefore = await getCurrentIntegrationRecord(github, identity);

      // Model partial cleanup/late redundant B, then let reconciliation finish idempotently.
      installProtectedBinding(github, record, protectedFence.fence, 99222, "2026-08-17T14:00:02.000Z");
      github.__authorityVariables.delete(protectedFence.names.fence);
      await expect(cleanupTerminalProtectedIntegrationRecovery(github, snapshot)).resolves.toBe(true);
      expect(github.__authorityVariables.has(protectedFence.names.binding)).toBe(false);
      expect(await getCurrentIntegrationRecord(github, identity)).toEqual(durableBefore);
      await expect(cleanupTerminalProtectedIntegrationRecovery(github, snapshot)).resolves.toBe(true);
      expect(await getCurrentIntegrationRecord(github, identity)).toEqual(durableBefore);
    });
  });
'''
# Insert before final describe close.
pos = s.rfind('\n});')
if pos < 0: raise SystemExit('final describe close not found')
s = s[:pos] + '\n' + tests + s[pos:]
write(p, s)

print('focused identity_lost transform applied')
