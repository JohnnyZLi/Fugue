from __future__ import annotations
import pathlib, sys

root = pathlib.Path(sys.argv[1])

def once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 match, found {count}")
    return text.replace(old, new, 1)

p = root / "src/core/state.ts"
s = p.read_text()
s = once(s,
'''const RECOVERY_RESERVE_PREFIX = "FUGUE_D3R_";
const RECOVERY_MUTATION_GUARD_PREFIX = "FUGUE_D3G_";
const RECOVERY_MUTATION_GUARD_RESERVE = "FUGUE_D3R_00";
const RECOVERY_MUTATION_GUARD_GRACE_MS = 10 * 60 * 1000;
const RECOVERY_RESERVE_COUNT = 8;
const RECOVERY_RESERVE_VALUE = "reserved-for-fugue-recovery-compaction";
const RECOVERY_COMPACTION_RETRY_LIMIT = 16;
const RECOVERY_PACK_MAX_ENTRIES = 16;''',
'''const RECOVERY_RESERVE_PREFIX = "FUGUE_D3R_";
const RECOVERY_MUTATION_GUARD_PREFIX = "FUGUE_D3GT_";
const RECOVERY_MUTATION_GUARD_IDLE = "FUGUE_D3GI_00";
const RECOVERY_MUTATION_GUARD_IDLE_VALUE = "reserved-for-fugue-recovery-mutation-guard";
const RECOVERY_MUTATION_GUARD_GRACE_MS = 10 * 60 * 1000;
const RECOVERY_RESERVE_COUNT = 8;
const RECOVERY_RESERVE_VALUE = "reserved-for-fugue-recovery-compaction";
const RECOVERY_COMPACTION_RETRY_LIMIT = 16;
const RECOVERY_PACK_MAX_ENTRIES = 17;''', "guard constants")

start = s.index('async function restoreRecoveryMutationGuardReserve(')
end = s.index('\nasync function rollbackGuardedRecoveryMutation(', start)
replacement = '''async function ensureRecoveryMutationGuardIdle(github: FugueGitHub): Promise<boolean> {
  if ((await activeRecoveryMutationGuards(github)).length) return false;
  const current = await getFugueAuthorityVariable(github, RECOVERY_MUTATION_GUARD_IDLE);
  if (current === RECOVERY_MUTATION_GUARD_IDLE_VALUE) return true;
  if (current !== undefined) {
    throw new CanonicalWorkStateIntegrityError("Protected recovery mutation guard idle slot has conflicting state.");
  }
  return createFugueAuthorityVariable(github, RECOVERY_MUTATION_GUARD_IDLE, RECOVERY_MUTATION_GUARD_IDLE_VALUE);
}

async function restoreRecoveryMutationGuardIdle(github: FugueGitHub, guardName: string, guardValue: string): Promise<void> {
  if (await getFugueAuthorityVariable(github, guardName) !== guardValue) return;
  const idle = await getFugueAuthorityVariable(github, RECOVERY_MUTATION_GUARD_IDLE);
  if (idle === RECOVERY_MUTATION_GUARD_IDLE_VALUE) {
    await deleteFugueAuthorityVariable(github, guardName);
    return;
  }
  if (idle !== undefined) {
    throw new CanonicalWorkStateIntegrityError("Protected recovery mutation guard idle slot has conflicting state.");
  }
  if (await replaceFugueAuthorityVariable(
    github, guardName, guardValue, RECOVERY_MUTATION_GUARD_IDLE, RECOVERY_MUTATION_GUARD_IDLE_VALUE,
  )) return;
  throw new CanonicalWorkStateIntegrityError("Unable to restore the protected recovery mutation guard idle slot.");
}
'''
s = s[:start] + replacement + s[end:]
s = s.replace('await restoreRecoveryMutationGuardReserve(github, guardName, guardValue);',
              'await restoreRecoveryMutationGuardIdle(github, guardName, guardValue);')

old_acquire = '''  const value = JSON.stringify(guard);
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
}'''
new_acquire = '''  const value = JSON.stringify(guard);
  const name = recoveryMutationGuardName(guard);
  if (!(await ensureRecoveryMutationGuardIdle(github))) return undefined;
  if (await replaceFugueAuthorityVariable(
    github, RECOVERY_MUTATION_GUARD_IDLE, RECOVERY_MUTATION_GUARD_IDLE_VALUE, name, value,
  )) return { name, value };
  return undefined;
}

async function releaseRecoveryMutationGuard(github: FugueGitHub, token: { name: string; value: string }): Promise<void> {
  await restoreRecoveryMutationGuardIdle(github, token.name, token.value);
}'''
s = once(s, old_acquire, new_acquire, "guard acquisition")

s = once(s,
'''  const guard = await acquireRecoveryMutationGuard(github, expectedPublisherSha, name, value);
  try {''',
'''  const guard = await acquireRecoveryMutationGuard(github, expectedPublisherSha, name, value);
  if (!guard) return false;
  try {''', "guard required create")
s = once(s,
'''  const guard = expectedPublisherSha
    ? await acquireRecoveryMutationGuard(github, expectedPublisherSha, targetName, targetValue, sourceName, expectedSourceValue)
    : undefined;
  if (expectedPublisherSha) await assertRepositoryDefaultBranchRevision(github, expectedPublisherSha);''',
'''  const guard = expectedPublisherSha
    ? await acquireRecoveryMutationGuard(github, expectedPublisherSha, targetName, targetValue, sourceName, expectedSourceValue)
    : undefined;
  if (expectedPublisherSha && !guard) return false;
  if (expectedPublisherSha) await assertRepositoryDefaultBranchRevision(github, expectedPublisherSha);''', "guard required replace")

s = s.replace('    .filter((reserve) => reserve.value === RECOVERY_RESERVE_VALUE && reserve.name !== RECOVERY_MUTATION_GUARD_RESERVE)',
              '    .filter((reserve) => reserve.value === RECOVERY_RESERVE_VALUE)')

# Dense small packs leave the dedicated guard slot available at the hard cap. Sort full units first
# so a partial unit is paired with any compatible full unit regardless of content-addressed name.
old_units = '''    units.push({ sourceName, expectedValue, entries: sourceEntries });
  }

  const sourceGroups: SourceUnit[][] = [];'''
new_units = '''    units.push({ sourceName, expectedValue, entries: sourceEntries });
  }
  units.sort((left, right) => right.entries.length - left.entries.length || left.sourceName.localeCompare(right.sourceName));

  const sourceGroups: SourceUnit[][] = [];'''
s = once(s, old_units, new_units, "pack unit order")

old_compact = '''export async function compactFugueRecoveryAuthorityVariables(
  github: FugueGitHub,
  preserveIdentity?: string,
  _reserveSlots = 0,
): Promise<void> {
  if (await recoverInterruptedRecoveryMutation(github)) return;
  await ensureRecoveryReserveVariables(github);'''
new_compact = '''export async function compactFugueRecoveryAuthorityVariables(
  github: FugueGitHub,
  preserveIdentity?: string,
  _reserveSlots = 0,
): Promise<void> {
  if (await recoverInterruptedRecoveryMutation(github)) return;
  // The mutation guard is protocol overhead, not an optional compaction reserve. Create it before
  // optional reserves whenever capacity exists; a legacy full namespace is compacted below and
  // gets the guard before any reserve recreation consumes newly freed headroom.
  await ensureRecoveryMutationGuardIdle(github);
  await ensureRecoveryReserveVariables(github);'''
s = once(s, old_compact, new_compact, "compaction guard start")
s = once(s,
'''  await ensureRecoveryReserveVariables(github);
}

async function writeRecoveryCursor(''',
'''  await ensureRecoveryMutationGuardIdle(github);
  await ensureRecoveryReserveVariables(github);
}

async function writeRecoveryCursor(''', "compaction guard end")

p.write_text(s)

p = root / "tests/reconcile.test.ts"
s = p.read_text()
s = once(s, 'expect(packedBefore).toHaveLength(10);', 'expect(packedBefore).toHaveLength(9);', 'hardcap pack count')
s = once(s, 'entries.length < 16', 'entries.length < 17', 'hardcap partial threshold')
p.write_text(s)

for path in ["AGENTS.md", "README.md", "docs/leader-chat.md"]:
    p = root / path
    s = p.read_text()
    s = s.replace(
      'Revision-bound recovery-witness mutation is fenced by a protected Authority-plane transaction guard.',
      'Revision-bound recovery-witness mutation is fenced by a dedicated protected Authority-plane transaction-guard slot that is protocol overhead, not an optional compaction reserve.')
    s = s.replace(
      'Final Authority-variable recovery writes are fenced while provisional so concurrent compaction/reserve maintenance cannot preserve a stale-base witness during rollback or crash recovery.',
      'Final Authority-variable recovery writes are fenced through a dedicated protocol guard slot while provisional so concurrent compaction/reserve maintenance cannot preserve a stale-base witness during rollback or crash recovery; optional reserve depletion cannot disable that fence.')
    p.write_text(s)

print('made recovery mutation guard mandatory at full-cap steady state')
