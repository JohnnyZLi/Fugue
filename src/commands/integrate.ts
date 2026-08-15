import { discoverRepository } from "../core/git.js";
import { requireWritableGitHub } from "../core/github.js";
import { integrate } from "../core/integration.js";

export async function runIntegrate(prValue: string): Promise<void> {
  const prNumber = parsePositiveInteger(prValue, "PR");
  const repository = await discoverRepository();
  const github = await requireWritableGitHub(repository);

  const result = await integrate(github, prNumber);

  console.log("INTEGRATION PASS");
  console.log(`PR           #${prNumber}`);
  console.log(`Head         ${result.snapshot.identity.headSha}`);
  console.log(`Base         ${result.snapshot.identity.baseBranch} @ ${result.snapshot.identity.baseSha.slice(0, 8)}`);
  console.log(`Policy       ${result.snapshot.identity.policyDigest.slice(0, 19)}`);
  console.log(`Work spec    ${result.snapshot.identity.workSpecDigest.slice(0, 19)}`);
  console.log(`Attestation  ${result.attestation.attestation_id}`);
  console.log(`Evidence     ${result.url}`);
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Invalid ${name} number: ${value}`);
  return parsed;
}
