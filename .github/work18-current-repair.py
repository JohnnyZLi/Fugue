from pathlib import Path
import re

root = Path(__import__('sys').argv[1])

def read(path): return (root / path).read_text()
def write(path, text): (root / path).write_text(text)
def once(text, old, new, label):
    if old not in text: raise RuntimeError(f'missing patch anchor: {label}')
    if text.count(old) != 1: raise RuntimeError(f'non-unique patch anchor {label}: {text.count(old)}')
    return text.replace(old, new)

def sub_once(text, pattern, repl, label, flags=re.S):
    out, n = re.subn(pattern, repl, text, count=1, flags=flags)
    if n != 1: raise RuntimeError(f'expected one regex patch {label}, got {n}')
    return out

# ---------------------------------------------------------------------------
# Submission provenance + bounded semantic rejection progress.
# ---------------------------------------------------------------------------
p = 'src/core/submissions.ts'
s = read(p)
s = once(s,
'''const submissionRejectionSchema = z.object({
  version: z.literal(1),
  comment_ids: z.array(z.number().int().positive()).min(1),
});

const submissionRejectionProgressSchema = z.object({
  version: z.literal(1),
  kind: z.literal("submission_rejection_progress"),
  identity: evaluationIdentitySchema,
  sequence: z.number().int().nonnegative(),
  comment_ids: z.array(z.number().int().positive()),
  fingerprints: z.array(z.string().regex(/^sha256:[0-9a-f]{64}$/)),
  created_at: z.string().min(1),
});

type SubmissionRejectionProgress = z.infer<typeof submissionRejectionProgressSchema>;
''',
'''const legacySubmissionRejectionProgressSchema = z.object({
  version: z.literal(1),
  kind: z.literal("submission_rejection_progress"),
  identity: evaluationIdentitySchema,
  sequence: z.number().int().nonnegative(),
  comment_ids: z.array(z.number().int().positive()),
  fingerprints: z.array(z.string().regex(/^sha256:[0-9a-f]{64}$/)),
  created_at: z.string().min(1),
});

const SUBMISSION_REJECTION_BLOOM_BYTES = 256;
const submissionRejectionProgressV2Schema = z.object({
  version: z.literal(2),
  kind: z.literal("submission_rejection_progress"),
  identity: evaluationIdentitySchema,
  sequence: z.number().int().nonnegative(),
  bloom_b64: z.string().min(1).max(512).refine(
    (value) => Buffer.from(value, "base64url").length === SUBMISSION_REJECTION_BLOOM_BYTES,
    "Invalid bounded Fugue submission-rejection bloom filter.",
  ),
  created_at: z.string().min(1),
});

const submissionRejectionProgressSchema = z.union([
  legacySubmissionRejectionProgressSchema,
  submissionRejectionProgressV2Schema,
]);

type SubmissionRejectionProgress = z.infer<typeof submissionRejectionProgressSchema>;
''', 'rejection schemas')
s = once(s,
'''interface SubmissionComment extends GitHubCommentLike {
  id: number;
  body?: string | null;
}
''',
'''interface SubmissionComment extends GitHubCommentLike {
  id: number;
  node_id?: string;
  body?: string | null;
}
''', 'submission comment node id')

start = s.index('export async function processCurrentSubmissions(')
end = s.index('export async function recordHumanControlPlaneAcknowledgement(', start)
new_process = r'''export async function processCurrentSubmissions(
  github: FugueGitHub,
  snapshot: EvaluationSnapshot,
): Promise<SubmissionProcessingResult> {
  const { owner, repo } = github.repository;
  const comments = await github.octokit.paginate(github.octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number: snapshot.pr.number,
    per_page: 100,
  }) as SubmissionComment[];

  let progress = await recoverSubmissionRejectionProgress(github, snapshot);
  const ignored = new Set<number>();

  const reject = async (commentIds: number[], semanticKey: string, reason: string): Promise<boolean> => {
    for (const id of commentIds) ignored.add(id);
    if (rejectionProgressContains(progress, semanticKey)) return false;
    progress = await recordSubmissionRejectionProgress(github, snapshot, semanticKey);
    try {
      await rejectSubmissions(github, snapshot.pr.number, commentIds, reason);
    } catch {
      // The fixed-size d3 semantic filter is authority. Receipt publication is presentation only.
    }
    return true;
  };

  const qaInputs: Array<SubmissionInput<QaSubmission>> = [];
  const humanInputs: Array<SubmissionInput<HumanSubmission>> = [];

  for (const comment of comments) {
    const body = comment.body ?? "";
    const hasQa = body.includes(REVIEW_START);
    const hasHuman = body.includes(HUMAN_START);
    if (!hasQa && !hasHuman) continue;
    const kind = hasQa && hasHuman ? "mixed" : hasQa ? "qa" : "human";
    const actor = comment.user?.login ?? "";

    if (!(await hasImmutableSubmissionProvenance(github, comment))) {
      if (await reject(
        [comment.id],
        semanticRejectionKey("edited-or-unverifiable", kind),
        "Edited or provenance-unverifiable GitHub comments are not authoritative Fugue submissions; submit a fresh immutable comment.",
      )) return { accepted: 1 };
      continue;
    }

    if (!actor) {
      if (await reject(
        [comment.id],
        semanticRejectionKey("missing-actor", kind),
        "Submission has no attributable GitHub actor.",
      )) return { accepted: 1 };
      continue;
    }

    try {
      const qa = parseQaSubmission(body);
      if (qa) qaInputs.push({ submission: qa, actor, commentId: comment.id });
      const human = parseHumanSubmission(body);
      if (human) humanInputs.push({ submission: human, actor, commentId: comment.id });
    } catch (error) {
      if (await reject(
        [comment.id],
        semanticRejectionKey("malformed", kind),
        `Malformed Fugue submission: ${message(error)}`,
      )) return { accepted: 1 };
    }
  }

  let accepted = 0;
  const activities = await currentReviewActivities(github, snapshot);

  for (const input of qaInputs) {
    const activity = activities.get(input.submission.role);
    if (activity?.completed?.session_id === input.submission.session_id) continue;
    if (activity?.active?.session_id === input.submission.session_id) continue;
    const currentSession = activity?.active?.session_id ?? activity?.completed?.session_id ?? "none";
    if (await reject(
      [input.commentId],
      semanticRejectionKey("qa-stale-session", input.submission.role, currentSession),
      `QA session ${input.submission.session_id} is not current for the exact PR evaluation identity.`,
    )) return { accepted: accepted + 1 };
  }

  for (const requirement of snapshot.qa.required) {
    const activity = activities.get(requirement.role);
    if (!activity?.active) continue;

    let matches = qaInputs.filter((input) =>
      !ignored.has(input.commentId) && input.submission.role === requirement.role &&
      input.submission.session_id === activity.active?.session_id,
    );
    if (!matches.length) continue;

    for (const match of matches) {
      if (await canSubmitProtocolEvidence(github, match.actor)) continue;
      if (await reject(
        [match.commentId],
        semanticRejectionKey("qa-permission", requirement.role, activity.active.session_id),
        `@${match.actor} does not have repository write permission required to submit Fugue protocol evidence.`,
      )) return { accepted: accepted + 1 };
    }
    matches = matches.filter((input) => !ignored.has(input.commentId));
    if (!matches.length) continue;

    const unique = new Map<string, typeof matches[number]>();
    for (const match of matches) unique.set(JSON.stringify(match.submission), match);
    if (unique.size > 1) {
      if (await reject(
        matches.map((match) => match.commentId),
        semanticRejectionKey("qa-conflict", requirement.role, activity.active.session_id),
        `Conflicting ${roleHeading(requirement.role)} submissions exist for session ${activity.active.session_id}; submit one fresh verdict.`,
      )) return { accepted: accepted + 1 };
      continue;
    }

    const selected = [...unique.values()][0];
    if (!selected) continue;
    await completeReview(
      github,
      snapshot.pr.number,
      requirement.role,
      qaSubmissionToReviewOptions(selected.submission),
    );
    accepted += 1;
  }

  if (snapshot.qa.controlPlaneChanged && !(await hasCurrentHumanAcknowledgement(github, snapshot))) {
    for (const input of humanInputs) {
      if (sameEvaluationIdentity(input.submission.identity, snapshot.identity)) continue;
      if (await reject(
        [input.commentId],
        semanticRejectionKey("human-stale-identity"),
        "Human control-plane acknowledgement is bound to a stale PR evaluation identity.",
      )) return { accepted: accepted + 1 };
    }

    const matches = humanInputs
      .filter((input) => !ignored.has(input.commentId) && sameEvaluationIdentity(input.submission.identity, snapshot.identity))
      .sort((a, b) => b.commentId - a.commentId);
    for (const selected of matches) {
      if (!(await canSubmitProtocolEvidence(github, selected.actor))) {
        if (await reject(
          [selected.commentId],
          semanticRejectionKey("human-permission"),
          `@${selected.actor} does not have repository write permission required for control-plane acknowledgement.`,
        )) return { accepted: accepted + 1 };
        continue;
      }
      await recordHumanControlPlaneAcknowledgement(
        github,
        snapshot.pr.number,
        selected.actor,
        selected.submission.identity,
      );
      accepted += 1;
      break;
    }
  }

  return { accepted };
}

async function hasImmutableSubmissionProvenance(github: FugueGitHub, comment: SubmissionComment): Promise<boolean> {
  if (!comment.node_id || !comment.user?.login) return false;
  try {
    const response = await github.octokit.graphql<{
      node?: {
        author?: { login?: string | null } | null;
        editor?: { login?: string | null } | null;
        lastEditedAt?: string | null;
      } | null;
    }>(
      `query FugueSubmissionProvenance($id: ID!) {
        node(id: $id) {
          ... on IssueComment {
            author { login }
            editor { login }
            lastEditedAt
          }
        }
      }`,
      { id: comment.node_id },
    );
    const node = response.node;
    return Boolean(node && node.author?.login === comment.user.login && !node.editor && !node.lastEditedAt);
  } catch {
    return false;
  }
}

'''
s = s[:start] + new_process + s[end:]

block_start = s.index('function submissionFingerprint(')
block_end = s.index('async function rejectSubmissions(', block_start)
new_rejection = r'''function semanticRejectionKey(...parts: string[]): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex")}`;
}

function rejectionBloom(progress?: SubmissionRejectionProgress): Buffer {
  if (!progress || progress.version !== 2) return Buffer.alloc(SUBMISSION_REJECTION_BLOOM_BYTES);
  const decoded = Buffer.from(progress.bloom_b64, "base64url");
  return decoded.length === SUBMISSION_REJECTION_BLOOM_BYTES
    ? Buffer.from(decoded)
    : Buffer.alloc(SUBMISSION_REJECTION_BLOOM_BYTES);
}

function rejectionBloomPositions(semanticKey: string): number[] {
  const digest = createHash("sha256").update(semanticKey, "utf8").digest();
  const bits = SUBMISSION_REJECTION_BLOOM_BYTES * 8;
  return [0, 2, 4, 6].map((offset) => digest.readUInt16BE(offset) % bits);
}

function rejectionProgressContains(progress: SubmissionRejectionProgress | undefined, semanticKey: string): boolean {
  if (!progress || progress.version !== 2) return false;
  const bloom = rejectionBloom(progress);
  return rejectionBloomPositions(semanticKey).every((position) =>
    (bloom[Math.floor(position / 8)]! & (1 << (position % 8))) !== 0,
  );
}

async function recoverSubmissionRejectionProgress(
  github: FugueGitHub,
  snapshot: EvaluationSnapshot,
): Promise<SubmissionRejectionProgress | undefined> {
  const recovered = await recoverDurableProtocolRecord(github, {
    storageSha: snapshot.identity.headSha,
    publisherSha: snapshot.identity.baseSha,
    scope: submissionRejectionScope(snapshot),
    issueNumber: snapshot.pr.number,
    parse: (body) => parseMarked(body, "<!-- fugue-submission-rejection-progress", submissionRejectionProgressSchema),
    timestamp: (value) => Date.parse(value.created_at),
    // Keep the historical v1 authority prefix so a v2 migration remains comparable with an existing
    // v1 durable record. The monotonically increasing sequence, not schema version, orders progress.
    order: (value) => `submission-rejection-v1:${String(value.sequence).padStart(20, "0")}`,
    validate: (value) => sameEvaluationIdentity(value.identity, snapshot.identity),
  });
  return recovered.record?.value;
}

async function recordSubmissionRejectionProgress(
  github: FugueGitHub,
  snapshot: EvaluationSnapshot,
  semanticKey: string,
): Promise<SubmissionRejectionProgress> {
  const current = await recoverSubmissionRejectionProgress(github, snapshot);
  if (rejectionProgressContains(current, semanticKey)) return current!;
  const bloom = rejectionBloom(current);
  for (const position of rejectionBloomPositions(semanticKey)) {
    bloom[Math.floor(position / 8)] = bloom[Math.floor(position / 8)]! | (1 << (position % 8));
  }
  const sequence = (current?.sequence ?? -1) + 1;
  const createdAt = new Date().toISOString();
  const value = submissionRejectionProgressV2Schema.parse({
    version: 2,
    kind: "submission_rejection_progress",
    identity: snapshot.identity,
    sequence,
    bloom_b64: bloom.toString("base64url"),
    created_at: createdAt,
  });
  const marker = `<!-- fugue-submission-rejection-progress\n${stringifyYaml(value).trim()}\n${END}`;
  await publishDurableProtocolRecord(github, {
    storageSha: snapshot.identity.headSha,
    publisherSha: snapshot.identity.baseSha,
    scope: submissionRejectionScope(snapshot),
    unsignedBody: `${marker}\n\nFUGUE SUBMISSION REJECTION PROGRESS — CANONICAL`,
    publicationTimestamp: Date.parse(createdAt),
    authorityOrder: `submission-rejection-v1:${String(sequence).padStart(20, "0")}`,
  });
  return (await recoverSubmissionRejectionProgress(github, snapshot)) ?? value;
}

'''
s = s[:block_start] + new_rejection + s[block_end:]
write(p, s)

# ---------------------------------------------------------------------------
# Integration attempt identity: persistent protected environment-deployment witness.
# ---------------------------------------------------------------------------
p = 'src/core/integration-status.ts'
s = read(p)
s = once(s,
'''interface WorkflowRunRecord {
  id: number;
  actor?: { login?: string | null; type?: string | null } | null;
  event: string;
  head_sha: string;
  display_title: string;
  created_at: string | null;
  run_attempt?: number;
  status: string | null;
  conclusion: string | null;
  html_url: string;
}
''',
'''interface WorkflowRunRecord {
  id: number;
  actor?: { login?: string | null; type?: string | null } | null;
  event: string;
  head_sha: string;
  display_title: string;
  created_at: string | null;
  run_attempt?: number;
  status: string | null;
  conclusion: string | null;
  html_url: string;
}

interface DeploymentRecord {
  id: number;
  sha: string;
  ref: string;
  task: string;
  environment: string;
  created_at: string;
}

interface DeploymentStatusRecord {
  id: number;
  state: string;
  environment?: string | null;
  environment_url?: string | null;
  created_at?: string | null;
}

interface CorrelatedDeploymentSnapshot {
  fingerprint: string;
  runs: IntegrationWorkflowRun[];
}
''', 'deployment interfaces')
s = once(s,
'''export class IntegrationAuthorityCapacityPendingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrationAuthorityCapacityPendingError";
  }
}
''',
'''export class IntegrationAuthorityCapacityPendingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrationAuthorityCapacityPendingError";
  }
}

class IntegrationRunDiscoveryPendingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrationRunDiscoveryPendingError";
  }
}
''', 'discovery pending class')

fn_start = s.index('/**\n * Recover the globally earliest protected attempt-1 run')
fn_end = s.index('export async function currentIntegrationState(', fn_start)
new_find = r'''/**
 * Recover the globally earliest protected attempt-1 run for an unbound request from GitHub's
 * environment-deployment history, not from mutable workflow-run pages. A job that references the
 * protected fugue-authority environment creates a platform deployment/status before its first step;
 * the configured environment URL carries only request/run correlation data and therefore survives
 * Actions-write deletion of the workflow-run record. Two identical complete scans are required so a
 * changing deployment set fails closed instead of producing a page-shifted winner.
 */
async function findEarliestCorrelatedIntegrationWorkflowRun(
  github: FugueGitHub,
  record: IntegrationRecord,
): Promise<IntegrationWorkflowRun | undefined> {
  if (!record.dispatch) return undefined;
  const anchorBody = await getFugueAuthorityVariable(github, record.dispatch.anchor_name);
  if (!anchorBody) return undefined;
  const anchor = await verifyIntegrationDispatchAnchor(github, record, anchorBody);
  if (!anchor) throw new Error(`Protected Integration request anchor ${record.dispatch.anchor_name} is not valid for earliest-run recovery.`);
  const token = integrationDispatchRunToken(record.request.request_id, anchor.dispatch_secret);

  let previous: CorrelatedDeploymentSnapshot | undefined;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const current = await correlatedIntegrationDeploymentSnapshot(github, record, token);
    if (previous?.fingerprint === current.fingerprint) {
      return [...current.runs].sort((left, right) => left.id - right.id)[0];
    }
    previous = current;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new IntegrationRunDiscoveryPendingError(
    `Protected Integration deployment history for request ${record.request.request_id} changed during recovery; retry before choosing a run.`,
  );
}

async function correlatedIntegrationDeploymentSnapshot(
  github: FugueGitHub,
  record: IntegrationRecord,
  token: string,
): Promise<CorrelatedDeploymentSnapshot> {
  const { owner, repo, fullName } = github.repository;
  const minimumCreated = Math.max(Date.parse(record.request.created_at), Date.parse(record.dispatch!.authorized_at));
  if (!Number.isFinite(minimumCreated)) return { fingerprint: "invalid-time", runs: [] };
  const matches: Array<{ deploymentId: number; statusId: number; run: IntegrationWorkflowRun }> = [];

  for (let page = 1; page <= 1000; page += 1) {
    const response = await github.octokit.request("GET /repos/{owner}/{repo}/deployments", {
      owner,
      repo,
      sha: record.identity.baseSha,
      environment: "fugue-authority",
      per_page: 100,
      page,
      headers: { "X-GitHub-Api-Version": "2026-03-10" },
    });
    const deployments = response.data as unknown as DeploymentRecord[];
    for (const deployment of deployments) {
      const created = Date.parse(deployment.created_at);
      if (deployment.sha !== record.identity.baseSha || deployment.ref !== record.identity.baseBranch ||
          deployment.environment !== "fugue-authority" || deployment.task !== "deploy" ||
          !Number.isFinite(created) || created < minimumCreated) continue;
      const statusesResponse = await github.octokit.request(
        "GET /repos/{owner}/{repo}/deployments/{deployment_id}/statuses",
        {
          owner,
          repo,
          deployment_id: deployment.id,
          per_page: 100,
          page: 1,
          headers: { "X-GitHub-Api-Version": "2026-03-10" },
        },
      );
      const statuses = statusesResponse.data as unknown as DeploymentStatusRecord[];
      for (const status of statuses) {
        const run = integrationRunFromDeploymentUrl(github, record.request, token, status.environment_url, deployment.created_at);
        if (!run || (status.environment && status.environment !== "fugue-authority")) continue;
        matches.push({ deploymentId: deployment.id, statusId: status.id, run });
        break;
      }
    }
    if (deployments.length < 100) break;
    if (page === 1000) {
      throw new IntegrationRunDiscoveryPendingError("Protected Integration deployment history exceeded the bounded stable-scan window.");
    }
  }

  matches.sort((left, right) => left.deploymentId - right.deploymentId || left.statusId - right.statusId);
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(matches.map((match) => [match.deploymentId, match.statusId, match.run.id])), "utf8")
    .digest("hex");
  return { fingerprint, runs: matches.map((match) => match.run) };
}

function integrationRunFromDeploymentUrl(
  github: FugueGitHub,
  request: IntegrationRequest,
  token: string,
  rawUrl: string | null | undefined,
  createdAt: string,
): IntegrationWorkflowRun | undefined {
  if (!rawUrl) return undefined;
  let url: URL;
  try { url = new URL(rawUrl); } catch { return undefined; }
  const prefix = `/${github.repository.fullName}/actions/runs/`;
  if (url.origin !== "https://github.com" || !url.pathname.startsWith(prefix) ||
      url.searchParams.get("fugue_request") !== request.request_id ||
      url.searchParams.get("fugue_run_token") !== token) return undefined;
  const suffix = url.pathname.slice(prefix.length);
  if (!/^\d+$/.test(suffix)) return undefined;
  const runId = Number(suffix);
  if (!Number.isSafeInteger(runId) || runId <= 0) return undefined;
  return {
    id: runId,
    status: null,
    conclusion: null,
    htmlUrl: `${url.origin}${url.pathname}`,
    createdAt,
    attempt: 1,
  };
}

'''
s = s[:fn_start] + new_find + s[fn_end:]

# Stable-history churn is pending, never evidence of "no run".
s = once(s,
'''    const earliest = await findEarliestCorrelatedIntegrationWorkflowRun(github, record);
    if (!earliest || earliest.id !== event.runId) return false;
''',
'''    let earliest: IntegrationWorkflowRun | undefined;
    try { earliest = await findEarliestCorrelatedIntegrationWorkflowRun(github, record); }
    catch (error) { if (error instanceof IntegrationRunDiscoveryPendingError) return false; throw error; }
    if (!earliest || earliest.id !== event.runId) return false;
''', 'seal stable discovery')
s = once(s,
'''    if (!current.run) {
      const earliest = await findEarliestCorrelatedIntegrationWorkflowRun(github, current);
      if (earliest) {
        current = await publishIntegrationRecord(github, {
          ...current,
          dispatch_started_at: current.dispatch_started_at ?? earliest.createdAt,
          run: { id: earliest.id, attempt: 1, created_at: earliest.createdAt, html_url: earliest.htmlUrl },
          created_at: new Date(now).toISOString(),
        });
      }
    }
''',
'''    if (!current.run) {
      let earliest: IntegrationWorkflowRun | undefined;
      try { earliest = await findEarliestCorrelatedIntegrationWorkflowRun(github, current); }
      catch (error) {
        if (error instanceof IntegrationRunDiscoveryPendingError) return { request: current.request, dispatch: false };
        throw error;
      }
      if (earliest) {
        current = await publishIntegrationRecord(github, {
          ...current,
          dispatch_started_at: current.dispatch_started_at ?? earliest.createdAt,
          run: { id: earliest.id, attempt: 1, created_at: earliest.createdAt, html_url: earliest.htmlUrl },
          created_at: new Date(now).toISOString(),
        });
      }
    }
''', 'ensure stable discovery')
write(p, s)

# ---------------------------------------------------------------------------
# Workflows: GitHub environment deployment/status becomes the pre-step run witness.
# ---------------------------------------------------------------------------
p = '.github/workflows/fugue-integration.yml'
s = read(p)
s = once(s,
'''    environment: fugue-authority
    permissions:
      actions: read
''',
'''    environment:
      name: fugue-authority
      url: "${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}?fugue_request=${{ inputs.request_id }}&fugue_run_token=${{ inputs.run_token }}"
    permissions:
      actions: read
''', 'prepare environment url')
write(p, s)

p = '.github/workflows/fugue-control-plane.yml'
s = read(p)
s = once(s, '  contents: write\n  id-token: write\n', '  contents: write\n  deployments: read\n  id-token: write\n', 'deployment read permission')
write(p, s)

# ---------------------------------------------------------------------------
# Static Integration control regression.
# ---------------------------------------------------------------------------
p = 'tests/integration-plan.test.ts'
s = read(p)
s = once(s,
'''  it("uses only unfiltered workflow-run enumeration for lost Integration binding recovery", async () => {
    const source = await readFile("src/core/integration-status.ts", "utf8");
    expect(source).toContain("listWorkflowRuns");
    expect(source).toContain('workflow_id: "fugue-integration.yml"');
    expect(source).toContain("per_page: 100");
    expect(source).not.toMatch(/listWorkflowRuns\\(\\{[\\s\\S]{0,500}?(?:actor|branch|created|event|head_sha|status):/);
    expect(source).toContain("getIntegrationRunStartEvidence");
  });
''',
'''  it("uses persistent environment deployments rather than mutable workflow-run pages for lost binding recovery", async () => {
    const source = await readFile("src/core/integration-status.ts", "utf8");
    const workflow = await readFile(".github/workflows/fugue-integration.yml", "utf8");
    const control = await readFile(".github/workflows/fugue-control-plane.yml", "utf8");
    expect(source).not.toContain("listWorkflowRuns");
    expect(source).toContain('GET /repos/{owner}/{repo}/deployments');
    expect(source).toContain('GET /repos/{owner}/{repo}/deployments/{deployment_id}/statuses');
    expect(source).toContain("previous?.fingerprint === current.fingerprint");
    expect(workflow).toContain("fugue_request=${{ inputs.request_id }}");
    expect(workflow).toContain("fugue_run_token=${{ inputs.run_token }}");
    expect(control).toContain("deployments: read");
    expect(source).toContain("getIntegrationRunStartEvidence");
  });
''', 'integration static test')
write(p, s)

# ---------------------------------------------------------------------------
# Focused adversarial regressions and mocks.
# ---------------------------------------------------------------------------
p = 'tests/state-authority-blockers.test.ts'
s = read(p)
s = once(s,
'import { currentReviewActivities } from "../src/core/reviews.js";\n',
'import { completeReview, currentReviewActivities } from "../src/core/reviews.js";\n', 'completeReview import')
# Mock completion only; durable activity recovery remains real.
anchor = 'vi.mock("../src/core/provenance.js", async (importOriginal) => {'
pos = s.index(anchor)
# append reviews mock after provenance mock block by locating its following const BASE
base_pos = s.index('const BASE = "b".repeat(40);')
s = s[:base_pos] + '''vi.mock("../src/core/reviews.js", async (importOriginal) => {\n  const actual = await importOriginal<typeof import("../src/core/reviews.js")>();\n  return { ...actual, completeReview: vi.fn(async () => undefined) };\n});\n\n''' + s[base_pos:]

s = once(s,
'''interface TestComment {
  id: number;
  issueNumber: number;
  body: string;
  user?: { login: string; type: string };
  created_at?: string;
  updated_at?: string;
}
''',
'''interface TestComment {
  id: number;
  node_id?: string;
  issueNumber: number;
  body: string;
  user?: { login: string; type: string };
  created_at?: string;
  updated_at?: string;
  editedBy?: string;
}

interface TestDeploymentStatus {
  id: number;
  state: string;
  environment: string;
  environment_url: string;
  created_at: string;
}

interface TestDeployment {
  id: number;
  sha: string;
  ref: string;
  task: string;
  environment: string;
  created_at: string;
  statuses: TestDeploymentStatus[];
}
''', 'test comment/deployment types')
s = once(s,
'''  __statuses: TestStatus[];
  __workflowRuns: Array<{ id: number; actor: typeof BOT; event: string; head_sha: string; display_title: string; created_at: string; run_attempt: number; status: string; conclusion: string | null; html_url: string }>;
  __beforeRecoverySign?: (body: string) => Promise<void> | void;
''',
'''  __statuses: TestStatus[];
  __workflowRuns: Array<{ id: number; actor: typeof BOT; event: string; head_sha: string; display_title: string; created_at: string; run_attempt: number; status: string; conclusion: string | null; html_url: string }>;
  __deployments: TestDeployment[];
  __hooks: { onDeploymentPage?: (page: number) => Promise<void> | void };
  __beforeRecoverySign?: (body: string) => Promise<void> | void;
''', 'test github deployment fields')
s = once(s,
'''  const workflowRuns: TestGithub["__workflowRuns"] = [];
  let nextCommentId = 0;
  let nextStatusId = 0;

  return {
''',
'''  const workflowRuns: TestGithub["__workflowRuns"] = [];
  const deployments: TestDeployment[] = [];
  const hooks: TestGithub["__hooks"] = {};
  let nextCommentId = 0;
  let nextStatusId = 0;

  return {
''', 'make github locals')
s = once(s,
'''    __comments: comments,
    __statuses: statuses,
    __workflowRuns: workflowRuns,
    octokit: {
''',
'''    __comments: comments,
    __statuses: statuses,
    __workflowRuns: workflowRuns,
    __deployments: deployments,
    __hooks: hooks,
    octokit: {
      graphql: vi.fn(async (_query: string, variables: { id?: string }) => {
        const comment = comments.find((candidate) => candidate.node_id === variables.id);
        if (!comment) return { node: null };
        return {
          node: {
            author: comment.user ? { login: comment.user.login } : null,
            editor: comment.editedBy ? { login: comment.editedBy } : null,
            lastEditedAt: comment.editedBy ? (comment.updated_at ?? new Date().toISOString()) : null,
          },
        };
      }),
      request: vi.fn(async (route: string, args: { page?: number; per_page?: number; deployment_id?: number }) => {
        if (route === "GET /repos/{owner}/{repo}/deployments") {
          const page = args.page ?? 1;
          const perPage = args.per_page ?? 100;
          await hooks.onDeploymentPage?.(page);
          const ordered = [...deployments].sort((a, b) => b.id - a.id);
          return { data: ordered.slice((page - 1) * perPage, page * perPage) };
        }
        if (route === "GET /repos/{owner}/{repo}/deployments/{deployment_id}/statuses") {
          const deployment = deployments.find((candidate) => candidate.id === args.deployment_id);
          return { data: deployment ? [...deployment.statuses].sort((a, b) => b.id - a.id) : [] };
        }
        throw new Error(`unexpected test route ${route}`);
      }),
''', 'octokit graphql/request mocks')
s = once(s,
'''            const comment: TestComment = {
              id: ++nextCommentId,
              issueNumber: args.issue_number,
''',
'''            const comment: TestComment = {
              id: ++nextCommentId,
              node_id: `IC_${nextCommentId}`,
              issueNumber: args.issue_number,
''', 'created comment node id')
# add permission method ahead of createCommitStatus
s = once(s,
'''        repos: {
          createCommitStatus: vi.fn(async (args: {
''',
'''        repos: {
          getCollaboratorPermissionLevel: vi.fn(async (args: { username: string }) => ({
            data: { permission: args.username === "human" ? "write" : "read" },
          })),
          createCommitStatus: vi.fn(async (args: {
''', 'permission mock')

# Helper before describe.
describe_pos = s.index('describe("absorbed Code QA / Security QA authority blockers"')
helper = r'''function addIntegrationDeploymentWitness(
  github: TestGithub,
  requestId: string,
  token: string,
  run: TestGithub["__workflowRuns"][number],
  deploymentId = 100_000 + run.id,
): void {
  github.__deployments.push({
    id: deploymentId,
    sha: run.head_sha,
    ref: "main",
    task: "deploy",
    environment: "fugue-authority",
    created_at: run.created_at,
    statuses: [{
      id: deploymentId * 10,
      state: run.conclusion === "failure" ? "failure" : run.status === "completed" ? "success" : "in_progress",
      environment: "fugue-authority",
      environment_url: `https://github.com/JohnnyZLi/Fugue/actions/runs/${run.id}?fugue_request=${requestId}&fugue_run_token=${token}`,
      created_at: run.created_at,
    }],
  });
}

function immutableUserComment(id: number, body: string, login = "attacker"): TestComment {
  const timestamp = `2026-08-17T08:${String(id % 60).padStart(2, "0")}:00.000Z`;
  return {
    id,
    node_id: `IC_${id}`,
    issueNumber: 19,
    body,
    user: { login, type: "User" },
    created_at: timestamp,
    updated_at: timestamp,
  };
}

'''
s = s[:describe_pos] + helper + s[describe_pos:]

# Existing L/A tests now install deployment witnesses.
s = s.replace('    github.__workflowRuns.push(L, A);\n\n    await expect(sealIntegrationWorkflowRunEvent',
'''    github.__workflowRuns.push(L, A);
    addIntegrationDeploymentWitness(github, request.request_id, token, L);
    addIntegrationDeploymentWitness(github, request.request_id, token, A);

    await expect(sealIntegrationWorkflowRunEvent''')

# Replace old rejection test with expanded exact current regressions.
old_start = s.index('  it("keeps rejected hostile submission progress durable across receipt deletion and equivalent replay"')
old_end = s.index('\n\n});', old_start)
new_tests = r'''  it("rejects attacker-edited privileged QA and Human comments instead of inheriting the original author", async () => {
    const github = makeGithub();
    vi.mocked(completeReview).mockClear();
    const identity = {
      prNumber: 19, headSha: "a".repeat(40), baseBranch: "main", baseSha: BASE,
      policyDigest: "sha256:policy", protocolVersion: 1 as const, issueNumber: 18, workId: "work-18",
      workSpecDigest: "sha256:spec",
    };
    const snapshot = {
      identity,
      pr: { number: 19 },
      qa: { required: [{ role: "code" }], controlPlaneChanged: true, validationControlChanged: false },
    } as unknown as EvaluationSnapshot;
    const session = reviewStartSchema.parse({
      version: 1, kind: "review_start", session_id: "rev-code-editproof1", role: "code", identity,
      fugue_version: "test", created_at: "2026-08-17T08:20:00.000Z",
    });
    github.__comments.push({
      id: 8800, node_id: "IC_8800", issueNumber: 19, body: serializeAttestation(session), user: BOT,
      created_at: "2026-08-17T08:20:00.000Z", updated_at: "2026-08-17T08:20:00.000Z",
    });
    const qaBody = `<!-- fugue-review-submit\nversion: 1\nsession_id: ${session.session_id}\nrole: code\nverdict: approved\nagents_update: not-required\nvalidation_control: acceptable\n-->`;
    github.__comments.push({
      ...immutableUserComment(8801, qaBody, "human"),
      updated_at: "2026-08-17T08:21:10.000Z",
      editedBy: "attacker-app",
    });
    const humanBody = `<!-- fugue-human-submit\nversion: 1\nkind: control_plane_ack\nidentity:\n  prNumber: 19\n  headSha: ${identity.headSha}\n  baseBranch: main\n  baseSha: ${BASE}\n  policyDigest: sha256:policy\n  protocolVersion: 1\n  issueNumber: 18\n  workId: work-18\n  workSpecDigest: sha256:spec\n-->`;
    github.__comments.push({
      ...immutableUserComment(8802, humanBody, "human"),
      updated_at: "2026-08-17T08:22:10.000Z",
      editedBy: "attacker-app",
    });

    await expect(processCurrentSubmissions(github, snapshot)).resolves.toEqual({ accepted: 1 });
    await expect(processCurrentSubmissions(github, snapshot)).resolves.toEqual({ accepted: 1 });
    await expect(processCurrentSubmissions(github, snapshot)).resolves.toEqual({ accepted: 0 });
    expect(vi.mocked(completeReview)).not.toHaveBeenCalled();
    await expect(hasCurrentHumanAcknowledgement(github, snapshot)).resolves.toBe(false);
  });

  it("survives deletion of dispatch-created unbound L and never lets replay A replace its terminal failure", async () => {
    const github = makeGithub();
    const identity = {
      prNumber: 19, headSha: "a".repeat(40), baseBranch: "main", baseSha: BASE,
      policyDigest: "sha256:policy", protocolVersion: 1 as const, issueNumber: 18, workId: "work-18",
      workSpecDigest: "sha256:spec",
    };
    const snapshot = { identity, pr: { number: 19 } } as unknown as EvaluationSnapshot;
    const request = createIntegrationRequest(identity, "2026-08-17T08:30:00.000Z", "7".repeat(16));
    const secret = "8".repeat(64);
    const authorized = await authorizeIntegrationDispatch(github, request, "2026-08-17T08:30:00.000Z", secret);
    await publishIntegrationRecord(github, createIntegrationRecord(authorized.request, {
      dispatch: authorized.authorization, createdAt: "2026-08-17T08:30:00.000Z",
    }));
    const token = integrationDispatchRunToken(request.request_id, secret);
    const title = `Fugue Integration PR #19 ${request.request_id} ${token}`;
    const L = { id: 6262, actor: BOT, event: "workflow_dispatch", head_sha: BASE, display_title: title,
      created_at: "2026-08-17T08:30:10.000Z", run_attempt: 1, status: "completed", conclusion: "failure",
      html_url: "https://github.com/JohnnyZLi/Fugue/actions/runs/6262" };
    const A = { id: 6263, actor: BOT, event: "workflow_dispatch", head_sha: BASE, display_title: title,
      created_at: "2026-08-17T08:30:20.000Z", run_attempt: 1, status: "completed", conclusion: "failure",
      html_url: "https://github.com/JohnnyZLi/Fugue/actions/runs/6263" };
    github.__workflowRuns.push(L, A);
    addIntegrationDeploymentWitness(github, request.request_id, token, L);
    addIntegrationDeploymentWitness(github, request.request_id, token, A);
    // Shared Actions authority deletes the genuine run before d3 bind/run-start/completion processing.
    github.__workflowRuns.splice(github.__workflowRuns.findIndex((run) => run.id === L.id), 1);

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
    await expect(ensureIntegrationDispatch(github, snapshot, Date.parse("2026-08-17T08:50:00.000Z")))
      .resolves.toMatchObject({ dispatch: false });
    expect((await getCurrentIntegrationRecord(github, identity))?.run?.id).toBe(L.id);
  });

  it("keeps globally-earliest discovery correct beyond 100 while workflow-run records are deleted concurrently", async () => {
    const github = makeGithub();
    const identity = {
      prNumber: 19, headSha: "a".repeat(40), baseBranch: "main", baseSha: BASE,
      policyDigest: "sha256:policy", protocolVersion: 1 as const, issueNumber: 18, workId: "work-18",
      workSpecDigest: "sha256:spec",
    };
    const snapshot = { identity, pr: { number: 19 } } as unknown as EvaluationSnapshot;
    const request = createIntegrationRequest(identity, "2026-08-17T08:30:00.000Z", "9".repeat(16));
    const secret = "a".repeat(64);
    const authorized = await authorizeIntegrationDispatch(github, request, "2026-08-17T08:30:00.000Z", secret);
    await publishIntegrationRecord(github, createIntegrationRecord(authorized.request, {
      dispatch: authorized.authorization, createdAt: "2026-08-17T08:30:00.000Z",
    }));
    const token = integrationDispatchRunToken(request.request_id, secret);
    const title = `Fugue Integration PR #19 ${request.request_id} ${token}`;
    for (let index = 0; index < 151; index += 1) {
      const id = 7000 + index;
      const run = { id, actor: BOT, event: "workflow_dispatch", head_sha: BASE, display_title: title,
        created_at: `2026-08-17T08:${String(30 + Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
        run_attempt: 1, status: "in_progress", conclusion: null,
        html_url: `https://github.com/JohnnyZLi/Fugue/actions/runs/${id}` };
      github.__workflowRuns.push(run);
      addIntegrationDeploymentWitness(github, request.request_id, token, run, 200_000 + index);
    }
    let deleted = false;
    github.__hooks.onDeploymentPage = (page) => {
      if (page !== 2 || deleted) return;
      deleted = true;
      // Model the old page-number failure exactly: delete newer run records while discovery crosses
      // the >100 boundary. Persistent protected deployment witnesses do not shift with run deletion.
      github.__workflowRuns.splice(50, 80);
    };
    vi.mocked(github.octokit.rest.actions.listWorkflowRuns).mockClear();
    await expect(ensureIntegrationDispatch(github, snapshot, Date.parse("2026-08-17T08:35:00.000Z")))
      .resolves.toMatchObject({ dispatch: false });
    expect((await getCurrentIntegrationRecord(github, identity))?.run?.id).toBe(7000);
    expect(vi.mocked(github.octokit.rest.actions.listWorkflowRuns)).not.toHaveBeenCalled();
  });

  it("dedupes semantic hostile rejection variants in fixed-size durable progress", async () => {
    const github = makeGithub();
    const identity = {
      prNumber: 19, headSha: "a".repeat(40), baseBranch: "main", baseSha: BASE,
      policyDigest: "sha256:policy", protocolVersion: 1 as const, issueNumber: 18, workId: "work-18",
      workSpecDigest: "sha256:spec",
    };
    const snapshot = { identity, pr: { number: 19 }, qa: { required: [], controlPlaneChanged: false } } as unknown as EvaluationSnapshot;
    for (let index = 0; index < 80; index += 1) {
      const body = index % 2 === 0
        ? `presentation ${index}\n<!-- fugue-review-submit\nversion: 1\nsession_id: rev-code-dead${String(index).padStart(4, "0")}\nrole: code\nverdict: changes_requested\nsummary: hostile variant ${index}\n-->`
        : `<!-- fugue-review-submit\n\nversion: 1\nsession_id: rev-code-beef${String(index).padStart(4, "0")}\nrole: code\nverdict: approved\nsummary: another presentation ${index}\n-->`;
      github.__comments.push(immutableUserComment(9000 + index, body));
    }
    await expect(processCurrentSubmissions(github, snapshot)).resolves.toEqual({ accepted: 1 });
    const scope = `submission-rejection/19/${createHash("sha256").update(JSON.stringify(identity), "utf8").digest("hex").slice(0, 20)}`;
    const beforeOrders = recoveryOrders(github, scope);
    await expect(processCurrentSubmissions(github, snapshot)).resolves.toEqual({ accepted: 0 });
    expect(recoveryOrders(github, scope)).toEqual(beforeOrders);
    for (let index = 80; index < 100; index += 1) {
      github.__comments.push(immutableUserComment(9000 + index,
        `<!-- fugue-review-submit\nversion: 1\nsession_id: rev-code-cafe${String(index).padStart(4, "0")}\nrole: code\nverdict: error\nsummary: fresh text ${index}\n-->`));
    }
    await expect(processCurrentSubmissions(github, snapshot)).resolves.toEqual({ accepted: 0 });
    expect(recoveryOrders(github, scope)).toEqual(beforeOrders);
    const progressBodies = recoveryCheckpointBodies(github).filter((body) => body.includes("fugue-submission-rejection-progress"));
    expect(progressBodies.some((body) => body.includes("version: 2") && body.includes("bloom_b64:"))).toBe(true);
    expect(progressBodies.filter((body) => body.includes("version: 2")).every((body) => body.length < 6000)).toBe(true);
  });

  it("never lets a legacy ID-only rejection receipt suppress a distinct legitimate current submission", async () => {
    const github = makeGithub();
    vi.mocked(completeReview).mockClear();
    const identity = {
      prNumber: 19, headSha: "a".repeat(40), baseBranch: "main", baseSha: BASE,
      policyDigest: "sha256:policy", protocolVersion: 1 as const, issueNumber: 18, workId: "work-18",
      workSpecDigest: "sha256:spec",
    };
    const snapshot = {
      identity, pr: { number: 19 },
      qa: { required: [{ role: "code" }], controlPlaneChanged: false, validationControlChanged: false },
    } as unknown as EvaluationSnapshot;
    const session = reviewStartSchema.parse({
      version: 1, kind: "review_start", session_id: "rev-code-legacyproof1", role: "code", identity,
      fugue_version: "test", created_at: "2026-08-17T08:20:00.000Z",
    });
    github.__comments.push({
      id: 9300, node_id: "IC_9300", issueNumber: 19, body: serializeAttestation(session), user: BOT,
      created_at: "2026-08-17T08:20:00.000Z", updated_at: "2026-08-17T08:20:00.000Z",
    });
    github.__comments.push({
      id: 9301, node_id: "IC_9301", issueNumber: 19,
      body: `FUGUE SUBMISSION — REJECTED\n\nlegacy presentation\n\n<!-- fugue-submission-rejection\nversion: 1\ncomment_ids:\n  - 9400\n-->`,
      user: BOT, created_at: "2026-08-17T08:21:00.000Z", updated_at: "2026-08-17T08:21:00.000Z",
    });
    github.__comments.push(immutableUserComment(9400,
      `<!-- fugue-review-submit\nversion: 1\nsession_id: ${session.session_id}\nrole: code\nverdict: approved\nagents_update: not-required\nvalidation_control: acceptable\n-->`, "human"));

    await expect(processCurrentSubmissions(github, snapshot)).resolves.toEqual({ accepted: 1 });
    expect(vi.mocked(completeReview)).toHaveBeenCalledWith(
      github, 19, "code", expect.objectContaining({ verdict: "approved" }),
    );
  });
'''
s = s[:old_start] + new_tests + s[old_end:]
write(p, s)

# ---------------------------------------------------------------------------
# Contract/docs updates, preserving all existing invariants while describing the new roots.
# ---------------------------------------------------------------------------
p = 'AGENTS.md'
s = read(p)
s = sub_once(s,
 r'^30\. Protected Integration.*?^31\. Every Human control-plane acknowledgement consumer.*$',
'''30. Protected Integration never records attempt existence before the workflow-dispatch POST creates a run. The protected `prepare` job references `fugue-authority` with a request/run-correlation environment URL, causing GitHub itself to persist a deployment/status carrying the exact run ID before any in-job environment audit or Authority App token-mint step. Recovery derives the expected correlation token from the one-use Authority-anchor secret, requires two identical complete scans of that protected environment-deployment history, and chooses the globally lowest matching run ID; mutable workflow-run pages and the public token/title are never binding authority. The deployment witness survives shared `actions:write` deletion of the Actions run, so a created-but-unbound attempt cannot become a pre-POST abort/retry and a later replay cannot replace it. If no matching deployment exists after a stable recovery grace window, only then may never-created transport abort/retry; once a deployment/run-start/returned binding exists, disappearance fails closed to terminal failure unless cancellation was actually observed.
31. Every Human control-plane acknowledgement consumer—including hosted Integration prepare/finalize and final merge-readiness planning—resolves the exact current acknowledgement from protected d3 authority. A PR comment is only a repairable mirror and deleting it cannot change a gate result. QA/Human request comments are authoritative only when GraphQL creation provenance shows no editor/`lastEditedAt`; edited bodies are rejected rather than attributed to their original author. Rejected/stale/conflicting/untrusted submissions are reduced to finite semantic rejection classes and recorded before any optional receipt in a fixed-size d3 Bloom filter scoped to the exact evaluation identity. Legacy ID-only/raw-fingerprint receipts remain presentation/migration history and cannot suppress a distinct valid submission; hostile IDs, whitespace, summaries, or presentation variants cannot grow durable rejection authority without bound.''', 'AGENTS current invariants', flags=re.S|re.M)
write(p, s)

p = 'README.md'
s = read(p)
s = s.replace(
'QA submissions are requests, not canonical evidence. Protected Fugue verifies the actor, current session, and exact evaluation identity, then writes canonical QA evidence. A changed head/base/policy/spec makes old QA historical.',
'QA submissions are requests, not canonical evidence. Protected Fugue verifies immutable comment creation provenance (edited comments are non-authoritative), actor permission, current session, and exact evaluation identity, then writes canonical QA evidence. Rejected requests are deduplicated by bounded semantic d3 progress rather than raw comment IDs/bodies. A changed head/base/policy/spec makes old QA historical.')
s = s.replace(
'''RUN START
    before checkout/setup/build, attempt 1 proves the one-use capability
    from its request-specific immutable anchor and creates a request-specific
    OIDC-signed run-start record with create-only first-wins semantics carrying
    GITHUB_RUN_ID + attempt 1; after d3 binds that run, transient request records are reclaimed
''',
'''RUN START
    GitHub's protected fugue-authority environment first persists a deployment/status
    whose environment URL correlates request + exact GITHUB_RUN_ID before any in-job audit
    or Authority App token mint; the run then proves the one-use capability and creates the
    request-specific OIDC-signed run-start record; after d3 binds that run, transient request records are reclaimed
''')
s = s.replace(
'''Filtered workflow-run search and custom Git refs are not binding authority. Concurrent protected reconcilers converge through one deterministic create-only election, then use immutable request-specific anchor/run-start names; no live Authority variable is PATCHed or reused. Same-request flood runs do not know the one-use capability and cannot replace the first create-only run-start, while reruns are rejected because only attempt 1 may consume it. Fugue caps active request anchors, safely scavenges aged pre-d3 orphans repository-wide, and reclaims each request's transient records as soon as d3 contains the protected run binding or terminal abort, so cancellation/retry or abandoned-PR residue cannot consume the finite Variables namespace. The exact run ID comes from the signed run-start value, so GitHub list caps and hostile ref movement do not affect first-run identity.

If transport never crosses the run-start boundary, protected recovery may abort that unused request and create a fresh one. Once run-start is durable, however, deletion of the exact Actions run cannot become a retry: after the recovery grace period Fugue seals terminal failure unless it already has durable PASS/failure/error or an actually observed cancellation/abortion. A `workflow_run` consumer can seal outcomes promptly, but cancelling or deleting that consumer cannot erase the run-start evidence or turn a possible genuine failure into retryable transport.
''',
'''Workflow-run search, public run titles/tokens, and custom Git refs are not binding authority. GitHub's environment deployment/status is the crash bridge between workflow-dispatch creation and d3 binding: it is created by the protected `fugue-authority` environment before failure-prone job steps, carries only request/run correlation in `environment_url`, and remains after an Actions-write principal deletes the workflow-run record. Recovery requires a stable repeated deployment scan and selects the globally lowest matching run ID, so later same-request replays or >100 mutable workflow-run records cannot replace the first created attempt. Concurrent protected reconcilers still converge through one deterministic create-only election and immutable request-specific anchor/run-start names; no live Authority variable is PATCHed or reused.

If a stable deployment scan proves no matching attempt was ever created after the recovery grace period, protected recovery may abort that unused request and create a fresh one. Once a protected deployment, run-start, or returned dispatch binding proves attempt 1 existed, deletion of the Actions run cannot become a retry: Fugue retains that exact run identity and fails closed to terminal failure unless it already has durable PASS/failure/error or an actually observed cancellation/abortion. A `workflow_run` consumer can seal outcomes promptly, but its event no longer depends on the deleted run remaining listable.
''')
write(p, s)

p = 'docs/leader-chat.md'
s = read(p)
needle = 'GitHub is durable truth'
if needle in s:
    # Add one concise implementation note at first occurrence without duplicating on rerun.
    s = s.replace(needle, needle + '; edited QA/Human request comments are non-authoritative, and protected Integration run creation is recoverable from the persistent fugue-authority deployment witness', 1)
write(p, s)

print('applied current Code/Security QA repair set')
