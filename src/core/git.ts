import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface RepositoryRef {
  owner: string;
  repo: string;
  fullName: string;
}

export async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout.trim();
}

export async function repositoryRoot(cwd = process.cwd()): Promise<string> {
  return git(["rev-parse", "--show-toplevel"], cwd);
}

export async function originUrl(cwd = process.cwd()): Promise<string> {
  return git(["config", "--get", "remote.origin.url"], cwd);
}

export async function currentBranch(cwd = process.cwd()): Promise<string> {
  return git(["branch", "--show-current"], cwd);
}

export function parseGitHubRepository(remote: string): RepositoryRef {
  const normalized = remote.trim().replace(/\.git$/, "");
  const ssh = normalized.match(/^git@github\.com:([^/]+)\/(.+)$/);
  const https = normalized.match(/^https?:\/\/github\.com\/([^/]+)\/(.+)$/);
  const match = ssh ?? https;

  if (!match?.[1] || !match[2]) {
    throw new Error(`Unsupported GitHub remote: ${remote}`);
  }

  return {
    owner: match[1],
    repo: match[2],
    fullName: `${match[1]}/${match[2]}`,
  };
}

export async function discoverRepository(cwd = process.cwd()): Promise<RepositoryRef> {
  const override = process.env.FUGUE_REPOSITORY;
  if (override) {
    const [owner, repo, ...rest] = override.split("/");
    if (!owner || !repo || rest.length) throw new Error("FUGUE_REPOSITORY must be owner/repo.");
    return { owner, repo, fullName: `${owner}/${repo}` };
  }
  return parseGitHubRepository(await originUrl(cwd));
}
