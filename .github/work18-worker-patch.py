from __future__ import annotations

import pathlib, re, sys

root = pathlib.Path(sys.argv[1])

def read(path: str) -> str:
    return (root / path).read_text()

def write(path: str, text: str) -> None:
    (root / path).write_text(text)

def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)

# ---------------------------------------------------------------------------
# Coordinator causal identity is part of canonical work state.
# ---------------------------------------------------------------------------
p = "src/core/state.ts"
s = read(p)
s = replace_once(s,
'''  authority_sequence: z.number().int().nonnegative().optional(),
  parent_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/i).nullable().optional(),
});''',
'''  authority_sequence: z.number().int().nonnegative().optional(),
  parent_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/i).nullable().optional(),
  coordinator_issue_updated_at: z.string().min(1).optional(),
  coordinator_event_sequence: z.number().int().nonnegative().optional(),
  coordinator_event_id: z.string().min(1).optional(),
}).superRefine((value, context) => {
  const coordinatorFields = [
    value.coordinator_issue_updated_at,
    value.coordinator_event_sequence,
    value.coordinator_event_id,
  ].filter((field) => field !== undefined).length;
  if (coordinatorFields !== 0 && coordinatorFields !== 3) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Canonical work-state Coordinator identity must be complete." });
  }
});''', "state schema coordinator")

s = replace_once(s,
'''  createdAt?: string;
  predecessor?: CanonicalWorkState;
  logicalRoot?: boolean;
}): CanonicalWorkState {''',
'''  createdAt?: string;
  predecessor?: CanonicalWorkState;
  logicalRoot?: boolean;
  coordinator?: { issueUpdatedAt: string; eventSequence: number; eventId: string };
}): CanonicalWorkState {''', "state create input")

s = replace_once(s,
'''  const authoritySequence = predecessor
    ? (predecessor.authority_sequence ?? -1) + 1
    : input.logicalRoot ? 0 : undefined;
  const parentDigest = predecessor ? canonicalWorkStateDigest(predecessor) : input.logicalRoot ? null : undefined;
  return canonicalWorkStateSchema.parse({''',
'''  const authoritySequence = predecessor
    ? (predecessor.authority_sequence ?? -1) + 1
    : input.logicalRoot ? 0 : undefined;
  const parentDigest = predecessor ? canonicalWorkStateDigest(predecessor) : input.logicalRoot ? null : undefined;
  const inheritedCoordinator = predecessor?.coordinator_issue_updated_at !== undefined &&
      predecessor.coordinator_event_sequence !== undefined && predecessor.coordinator_event_id !== undefined
    ? {
        issueUpdatedAt: predecessor.coordinator_issue_updated_at,
        eventSequence: predecessor.coordinator_event_sequence,
        eventId: predecessor.coordinator_event_id,
      }
    : undefined;
  const coordinator = input.coordinator ?? inheritedCoordinator;
  return canonicalWorkStateSchema.parse({''', "state coordinator inheritance")

s = replace_once(s,
'''    ...(authoritySequence === undefined ? {} : { authority_sequence: authoritySequence, parent_digest: parentDigest }),
  });''',
'''    ...(authoritySequence === undefined ? {} : { authority_sequence: authoritySequence, parent_digest: parentDigest }),
    ...(coordinator ? {
      coordinator_issue_updated_at: coordinator.issueUpdatedAt,
      coordinator_event_sequence: coordinator.eventSequence,
      coordinator_event_id: coordinator.eventId,
    } : {}),
  });''', "state coordinator fields")

s = replace_once(s,
'''    left.requirements_b64 === right.requirements_b64 &&
    JSON.stringify(left.metadata) === JSON.stringify(right.metadata) &&
    JSON.stringify(left.pr) === JSON.stringify(right.pr);''',
'''    left.requirements_b64 === right.requirements_b64 &&
    JSON.stringify(left.metadata) === JSON.stringify(right.metadata) &&
    JSON.stringify(left.pr) === JSON.stringify(right.pr) &&
    left.coordinator_issue_updated_at === right.coordinator_issue_updated_at &&
    left.coordinator_event_sequence === right.coordinator_event_sequence &&
    left.coordinator_event_id === right.coordinator_event_id;''', "state same coordinator")

# ---------------------------------------------------------------------------
# Fence revision-bound Authority mutations against concurrent recovery work.
# ---------------------------------------------------------------------------
s = replace_once(s,
'''const RECOVERY_RESERVE_PREFIX = "FUGUE_D3R_";
const RECOVERY_RESERVE_COUNT = 8;''',
'''const RECOVERY_RESERVE_PREFIX = "FUGUE_D3R_";
const RECOVERY_MUTATION_GUARD_PREFIX = "FUGUE_D3G_";
const RECOVERY_MUTATION_GUARD_RESERVE = "FUGUE_D3R_00";
const RECOVERY_MUTATION_GUARD_GRACE_MS = 10 * 60 * 1000;
const RECOVERY_RESERVE_COUNT = 8;''', "guard constants")

insert_after_delete = '''export async function deleteFugueAuthorityVariable(github: FugueGitHub, name: string): Promise<void> {
  const injected = injectedAuthorityVariables(github);
  if (injected) {
    injected.delete(name);
    return;
  }
  const response = await authorityRequest(github, `/actions/variables/${encodeURIComponent(name)}`, { method: "DELETE" });
  if (!response.ok && response.status !== 404) {
    throw new CanonicalWorkStateIntegrityError(`Unable to delete stale Fugue authority variable ${name} (${response.status}).`);
  }
}
'''
if insert_after_delete not in s:
    raise SystemExit("guard insertion anchor missing")
guard_code = insert_after_delete + r'''
interface RecoveryMutationGuard {
  version: 1;
  publisher_sha: string;
  target_name: string;
  target_value: string;
  source_name?: string;
  source_value?: string;
  created_at: string;
}

function recoveryMutationGuardName(guard: RecoveryMutationGuard): string {
  const digest = createHash("sha256")
    .update(`${guard.publisher_sha}\0${guard.source_name ?? ""}\0${guard.target_name}\0${guard.target_value}`, "utf8")
    .digest("hex").slice(0, 24).toUpperCase();
  return `${RECOVERY_MUTATION_GUARD_PREFIX}${digest}`;
}

function parseRecoveryMutationGuard(value: string): RecoveryMutationGuard | undefined {
  try {
    const parsed = JSON.parse(value) as Partial<RecoveryMutationGuard>;
    if (parsed.version !== 1 || typeof parsed.publisher_sha !== "string" ||
        !/^[0-9a-f]{40}$/i.test(parsed.publisher_sha) || typeof parsed.target_name !== "string" ||
        typeof parsed.target_value !== "string" || typeof parsed.created_at !== "string") return undefined;
    if ((parsed.source_name === undefined) !== (parsed.source_value === undefined)) return undefined;
    return parsed as RecoveryMutationGuard;
  } catch { return undefined; }
}

async function activeRecoveryMutationGuards(github: FugueGitHub): Promise<Array<{ name: string; guard: RecoveryMutationGuard }>> {
  const result: Array<{ name: string; guard: RecoveryMutationGuard }> = [];
  for (const variable of await listFugueAuthorityVariables(github, RECOVERY_MUTATION_GUARD_PREFIX)) {
    const guard = parseRecoveryMutationGuard(variable.value);
    if (!guard) {
      throw new CanonicalWorkStateIntegrityError(`Protected recovery mutation guard ${variable.name} is malformed.`);
    }
    result.push({ name: variable.name, guard });
  }
  return result;
}

async function restoreRecoveryMutationGuardReserve(github: FugueGitHub, guardName: string, guardValue: string): Promise<void> {
  if (await getFugueAuthorityVariable(github, guardName) !== guardValue) return;
  if (await getFugueAuthorityVariable(github, RECOVERY_MUTATION_GUARD_RESERVE) === RECOVERY_RESERVE_VALUE) {
    await deleteFugueAuthorityVariable(github, guardName);
    return;
  }
  if (await replaceFugueAuthorityVariable(
    github, guardName, guardValue, RECOVERY_MUTATION_GUARD_RESERVE, RECOVERY_RESERVE_VALUE,
  )) return;
  throw new CanonicalWorkStateIntegrityError("Unable to restore the protected recovery mutation guard reserve.");
}

async function rollbackGuardedRecoveryMutation(
  github: FugueGitHub,
  guardName: string,
  guardValue: string,
  guard: RecoveryMutationGuard,
): Promise<void> {
  if (guard.source_name && guard.source_value !== undefined) {
    const source = await getFugueAuthorityVariable(github, guard.source_name);
    const target = await getFugueAuthorityVariable(github, guard.target_name);
    if (source === undefined && target === guard.target_value) {
      if (!(await replaceFugueAuthorityVariable(
        github, guard.target_name, guard.target_value, guard.source_name, guard.source_value,
      ))) {
        throw new CanonicalWorkStateIntegrityError(
          `Unable to recover interrupted protected recovery replacement ${guard.source_name} -> ${guard.target_name}.`,
        );
      }
    } else if (source !== guard.source_value || (target !== undefined && target !== guard.target_value)) {
      throw new CanonicalWorkStateIntegrityError("Protected recovery mutation guard observed conflicting source/target state.");
    } else if (target === guard.target_value) {
      await deleteAuthorityVariableIfExact(github, guard.target_name, guard.target_value);
    }
  } else {
    await deleteAuthorityVariableIfExact(github, guard.target_name, guard.target_value);
  }
  await restoreRecoveryMutationGuardReserve(github, guardName, guardValue);
}

async function recoverInterruptedRecoveryMutation(github: FugueGitHub): Promise<boolean> {
  const guards = await activeRecoveryMutationGuards(github);
  if (!guards.length) return false;
  if (guards.length > 1) throw new CanonicalWorkStateIntegrityError("Multiple protected recovery mutation guards are active.");
  const { name, guard } = guards[0]!;
  const value = await getFugueAuthorityVariable(github, name);
  if (value === undefined) return false;
  const current = await readRepositoryDefaultBranchIdentity(github);
  const age = Date.now() - Date.parse(guard.created_at);
  if (current.sha.toLowerCase() === guard.publisher_sha.toLowerCase() &&
      Number.isFinite(age) && age < RECOVERY_MUTATION_GUARD_GRACE_MS) {
    return true;
  }
  await rollbackGuardedRecoveryMutation(github, name, value, guard);
  return false;
}

async function acquireRecoveryMutationGuard(
  github: FugueGitHub,
  publisherSha: string,
  targetName: string,
  targetValue: string,
  sourceName?: string,
  sourceValue?: string,
): Promise<{ name: string; value: string } | undefined> {
  if (await recoverInterruptedRecoveryMutation(github)) return undefined;
  await assertRepositoryDefaultBranchRevision(github, publisherSha);
  const guard: RecoveryMutationGuard = {
    version: 1, publisher_sha: publisherSha, target_name: targetName, target_value: targetValue,
    ...(sourceName && sourceValue !== undefined ? { source_name: sourceName, source_value: sourceValue } : {}),
    created_at: new Date().toISOString(),
  };
  const value = JSON.stringify(guard);
  const name = recoveryMutationGuardName(guard);
  const reserve = await getFugueAuthorityVariable(github, RECOVERY_MUTATION_GUARD_RESERVE);
  if (reserve === RECOVERY_RESERVE_VALUE && await replaceFugueAuthorityVariable(
    github, RECOVERY_MUTATION_GUARD_RESERVE, RECOVERY_RESERVE_VALUE, name, value,
  )) return { name, value };
  // Below the hard cap a missing guard reserve can be materialized without consuming recovery data.
  if (reserve === undefined && await createFugueAuthorityVariable(github, name, value)) return { name, value };
  return undefined;
}

async function releaseRecoveryMutationGuard(github: FugueGitHub, token: { name: string; value: string }): Promise<void> {
  await restoreRecoveryMutationGuardReserve(github, token.name, token.value);
}
'''
s = s.replace(insert_after_delete, guard_code, 1)

# Revision-bound create: hold guard across mutation + post-check, so concurrent recovery cannot move it.
old_create = '''async function createFugueAuthorityVariableAtRevision(
  github: FugueGitHub,
  name: string,
  value: string,
  expectedPublisherSha: string,
): Promise<boolean> {
  await assertRepositoryDefaultBranchRevision(github, expectedPublisherSha);
  const created = await createFugueAuthorityVariable(github, name, value);
  if (!created) return false;
  try {
    // The repository-variable API cannot predicate the POST on another resource's SHA. Treat the
    // write as provisional until a post-mutation re-proof succeeds; a stale write is removed before
    // this call can report a committed Authority witness.
    await assertRepositoryDefaultBranchRevision(github, expectedPublisherSha);
    return true;
  } catch (error) {
    await deleteAuthorityVariableIfExact(github, name, value);
    throw error;
  }
}'''
new_create = '''async function createFugueAuthorityVariableAtRevision(
  github: FugueGitHub,
  name: string,
  value: string,
  expectedPublisherSha: string,
): Promise<boolean> {
  const guard = await acquireRecoveryMutationGuard(github, expectedPublisherSha, name, value);
  if (!guard) return false;
  try {
    await assertRepositoryDefaultBranchRevision(github, expectedPublisherSha);
    const created = await createFugueAuthorityVariable(github, name, value);
    if (!created) return false;
    try {
      await assertRepositoryDefaultBranchRevision(github, expectedPublisherSha);
      return true;
    } catch (error) {
      await deleteAuthorityVariableIfExact(github, name, value);
      throw error;
    }
  } finally {
    await releaseRecoveryMutationGuard(github, guard);
  }
}'''
s = replace_once(s, old_create, new_create, "guard create")

# Revision-bound replacement: same guard, with source restoration journalled.
old_head = '''  if (expectedPublisherSha) await assertRepositoryDefaultBranchRevision(github, expectedPublisherSha);
  if (sourceName === targetName) return expectedSourceValue === targetValue;
  const injected = injectedAuthorityVariables(github);'''
new_head = '''  const guard = expectedPublisherSha
    ? await acquireRecoveryMutationGuard(github, expectedPublisherSha, targetName, targetValue, sourceName, expectedSourceValue)
    : undefined;
  if (expectedPublisherSha && !guard) return false;
  if (expectedPublisherSha) await assertRepositoryDefaultBranchRevision(github, expectedPublisherSha);
  if (sourceName === targetName) {
    if (guard) await releaseRecoveryMutationGuard(github, guard);
    return expectedSourceValue === targetValue;
  }
  const injected = injectedAuthorityVariables(github);'''
s = replace_once(s, old_head, new_head, "guard replace head")

old_tail = '''  if (!replaced || !expectedPublisherSha) return replaced;
  try {
    // A slot-preserving rename carrying a new witness is also provisional until the exact protected
    // revision is re-proved after GitHub has applied the PATCH.
    await assertRepositoryDefaultBranchRevision(github, expectedPublisherSha);
    return true;
  } catch (error) {
    await rollbackFugueAuthorityVariableReplacement(github, sourceName, expectedSourceValue, targetName, targetValue);
    throw error;
  }
}'''
new_tail = '''  if (!replaced || !expectedPublisherSha) {
    if (guard) await releaseRecoveryMutationGuard(github, guard);
    return replaced;
  }
  try {
    await assertRepositoryDefaultBranchRevision(github, expectedPublisherSha);
    return true;
  } catch (error) {
    await rollbackFugueAuthorityVariableReplacement(github, sourceName, expectedSourceValue, targetName, targetValue);
    throw error;
  } finally {
    if (guard) await releaseRecoveryMutationGuard(github, guard);
  }
}'''
s = replace_once(s, old_tail, new_tail, "guard replace tail")

# Active guard blocks reserve recreation and makes reads fail closed until cleanup.
s = replace_once(s,
'''async function ensureRecoveryReserveVariables(github: FugueGitHub): Promise<void> {
  const existing = new Set((await listFugueAuthorityVariables(github, RECOVERY_RESERVE_PREFIX)).map((entry) => entry.name));''',
'''async function ensureRecoveryReserveVariables(github: FugueGitHub): Promise<void> {
  if ((await activeRecoveryMutationGuards(github)).length) return;
  const existing = new Set((await listFugueAuthorityVariables(github, RECOVERY_RESERVE_PREFIX)).map((entry) => entry.name));''', "guard reserve")

s = replace_once(s,
'''async function findRecoveryCursor(
  github: FugueGitHub,
  options: RecoveryIdentityOptions,
): Promise<{ variableName: string; cursor: RecoveryCursor } | undefined> {
  const identity = recoveryOptionsIdentity(options);''',
'''async function findRecoveryCursor(
  github: FugueGitHub,
  options: RecoveryIdentityOptions,
): Promise<{ variableName: string; cursor: RecoveryCursor } | undefined> {
  if (await recoverInterruptedRecoveryMutation(github)) {
    throw new DurableProtocolRecoveryPendingError("Protected recovery mutation is still provisional; committed authority remains fenced.");
  }
  const identity = recoveryOptionsIdentity(options);''', "guard reader")

s = replace_once(s,
'''export async function compactFugueRecoveryAuthorityVariables(
  github: FugueGitHub,
  preserveIdentity?: string,
  _reserveSlots = 0,
): Promise<void> {
  await ensureRecoveryReserveVariables(github);''',
'''export async function compactFugueRecoveryAuthorityVariables(
  github: FugueGitHub,
  preserveIdentity?: string,
  _reserveSlots = 0,
): Promise<void> {
  if (await recoverInterruptedRecoveryMutation(github)) return;
  await ensureRecoveryReserveVariables(github);''', "guard compaction")

# Never consume the dedicated mutation-guard reserve as a witness allocation donor.
s = replace_once(s,
'''  const reserves = (await listFugueAuthorityVariables(github, RECOVERY_RESERVE_PREFIX))
    .filter((reserve) => reserve.value === RECOVERY_RESERVE_VALUE)''',
'''  const reserves = (await listFugueAuthorityVariables(github, RECOVERY_RESERVE_PREFIX))
    .filter((reserve) => reserve.value === RECOVERY_RESERVE_VALUE && reserve.name !== RECOVERY_MUTATION_GUARD_RESERVE)''', "guard reserve donor")
write(p, s)

# ---------------------------------------------------------------------------
# Coordinator ingestion compares causal issue identity, not publication time.
# ---------------------------------------------------------------------------
p = "src/core/reconcile.ts"
s = read(p)
old = '''  const existing = await loadCurrentCanonicalWorkState(github, event.issueNumber, policy.identity.baseSha);

  if (event.action === "labeled" || event.action === "unlabeled") {
    if (!existing || !event.label || !event.issueLabels) return false;
    const eventRevision = Date.parse(event.issueUpdatedAt ?? "");
    const stateRevision = Date.parse(existing.created_at);
    // Replaying an old Human label snapshot must not roll back a later protected lifecycle transition.
    if (Number.isFinite(eventRevision) && Number.isFinite(stateRevision) && stateRevision > eventRevision) return false;'''
new = '''  const existing = await loadCurrentCanonicalWorkState(github, event.issueNumber, policy.identity.baseSha);
  const coordinator = coordinatorIdentity(event);
  if (existing && coordinator && compareCoordinatorIdentity(existing, coordinator) >= 0) return false;

  if (event.action === "labeled" || event.action === "unlabeled") {
    if (!existing || !event.label || !event.issueLabels) return false;'''
s = replace_once(s, old, new, "coordinator gate")

s = replace_once(s,
'''      baseSha: policy.identity.baseSha,
      predecessor: existing,
    }));''',
'''      baseSha: policy.identity.baseSha,
      predecessor: existing,
      ...(coordinator ? { coordinator } : {}),
    }));''', "coordinator label publish")

# Replace the first edit/root publication occurrence following acceptedMetadata.
old_edit = '''    baseSha: policy.identity.baseSha,
    ...(existing ? { predecessor: existing } : { logicalRoot: true }),
  }));
}'''
new_edit = '''    baseSha: policy.identity.baseSha,
    ...(existing ? { predecessor: existing } : { logicalRoot: true }),
    ...(coordinator ? { coordinator } : {}),
  }));
}

function coordinatorIdentity(event: CoordinatorIssueEvent): { issueUpdatedAt: string; eventSequence: number; eventId: string } | undefined {
  if (!event.issueUpdatedAt || !event.issueNumber) return undefined;
  return {
    issueUpdatedAt: event.issueUpdatedAt,
    eventSequence: event.eventSequence ?? 0,
    eventId: event.eventId ?? `${event.issueNumber}:${event.issueUpdatedAt}:${event.action}:${event.label ?? ""}`,
  };
}

function compareCoordinatorIdentity(
  state: { coordinator_issue_updated_at?: string; coordinator_event_sequence?: number; coordinator_event_id?: string },
  incoming: { issueUpdatedAt: string; eventSequence: number; eventId: string },
): number {
  if (state.coordinator_issue_updated_at === undefined || state.coordinator_event_sequence === undefined ||
      state.coordinator_event_id === undefined) return -1;
  const left = Date.parse(state.coordinator_issue_updated_at);
  const right = Date.parse(incoming.issueUpdatedAt);
  if (Number.isFinite(left) && Number.isFinite(right) && left !== right) return left < right ? -1 : 1;
  if (state.coordinator_issue_updated_at !== incoming.issueUpdatedAt) {
    return state.coordinator_issue_updated_at.localeCompare(incoming.issueUpdatedAt);
  }
  if (state.coordinator_event_sequence !== incoming.eventSequence) {
    return state.coordinator_event_sequence < incoming.eventSequence ? -1 : 1;
  }
  return state.coordinator_event_id.localeCompare(incoming.eventId);
}'''
s = replace_once(s, old_edit, new_edit, "coordinator edit publish")
write(p, s)

# ---------------------------------------------------------------------------
# Review start + QA verdict become d3 durable authority; comments are mirrors/migration input.
# ---------------------------------------------------------------------------
p = "src/core/reviews.ts"
s = read(p)
s = replace_once(s, 'import type { FugueGitHub } from "./github.js";\n', 'import { createHash } from "node:crypto";\nimport type { FugueGitHub } from "./github.js";\n', "reviews crypto")
s = replace_once(s,
'import { resolveReviewActivity, type ReviewActivity } from "./review-activity.js";\n',
'import { resolveReviewActivity, type ReviewActivity } from "./review-activity.js";\nimport { publishDurableProtocolRecord, recoverDurableProtocolRecord } from "./state.js";\n', "reviews state import")

s = replace_once(s,
'''  const comment = await createProtocolComment(
    github,
    prNumber,''',
'''  await publishReviewAuthority(github, snapshot, session);
  const comment = await createProtocolComment(
    github,
    prNumber,''', "review start durable")

# only completeReview's comment: replace second exact heading anchor
needle = '''  const summary = summaryText ? `\\n\\n${summaryText}` : "";
  const comment = await createProtocolComment('''
replacement = '''  const summary = summaryText ? `\\n\\n${summaryText}` : "";
  await publishReviewAuthority(github, snapshot, attestation);
  const comment = await createProtocolComment('''
s = replace_once(s, needle, replacement, "review qa durable")

old_activity = '''  const activities = new Map<QaRole, ReviewActivity>();
  for (const role of QA_ROLES) {
    activities.set(role, resolveReviewActivity(sessions.get(role) ?? [], attestations.get(role) ?? []));
  }
  return activities;
}'''
new_activity = '''  const activities = new Map<QaRole, ReviewActivity>();
  for (const role of QA_ROLES) {
    const durable = await recoverReviewAuthority(github, snapshot, role);
    if (durable?.kind === "review_start") {
      activities.set(role, resolveReviewActivity([durable], []));
      continue;
    }
    if (durable?.kind === "qa") {
      activities.set(role, resolveReviewActivity([], [durable]));
      continue;
    }
    const migrated = resolveReviewActivity(sessions.get(role) ?? [], attestations.get(role) ?? []);
    const canonical = migrated.completed ?? migrated.active;
    if (canonical) await publishReviewAuthority(github, snapshot, canonical);
    activities.set(role, migrated);
  }
  return activities;
}

function reviewIdentityToken(snapshot: EvaluationSnapshot): string {
  return createHash("sha256").update(JSON.stringify(snapshot.identity), "utf8").digest("hex").slice(0, 16);
}

function reviewAuthorityScope(snapshot: EvaluationSnapshot, role: QaRole): string {
  return `review/${snapshot.identity.prNumber}/${role}/${reviewIdentityToken(snapshot)}`;
}

function reviewAuthorityOrder(value: ReviewStart | QaAttestation): string {
  return `review-v1:${value.kind === "qa" ? "1" : "0"}:${value.created_at}`;
}

async function publishReviewAuthority(
  github: FugueGitHub,
  snapshot: EvaluationSnapshot,
  value: ReviewStart | QaAttestation,
): Promise<void> {
  await publishDurableProtocolRecord(github, {
    storageSha: snapshot.identity.headSha,
    publisherSha: snapshot.identity.baseSha,
    scope: reviewAuthorityScope(snapshot, value.role),
    unsignedBody: `${serializeAttestation(value)}\\n\\nFUGUE REVIEW EVIDENCE — CANONICAL`,
    publicationTimestamp: Date.parse(value.created_at),
    authorityOrder: reviewAuthorityOrder(value),
  });
}

async function recoverReviewAuthority(
  github: FugueGitHub,
  snapshot: EvaluationSnapshot,
  role: QaRole,
): Promise<ReviewStart | QaAttestation | undefined> {
  const recovered = await recoverDurableProtocolRecord(github, {
    storageSha: snapshot.identity.headSha,
    publisherSha: snapshot.identity.baseSha,
    scope: reviewAuthorityScope(snapshot, role),
    issueNumber: snapshot.pr.number,
    parse: (body) => {
      const value = parseAttestation(body);
      return value?.kind === "review_start" || value?.kind === "qa" ? value : null;
    },
    timestamp: (value) => Date.parse(value.created_at),
    order: reviewAuthorityOrder,
    validate: (value) => value.role === role && sameEvaluationIdentity(value.identity, snapshot.identity),
  });
  return recovered.record?.value;
}'''
s = replace_once(s, old_activity, new_activity, "review activity durable")
write(p, s)

# ---------------------------------------------------------------------------
# Human acknowledgement becomes d3 authority, with comments only as repair/migration mirrors.
# ---------------------------------------------------------------------------
p = "src/core/submissions.ts"
s = read(p)
s = replace_once(s, 'import { parse as parseYaml, stringify as stringifyYaml } from "yaml";\n', 'import { createHash } from "node:crypto";\nimport { parse as parseYaml, stringify as stringifyYaml } from "yaml";\n', "submissions crypto")
s = replace_once(s,
'import { completeReview, currentReviewActivities, type CompleteReviewOptions } from "./reviews.js";\n',
'import { completeReview, currentReviewActivities, type CompleteReviewOptions } from "./reviews.js";\nimport { publishDurableProtocolRecord, recoverDurableProtocolRecord } from "./state.js";\n', "submissions state")

s = replace_once(s,
'''  await createProtocolComment(
    github,
    prNumber,
    `HUMAN CONTROL-PLANE ACKNOWLEDGEMENT''',
'''  await publishHumanAcknowledgementAuthority(github, snapshot, attestation);
  await createProtocolComment(
    github,
    prNumber,
    `HUMAN CONTROL-PLANE ACKNOWLEDGEMENT''', "human durable publish")

old_human = '''export async function hasCurrentHumanAcknowledgement(
  github: FugueGitHub,
  snapshot: EvaluationSnapshot,
): Promise<boolean> {
  const { owner, repo } = github.repository;
  const comments = await github.octokit.paginate(github.octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number: snapshot.pr.number,
    per_page: 100,
  });

  for (const comment of comments) {
    if (!(await isTrustedProtocolComment(github, comment))) continue;
    try {
      const value = parseAttestation(comment.body ?? "");
      if (value?.kind !== "human_control_plane") continue;
      if (sameEvaluationIdentity(value.identity, snapshot.identity)) return true;
    } catch {
      // Historical malformed evidence is not current acknowledgement.
    }
  }
  return false;
}'''
new_human = '''export async function hasCurrentHumanAcknowledgement(
  github: FugueGitHub,
  snapshot: EvaluationSnapshot,
): Promise<boolean> {
  const durable = await recoverHumanAcknowledgementAuthority(github, snapshot);
  if (durable) return true;

  const { owner, repo } = github.repository;
  const comments = await github.octokit.paginate(github.octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number: snapshot.pr.number,
    per_page: 100,
  });

  for (const comment of comments) {
    if (!(await isTrustedProtocolComment(github, comment))) continue;
    try {
      const value = parseAttestation(comment.body ?? "");
      if (value?.kind !== "human_control_plane") continue;
      if (!sameEvaluationIdentity(value.identity, snapshot.identity)) continue;
      await publishHumanAcknowledgementAuthority(github, snapshot, value);
      return true;
    } catch {
      // Historical malformed evidence is not current acknowledgement.
    }
  }
  return false;
}

function humanIdentityToken(snapshot: EvaluationSnapshot): string {
  return createHash("sha256").update(JSON.stringify(snapshot.identity), "utf8").digest("hex").slice(0, 20);
}

function humanAcknowledgementScope(snapshot: EvaluationSnapshot): string {
  return `human-cp/${snapshot.identity.prNumber}/${humanIdentityToken(snapshot)}`;
}

async function publishHumanAcknowledgementAuthority(
  github: FugueGitHub,
  snapshot: EvaluationSnapshot,
  value: ReturnType<typeof humanControlPlaneAttestationSchema.parse>,
): Promise<void> {
  await publishDurableProtocolRecord(github, {
    storageSha: snapshot.identity.headSha,
    publisherSha: snapshot.identity.baseSha,
    scope: humanAcknowledgementScope(snapshot),
    unsignedBody: `${serializeAttestation(value)}\\n\\nHUMAN CONTROL-PLANE ACKNOWLEDGEMENT — CANONICAL`,
    publicationTimestamp: Date.parse(value.created_at),
    authorityOrder: `human-cp-v1:${value.created_at}`,
  });
}

async function recoverHumanAcknowledgementAuthority(
  github: FugueGitHub,
  snapshot: EvaluationSnapshot,
): Promise<ReturnType<typeof humanControlPlaneAttestationSchema.parse> | undefined> {
  const recovered = await recoverDurableProtocolRecord(github, {
    storageSha: snapshot.identity.headSha,
    publisherSha: snapshot.identity.baseSha,
    scope: humanAcknowledgementScope(snapshot),
    issueNumber: snapshot.pr.number,
    parse: (body) => {
      const value = parseAttestation(body);
      return value?.kind === "human_control_plane" ? value : null;
    },
    timestamp: (value) => Date.parse(value.created_at),
    order: (value) => `human-cp-v1:${value.created_at}`,
    validate: (value) => sameEvaluationIdentity(value.identity, snapshot.identity) && value.verdict === "acknowledged",
  });
  return recovered.record?.value;
}'''
s = replace_once(s, old_human, new_human, "human durable read")
write(p, s)

# ---------------------------------------------------------------------------
# A completed protected attempt-1 run can seal failure before custom run-start evidence exists.
# ---------------------------------------------------------------------------
p = "src/core/integration-status.ts"
s = read(p)
old_binding = '''  const evidence = record.run ? undefined : await getIntegrationRunStartEvidence(github, record);
  const binding = record.run ?? (evidence ? integrationRunBindingFromEvidence(github, evidence) : undefined);
  if (!binding || binding.id !== event.runId) return false;
  const createdAt = new Date().toISOString();'''
new_binding = '''  const evidence = record.run ? undefined : await getIntegrationRunStartEvidence(github, record);
  let binding = record.run ?? (evidence ? integrationRunBindingFromEvidence(github, evidence) : undefined);
  if (!binding) {
    const requestCreated = Date.parse(record.request.created_at);
    const eventCreated = Date.parse(event.createdAt);
    if (!Number.isFinite(requestCreated) || !Number.isFinite(eventCreated) || eventCreated < requestCreated ||
        event.headSha.toLowerCase() !== record.identity.baseSha.toLowerCase() ||
        event.displayTitle !== integrationRunTitle(record.request.request_id, record.identity.prNumber) ||
        !(await isEarliestCausallyValidIntegrationRun(github, record.request, event.runId))) return false;
    binding = {
      id: event.runId,
      attempt: 1,
      created_at: event.createdAt,
      html_url: event.htmlUrl,
    };
  }
  if (binding.id !== event.runId) return false;
  const createdAt = new Date().toISOString();'''
s = replace_once(s, old_binding, new_binding, "integration prestart binding")

anchor = '''function workflowRun(run: WorkflowRunRecord): IntegrationWorkflowRun {
  return { id: run.id, status: run.status, conclusion: run.conclusion, htmlUrl: run.html_url, createdAt: run.created_at ?? "", attempt: 1 };
}
'''
helper = anchor + '''\nasync function isEarliestCausallyValidIntegrationRun(\n  github: FugueGitHub,\n  request: IntegrationRequest,\n  eventRunId: number,\n): Promise<boolean> {\n  const { owner, repo } = github.repository;\n  const requestCreated = Date.parse(request.created_at);\n  if (!Number.isFinite(requestCreated)) return false;\n  const runs = await github.octokit.paginate(github.octokit.rest.actions.listWorkflowRuns, {\n    owner, repo, workflow_id: "fugue-integration.yml", event: "workflow_dispatch", per_page: 100,\n  });\n  let earliest = eventRunId;\n  for (const raw of runs as unknown as WorkflowRunRecord[]) {\n    if (normalizedRunAttempt(raw.run_attempt) !== 1 || !matchesIntegrationRunIdentity(raw, request, requestCreated)) continue;\n    earliest = Math.min(earliest, raw.id);\n  }\n  return earliest === eventRunId;\n}\n'''
s = replace_once(s, anchor, helper, "integration earliest helper")
write(p, s)

# ---------------------------------------------------------------------------
# Focused adversarial regressions on the newly owned path.
# ---------------------------------------------------------------------------
p = "tests/state-authority-blockers.test.ts"
s = read(p)
s = replace_once(s,
'import type { FugueGitHub } from "../src/core/github.js";\n',
'import type { FugueGitHub } from "../src/core/github.js";\nimport type { EvaluationSnapshot } from "../src/core/evaluation.js";\nimport type { ActivePolicy } from "../src/core/policy.js";\n', "test types")
s = replace_once(s,
'import { workMetadataSchema } from "../src/core/metadata.js";\n',
'import { workMetadataSchema } from "../src/core/metadata.js";\nimport { ingestCoordinatorIssueEvent } from "../src/core/reconcile.js";\nimport { currentReviewActivities } from "../src/core/reviews.js";\nimport { hasCurrentHumanAcknowledgement } from "../src/core/submissions.js";\nimport { createIntegrationRecord, createIntegrationRequest } from "../src/core/integration-plan.js";\nimport { authorizeIntegrationDispatch, getCurrentIntegrationRecord, publishIntegrationRecord, sealIntegrationWorkflowRunEvent } from "../src/core/integration-status.js";\nimport { humanControlPlaneAttestationSchema, qaAttestationSchema, reviewStartSchema, serializeAttestation } from "../src/core/attestations.js";\n', "test imports")

# add revision hook to mock + interface
s = replace_once(s,
'''    assertRepositoryDefaultBranchRevision: vi.fn(async (github: FugueGitHub, expected: string) => {
      const actualSha = (github as TestGithub).__baseSha;''',
'''    assertRepositoryDefaultBranchRevision: vi.fn(async (github: FugueGitHub, expected: string) => {
      await (github as TestGithub).__beforeRevisionCheck?.();
      const actualSha = (github as TestGithub).__baseSha;''', "test revision hook")
s = replace_once(s,
'''  __beforeRecoverySign?: (body: string) => Promise<void> | void;
}''',
'''  __beforeRecoverySign?: (body: string) => Promise<void> | void;
  __beforeRevisionCheck?: () => Promise<void> | void;
}''', "test interface hook")

# makeGithub needs pulls/actions for integration focused test.
s = replace_once(s,
'''        repos: {
          createCommitStatus: vi.fn(async (args: {''',
'''        pulls: {
          get: vi.fn(async (args: { pull_number: number }) => ({ data: { number: args.pull_number, head: { sha: "a".repeat(40) } } })),
        },
        actions: {
          listWorkflowRuns: vi.fn(async () => ({ data: { workflow_runs: [] } })),
        },
        repos: {
          createCommitStatus: vi.fn(async (args: {''', "test github integration APIs")

# append tests before final describe close (last occurrence).
extra = r'''

  it("replays newer Coordinator intent by immutable issue revision even after a slower older publication timestamp", async () => {
    const github = makeGithub();
    const root = createCanonicalWorkState({
      issue: 18, title: "Coordinator root", state: "state:ready", agentReady: true,
      requirements: "## Outcome\nroot", metadata: metadata(false), pr: null, baseSha: BASE,
      createdAt: "2026-08-17T08:00:00.000Z", logicalRoot: true,
      coordinator: { issueUpdatedAt: "2026-08-17T07:00:00.000Z", eventSequence: 10, eventId: "e1" },
    });
    await publishCanonicalWorkState(github, root);
    const current = (await loadCurrentCanonicalWorkState(github, 18, BASE))!;
    const slowOldPublication = createCanonicalWorkState({
      issue: 18, title: current.title, state: "state:working", agentReady: current.agent_ready,
      requirements: canonicalRequirements(current), metadata: current.metadata, pr: current.pr, baseSha: BASE,
      createdAt: "2026-08-17T09:00:00.000Z", predecessor: current,
    });
    await publishCanonicalWorkState(github, slowOldPublication);

    const policy = { identity: { baseSha: BASE } } as unknown as ActivePolicy;
    await expect(ingestCoordinatorIssueEvent(github, policy, {
      eventName: "issues", action: "unlabeled", actor: "human", issueNumber: 18,
      label: "agent:ready", issueTitle: "Coordinator root", issueBody: "", issueLabels: ["state:working"],
      issueUpdatedAt: "2026-08-17T07:30:00.000Z", eventSequence: 11, eventId: "e2",
    }, true)).resolves.toBe(true);
    const applied = await loadCurrentCanonicalWorkState(github, 18, BASE);
    expect(applied?.agent_ready).toBe(false);
    expect(applied?.coordinator_event_id).toBe("e2");
  });

  it("keeps final Authority witness fenced while stale cleanup races compaction and reserve recreation", async () => {
    const github = makeGithub();
    let raced = false;
    github.__beforeRevisionCheck = async () => {
      if (raced || ![...github.__authorityVariables.keys()].some((name) => name.startsWith("FUGUE_D3G_"))) return;
      const target = [...github.__authorityVariables.keys()].find((name) => /^FUGUE_D3_[0-9A-F]{16}_[0-9A-F]{16}$/i.test(name));
      if (!target) return;
      raced = true;
      github.__baseSha = NEXT_BASE;
      await compactFugueRecoveryAuthorityVariables(github);
    };
    await expect(publishDurableProtocolRecord(github, {
      storageSha: BASE, publisherSha: BASE, scope: "guarded-create-race",
      unsignedBody: "must-not-survive-guard-race", publicationTimestamp: Date.parse("2026-08-17T08:10:00.000Z"),
      authorityOrder: "2026-08-17T08:10:00.000Z",
    })).rejects.toThrow(/stale protected revision/);
    github.__beforeRevisionCheck = undefined;
    expect(recoveryScopes(github).has("guarded-create-race")).toBe(false);
    expect([...github.__authorityVariables.keys()].some((name) => name.startsWith("FUGUE_D3G_"))).toBe(false);
    expect(github.__authorityVariables.get("FUGUE_D3R_00")).toBe("reserved-for-fugue-recovery-compaction");
  });

  it("recovers accepted QA and Human evidence from d3 after every presentation comment is deleted", async () => {
    const github = makeGithub();
    const identity = {
      prNumber: 19, headSha: "a".repeat(40), baseBranch: "main", baseSha: BASE,
      policyDigest: "sha256:policy", protocolVersion: 1 as const, issueNumber: 18, workId: "work-18",
      workSpecDigest: "sha256:spec",
    };
    const snapshot = { identity, pr: { number: 19 }, qa: { controlPlaneChanged: true } } as unknown as EvaluationSnapshot;
    const session = reviewStartSchema.parse({ version: 1, kind: "review_start", session_id: "rev-code-durable1", role: "code", identity, fugue_version: "test", created_at: "2026-08-17T08:20:00.000Z" });
    const qa = qaAttestationSchema.parse({ version: 1, kind: "qa", attestation_id: "att-code-durable1", session_id: session.session_id, role: "code", identity, fugue_version: "test", verdict: "approved", created_at: "2026-08-17T08:21:00.000Z" });
    const human = humanControlPlaneAttestationSchema.parse({ version: 1, kind: "human_control_plane", attestation_id: "att-human-durable1", identity, fugue_version: "test", actor: "human", verdict: "acknowledged", created_at: "2026-08-17T08:22:00.000Z" });
    for (const value of [session, qa, human]) {
      await github.octokit.rest.issues.createComment({ owner: "JohnnyZLi", repo: "Fugue", issue_number: 19, body: serializeAttestation(value) });
    }
    const before = await currentReviewActivities(github, snapshot);
    expect(before.get("code")?.completed?.attestation_id).toBe(qa.attestation_id);
    await expect(hasCurrentHumanAcknowledgement(github, snapshot)).resolves.toBe(true);
    github.__comments.splice(0);
    const after = await currentReviewActivities(github, snapshot);
    expect(after.get("code")?.completed?.attestation_id).toBe(qa.attestation_id);
    await expect(hasCurrentHumanAcknowledgement(github, snapshot)).resolves.toBe(true);
  });

  it("seals a genuine protected attempt-1 failure even when it completes before custom run-start evidence", async () => {
    const github = makeGithub();
    const identity = {
      prNumber: 19, headSha: "a".repeat(40), baseBranch: "main", baseSha: BASE,
      policyDigest: "sha256:policy", protocolVersion: 1 as const, issueNumber: 18, workId: "work-18",
      workSpecDigest: "sha256:spec",
    };
    const request = createIntegrationRequest(identity, "2026-08-17T08:30:00.000Z", "1".repeat(16));
    const authorized = await authorizeIntegrationDispatch(github, request, "2026-08-17T08:30:00.000Z", "2".repeat(64));
    await publishIntegrationRecord(github, createIntegrationRecord(request, { dispatch: authorized.authorization, createdAt: "2026-08-17T08:30:00.000Z" }));
    (github.octokit.rest.actions.listWorkflowRuns as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { workflow_runs: [] } });
    await expect(sealIntegrationWorkflowRunEvent(github, {
      eventName: "workflow_run", workflowName: "Fugue Integration", runId: 4242, runAttempt: 1,
      conclusion: "failure", status: "completed", headSha: BASE,
      displayTitle: `Fugue Integration PR #19 ${request.request_id}`,
      createdAt: "2026-08-17T08:31:00.000Z", htmlUrl: "https://github.com/JohnnyZLi/Fugue/actions/runs/4242",
      actor: "github-actions[bot]",
    })).resolves.toBe(true);
    const terminal = await getCurrentIntegrationRecord(github, identity);
    expect(terminal?.run?.id).toBe(4242);
    expect(terminal?.terminal?.state).toBe("failure");
  });
'''
idx = s.rfind('\n});')
if idx < 0:
    raise SystemExit("test final describe close missing")
s = s[:idx] + extra + s[idx:]
write(p, s)

# ---------------------------------------------------------------------------
# Contract/docs: append precise new boundaries without rewriting unrelated history.
# ---------------------------------------------------------------------------
p = "AGENTS.md"
s = read(p)
needle = "26. Every protected protocol publication site supplies its own writer-owned marker. Reflected filenames, errors, summaries, reasons, and other untrusted details are escaped as data and can never become the marker protected Fugue signs or suppress dashboard publication."
replacement = needle + "\n27. Canonical work state carries the last accepted immutable Coordinator issue revision identity (`issue_updated_at`, protected sequence, event ID). Human event replay compares that causal identity, never publication `created_at`, so a slow older protected write cannot suppress newer Human intent.\n28. Review-start/QA verdicts and explicit Human control-plane acknowledgement are committed to protected d3 durable authority before their PR comments/statuses are treated as presentation mirrors; deleting every current evidence comment cannot erase accepted exact-identity evidence.\n29. Revision-bound recovery-witness mutation is fenced by a protected Authority-plane transaction guard. While a final create/rename is provisional, readers fail closed and compactors/reserve maintenance defer; stale/crashed transactions restore their exact source/target before the guard is released.\n30. A completed protected Integration attempt-1 event can durably seal its exact request/run as terminal before custom run-start publication when failure occurs during environment/App-token setup; absence of `FUGUE_INT_S_*` cannot by itself convert observed attempt-1 failure into retry."
s = replace_once(s, needle, replacement, "AGENTS new invariants")
write(p, s)

for p in ["README.md", "docs/leader-chat.md"]:
    s = read(p)
    addition = "\n\n### Durable review and final-mutation recovery\n\nCurrent review-start/QA verdicts and explicit Human control-plane acknowledgement are protected d3 records; their GitHub comments/statuses are repairable mirrors. Canonical work state also carries the immutable Coordinator issue revision identity, so Human event replay is ordered by issue revision/sequence/event ID rather than work-state publication time. Final Authority-variable recovery writes are fenced while provisional so concurrent compaction/reserve maintenance cannot preserve a stale-base witness during rollback or crash recovery. A protected attempt-1 Integration failure observed before custom run-start evidence is sealed terminal against its exact durable request/run instead of becoming an unstarted retry.\n"
    if "### Durable review and final-mutation recovery" not in s:
        s += addition
    write(p, s)

print("patched absorbed QA blockers")
