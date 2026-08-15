import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { parseConfig, type FugueConfig } from "./config.js";
import { digestCanonical } from "./hash.js";
import { readRepositoryFile, type FugueGitHub } from "./github.js";
import {
  assertCompatibleCliVersion,
  assertSupportedProtocol,
  type PolicyIdentity,
} from "./protocol.js";

const versionSchema = z.object({
  protocol: z.number().int().positive(),
  fugue_min_version: z.string().min(1),
  fugue_max_compatible_version: z.string().min(1),
});

export type FugueVersionFile = z.infer<typeof versionSchema>;

export interface ActivePolicy {
  identity: PolicyIdentity;
  config: FugueConfig;
  configRaw: string;
  agentsRaw: string;
  versionRaw: string;
}

export function parseVersionFile(raw: string): FugueVersionFile {
  return versionSchema.parse(parseYaml(raw));
}

export async function resolveActivePolicy(github: FugueGitHub): Promise<ActivePolicy> {
  const { owner, repo } = github.repository;
  const repoResponse = await github.octokit.rest.repos.get({ owner, repo });
  const baseBranch = repoResponse.data.default_branch;
  const branch = await github.octokit.rest.repos.getBranch({ owner, repo, branch: baseBranch });
  const baseSha = branch.data.commit.sha;

  const configRaw = await readRepositoryFile(github, ".fugue/config.yml", baseSha);
  const config = parseConfig(configRaw);
  const versionRaw = await readRepositoryFile(github, ".fugue/VERSION", baseSha);
  const version = parseVersionFile(versionRaw);
  assertSupportedProtocol(version.protocol);
  assertCompatibleCliVersion(version.fugue_min_version, version.fugue_max_compatible_version);

  if (config.repository.default_branch !== baseBranch) {
    throw new Error(
      `Configured base branch ${config.repository.default_branch} does not match GitHub default branch ${baseBranch}.`,
    );
  }

  const agentsRaw = await readRepositoryFile(github, config.repository.agents_file, baseSha);
  const policyDigest = digestCanonical({
    protocol: version.protocol,
    version: normalize(versionRaw),
    config: normalize(configRaw),
    agents: normalize(agentsRaw),
  });

  return {
    identity: {
      baseBranch,
      baseSha,
      policyDigest,
      protocolVersion: version.protocol,
    },
    config,
    configRaw,
    agentsRaw,
    versionRaw,
  };
}

function normalize(value: string): string {
  return value.replace(/\r\n?/g, "\n").trim();
}
