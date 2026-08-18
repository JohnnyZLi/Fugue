from __future__ import annotations
from pathlib import Path
import re, sys
root=Path(sys.argv[1])

def once(s, old, new, label):
    n=s.count(old)
    if n!=1: raise SystemExit(f'{label}: expected 1 match, found {n}')
    return s.replace(old,new,1)

# Integration dispatch: no durable attempt-exists marker before POST. Ask GitHub for exact run details,
# and bind that returned identity immediately when the POST succeeds.
p=root/'src/core/reconcile.ts'; s=p.read_text()
s=once(s,
'import { bindDispatchedIntegrationRun, ensureIntegrationDispatch, integrationDispatchRunToken, markIntegrationDispatchStarted, reclaimOrphanIntegrationAuthorityVariables, sealIntegrationWorkflowRunEvent } from "./integration-status.js";',
'import { bindDispatchedIntegrationRun, ensureIntegrationDispatch, integrationDispatchRunToken, reclaimOrphanIntegrationAuthorityVariables, sealIntegrationWorkflowRunEvent } from "./integration-status.js";',
'reconcile import')
s=once(s,
'''  const dispatchStartedAt = new Date().toISOString();
  await markIntegrationDispatchStarted(github, snapshot, next.request.request_id, dispatchStartedAt);
  const runToken = integrationDispatchRunToken(next.request.request_id, next.dispatchSecret);''',
'''  const runToken = integrationDispatchRunToken(next.request.request_id, next.dispatchSecret);''',
'pre-post marker')
s=once(s,
'''    ref: policy.identity.baseBranch,
    inputs: {''',
'''    ref: policy.identity.baseBranch,
    return_run_details: true,
    inputs: {''',
'dispatch run details')
p.write_text(s)

# Integration authority: public token is correlation only. Recovery exhaustively selects the lowest
# causally valid matching protected attempt-1 run; no completion event can choose a later replay.
p=root/'src/core/integration-status.ts'; s=p.read_text()
insert_after='''function integrationRunBindingFromEvidence(github: FugueGitHub, evidence: IntegrationRunStartEvidence): IntegrationRunBinding {
  return {
    id: evidence.run_id,
    attempt: 1,
    created_at: evidence.created_at,
    html_url: `https://github.com/${github.repository.fullName}/actions/runs/${evidence.run_id}`,
  };
}
'''
helper='''

/**
 * Recover the globally earliest protected attempt-1 run for an unbound request. The HMAC token is
 * deliberately public once the legitimate run exists, so it is only a correlation selector. It can
 * never authorize a run by itself: we enumerate the protected workflow without capped filters and
 * choose the lowest matching server-assigned run ID. A later replay therefore cannot outrank the
 * run that first made the unpredictable token observable.
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

  const expectedTitle = integrationRunTitleWithToken(
    record.request,
    integrationDispatchRunToken(record.request.request_id, anchor.dispatch_secret),
  );
  const requestCreated = Date.parse(record.request.created_at);
  const authorizedAt = Date.parse(anchor.authorized_at);
  const minimumCreated = Math.max(requestCreated, authorizedAt);
  if (!Number.isFinite(minimumCreated)) return undefined;

  const { owner, repo } = github.repository;
  let earliest: WorkflowRunRecord | undefined;
  for (let page = 1; ; page += 1) {
    const response = await github.octokit.rest.actions.listWorkflowRuns({
      owner,
      repo,
      workflow_id: "fugue-integration.yml",
      per_page: 100,
      page,
    });
    const runs = ((response.data as unknown as { workflow_runs?: WorkflowRunRecord[] }).workflow_runs ?? []);
    for (const run of runs) {
      const created = Date.parse(run.created_at ?? "");
      if (!isTrustedProtocolWorkflowRun(run) || run.event !== "workflow_dispatch" ||
          run.head_sha !== record.identity.baseSha || run.display_title !== expectedTitle ||
          normalizedRunAttempt(run.run_attempt) !== 1 || !Number.isFinite(created) || created < minimumCreated) continue;
      if (!earliest || run.id < earliest.id) earliest = run;
    }
    if (runs.length < 100) break;
  }
  return earliest ? workflowRun(earliest) : undefined;
}
'''
s=once(s,insert_after,insert_after+helper,'earliest helper')

# currentIntegrationState: legacy dispatch_started_at no longer means a run definitely exists.
s=once(s,
'''  if (record.dispatch_started_at) return { state: "pending", request };
  const created = Date.parse(request.created_at);''',
'''  const created = Date.parse(request.created_at);''',
'current state permanent pending')

# seal completion: eliminate direct token authority; only the exhaustive globally-earliest selector may
# supply a lost binding, and only when this event is that exact earliest run.
old='''  const evidence = record.run ? undefined : await getIntegrationRunStartEvidence(github, record);
  let binding = record.run ?? (evidence ? integrationRunBindingFromEvidence(github, evidence) : undefined);
  if (!binding && match[3] && record.dispatch && record.dispatch_started_at) {
    const anchorBody = await getFugueAuthorityVariable(github, record.dispatch.anchor_name);
    const anchor = anchorBody ? await verifyIntegrationDispatchAnchor(github, record, anchorBody) : undefined;
    if (!anchor || integrationDispatchRunToken(record.request.request_id, anchor.dispatch_secret) !== match[3]) return false;
    const eventCreated = Date.parse(event.createdAt);
    const minimumCreated = Math.max(Date.parse(record.request.created_at), Date.parse(record.dispatch_started_at));
    if (!Number.isFinite(eventCreated) || !Number.isFinite(minimumCreated) || eventCreated < minimumCreated) return false;
    binding = { id: event.runId, attempt: 1, created_at: event.createdAt, html_url: event.htmlUrl };
  }
  if (!binding || binding.id !== event.runId) return false;'''
new='''  const evidence = record.run ? undefined : await getIntegrationRunStartEvidence(github, record);
  let binding = record.run ?? (evidence ? integrationRunBindingFromEvidence(github, evidence) : undefined);
  if (!binding) {
    // A token in a run title is public presentation after the first run exists. Never bind from the
    // completion event itself. Reconstruct the entire matching protected-workflow set and accept this
    // event only if GitHub's globally earliest matching attempt-1 run is this exact run ID.
    if (!match[3] || !record.dispatch) return false;
    const earliest = await findEarliestCorrelatedIntegrationWorkflowRun(github, record);
    if (!earliest || earliest.id !== event.runId) return false;
    binding = { id: earliest.id, attempt: 1, created_at: earliest.createdAt, html_url: earliest.htmlUrl };
  }
  if (binding.id !== event.runId) return false;'''
s=once(s,old,new,'seal token fallback')

# ensureIntegrationDispatch: recover a created-but-unbound run by exhaustive earliest selection. If no
# run exists after grace, abort/retry even for legacy pre-POST dispatch_started_at records.
old='''  if (current) {
    const evidence = current.run ? undefined : await getIntegrationRunStartEvidence(github, current);
    if (evidence && !current.run) {
      current = await publishIntegrationRecord(github, {
        ...current,
        run: integrationRunBindingFromEvidence(github, evidence),
        created_at: new Date(now).toISOString(),
      });
    }
    if (current.run) {'''
new='''  if (current) {
    const evidence = current.run ? undefined : await getIntegrationRunStartEvidence(github, current);
    if (evidence && !current.run) {
      current = await publishIntegrationRecord(github, {
        ...current,
        dispatch_started_at: current.dispatch_started_at ?? evidence.created_at,
        run: integrationRunBindingFromEvidence(github, evidence),
        created_at: new Date(now).toISOString(),
      });
    }
    if (!current.run) {
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
    if (current.run) {'''
s=once(s,old,new,'ensure earliest binding')
old='''    } else if (!evidence) {
      const created = Date.parse(current.dispatch_started_at ?? current.request.created_at);
      if (!Number.isFinite(created) || now - created < INTEGRATION_REQUEST_RECOVERY_GRACE_MS) {
        return { request: current.request, dispatch: false };
      }
      if (current.dispatch_started_at) {
        // Crossing the durable dispatch-creation boundary is irreversible. Without exact run-start,
        // returned-run binding, or the authenticated completion event we cannot prove whether GitHub
        // created the attempt, so remain pending forever rather than silently converting possible
        // attempt-1 failure into abort/retry. The workflow_run event can still seal the exact run ID.
        return { request: current.request, dispatch: false };
      }
      await publishIntegrationRecord(github, {
        ...current,
        terminal: {
          state: "aborted",
          detail: "Authorized Integration dispatch never crossed its protected dispatch-creation boundary; transport may recover with a fresh request.",
          created_at: new Date(now).toISOString(),
        },
        created_at: new Date(now).toISOString(),
      });'''
new='''    } else if (!evidence) {
      const created = Date.parse(current.request.created_at);
      if (!Number.isFinite(created) || now - created < INTEGRATION_REQUEST_RECOVERY_GRACE_MS) {
        return { request: current.request, dispatch: false };
      }
      // No exact returned binding, protected run-start, or globally earliest correlated workflow run
      // exists after the recovery grace period. This includes legacy records carrying the old
      // pre-POST dispatch_started_at marker: that marker is no longer evidence that GitHub created a
      // run, so a crash before the POST cannot wedge the request forever.
      await publishIntegrationRecord(github, {
        ...current,
        terminal: {
          state: "aborted",
          detail: "Authorized Integration request has no discoverable protected attempt-1 run after the recovery grace period; transport may recover with a fresh request.",
          created_at: new Date(now).toISOString(),
        },
        created_at: new Date(now).toISOString(),
      });'''
s=once(s,old,new,'ensure no-run recovery')

# A returned exact run ID is the post-POST proof that the attempt exists; make that the only place the
# dispatch-start timestamp is introduced by the direct dispatch path.
old='''  return publishIntegrationRecord(github, {
    ...current,
    run: { id: runId, attempt: 1, created_at: createdAt, html_url: htmlUrl },
    created_at: createdAt,
  });'''
new='''  return publishIntegrationRecord(github, {
    ...current,
    dispatch_started_at: current.dispatch_started_at ?? createdAt,
    run: { id: runId, attempt: 1, created_at: createdAt, html_url: htmlUrl },
    created_at: createdAt,
  });'''
s=once(s,old,new,'bind returned run marker')
p.write_text(s)

# Submission rejection progress: d3 is authority; receipt comments are optional mirrors. Equivalent
# hostile comments are fingerprinted so deletion/reinjection cannot consume every reconciliation pass.
p=root/'src/core/submissions.ts'; s=p.read_text()
s=once(s,
'''const submissionRejectionSchema = z.object({
  version: z.literal(1),
  comment_ids: z.array(z.number().int().positive()).min(1),
});''',
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

type SubmissionRejectionProgress = z.infer<typeof submissionRejectionProgressSchema>;''',
'rejection schema')

# Replace initial comment-receipt-only rejection load and loop preamble.
s=once(s,
'''  const rejectedIds = await rejectedSubmissionIds(github, comments as SubmissionComment[]);
  const qaInputs: Array<SubmissionInput<QaSubmission>> = [];
  const humanInputs: Array<SubmissionInput<HumanSubmission>> = [];

  for (const comment of comments) {
    if (rejectedIds.has(comment.id)) continue;
    const body = comment.body ?? "";
    if (!body.includes(REVIEW_START) && !body.includes(HUMAN_START)) continue;

    const actor = comment.user?.login;
    if (!actor) {
      await rejectSubmissions(github, snapshot.pr.number, [comment.id], "Submission has no attributable GitHub actor.");
      return { accepted: 1 };
    }''',
'''  let progress = await recoverSubmissionRejectionProgress(github, snapshot);
  const legacyIds = await rejectedSubmissionReceiptIds(github, comments as SubmissionComment[]);
  if ([...legacyIds].some((id) => !(progress?.comment_ids ?? []).includes(id))) {
    const migrated = [...legacyIds].map((id) => {
      const comment = (comments as SubmissionComment[]).find((candidate) => candidate.id === id);
      return { id, fingerprint: submissionFingerprint(comment?.user?.login ?? "", comment?.body ?? "") };
    });
    progress = await recordSubmissionRejectionProgress(github, snapshot, migrated);
  }
  const rejectedIds = new Set(progress?.comment_ids ?? []);
  const rejectedFingerprints = new Set(progress?.fingerprints ?? []);
  const fingerprints = new Map<number, string>();
  const qaInputs: Array<SubmissionInput<QaSubmission>> = [];
  const humanInputs: Array<SubmissionInput<HumanSubmission>> = [];

  const reject = async (commentIds: number[], reason: string): Promise<void> => {
    const entries = commentIds.map((id) => ({ id, fingerprint: fingerprints.get(id) ?? submissionFingerprint("", String(id)) }));
    progress = await recordSubmissionRejectionProgress(github, snapshot, entries);
    for (const entry of entries) {
      rejectedIds.add(entry.id);
      rejectedFingerprints.add(entry.fingerprint);
    }
    try {
      await rejectSubmissions(github, snapshot.pr.number, commentIds, reason);
    } catch {
      // Durable rejection progress is authoritative; a presentation receipt failure cannot make the
      // same hostile submission consume another reconciliation transition.
    }
  };

  for (const comment of comments) {
    const body = comment.body ?? "";
    if (!body.includes(REVIEW_START) && !body.includes(HUMAN_START)) continue;
    const actor = comment.user?.login ?? "";
    const fingerprint = submissionFingerprint(actor, body);
    fingerprints.set(comment.id, fingerprint);
    if (rejectedIds.has(comment.id) || rejectedFingerprints.has(fingerprint)) continue;

    if (!actor) {
      await reject([comment.id], "Submission has no attributable GitHub actor.");
      return { accepted: 1 };
    }''',
'rejection preamble')
# Replace all calls inside processCurrentSubmissions only. Safe because rejectSubmissions helper definition appears later.
start=s.index('export async function processCurrentSubmissions')
end=s.index('export async function recordHumanControlPlaneAcknowledgement', start)
body=s[start:end]
body=body.replace('await rejectSubmissions(\n        github,\n        snapshot.pr.number,\n        [comment.id],', 'await reject(\n        [comment.id],')
body=body.replace('await rejectSubmissions(\n      github,\n      snapshot.pr.number,\n      [input.commentId],', 'await reject(\n      [input.commentId],')
body=body.replace('await rejectSubmissions(\n          github,\n          snapshot.pr.number,\n          [match.commentId],', 'await reject(\n          [match.commentId],')
body=body.replace('await rejectSubmissions(\n        github,\n        snapshot.pr.number,\n        matches.map((match) => match.commentId),', 'await reject(\n        matches.map((match) => match.commentId),')
body=body.replace('await rejectSubmissions(\n          github,\n          snapshot.pr.number,\n          [input.commentId],', 'await reject(\n          [input.commentId],')
body=body.replace('await rejectSubmissions(\n          github,\n          snapshot.pr.number,\n          [selected.commentId],', 'await reject(\n          [selected.commentId],')
s=s[:start]+body+s[end:]

# Replace receipt reader with durable helpers + legacy reader.
old='''async function rejectedSubmissionIds(
  github: FugueGitHub,
  comments: SubmissionComment[],
): Promise<Set<number>> {
  const ids = new Set<number>();
  for (const comment of comments) {
    if (!(await isTrustedProtocolComment(github, comment))) continue;
    try {
      const rejection = parseMarked(comment.body ?? "", REJECTION_START, submissionRejectionSchema);
      for (const id of rejection?.comment_ids ?? []) ids.add(id);
    } catch {
      // Invalid rejection-looking text is not protocol state.
    }
  }
  return ids;
}
'''
new='''function submissionRejectionIdentityToken(snapshot: EvaluationSnapshot): string {
  return createHash("sha256").update(JSON.stringify(snapshot.identity), "utf8").digest("hex").slice(0, 20);
}

function submissionRejectionScope(snapshot: EvaluationSnapshot): string {
  return `submission-rejection/${snapshot.identity.prNumber}/${submissionRejectionIdentityToken(snapshot)}`;
}

function submissionFingerprint(actor: string, body: string): string {
  return `sha256:${createHash("sha256").update(`${actor}\\0${body}`, "utf8").digest("hex")}`;
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
    parse: (body) => {
      const marker = "<!-- fugue-submission-rejection-progress";
      const value = parseMarked(body, marker, submissionRejectionProgressSchema);
      return value;
    },
    timestamp: (value) => Date.parse(value.created_at),
    order: (value) => `submission-rejection-v1:${String(value.sequence).padStart(20, "0")}`,
    validate: (value) => sameEvaluationIdentity(value.identity, snapshot.identity),
  });
  return recovered.record?.value;
}

async function recordSubmissionRejectionProgress(
  github: FugueGitHub,
  snapshot: EvaluationSnapshot,
  entries: Array<{ id: number; fingerprint: string }>,
): Promise<SubmissionRejectionProgress> {
  const current = await recoverSubmissionRejectionProgress(github, snapshot);
  const ids = [...new Set([...(current?.comment_ids ?? []), ...entries.map((entry) => entry.id)])].sort((a, b) => a - b);
  const fingerprints = [...new Set([...(current?.fingerprints ?? []), ...entries.map((entry) => entry.fingerprint)])].sort();
  if (current && ids.length === current.comment_ids.length && fingerprints.length === current.fingerprints.length) return current;
  const sequence = (current?.sequence ?? -1) + 1;
  const createdAt = new Date().toISOString();
  const value = submissionRejectionProgressSchema.parse({
    version: 1,
    kind: "submission_rejection_progress",
    identity: snapshot.identity,
    sequence,
    comment_ids: ids,
    fingerprints,
    created_at: createdAt,
  });
  const marker = `<!-- fugue-submission-rejection-progress\\n${stringifyYaml(value).trim()}\\n${END}`;
  await publishDurableProtocolRecord(github, {
    storageSha: snapshot.identity.headSha,
    publisherSha: snapshot.identity.baseSha,
    scope: submissionRejectionScope(snapshot),
    unsignedBody: `${marker}\\n\\nFUGUE SUBMISSION REJECTION PROGRESS — CANONICAL`,
    publicationTimestamp: Date.parse(createdAt),
    authorityOrder: `submission-rejection-v1:${String(sequence).padStart(20, "0")}`,
  });
  return (await recoverSubmissionRejectionProgress(github, snapshot)) ?? value;
}

async function rejectedSubmissionReceiptIds(
  github: FugueGitHub,
  comments: SubmissionComment[],
): Promise<Set<number>> {
  const ids = new Set<number>();
  for (const comment of comments) {
    if (!(await isTrustedProtocolComment(github, comment))) continue;
    try {
      const rejection = parseMarked(comment.body ?? "", REJECTION_START, submissionRejectionSchema);
      for (const id of rejection?.comment_ids ?? []) ids.add(id);
    } catch {
      // Invalid rejection-looking text is not protocol state.
    }
  }
  return ids;
}
'''
s=once(s,old,new,'durable rejection helpers')
p.write_text(s)

# Focused adversarial regressions live in the Worker-owned blocker test file.
p=root/'tests/state-authority-blockers.test.ts'; s=p.read_text()
s=once(s,
'import { hasCurrentHumanAcknowledgement } from "../src/core/submissions.js";',
'import { hasCurrentHumanAcknowledgement, processCurrentSubmissions } from "../src/core/submissions.js";',
'test submissions import')
s=once(s,
'import { authorizeIntegrationDispatch, getCurrentIntegrationRecord, getIntegrationRunStartEvidence, integrationDispatchRunToken, markIntegrationDispatchStarted, publishIntegrationRecord, sealIntegrationWorkflowRunEvent } from "../src/core/integration-status.js";',
'import { authorizeIntegrationDispatch, ensureIntegrationDispatch, getCurrentIntegrationRecord, getIntegrationRunStartEvidence, integrationDispatchRunToken, publishIntegrationRecord, sealIntegrationWorkflowRunEvent } from "../src/core/integration-status.js";',
'test integration import')
s=once(s,
'''  __statuses: TestStatus[];
  __beforeRecoverySign?:''',
'''  __statuses: TestStatus[];
  __workflowRuns: Array<{ id: number; actor: typeof BOT; event: string; head_sha: string; display_title: string; created_at: string; run_attempt: number; status: string; conclusion: string | null; html_url: string }>;
  __beforeRecoverySign?:''',
'test workflow interface')
s=once(s,
'''  const statuses: TestStatus[] = [];
  let nextCommentId = 0;''',
'''  const statuses: TestStatus[] = [];
  const workflowRuns: TestGithub["__workflowRuns"] = [];
  let nextCommentId = 0;''',
'test workflow storage')
s=once(s,
'''    __comments: comments,
    __statuses: statuses,
    octokit:''',
'''    __comments: comments,
    __statuses: statuses,
    __workflowRuns: workflowRuns,
    octokit:''',
'test workflow expose')
s=once(s,
'''        actions: {
          listWorkflowRuns: vi.fn(async () => ({ data: { workflow_runs: [] } })),
        },''',
'''        actions: {
          listWorkflowRuns: vi.fn(async (args: { page?: number; per_page?: number }) => {
            const page = args.page ?? 1;
            const perPage = args.per_page ?? 100;
            const ordered = [...workflowRuns].sort((a, b) => b.id - a.id);
            return { data: { workflow_runs: ordered.slice((page - 1) * perPage, page * perPage) } };
          }),
          getWorkflowRunAttempt: vi.fn(async (args: { run_id: number }) => {
            const found = workflowRuns.find((run) => run.id === args.run_id);
            if (!found) throw Object.assign(new Error("not found"), { status: 404 });
            return { data: found };
          }),
        },''',
'test actions mock')
# Replace the previous single optimistic token test with exact Coordinator regressions.
start=s.index('  it("recovers dispatch-created attempt 1 after d3 bind loss and seals pre-run-start failure"')
end=s.index('\n\n});', start)
replacement=r'''  it("recovers a pre-POST crash without treating a nonexistent attempt as permanently pending", async () => {
    const github = makeGithub();
    const identity = {
      prNumber: 19, headSha: "a".repeat(40), baseBranch: "main", baseSha: BASE,
      policyDigest: "sha256:policy", protocolVersion: 1 as const, issueNumber: 18, workId: "work-18",
      workSpecDigest: "sha256:spec",
    };
    const snapshot = { identity, pr: { number: 19 } } as unknown as EvaluationSnapshot;
    const request = createIntegrationRequest(identity, "2026-08-17T08:30:00.000Z", "1".repeat(16));
    const authorized = await authorizeIntegrationDispatch(github, request, "2026-08-17T08:30:00.000Z", "2".repeat(64));
    await publishIntegrationRecord(github, createIntegrationRecord(authorized.request, {
      dispatch: authorized.authorization, createdAt: "2026-08-17T08:30:00.000Z",
    }));

    // Model process death immediately before the workflow-dispatch POST: no run exists anywhere.
    const recovered = await ensureIntegrationDispatch(github, snapshot, Date.parse("2026-08-17T08:41:00.000Z"));
    expect(recovered.dispatch).toBe(true);
    expect(recovered.request?.request_id).not.toBe(request.request_id);
    expect((await getCurrentIntegrationRecord(github, identity))?.request.request_id).toBe(recovered.request?.request_id);
  });

  it("keeps legitimate run L authoritative when later replay run A completes first", async () => {
    const github = makeGithub();
    const identity = {
      prNumber: 19, headSha: "a".repeat(40), baseBranch: "main", baseSha: BASE,
      policyDigest: "sha256:policy", protocolVersion: 1 as const, issueNumber: 18, workId: "work-18",
      workSpecDigest: "sha256:spec",
    };
    const snapshot = { identity, pr: { number: 19 } } as unknown as EvaluationSnapshot;
    const request = createIntegrationRequest(identity, "2026-08-17T08:30:00.000Z", "3".repeat(16));
    const secret = "4".repeat(64);
    const authorized = await authorizeIntegrationDispatch(github, request, "2026-08-17T08:30:00.000Z", secret);
    await publishIntegrationRecord(github, createIntegrationRecord(authorized.request, {
      dispatch: authorized.authorization, createdAt: "2026-08-17T08:30:00.000Z",
    }));
    const token = integrationDispatchRunToken(request.request_id, secret);
    const title = `Fugue Integration PR #19 ${request.request_id} ${token}`;
    const L = { id: 4242, actor: BOT, event: "workflow_dispatch", head_sha: BASE, display_title: title,
      created_at: "2026-08-17T08:30:10.000Z", run_attempt: 1, status: "in_progress", conclusion: null,
      html_url: "https://github.com/JohnnyZLi/Fugue/actions/runs/4242" };
    const A = { id: 4243, actor: BOT, event: "workflow_dispatch", head_sha: BASE, display_title: title,
      created_at: "2026-08-17T08:30:20.000Z", run_attempt: 1, status: "completed", conclusion: "failure",
      html_url: "https://github.com/JohnnyZLi/Fugue/actions/runs/4243" };
    github.__workflowRuns.push(L, A);

    await expect(sealIntegrationWorkflowRunEvent(github, {
      eventName: "workflow_run", workflowName: "Fugue Integration", runId: A.id, runAttempt: 1,
      conclusion: A.conclusion, status: A.status, headSha: BASE, displayTitle: title,
      createdAt: A.created_at, htmlUrl: A.html_url, actor: BOT.login,
    })).resolves.toBe(false);
    expect((await getCurrentIntegrationRecord(github, identity))?.run).toBeNull();

    await expect(ensureIntegrationDispatch(github, snapshot, Date.parse("2026-08-17T08:31:00.000Z"))).resolves.toMatchObject({ dispatch: false });
    const bound = await getCurrentIntegrationRecord(github, identity);
    expect(bound?.run?.id).toBe(L.id);
    expect(bound?.terminal).toBeNull();
  });

  it("preserves legitimate pre-run-start failure when replay A completes before L", async () => {
    const github = makeGithub();
    const identity = {
      prNumber: 19, headSha: "a".repeat(40), baseBranch: "main", baseSha: BASE,
      policyDigest: "sha256:policy", protocolVersion: 1 as const, issueNumber: 18, workId: "work-18",
      workSpecDigest: "sha256:spec",
    };
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
  });

  it("keeps rejected hostile submission progress durable across receipt deletion and equivalent replay", async () => {
    const github = makeGithub();
    const identity = {
      prNumber: 19, headSha: "a".repeat(40), baseBranch: "main", baseSha: BASE,
      policyDigest: "sha256:policy", protocolVersion: 1 as const, issueNumber: 18, workId: "work-18",
      workSpecDigest: "sha256:spec",
    };
    const snapshot = { identity, pr: { number: 19 }, qa: { required: [], controlPlaneChanged: false } } as unknown as EvaluationSnapshot;
    const hostileBody = `<!-- fugue-review-submit\nversion: 1\nsession_id: rev-code-deadbeef\nrole: code\nverdict: approved\n-->`;
    github.__comments.push({ id: 9001, issueNumber: 19, body: hostileBody, user: { login: "attacker", type: "User" } });

    await expect(processCurrentSubmissions(github, snapshot)).resolves.toEqual({ accepted: 1 });
    expect(recoveryScopes(github)).toContain(`submission-rejection/19/${createHash("sha256").update(JSON.stringify(identity), "utf8").digest("hex").slice(0, 20)}`);
    for (let index = github.__comments.length - 1; index >= 0; index -= 1) {
      if (github.__comments[index]?.user?.login === BOT.login && github.__comments[index]?.body.includes("fugue-submission-rejection")) {
        github.__comments.splice(index, 1);
      }
    }
    const afterDeletion = github.__comments.length;
    await expect(processCurrentSubmissions(github, snapshot)).resolves.toEqual({ accepted: 0 });
    expect(github.__comments).toHaveLength(afterDeletion);

    github.__comments.push({ id: 9002, issueNumber: 19, body: hostileBody, user: { login: "attacker", type: "User" } });
    await expect(processCurrentSubmissions(github, snapshot)).resolves.toEqual({ accepted: 0 });
    expect(github.__comments.filter((comment) => comment.user?.login === BOT.login && comment.body.includes("fugue-submission-rejection"))).toHaveLength(0);
  });'''
s=s[:start]+replacement+s[end:]
p.write_text(s)

# Documentation: replace the now-obsolete pre-POST/public-token invariant and add durable rejection authority.
p=root/'AGENTS.md'; s=p.read_text()
s=once(s,
'30. Protected Integration durably records crossing the dispatch-creation transition before calling workflow dispatch and correlates the created attempt-1 run with a token derived from the one-use Authority-anchor secret. The authenticated immutable `workflow_run` completion event can bind and seal the exact request/run after a control-plane crash before custom run-start publication; no workflow-run search becomes binding authority, and an unresolved request that crossed the durable dispatch boundary remains fail-closed/pending rather than becoming retry.\n31. Every Human control-plane acknowledgement consumer—including hosted Integration prepare/finalize and final merge-readiness planning—resolves the exact current acknowledgement from protected d3 authority. A PR comment is only a repairable mirror and deleting it cannot change a gate result.',
'30. Protected Integration never records attempt existence before the workflow-dispatch POST creates a run. The one-use Authority-anchor secret derives a public correlation token, but that token is presentation/correlation only: after a dispatch-response bind loss, protected recovery enumerates the unfiltered protected Integration workflow history and selects the globally lowest causally valid attempt-1 run ID carrying that previously unpredictable token. A later replay cannot bind or seal over the first run; if no correlated run exists after the recovery grace period, a pre-POST crash is safely aborted/retried, while a discovered/run-start/returned binding makes disappearance fail closed to terminal failure.\n31. Every Human control-plane acknowledgement consumer—including hosted Integration prepare/finalize and final merge-readiness planning—resolves the exact current acknowledgement from protected d3 authority. A PR comment is only a repairable mirror and deleting it cannot change a gate result. Rejected/stale/conflicting/untrusted QA/Human submission progress is likewise fingerprinted and committed to exact-identity d3 authority before an optional rejection receipt is written, so receipt deletion or equivalent hostile-comment replay cannot consume reconciliation repeatedly.',
'AGENTS latest invariants')
p.write_text(s)

for rel in ['README.md','docs/leader-chat.md']:
    p=root/rel; s=p.read_text()
    old='Integration records the dispatch-creation transition before the workflow API call and uses a secret-derived run token so the authenticated completion event can bind and seal the exact attempt-1 run after a control-plane crash, including failures before custom run-start evidence; unresolved post-dispatch state never becomes retry. Human control-plane acknowledgement is consumed from deletion-resistant d3 authority by Integration and final merge-readiness; acknowledgement comments are presentation only.'
    new='Integration keeps durable request authorization distinct from attempt existence: a pre-POST crash can recover after grace, while a created-but-unbound attempt is recovered by enumerating unfiltered protected workflow history and selecting the globally lowest run ID carrying the secret-derived correlation token. The token is public correlation only and never binding authority, so later same-request replay cannot outrank the first run; genuine pre-run-start failure remains terminal once that first run is recovered. Human control-plane acknowledgement is consumed from deletion-resistant d3 authority by Integration and final merge-readiness, and submission-rejection progress is also exact-identity d3 authority rather than a deletable receipt comment.'
    s=once(s,old,new,f'{rel} latest recovery paragraph')
    p.write_text(s)

print('applied current Code/Security QA repairs and focused regressions')
