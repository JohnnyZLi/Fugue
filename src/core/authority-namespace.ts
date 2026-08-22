import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import type { FugueGitHub } from "./github.js";
import {
  CanonicalWorkStateIntegrityError,
  createFugueAuthorityVariable as createAuthorityVariableUnchecked,
  deleteFugueAuthorityVariable as deleteAuthorityVariableUnchecked,
  DurableProtocolRecoveryPendingError,
  getFugueAuthorityVariable,
  listFugueAuthorityVariables,
} from "./state-raw.js";

const NAMESPACE_GUARD_PREFIX = "FUGUE_D3GT_";
const NAMESPACE_GUARD_IDLE = "FUGUE_D3GI_00";
const NAMESPACE_GUARD_IDLE_PREFIX = "reserved-for-fugue-recovery-mutation-guard";
const NAMESPACE_MAINTENANCE_TARGET = "__fugue_authority_namespace_maintenance__";

interface NamespaceMutationGuard {
  version: 1;
  publisher_sha: string;
  target_name: string;
  target_value: string;
  created_at: string;
  maintenance: true;
}

const namespaceMutationContext = new AsyncLocalStorage<ReadonlySet<FugueGitHub>>();

function injectedAuthorityVariables(github: FugueGitHub): Map<string, string> | undefined {
  return (github as FugueGitHub & { __authorityVariables?: Map<string, string> }).__authorityVariables;
}

function authorityToken(): string {
  const token = process.env.FUGUE_AUTHORITY_TOKEN?.trim();
  if (!token) {
    throw new CanonicalWorkStateIntegrityError(
      "Protected Fugue authority token is unavailable for namespace-coherent Integration mutation.",
    );
  }
  return token;
}

async function authorityRequest(github: FugueGitHub, path: string, init: RequestInit): Promise<Response> {
  return fetch(`https://api.github.com/repos/${github.repository.owner}/${github.repository.repo}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${authorityToken()}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

function isIdleEpoch(value: string): boolean {
  return value === NAMESPACE_GUARD_IDLE_PREFIX ||
    new RegExp(`^${NAMESPACE_GUARD_IDLE_PREFIX}:[0-9a-f]{32}$`, "i").test(value);
}

function guardName(guard: NamespaceMutationGuard): string {
  const digest = createHash("sha256")
    .update(`${guard.publisher_sha}\0\0${guard.target_name}\0${guard.target_value}`, "utf8")
    .digest("hex")
    .slice(0, 24)
    .toUpperCase();
  return `${NAMESPACE_GUARD_PREFIX}${digest}`;
}

function nextIdleEpoch(name: string, value: string): string {
  const epoch = createHash("sha256").update(`${name}\0${value}`, "utf8").digest("hex").slice(0, 32);
  return `${NAMESPACE_GUARD_IDLE_PREFIX}:${epoch}`;
}

function namespaceMutationActive(github: FugueGitHub): boolean {
  return namespaceMutationContext.getStore()?.has(github) ?? false;
}

async function verifiedIdleEpoch(github: FugueGitHub): Promise<string> {
  const directIdle = await getFugueAuthorityVariable(github, NAMESPACE_GUARD_IDLE);
  if (directIdle === undefined) {
    throw new DurableProtocolRecoveryPendingError(
      "Protected Authority namespace mutation is already active; Integration mutation remains pending.",
    );
  }
  if (!isIdleEpoch(directIdle)) {
    throw new CanonicalWorkStateIntegrityError("Protected Authority namespace idle epoch is malformed.");
  }

  // A self-produced idle epoch proves freshness of that one slot, not exclusive ownership of the
  // namespace. A stale/interrupted active FUGUE_D3GT_* guard may coexist with the same idle value.
  // Therefore every logical writer transaction performs one bounded namespace corruption preflight;
  // callers keep request cost bounded by batching all related C/S/B/cleanup mutations in one session.
  const variables = await listFugueAuthorityVariables(github, "");
  const active = variables.filter((variable) => variable.name.startsWith(NAMESPACE_GUARD_PREFIX));
  const listedIdle = variables.find((variable) => variable.name === NAMESPACE_GUARD_IDLE);
  if (active.length && listedIdle) {
    throw new CanonicalWorkStateIntegrityError(
      "Protected Authority namespace simultaneously exposes an idle epoch and an active mutation guard.",
    );
  }
  if (active.length || !listedIdle) {
    throw new DurableProtocolRecoveryPendingError(
      "Protected Authority namespace mutation is already active; Integration mutation remains pending.",
    );
  }
  if (!isIdleEpoch(listedIdle.value)) {
    throw new CanonicalWorkStateIntegrityError("Protected Authority namespace idle epoch is malformed.");
  }
  if (listedIdle.value !== directIdle ||
      await getFugueAuthorityVariable(github, NAMESPACE_GUARD_IDLE) !== directIdle) {
    throw new DurableProtocolRecoveryPendingError(
      "Protected Authority namespace rotated while an Integration mutation was acquiring the guard.",
    );
  }
  return directIdle;
}

async function acquireNamespaceMutationGuard(
  github: FugueGitHub,
): Promise<{ name: string; value: string }> {
  await verifiedIdleEpoch(github);
  const guard: NamespaceMutationGuard = {
    version: 1,
    publisher_sha: "0".repeat(40),
    target_name: NAMESPACE_MAINTENANCE_TARGET,
    target_value: randomBytes(16).toString("hex"),
    created_at: new Date().toISOString(),
    maintenance: true,
  };
  const value = JSON.stringify(guard);
  const name = guardName(guard);
  const response = await authorityRequest(github, `/actions/variables/${encodeURIComponent(NAMESPACE_GUARD_IDLE)}`, {
    method: "PATCH",
    body: JSON.stringify({ name, value }),
  });
  if (response.status === 404 || response.status === 409 || response.status === 422) {
    throw new DurableProtocolRecoveryPendingError(
      "Protected Authority namespace changed while an Integration mutation was acquiring the guard.",
    );
  }
  if (!response.ok) {
    throw new CanonicalWorkStateIntegrityError(
      `Unable to acquire protected Authority namespace mutation guard (${response.status}).`,
    );
  }
  if (await getFugueAuthorityVariable(github, name) !== value ||
      await getFugueAuthorityVariable(github, NAMESPACE_GUARD_IDLE) !== undefined) {
    throw new DurableProtocolRecoveryPendingError(
      "Protected Authority namespace guard did not become exclusively active.",
    );
  }
  return { name, value };
}

async function releaseNamespaceMutationGuard(
  github: FugueGitHub,
  token: { name: string; value: string },
): Promise<void> {
  if (await getFugueAuthorityVariable(github, token.name) !== token.value) {
    throw new CanonicalWorkStateIntegrityError("Protected Authority namespace mutation guard was replaced while active.");
  }
  if (await getFugueAuthorityVariable(github, NAMESPACE_GUARD_IDLE) !== undefined) {
    throw new CanonicalWorkStateIntegrityError(
      "Protected Authority namespace idle epoch reappeared while a mutation guard was active.",
    );
  }
  const idle = nextIdleEpoch(token.name, token.value);
  const response = await authorityRequest(github, `/actions/variables/${encodeURIComponent(token.name)}`, {
    method: "PATCH",
    body: JSON.stringify({ name: NAMESPACE_GUARD_IDLE, value: idle }),
  });
  if (!response.ok) {
    throw new CanonicalWorkStateIntegrityError(
      `Unable to rotate protected Authority namespace epoch after Integration mutation (${response.status}).`,
    );
  }
  if (await getFugueAuthorityVariable(github, NAMESPACE_GUARD_IDLE) !== idle) {
    throw new CanonicalWorkStateIntegrityError("Protected Authority namespace epoch rotation did not become durable.");
  }
}

export async function withFugueAuthorityNamespaceMutation<T>(
  github: FugueGitHub,
  operation: () => Promise<T>,
): Promise<T> {
  if (injectedAuthorityVariables(github) || namespaceMutationActive(github)) return operation();
  const guard = await acquireNamespaceMutationGuard(github);
  const parent = namespaceMutationContext.getStore();
  const active = new Set(parent ?? []);
  active.add(github);
  try {
    return await namespaceMutationContext.run(active, operation);
  } finally {
    await releaseNamespaceMutationGuard(github, guard);
  }
}

export async function createFugueAuthorityVariable(
  github: FugueGitHub,
  name: string,
  value: string,
): Promise<boolean> {
  if (!name.startsWith("FUGUE_INT_") || namespaceMutationActive(github)) {
    return createAuthorityVariableUnchecked(github, name, value);
  }
  return withFugueAuthorityNamespaceMutation(github, () => createAuthorityVariableUnchecked(github, name, value));
}

export async function deleteFugueAuthorityVariable(github: FugueGitHub, name: string): Promise<void> {
  if (!name.startsWith("FUGUE_INT_") || namespaceMutationActive(github)) {
    return deleteAuthorityVariableUnchecked(github, name);
  }
  await withFugueAuthorityNamespaceMutation(github, () => deleteAuthorityVariableUnchecked(github, name));
}
