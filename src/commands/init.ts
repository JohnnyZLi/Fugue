import { discoverRepository } from "../core/git.js";
import { requireWritableGitHub } from "../core/github.js";
import { resolveActivePolicy } from "../core/policy.js";
import { applyBranchProtection, ensureProtocolLabels } from "../core/repository-init.js";

export interface InitOptions {
  noProtection?: boolean;
}

export async function runInit(options: InitOptions): Promise<void> {
  const repository = await discoverRepository();
  const github = await requireWritableGitHub(repository);
  const policy = await resolveActivePolicy(github);

  const labels = await ensureProtocolLabels(github);
  const protection = options.noProtection
    ? null
    : await applyBranchProtection(github, policy.config);

  console.log(`FUGUE INIT — ${repository.fullName}`);
  console.log(`Base         ${policy.identity.baseBranch} @ ${policy.identity.baseSha.slice(0, 8)}`);
  console.log(`Protocol     ${policy.identity.protocolVersion}`);
  console.log(`Labels       ${labels.created.length ? `created ${labels.created.length}` : "already present"}`);
  if (labels.created.length) console.log(`             ${labels.created.join(", ")}`);

  if (protection) {
    console.log(`Protection   ${protection.branch}`);
    console.log(`Strict base  ${protection.strict ? "required" : "not required"}`);
    console.log(`Checks       ${protection.requiredStatusChecks.join(", ")}`);
    console.log("Force push   blocked");
    console.log("Deletion     blocked");
    console.log("Admins       enforced");
  } else {
    console.log("Protection   skipped (--no-protection)");
  }
}
