from __future__ import annotations
import pathlib, sys

root = pathlib.Path(sys.argv[1])

def once(text: str, old: str, new: str, label: str) -> str:
    n = text.count(old)
    if n != 1:
        raise SystemExit(f"{label}: expected 1 match, found {n}")
    return text.replace(old, new, 1)

# ---------- src/core/state.ts: epoch-pinned reads + exclusive maintenance guard ----------
p = root / 'src/core/state.ts'
s = p.read_text()
s = once(s,
'''interface RecoveryMutationGuard {
  version: 1;
  publisher_sha: string;
  target_name: string;
  target_value: string;
  source_name?: string;
  source_value?: string;
  created_at: string;
}''',
'''interface RecoveryMutationGuard {
  version: 1;
  publisher_sha: string;
  target_name: string;
  target_value: string;
  source_name?: string;
  source_value?: string;
  created_at: string;
  maintenance?: boolean;
}''', 'guard interface')

start = s.index('async function ensureRecoveryMutationGuardIdle(')
end = s.index('\nasync function rollbackFugueAuthorityVariableReplacement(', start)
new_block = r'''function isRecoveryMutationGuardIdleValue(value: string): boolean {
  return value === RECOVERY_MUTATION_GUARD_IDLE_VALUE ||
    new RegExp(`^${RECOVERY_MUTATION_GUARD_IDLE_VALUE}:[0-9a-f]{32}$`, "i").test(value);
}

function nextRecoveryMutationGuardIdleValue(guardName: string, guardValue: string): string {
  const epoch = createHash("sha256").update(`${guardName}\0${guardValue}`, "utf8").digest("hex").slice(0, 32);
  return `${RECOVERY_MUTATION_GUARD_IDLE_VALUE}:${epoch}`;
}

async function ensureRecoveryMutationGuardIdle(github: FugueGitHub): Promise<string | undefined> {
  if ((await activeRecoveryMutationGuards(github)).length) return undefined;
  let current = await getFugueAuthorityVariable(github, RECOVERY_MUTATION_GUARD_IDLE);
  if (current !== undefined) {
    if (!isRecoveryMutationGuardIdleValue(current)) {
      throw new CanonicalWorkStateIntegrityError("Protected recovery mutation guard idle slot has conflicting state.");
    }
    if ((await activeRecoveryMutationGuards(github)).length) return undefined;
    return current;
  }

  const initial = `${RECOVERY_MUTATION_GUARD_IDLE_VALUE}:${randomBytes(16).toString("hex")}`;
  if (!(await createFugueAuthorityVariable(github, RECOVERY_MUTATION_GUARD_IDLE, initial))) {
    current = await getFugueAuthorityVariable(github, RECOVERY_MUTATION_GUARD_IDLE);
    if (current !== undefined && !isRecoveryMutationGuardIdleValue(current)) {
      throw new CanonicalWorkStateIntegrityError("Protected recovery mutation guard idle slot has conflicting state.");
    }
    return current;
  }
  // If another protected writer acquired the just-created slot between our initial active check and
  // this revalidation, never leave a second idle slot beside its active transaction.
  if ((await activeRecoveryMutationGuards(github)).length) {
    await deleteAuthorityVariableIfExact(github, RECOVERY_MUTATION_GUARD_IDLE, initial);
    return undefined;
  }
  return await getFugueAuthorityVariable(github, RECOVERY_MUTATION_GUARD_IDLE) === initial ? initial : undefined;
}

async function restoreRecoveryMutationGuardIdle(github: FugueGitHub, guardName: string, guardValue: string): Promise<void> {
  if (await getFugueAuthorityVariable(github, guardName) !== guardValue) return;
  const idle = await getFugueAuthorityVariable(github, RECOVERY_MUTATION_GUARD_IDLE);
  if (idle !== undefined) {
    throw new CanonicalWorkStateIntegrityError("Protected recovery mutation guard idle slot reappeared while a transaction was active.");
  }
  const nextIdle = nextRecoveryMutationGuardIdleValue(guardName, guardValue);
  if (await replaceFugueAuthorityVariable(
    github, guardName, guardValue, RECOVERY_MUTATION_GUARD_IDLE, nextIdle,
  )) return;
  throw new CanonicalWorkStateIntegrityError("Unable to restore the protected recovery mutation guard idle slot.");
}

async function rollbackGuardedRecoveryMutation(
  github: FugueGitHub,
  guardName: string,
  guardValue: string,
  guard: RecoveryMutationGuard,
): Promise<void> {
  if (guard.maintenance) {
    await restoreRecoveryMutationGuardIdle(github, guardName, guardValue);
    return;
  }
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
  await restoreRecoveryMutationGuardIdle(github, guardName, guardValue);
}

async function recoverInterruptedRecoveryMutation(github: FugueGitHub): Promise<boolean> {
  const guards = await activeRecoveryMutationGuards(github);
  if (!guards.length) return false;
  if (guards.length > 1) throw new CanonicalWorkStateIntegrityError("Multiple protected recovery mutation guards are active.");
  const { name, guard } = guards[0]!;
  const value = await getFugueAuthorityVariable(github, name);
  if (value === undefined) return false;
  const age = Date.now() - Date.parse(guard.created_at);
  if (guard.maintenance) {
    if (Number.isFinite(age) && age < RECOVERY_MUTATION_GUARD_GRACE_MS) return true;
    await rollbackGuardedRecoveryMutation(github, name, value, guard);
    return false;
  }
  let publisherStillCurrent = true;
  try { await assertRepositoryDefaultBranchRevision(github, guard.publisher_sha); }
  catch { publisherStillCurrent = false; }
  if (publisherStillCurrent && Number.isFinite(age) && age < RECOVERY_MUTATION_GUARD_GRACE_MS) return true;
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
  const idle = await ensureRecoveryMutationGuardIdle(github);
  if (!idle) return undefined;
  if (await replaceFugueAuthorityVariable(github, RECOVERY_MUTATION_GUARD_IDLE, idle, name, value)) {
    return { name, value };
  }
  return undefined;
}

async function acquireRecoveryMaintenanceGuard(
  github: FugueGitHub,
): Promise<{ name: string; value: string } | undefined> {
  if (await recoverInterruptedRecoveryMutation(github)) return undefined;
  const guard: RecoveryMutationGuard = {
    version: 1,
    publisher_sha: "0".repeat(40),
    target_name: "__fugue_recovery_maintenance__",
    target_value: randomBytes(16).toString("hex"),
    created_at: new Date().toISOString(),
    maintenance: true,
  };
  const value = JSON.stringify(guard);
  const name = recoveryMutationGuardName(guard);
  const idle = await ensureRecoveryMutationGuardIdle(github);
  if (!idle) return undefined;
  return await replaceFugueAuthorityVariable(github, RECOVERY_MUTATION_GUARD_IDLE, idle, name, value)
    ? { name, value }
    : undefined;
}

async function releaseRecoveryMutationGuard(github: FugueGitHub, token: { name: string; value: string }): Promise<void> {
  await restoreRecoveryMutationGuardIdle(github, token.name, token.value);
}
'''
s = s[:start] + new_block + s[end:]

# Insert revision-bound replacement helper after the ordinary replacement function.
needle = '''interface VerifiedRecoveryEntry {
  sourceVariableName: string;'''
helper = '''async function replaceFugueAuthorityVariableAtRevisionUnderGuard(
  github: FugueGitHub,
  sourceName: string,
  expectedSourceValue: string,
  targetName: string,
  targetValue: string,
  expectedPublisherSha: string,
  guard: { name: string; value: string },
): Promise<boolean> {
  if (await getFugueAuthorityVariable(github, guard.name) !== guard.value) {
    throw new DurableProtocolRecoveryPendingError("Protected recovery maintenance transaction lost its guard.");
  }
  await assertRepositoryDefaultBranchRevision(github, expectedPublisherSha);
  const replaced = await replaceFugueAuthorityVariable(
    github, sourceName, expectedSourceValue, targetName, targetValue,
  );
  if (!replaced) return false;
  try {
    await assertRepositoryDefaultBranchRevision(github, expectedPublisherSha);
    return true;
  } catch (error) {
    await rollbackFugueAuthorityVariableReplacement(
      github, sourceName, expectedSourceValue, targetName, targetValue,
    );
    throw error;
  }
}

interface VerifiedRecoveryEntry {
  sourceVariableName: string;'''
s = once(s, needle, helper, 'revision replacement helper')

# Replace reserve maintenance with a locked primitive plus a wrapper.
old = '''async function ensureRecoveryReserveVariables(github: FugueGitHub): Promise<void> {
  if ((await activeRecoveryMutationGuards(github)).length) return;
  const existing = new Set((await listFugueAuthorityVariables(github, RECOVERY_RESERVE_PREFIX)).map((entry) => entry.name));
  let allCount = (await listFugueAuthorityVariables(github, "")).length;
  for (let index = 0; index < RECOVERY_RESERVE_COUNT; index += 1) {
    const name = recoveryReserveName(index);
    if (existing.has(name) || allCount >= REPOSITORY_AUTHORITY_VARIABLE_CAPACITY) continue;
    if (await createFugueAuthorityVariable(github, name, RECOVERY_RESERVE_VALUE)) {
      allCount += 1;
    }
  }
}'''
new = '''async function ensureRecoveryReserveVariablesLocked(github: FugueGitHub): Promise<void> {
  const existing = new Set((await listFugueAuthorityVariables(github, RECOVERY_RESERVE_PREFIX)).map((entry) => entry.name));
  let allCount = (await listFugueAuthorityVariables(github, "")).length;
  for (let index = 0; index < RECOVERY_RESERVE_COUNT; index += 1) {
    const name = recoveryReserveName(index);
    if (existing.has(name) || allCount >= REPOSITORY_AUTHORITY_VARIABLE_CAPACITY) continue;
    if (await createFugueAuthorityVariable(github, name, RECOVERY_RESERVE_VALUE)) allCount += 1;
  }
}

async function ensureRecoveryReserveVariables(github: FugueGitHub): Promise<void> {
  const guard = await acquireRecoveryMaintenanceGuard(github);
  if (!guard) return;
  try { await ensureRecoveryReserveVariablesLocked(github); }
  finally { await releaseRecoveryMutationGuard(github, guard); }
}'''
s = once(s, old, new, 'reserve lock')

# Add epoch capture and revalidation to reader paths.
old = '''async function findRecoveryCursor(
  github: FugueGitHub,
  options: RecoveryIdentityOptions,
): Promise<{ variableName: string; cursor: RecoveryCursor } | undefined> {
  if (await recoverInterruptedRecoveryMutation(github)) {
    throw new DurableProtocolRecoveryPendingError("Protected recovery mutation is still provisional; committed authority remains fenced.");
  }
  const identity = recoveryOptionsIdentity(options);'''
new = '''async function captureRecoveryReadEpoch(github: FugueGitHub): Promise<string> {
  if (await recoverInterruptedRecoveryMutation(github)) {
    throw new DurableProtocolRecoveryPendingError("Protected recovery mutation is still provisional; committed authority remains fenced.");
  }
  const epoch = await ensureRecoveryMutationGuardIdle(github);
  if (!epoch || (await activeRecoveryMutationGuards(github)).length ||
      await getFugueAuthorityVariable(github, RECOVERY_MUTATION_GUARD_IDLE) !== epoch) {
    throw new DurableProtocolRecoveryPendingError("Protected recovery authority changed while the reader was starting.");
  }
  return epoch;
}

async function assertRecoveryReadEpoch(github: FugueGitHub, epoch: string): Promise<void> {
  if ((await activeRecoveryMutationGuards(github)).length ||
      await getFugueAuthorityVariable(github, RECOVERY_MUTATION_GUARD_IDLE) !== epoch) {
    throw new DurableProtocolRecoveryPendingError(
      "Protected recovery authority changed during the read; retry from a fresh committed epoch.",
    );
  }
}

async function findRecoveryCursor(
  github: FugueGitHub,
  options: RecoveryIdentityOptions,
): Promise<{ variableName: string; cursor: RecoveryCursor } | undefined> {
  const readEpoch = await captureRecoveryReadEpoch(github);
  const identity = recoveryOptionsIdentity(options);'''
s = once(s, old, new, 'reader epoch start')
s = once(s,
'''    if (best && recoveryAuthorityConflict(entry.cursor, best.cursor)) {
      throw new CanonicalWorkStateIntegrityError(
        `Conflicting protected durable witnesses share one authority order for ${options.scope}.`,
      );
    }''',
'''    if (best && recoveryAuthorityConflict(entry.cursor, best.cursor)) {
      await assertRecoveryReadEpoch(github, readEpoch);
      throw new CanonicalWorkStateIntegrityError(
        `Conflicting protected durable witnesses share one authority order for ${options.scope}.`,
      );
    }''', 'reader conflict recheck')
s = once(s,
'''  return best ? { variableName: best.sourceVariableName, cursor: best.cursor } : undefined;
}

async function hasStructuralRecoveryWitness(''',
'''  await assertRecoveryReadEpoch(github, readEpoch);
  return best ? { variableName: best.sourceVariableName, cursor: best.cursor } : undefined;
}

async function hasStructuralRecoveryWitness(''', 'reader final recheck')

old = '''async function hasStructuralRecoveryWitness(
  github: FugueGitHub,
  options: RecoveryIdentityOptions,
): Promise<boolean> {
  const identity = recoveryOptionsIdentity(options);'''
new = '''async function hasStructuralRecoveryWitness(
  github: FugueGitHub,
  options: RecoveryIdentityOptions,
): Promise<boolean> {
  const readEpoch = await captureRecoveryReadEpoch(github);
  const identity = recoveryOptionsIdentity(options);'''
s = once(s, old, new, 'structural epoch start')
s = once(s,
'''      if (cursor?.commit_witness && recoveryIdentity(cursor) === identity) return true;
    }
  }
  return false;
}''',
'''      if (cursor?.commit_witness && recoveryIdentity(cursor) === identity) {
        await assertRecoveryReadEpoch(github, readEpoch);
        return true;
      }
    }
  }
  await assertRecoveryReadEpoch(github, readEpoch);
  return false;
}''', 'structural epoch final')

# Thread the maintenance token through compaction.
s = once(s,
'''async function compactRecoveryBucket(
  github: FugueGitHub,
  bucket: string,
  variables: readonly FugueAuthorityVariable[],
  allocation?: VerifiedRecoveryAllocation,
): Promise<RecoveryCompactionResult> {''',
'''async function compactRecoveryBucket(
  github: FugueGitHub,
  bucket: string,
  variables: readonly FugueAuthorityVariable[],
  allocation?: VerifiedRecoveryAllocation,
  maintenanceGuard?: { name: string; value: string },
): Promise<RecoveryCompactionResult> {''', 'compaction guard parameter')

# Replace all three revision-bound allocation renames in compactRecoveryBucket with the under-guard helper.
s = s.replace('''await replaceFugueAuthorityVariable(
          github,
          sourceName,
          expected,
          allocation.name,
          allocation.value,
          allocation.entry.cursor.publisher_sha,
        )''', '''await (maintenanceGuard
          ? replaceFugueAuthorityVariableAtRevisionUnderGuard(
              github, sourceName, expected, allocation.name, allocation.value,
              allocation.entry.cursor.publisher_sha, maintenanceGuard,
            )
          : replaceFugueAuthorityVariable(
              github, sourceName, expected, allocation.name, allocation.value,
              allocation.entry.cursor.publisher_sha,
            ))''')
s = s.replace('''await replaceFugueAuthorityVariable(
        github,
        candidate.sourceName,
        candidate.expectedValue,
        outputName,
        outputValue,
        allocation.entry.cursor.publisher_sha,
      )''', '''await (maintenanceGuard
        ? replaceFugueAuthorityVariableAtRevisionUnderGuard(
            github, candidate.sourceName, candidate.expectedValue, outputName, outputValue,
            allocation.entry.cursor.publisher_sha, maintenanceGuard,
          )
        : replaceFugueAuthorityVariable(
            github, candidate.sourceName, candidate.expectedValue, outputName, outputValue,
            allocation.entry.cursor.publisher_sha,
          ))''')
s = s.replace('''await replaceFugueAuthorityVariable(
            github,
            unit.sourceName,
            unit.expectedValue,
            allocation.name,
            allocation.value,
            allocation.entry.cursor.publisher_sha,
          )''', '''await (maintenanceGuard
          ? replaceFugueAuthorityVariableAtRevisionUnderGuard(
              github, unit.sourceName, unit.expectedValue, allocation.name, allocation.value,
              allocation.entry.cursor.publisher_sha, maintenanceGuard,
            )
          : replaceFugueAuthorityVariable(
              github, unit.sourceName, unit.expectedValue, allocation.name, allocation.value,
              allocation.entry.cursor.publisher_sha,
            ))''')

# Replace allocation compaction loop with an exclusive maintenance section.
old = '''  for (let attempt = 0; attempt < RECOVERY_COMPACTION_RETRY_LIMIT; attempt += 1) {
    const variables = await listFugueAuthorityVariables(github, "FUGUE_D3");
    const buckets = [...new Set(variables.map((entry) => variableRecoveryBucket(entry.name))
      .filter((value): value is string => Boolean(value)))].sort();
    let madeProgress = false;
    for (const bucket of buckets) {
      const result = await compactRecoveryBucket(
        github,
        bucket,
        variables.filter((entry) => variableRecoveryBucket(entry.name) === bucket),
        verifiedAllocation,
      );
      madeProgress ||= result.progress;
      if (result.allocated || await getFugueAuthorityVariable(github, verifiedAllocation.name) === verifiedAllocation.value) {
        await assertRepositoryDefaultBranchRevision(github, publisherSha);
        await ensureRecoveryReserveVariables(github);
        return true;
      }
    }
    await assertRepositoryDefaultBranchRevision(github, publisherSha);
    if (await createFugueAuthorityVariableAtRevision(github, verifiedAllocation.name, verifiedAllocation.value, publisherSha)) {
      await ensureRecoveryReserveVariables(github);
      return true;
    }
    if (!madeProgress) break;
  }'''
new = '''  for (let attempt = 0; attempt < RECOVERY_COMPACTION_RETRY_LIMIT; attempt += 1) {
    let madeProgress = false;
    let allocated = false;
    const maintenanceGuard = await acquireRecoveryMaintenanceGuard(github);
    if (maintenanceGuard) {
      try {
        await assertRepositoryDefaultBranchRevision(github, publisherSha);
        const variables = await listFugueAuthorityVariables(github, "FUGUE_D3");
        const buckets = [...new Set(variables.map((entry) => variableRecoveryBucket(entry.name))
          .filter((value): value is string => Boolean(value)))].sort();
        for (const bucket of buckets) {
          const result = await compactRecoveryBucket(
            github,
            bucket,
            variables.filter((entry) => variableRecoveryBucket(entry.name) === bucket),
            verifiedAllocation,
            maintenanceGuard,
          );
          madeProgress ||= result.progress;
          if (result.allocated || await getFugueAuthorityVariable(github, verifiedAllocation.name) === verifiedAllocation.value) {
            allocated = true;
            break;
          }
        }
        if (allocated) await assertRepositoryDefaultBranchRevision(github, publisherSha);
      } finally {
        await releaseRecoveryMutationGuard(github, maintenanceGuard);
      }
    }
    if (allocated) {
      await ensureRecoveryReserveVariables(github);
      return true;
    }
    await assertRepositoryDefaultBranchRevision(github, publisherSha);
    if (await createFugueAuthorityVariableAtRevision(github, verifiedAllocation.name, verifiedAllocation.value, publisherSha)) {
      await ensureRecoveryReserveVariables(github);
      return true;
    }
    if (!madeProgress) break;
  }'''
s = once(s, old, new, 'allocation compaction lock')

# Replace exported compaction body with an exclusive maintenance transaction.
old = '''export async function compactFugueRecoveryAuthorityVariables(
  github: FugueGitHub,
  preserveIdentity?: string,
  _reserveSlots = 0,
): Promise<void> {
  if (await recoverInterruptedRecoveryMutation(github)) return;
  // The mutation guard is protocol overhead, not an optional compaction reserve. Create it before
  // optional reserves whenever capacity exists; a legacy full namespace is compacted below and
  // gets the guard before any reserve recreation consumes newly freed headroom.
  await ensureRecoveryMutationGuardIdle(github);
  await ensureRecoveryReserveVariables(github);
  for (let attempt = 0; attempt < RECOVERY_COMPACTION_RETRY_LIMIT; attempt += 1) {
    const variables = await listFugueAuthorityVariables(github, "FUGUE_D3");
    const buckets = preserveIdentity ? [recoveryBucket(preserveIdentity)] :
      [...new Set(variables.map((entry) => variableRecoveryBucket(entry.name))
        .filter((value): value is string => Boolean(value)))].sort();
    let progress = false;
    for (const bucket of buckets) {
      const result = await compactRecoveryBucket(
        github,
        bucket,
        variables.filter((entry) => variableRecoveryBucket(entry.name) === bucket),
      );
      progress ||= result.progress;
    }
    if (!progress) break;
  }
  await ensureRecoveryMutationGuardIdle(github);
  await ensureRecoveryReserveVariables(github);
}'''
new = '''export async function compactFugueRecoveryAuthorityVariables(
  github: FugueGitHub,
  preserveIdentity?: string,
  _reserveSlots = 0,
): Promise<void> {
  const maintenanceGuard = await acquireRecoveryMaintenanceGuard(github);
  if (!maintenanceGuard) return;
  try {
    await ensureRecoveryReserveVariablesLocked(github);
    for (let attempt = 0; attempt < RECOVERY_COMPACTION_RETRY_LIMIT; attempt += 1) {
      const variables = await listFugueAuthorityVariables(github, "FUGUE_D3");
      const buckets = preserveIdentity ? [recoveryBucket(preserveIdentity)] :
        [...new Set(variables.map((entry) => variableRecoveryBucket(entry.name))
          .filter((value): value is string => Boolean(value)))].sort();
      let progress = false;
      for (const bucket of buckets) {
        const result = await compactRecoveryBucket(
          github,
          bucket,
          variables.filter((entry) => variableRecoveryBucket(entry.name) === bucket),
          undefined,
          maintenanceGuard,
        );
        progress ||= result.progress;
      }
      if (!progress) break;
    }
    await ensureRecoveryReserveVariablesLocked(github);
  } finally {
    await releaseRecoveryMutationGuard(github, maintenanceGuard);
  }
}'''
s = once(s, old, new, 'exported compaction lock')
p.write_text(s)

# ---------- Integration record schema: durable dispatch-start transition ----------
p = root / 'src/core/integration-plan.ts'; s = p.read_text()
s = once(s,
'''  dispatch: integrationDispatchAuthorizationSchema.nullable().default(null),
  run: integrationRunBindingSchema.nullable(),''',
'''  dispatch: integrationDispatchAuthorizationSchema.nullable().default(null),
  dispatch_started_at: z.string().min(1).nullable().default(null),
  run: integrationRunBindingSchema.nullable(),''', 'integration dispatch started schema')
s = once(s,
'''    dispatch?: IntegrationDispatchAuthorization | null;
    run?: IntegrationRunBinding | null;''',
'''    dispatch?: IntegrationDispatchAuthorization | null;
    dispatchStartedAt?: string | null;
    run?: IntegrationRunBinding | null;''', 'integration create input')
s = once(s,
'''    dispatch: input.dispatch ?? null,
    run: input.run ?? null,''',
'''    dispatch: input.dispatch ?? null,
    dispatch_started_at: input.dispatchStartedAt ?? null,
    run: input.run ?? null,''', 'integration create value')
p.write_text(s)

# ---------- integration-status.ts: secret run token, recover lost bind, seal event ----------
p = root / 'src/core/integration-status.ts'; s = p.read_text()
s = once(s, 'import { createHash, randomBytes } from "node:crypto";', 'import { createHash, createHmac, randomBytes } from "node:crypto";', 'hmac import')
insert_after = '''export const INTEGRATION_AUTHORITY_SLOT_LIMIT = 64;\n'''
addition = r'''

export function integrationDispatchRunToken(requestId: string, dispatchSecret: string): string {
  if (!/^int-[0-9a-f]{16}-[0-9a-f]{16}$/.test(requestId) || !/^[0-9a-f]{64}$/i.test(dispatchSecret)) {
    throw new Error("Invalid Integration run-correlation input.");
  }
  return createHmac("sha256", Buffer.from(dispatchSecret, "hex"))
    .update(`fugue-integration-run\0${requestId}`, "utf8")
    .digest("hex")
    .slice(0, 24);
}

function integrationRunTitleWithToken(request: IntegrationRequest, token: string): string {
  return `${integrationRunTitle(request.request_id, request.identity.prNumber)} ${token}`;
}
'''
s = once(s, insert_after, insert_after + addition, 'run token helper')

# Monotonic dispatch-start field check in publication.
s = once(s,
'''  if (current && record.request.request_id === current.request.request_id &&
      JSON.stringify(current.dispatch) !== JSON.stringify(record.dispatch)) {
    throw new Error(`Integration request ${record.request.request_id} cannot replace its protected dispatch authorization.`);
  }
  if (current?.run && record.run && current.run.id !== record.run.id) {''',
'''  if (current && record.request.request_id === current.request.request_id &&
      JSON.stringify(current.dispatch) !== JSON.stringify(record.dispatch)) {
    throw new Error(`Integration request ${record.request.request_id} cannot replace its protected dispatch authorization.`);
  }
  if (current?.dispatch_started_at && record.dispatch_started_at !== current.dispatch_started_at) {
    throw new Error(`Integration request ${record.request.request_id} cannot clear or replace its durable dispatch-start boundary.`);
  }
  if (current?.run && record.run && current.run.id !== record.run.id) {''', 'dispatch start monotonic')

# Insert helpers before ensureIntegrationDispatch.
marker = '''export async function ensureIntegrationDispatch(\n'''
idx = s.index(marker)
helper = r'''export async function markIntegrationDispatchStarted(
  github: FugueGitHub,
  snapshot: EvaluationSnapshot,
  requestId: string,
  startedAt = new Date().toISOString(),
): Promise<IntegrationRecord> {
  const current = await getCurrentIntegrationRecord(github, snapshot.identity);
  if (!current || current.request.request_id !== requestId || current.terminal || !current.dispatch) {
    throw new Error(`Integration request ${requestId} is not an active authorized dispatch.`);
  }
  if (current.dispatch_started_at) return current;
  return publishIntegrationRecord(github, {
    ...current,
    dispatch_started_at: startedAt,
    created_at: startedAt,
  });
}

async function recoverDispatchedIntegrationRun(
  github: FugueGitHub,
  record: IntegrationRecord,
): Promise<IntegrationRunBinding | undefined> {
  if (record.run || !record.dispatch) return record.run ?? undefined;
  const anchorBody = await getFugueAuthorityVariable(github, record.dispatch.anchor_name);
  if (!anchorBody) return undefined;
  const anchor = await verifyIntegrationDispatchAnchor(github, record, anchorBody);
  if (!anchor) throw new Error(`Protected Integration request anchor ${record.dispatch.anchor_name} is invalid.`);
  const token = integrationDispatchRunToken(record.request.request_id, anchor.dispatch_secret);
  const expectedTitle = integrationRunTitleWithToken(record.request, token);
  const minimumCreated = Math.max(Date.parse(record.request.created_at), Date.parse(record.dispatch_started_at ?? record.dispatch.authorized_at));
  if (!Number.isFinite(minimumCreated)) throw new Error("Integration dispatch recovery has invalid causal time.");
  const { owner, repo } = github.repository;
  let earliest: WorkflowRunRecord | undefined;
  for (let page = 1; ; page += 1) {
    const response = await github.octokit.rest.actions.listWorkflowRuns({
      owner, repo, workflow_id: "fugue-integration.yml", event: "workflow_dispatch", per_page: 100, page,
    });
    const runs = (response.data.workflow_runs ?? []) as unknown as WorkflowRunRecord[];
    for (const run of runs) {
      const created = Date.parse(run.created_at ?? "");
      if (!isTrustedProtocolWorkflowRun(run) || run.event !== "workflow_dispatch" ||
          run.head_sha !== record.identity.baseSha || run.display_title !== expectedTitle ||
          !Number.isFinite(created) || created < minimumCreated) continue;
      const currentCreated = earliest ? Date.parse(earliest.created_at ?? "") : Number.POSITIVE_INFINITY;
      if (!earliest || created < currentCreated || (created === currentCreated && run.id < earliest.id)) earliest = run;
    }
    if (runs.length < 100) break;
  }
  if (!earliest) return undefined;
  const attempt = await getIntegrationWorkflowRunForBinding(github, record.request, {
    id: earliest.id, attempt: 1, created_at: earliest.created_at ?? record.request.created_at, html_url: earliest.html_url,
  });
  if (!attempt || attempt.id !== earliest.id) return undefined;
  return { id: attempt.id, attempt: 1, created_at: attempt.createdAt, html_url: attempt.htmlUrl };
}

'''
s = s[:idx] + helper + s[idx:]

# Recover returned-but-unbound run before abort classification.
s = once(s,
'''  if (current) {
    const evidence = current.run ? undefined : await getIntegrationRunStartEvidence(github, current);
    if (evidence && !current.run) {
      current = await publishIntegrationRecord(github, {
        ...current,
        run: integrationRunBindingFromEvidence(github, evidence),
        created_at: new Date(now).toISOString(),
      });
    }
    if (current.run) {''',
'''  if (current) {
    const evidence = current.run ? undefined : await getIntegrationRunStartEvidence(github, current);
    if (evidence && !current.run) {
      current = await publishIntegrationRecord(github, {
        ...current,
        run: integrationRunBindingFromEvidence(github, evidence),
        created_at: new Date(now).toISOString(),
      });
    }
    if (!current.run) {
      const recoveredRun = await recoverDispatchedIntegrationRun(github, current);
      if (recoveredRun) {
        current = await publishIntegrationRecord(github, {
          ...current,
          run: recoveredRun,
          created_at: new Date(now).toISOString(),
        });
      }
    }
    if (current.run) {''', 'recover lost dispatch bind')

# Fail closed once durable dispatch transition was crossed; only pre-transition no-run can abort/retry.
s = once(s,
'''    } else if (!evidence) {
      const created = Date.parse(current.request.created_at);
      if (!Number.isFinite(created) || now - created < INTEGRATION_REQUEST_RECOVERY_GRACE_MS) {
        return { request: current.request, dispatch: false };
      }
      await publishIntegrationRecord(github, {
        ...current,
        terminal: {
          state: "aborted",
          detail: "Authorized Integration dispatch never crossed its protected run-start boundary; transport may recover with a fresh request.",
          created_at: new Date(now).toISOString(),
        },
        created_at: new Date(now).toISOString(),
      });
      predecessorRequestId = current.request.request_id;
      current = undefined;
    }''',
'''    } else if (!evidence) {
      const created = Date.parse(current.dispatch_started_at ?? current.request.created_at);
      if (!Number.isFinite(created) || now - created < INTEGRATION_REQUEST_RECOVERY_GRACE_MS) {
        return { request: current.request, dispatch: false };
      }
      if (current.dispatch_started_at) {
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
      }
      await publishIntegrationRecord(github, {
        ...current,
        terminal: {
          state: "aborted",
          detail: "Authorized Integration dispatch never crossed its protected dispatch-creation boundary; transport may recover with a fresh request.",
          created_at: new Date(now).toISOString(),
        },
        created_at: new Date(now).toISOString(),
      });
      predecessorRequestId = current.request.request_id;
      current = undefined;
    }''', 'dispatch-start failure boundary')

# New title format remains accepted for a durable exact run binding.
s = once(s,
'''  return isTrustedProtocolWorkflowRun(run) &&
    run.event === "workflow_dispatch" &&
    run.head_sha === request.identity.baseSha &&
    run.display_title === integrationRunTitle(request.request_id, request.identity.prNumber) &&
    Number.isFinite(runCreated) && runCreated >= requestCreated;''',
'''  const baseTitle = integrationRunTitle(request.request_id, request.identity.prNumber);
  const titleMatches = run.display_title === baseTitle ||
    new RegExp(`^${baseTitle.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")} [0-9a-f]{24}$`).test(run.display_title);
  return isTrustedProtocolWorkflowRun(run) &&
    run.event === "workflow_dispatch" &&
    run.head_sha === request.identity.baseSha && titleMatches &&
    Number.isFinite(runCreated) && runCreated >= requestCreated;''', 'bound tokenized run title')

# Seal an unbound completed run from the secret-correlated immutable workflow_run event.
old = '''  const match = event.displayTitle.match(/^Fugue Integration PR #(\\d+) (int-[0-9a-f]{16}-[0-9a-f]{16})$/);
  if (!match?.[1] || !match[2]) return false;'''
new = '''  const match = event.displayTitle.match(/^Fugue Integration PR #(\\d+) (int-[0-9a-f]{16}-[0-9a-f]{16})(?: ([0-9a-f]{24}))?$/);
  if (!match?.[1] || !match[2]) return false;'''
s = once(s, old, new, 'workflow event title regex')
old = '''  const evidence = record.run ? undefined : await getIntegrationRunStartEvidence(github, record);
  const binding = record.run ?? (evidence ? integrationRunBindingFromEvidence(github, evidence) : undefined);
  if (!binding || binding.id !== event.runId) return false;
  const createdAt = new Date().toISOString();'''
new = '''  const evidence = record.run ? undefined : await getIntegrationRunStartEvidence(github, record);
  let binding = record.run ?? (evidence ? integrationRunBindingFromEvidence(github, evidence) : undefined);
  if (!binding && match[3] && record.dispatch) {
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
  }
  if (!binding || binding.id !== event.runId) return false;
  const createdAt = new Date().toISOString();'''
s = once(s, old, new, 'seal unbound dispatch event')
p.write_text(s)

# ---------- reconcile.ts: durable dispatch-start before API + secret run token ----------
p = root / 'src/core/reconcile.ts'; s = p.read_text()
s = once(s,
'import { bindDispatchedIntegrationRun, ensureIntegrationDispatch, reclaimOrphanIntegrationAuthorityVariables, sealIntegrationWorkflowRunEvent } from "./integration-status.js";',
'import { bindDispatchedIntegrationRun, ensureIntegrationDispatch, integrationDispatchRunToken, markIntegrationDispatchStarted, reclaimOrphanIntegrationAuthorityVariables, sealIntegrationWorkflowRunEvent } from "./integration-status.js";',
'integration status imports')
s = once(s,
'''  if (!next.dispatch || !next.request || !next.dispatchSecret || !next.authorityAnchor) return;
  const dispatched = await github.octokit.request("POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches", {''',
'''  if (!next.dispatch || !next.request || !next.dispatchSecret || !next.authorityAnchor) return;
  const dispatchStartedAt = new Date().toISOString();
  await markIntegrationDispatchStarted(github, snapshot, next.request.request_id, dispatchStartedAt);
  const runToken = integrationDispatchRunToken(next.request.request_id, next.dispatchSecret);
  const dispatched = await github.octokit.request("POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches", {''', 'dispatch start before api')
s = once(s,
'''    inputs: { pr: prNumber, request_id: next.request.request_id, dispatch_secret: next.dispatchSecret, authority_anchor: next.authorityAnchor },''',
'''    inputs: {
      pr: prNumber, request_id: next.request.request_id, dispatch_secret: next.dispatchSecret,
      authority_anchor: next.authorityAnchor, run_token: runToken,
    },''', 'dispatch token input')
p.write_text(s)

# ---------- workflow: tokenized immutable run identity, checked against protected secret ----------
p = root / '.github/workflows/fugue-integration.yml'; s = p.read_text()
s = once(s,
'run-name: "Fugue Integration PR #${{ inputs.pr }} ${{ inputs.request_id }}"',
'run-name: "Fugue Integration PR #${{ inputs.pr }} ${{ inputs.request_id }} ${{ inputs.run_token }}"', 'workflow run name')
s = once(s,
'''      authority_anchor:
        description: Exact immutable Fugue Authority request anchor
        required: true
        type: string''',
'''      authority_anchor:
        description: Exact immutable Fugue Authority request anchor
        required: true
        type: string
      run_token:
        description: Secret-derived one-run correlation token
        required: true
        type: string''', 'workflow run token input')
s = once(s,
"          import { createHash } from 'node:crypto';",
"          import { createHash, createHmac } from 'node:crypto';", 'workflow hmac import')
s = once(s,
'''          const anchorName = String(inputs.authority_anchor ?? '');
          const runId = Number(process.env.GITHUB_RUN_ID);''',
'''          const anchorName = String(inputs.authority_anchor ?? '');
          const runToken = String(inputs.run_token ?? '');
          const runId = Number(process.env.GITHUB_RUN_ID);''', 'workflow run token read')
s = once(s,
'''              !/^[0-9a-f]{64}$/i.test(secret) || !/^FUGUE_INT_A_\\d{10}_[0-9A-F]{16}$/.test(anchorName) ||
              !Number.isInteger(runId) || runId <= 0 || runAttempt !== 1 || !/^[0-9a-f]{40}$/i.test(baseSha)) {''',
'''              !/^[0-9a-f]{64}$/i.test(secret) || !/^FUGUE_INT_A_\\d{10}_[0-9A-F]{16}$/.test(anchorName) ||
              !/^[0-9a-f]{24}$/.test(runToken) || !Number.isInteger(runId) || runId <= 0 || runAttempt !== 1 ||
              !/^[0-9a-f]{40}$/i.test(baseSha)) {''', 'workflow token validation shape')
s = once(s,
'''          const digest = createHash('sha256').update(secret, 'utf8').digest('hex');
          const requestToken = createHash('sha256').update(requestId, 'utf8').digest('hex').slice(0, 16).toUpperCase();''',
'''          const digest = createHash('sha256').update(secret, 'utf8').digest('hex');
          const expectedRunToken = createHmac('sha256', Buffer.from(secret, 'hex'))
            .update(`fugue-integration-run\\0${requestId}`, 'utf8').digest('hex').slice(0, 24);
          if (runToken !== expectedRunToken) throw new Error('Protected Integration run token does not match its one-use dispatch capability.');
          const requestToken = createHash('sha256').update(requestId, 'utf8').digest('hex').slice(0, 16).toUpperCase();''', 'workflow token secret binding')
p.write_text(s)

# ---------- submissions.ts: one durable Human acknowledgement resolver ----------
p = root / 'src/core/submissions.ts'; s = p.read_text()
s = once(s,
'''  serializeAttestation,
  type QaRole,''',
'''  serializeAttestation,
  type HumanControlPlaneAttestation,
  type QaRole,''', 'human attestation type import')
old = '''export async function hasCurrentHumanAcknowledgement(
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
}'''
new = '''export async function currentHumanAcknowledgement(
  github: FugueGitHub,
  snapshot: EvaluationSnapshot,
): Promise<HumanControlPlaneAttestation | undefined> {
  const durable = await recoverHumanAcknowledgementAuthority(github, snapshot);
  if (durable) return durable;

  const { owner, repo } = github.repository;
  const comments = await github.octokit.paginate(github.octokit.rest.issues.listComments, {
    owner, repo, issue_number: snapshot.pr.number, per_page: 100,
  });
  for (const comment of comments) {
    if (!(await isTrustedProtocolComment(github, comment))) continue;
    try {
      const value = parseAttestation(comment.body ?? "");
      if (value?.kind !== "human_control_plane" || !sameEvaluationIdentity(value.identity, snapshot.identity)) continue;
      await publishHumanAcknowledgementAuthority(github, snapshot, value);
      return value;
    } catch {
      // Historical malformed evidence is not current acknowledgement.
    }
  }
  return undefined;
}

export async function hasCurrentHumanAcknowledgement(
  github: FugueGitHub,
  snapshot: EvaluationSnapshot,
): Promise<boolean> {
  return Boolean(await currentHumanAcknowledgement(github, snapshot));
}'''
s = once(s, old, new, 'durable human resolver')
p.write_text(s)

# ---------- integration.ts: actual prerequisite consumes durable authority ----------
p = root / 'src/core/integration.ts'; s = p.read_text()
s = s.replace('  parseAttestation,\n', '')
s = once(s,
'import { createProtocolComment, escapeProtocolMarkers, isTrustedProtocolComment } from "./provenance.js";',
'import { createProtocolComment, escapeProtocolMarkers } from "./provenance.js";', 'integration provenance imports')
s = once(s,
'import { currentQaAttestations } from "./reviews.js";',
'import { currentQaAttestations } from "./reviews.js";\nimport { currentHumanAcknowledgement } from "./submissions.js";', 'integration durable human import')
s = once(s,
'''  let humanAcknowledgement: HumanControlPlaneAttestation | null = null;
  if (snapshot.qa.controlPlaneChanged) {
    humanAcknowledgement = await findCurrentHumanAcknowledgement(github, snapshot);
    if (!humanAcknowledgement) {
      throw new IntegrationGateFailure(
        "control-plane",
        "Control-plane changes require a current head-bound Human acknowledgement.",
      );
    }
  }

  return { qa, codeAttestation, humanAcknowledgement };''',
'''  const humanAcknowledgement = await verifyHumanControlPlanePrerequisite(github, snapshot);
  return { qa, codeAttestation, humanAcknowledgement };''', 'integration prerequisite call')
start = s.index('async function findCurrentHumanAcknowledgement(')
end = s.index('\nfunction truncate(', start)
replacement = '''export async function verifyHumanControlPlanePrerequisite(
  github: FugueGitHub,
  snapshot: EvaluationSnapshot,
): Promise<HumanControlPlaneAttestation | null> {
  if (!snapshot.qa.controlPlaneChanged) return null;
  const acknowledgement = await currentHumanAcknowledgement(github, snapshot);
  if (!acknowledgement) {
    throw new IntegrationGateFailure(
      "control-plane",
      "Control-plane changes require a current head-bound Human acknowledgement.",
    );
  }
  return acknowledgement;
}
'''
s = s[:start] + replacement + s[end:]
p.write_text(s)

# ---------- workflow.ts: final merge readiness consumes same durable authority ----------
p = root / 'src/core/workflow.ts'; s = p.read_text()
s = once(s, 'import { parseAttestation, type QaRole } from "./attestations.js";', 'import { type QaRole } from "./attestations.js";', 'workflow attestation import')
s = once(s, 'import { captureEvaluation, sameEvaluationIdentity, type EvaluationSnapshot } from "./evaluation.js";', 'import { captureEvaluation } from "./evaluation.js";', 'workflow evaluation import')
s = s.replace('import { isTrustedProtocolComment } from "./provenance.js";\n', '')
s = once(s, 'import { currentReviewActivities } from "./reviews.js";', 'import { currentReviewActivities } from "./reviews.js";\nimport { hasCurrentHumanAcknowledgement } from "./submissions.js";', 'workflow durable human import')
s = once(s,
'''    humanControlPlaneAcknowledged: snapshot.qa.controlPlaneChanged
      ? await hasCurrentHumanControlPlaneAcknowledgement(github, snapshot)
      : false,''',
'''    humanControlPlaneAcknowledged: snapshot.qa.controlPlaneChanged
      ? await hasCurrentHumanAcknowledgement(github, snapshot)
      : false,''', 'workflow durable human call')
start = s.index('\nasync function hasCurrentHumanControlPlaneAcknowledgement(')
s = s[:start].rstrip() + '\n'
p.write_text(s)

# ---------- focused adversarial regressions ----------
p = root / 'tests/state-authority-blockers.test.ts'; s = p.read_text()
s = once(s,
'import { hasCurrentHumanAcknowledgement } from "../src/core/submissions.js";',
'import { hasCurrentHumanAcknowledgement } from "../src/core/submissions.js";\nimport { verifyHumanControlPlanePrerequisite } from "../src/core/integration.js";', 'test integration human import')
s = once(s,
'import { authorizeIntegrationDispatch, bindDispatchedIntegrationRun, getCurrentIntegrationRecord, getIntegrationRunStartEvidence, publishIntegrationRecord, sealIntegrationWorkflowRunEvent } from "../src/core/integration-status.js";',
'import { authorizeIntegrationDispatch, getCurrentIntegrationRecord, getIntegrationRunStartEvidence, integrationDispatchRunToken, markIntegrationDispatchStarted, publishIntegrationRecord, sealIntegrationWorkflowRunEvent } from "../src/core/integration-status.js";', 'test integration status imports')
s = once(s,
'''  compactFugueRecoveryAuthorityVariables,
  createCanonicalWorkState,''',
'''  compactFugueRecoveryAuthorityVariables,
  createCanonicalWorkState,
  DurableProtocolRecoveryPendingError,''', 'test pending error import')

# Idle value is now epoch-rotating.
s = s.replace('expect(github.__authorityVariables.get("FUGUE_D3GI_00")).toBe("reserved-for-fugue-recovery-mutation-guard");',
'''expect(github.__authorityVariables.get("FUGUE_D3GI_00")).toMatch(
      /^reserved-for-fugue-recovery-mutation-guard(?::[0-9a-f]{32})?$/,
    );''')

# Insert exact reader-idle -> writer-guard -> reader-resume TOCTOU regression before evidence durability test.
marker = '  it("recovers accepted QA and Human evidence from d3 after every presentation comment is deleted", async () => {'
idx = s.index(marker)
newtest = r'''  it("invalidates a reader that passed idle immediately before a provisional writer acquires the guard", async () => {
    const github = makeGithub();
    const firstOrder = "2026-08-17T08:15:00.000Z";
    await publishDurableProtocolRecord(github, {
      storageSha: BASE, publisherSha: BASE, scope: "guard-precheck-reader",
      unsignedBody: "committed-before-race", publicationTimestamp: Date.parse(firstOrder), authorityOrder: firstOrder,
    });

    let releaseReader!: () => void;
    let readerReached!: () => void;
    const readerGate = new Promise<void>((resolve) => { releaseReader = resolve; });
    const readerPaused = new Promise<void>((resolve) => { readerReached = resolve; });
    let pausedOnce = false;
    vi.mocked(verifyProtocolPublicationBodyAtRevision).mockImplementation(async (candidateGithub, body, expected) => {
      const cursor = recoveryCursorBody(body);
      if (!pausedOnce && cursor?.scope === "guard-precheck-reader" && cursor.commit_witness === true) {
        pausedOnce = true;
        readerReached();
        await readerGate;
      }
      return defaultPublicationVerifier(candidateGithub, body, expected);
    });

    const reader = recoverDurableProtocolRecord(github, {
      storageSha: BASE, publisherSha: BASE, scope: "guard-precheck-reader", issueNumber: 18,
      parse: (body) => body, timestamp: () => Date.parse(firstOrder), order: () => firstOrder,
    });
    await readerPaused;

    let releaseWriter!: () => void;
    let writerReached!: () => void;
    const writerGate = new Promise<void>((resolve) => { releaseWriter = resolve; });
    const writerPaused = new Promise<void>((resolve) => { writerReached = resolve; });
    let writerHeld = false;
    github.__beforeRevisionCheck = async () => {
      if (writerHeld || ![...github.__authorityVariables.keys()].some((name) => name.startsWith("FUGUE_D3GT_"))) return;
      const provisional = [...github.__authorityVariables.keys()].some((name) =>
        /^FUGUE_D3_[0-9A-F]{16}_[0-9A-F]{16}$/i.test(name) &&
        recoveryCursorBody(github.__authorityVariables.get(name) ?? "")?.scope === "guard-precheck-reader");
      if (!provisional) return;
      writerHeld = true;
      writerReached();
      await writerGate;
    };
    const secondOrder = "2026-08-17T08:16:00.000Z";
    const writer = publishDurableProtocolRecord(github, {
      storageSha: BASE, publisherSha: BASE, scope: "guard-precheck-reader",
      unsignedBody: "provisional-must-never-be-observed", publicationTimestamp: Date.parse(secondOrder), authorityOrder: secondOrder,
    });
    await writerPaused;
    github.__baseSha = NEXT_BASE;
    releaseReader();
    await expect(reader).rejects.toBeInstanceOf(DurableProtocolRecoveryPendingError);
    releaseWriter();
    await expect(writer).rejects.toThrow(/stale protected revision/);
    github.__beforeRevisionCheck = undefined;
    vi.mocked(verifyProtocolPublicationBodyAtRevision).mockImplementation(defaultPublicationVerifier);
    expect(recoveryCheckpointBodies(github).some((body) => body.includes("provisional-must-never-be-observed"))).toBe(false);
  });

'''
s = s[:idx] + newtest + s[idx:]

# Durable Human evidence test now executes the actual Integration control-plane prerequisite after presentation deletion.
s = once(s,
'''    await expect(hasCurrentHumanAcknowledgement(github, snapshot)).resolves.toBe(true);
    github.__comments.splice(0);
    const after = await currentReviewActivities(github, snapshot);
    expect(after.get("code")?.completed?.attestation_id).toBe(qa.attestation_id);
    await expect(hasCurrentHumanAcknowledgement(github, snapshot)).resolves.toBe(true);''',
'''    await expect(hasCurrentHumanAcknowledgement(github, snapshot)).resolves.toBe(true);
    github.__comments.splice(0);
    const after = await currentReviewActivities(github, snapshot);
    expect(after.get("code")?.completed?.attestation_id).toBe(qa.attestation_id);
    await expect(hasCurrentHumanAcknowledgement(github, snapshot)).resolves.toBe(true);
    await expect(verifyHumanControlPlanePrerequisite(github, snapshot)).resolves.toMatchObject({
      attestation_id: human.attestation_id, verdict: "acknowledged",
    });''', 'human integration gate regression')

# Replace prior manually-bound pre-run-start test with the exact dispatch-created/d3-bind-lost sequence.
old_start = s.index('  it("seals a genuine protected attempt-1 failure even when it completes before custom run-start evidence", async () => {')
old_end = s.index('\n  });\n\n});', old_start) + len('\n  });')
newtest = r'''  it("recovers dispatch-created attempt 1 after d3 bind loss and seals pre-run-start failure", async () => {
    const github = makeGithub();
    const identity = {
      prNumber: 19, headSha: "a".repeat(40), baseBranch: "main", baseSha: BASE,
      policyDigest: "sha256:policy", protocolVersion: 1 as const, issueNumber: 18, workId: "work-18",
      workSpecDigest: "sha256:spec",
    };
    const snapshot = { identity, pr: { number: 19 } } as unknown as EvaluationSnapshot;
    const request = createIntegrationRequest(identity, "2026-08-17T08:30:00.000Z", "1".repeat(16));
    const secret = "2".repeat(64);
    const authorized = await authorizeIntegrationDispatch(github, request, "2026-08-17T08:30:00.000Z", secret);
    await publishIntegrationRecord(github, createIntegrationRecord(authorized.request, {
      dispatch: authorized.authorization, createdAt: "2026-08-17T08:30:00.000Z",
    }));
    await markIntegrationDispatchStarted(github, snapshot, authorized.request.request_id, "2026-08-17T08:30:10.000Z");
    const beforeFailure = (await getCurrentIntegrationRecord(github, identity))!;
    expect(beforeFailure.run).toBeNull();
    expect(await getIntegrationRunStartEvidence(github, beforeFailure)).toBeUndefined();

    const runToken = integrationDispatchRunToken(authorized.request.request_id, secret);
    const displayTitle = `Fugue Integration PR #19 ${authorized.request.request_id} ${runToken}`;
    await expect(sealIntegrationWorkflowRunEvent(github, {
      eventName: "workflow_run", workflowName: "Fugue Integration", runId: 4242, runAttempt: 1,
      conclusion: "failure", status: "completed", headSha: BASE, displayTitle,
      createdAt: "2026-08-17T08:31:00.000Z", htmlUrl: "https://github.com/JohnnyZLi/Fugue/actions/runs/4242",
      actor: "github-actions[bot]",
    })).resolves.toBe(true);
    const terminal = await getCurrentIntegrationRecord(github, identity);
    expect(terminal?.run?.id).toBe(4242);
    expect(terminal?.terminal?.state).toBe("failure");

    // Once the original exact run is terminal, a later same-token run can never replace it.
    await expect(sealIntegrationWorkflowRunEvent(github, {
      eventName: "workflow_run", workflowName: "Fugue Integration", runId: 4243, runAttempt: 1,
      conclusion: "success", status: "completed", headSha: BASE, displayTitle,
      createdAt: "2026-08-17T08:32:00.000Z", htmlUrl: "https://github.com/JohnnyZLi/Fugue/actions/runs/4243",
      actor: "github-actions[bot]",
    })).resolves.toBe(false);
    expect((await getCurrentIntegrationRecord(github, identity))?.run?.id).toBe(4242);
  });'''
s = s[:old_start] + newtest + s[old_end:]
p.write_text(s)

# ---------- docs / invariants ----------
p = root / 'AGENTS.md'; s = p.read_text()
s = once(s,
'''29. Revision-bound recovery-witness mutation is fenced by a dedicated protected Authority-plane transaction-guard slot that is protocol overhead, not an optional compaction reserve. While a final create/rename is provisional, readers fail closed and compactors/reserve maintenance defer; stale/crashed transactions restore their exact source/target before the guard is released.
30. A completed protected Integration attempt-1 event can durably seal its exact request/run as terminal before custom run-start publication when failure occurs during environment/App-token setup; absence of `FUGUE_INT_S_*` cannot by itself convert observed attempt-1 failure into retry.''',
'''29. Revision-bound recovery-witness mutation is fenced by a dedicated protected Authority-plane transaction-guard slot that is protocol overhead, not an optional compaction reserve. Guard release rotates an idle epoch; every d3 reader pins and revalidates that epoch before returning, while destructive compaction/reserve maintenance holds the same slot exclusively. Thus a reader/compactor that began immediately before a writer acquires the guard cannot accept, rename, pack, or delete provisional authority; stale/crashed transactions restore their exact source/target before a new epoch is exposed.
30. Protected Integration durably records crossing the dispatch-creation transition before calling workflow dispatch and correlates the created attempt-1 run with a token derived from the one-use Authority-anchor secret. The exact earliest matching run can be rebound after a control-plane crash, and its immutable completion event can seal the exact request/run before custom run-start publication when failure occurs during environment/App-token setup; ambiguity after the durable dispatch boundary fails terminal rather than becoming retry.
31. Every Human control-plane acknowledgement consumer—including hosted Integration prepare/finalize and final merge-readiness planning—resolves the exact current acknowledgement from protected d3 authority. A PR comment is only a repairable mirror and deleting it cannot change a gate result.''', 'AGENTS trust invariants')
p.write_text(s)

for rel in ['README.md', 'docs/leader-chat.md']:
    p = root / rel; s = p.read_text().rstrip()
    s += '''\n\n### Final transaction and Integration recovery\n\nD3 readers pin the dedicated recovery-guard idle epoch and revalidate it before accepting authority; compaction and reserve maintenance hold the same guard slot while mutating, so a writer that starts after an idle observation invalidates the in-flight read instead of exposing provisional authority. Integration records the dispatch-creation transition before the workflow API call and uses a secret-derived run token to recover or seal the exact attempt-1 run after a control-plane crash, including failures before custom run-start evidence. Human control-plane acknowledgement is consumed from deletion-resistant d3 authority by Integration and final merge-readiness; acknowledgement comments are presentation only.\n'''
    p.write_text(s)

print('applied current Code/Security QA blocker repairs')
