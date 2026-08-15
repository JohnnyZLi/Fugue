import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Octokit } from "@octokit/rest";
import type { RepositoryRef } from "./git.js";

const execFileAsync = promisify(execFile);

export interface FugueGitHub {
  octokit: Octokit;
  repository: RepositoryRef;
}

export async function resolveGitHubToken(): Promise<string | undefined> {
  const envToken = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (envToken?.trim()) return envToken.trim();

  try {
    const { stdout } = await execFileAsync("gh", ["auth", "token"], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    const token = stdout.trim();
    return token || undefined;
  } catch {
    return undefined;
  }
}

export async function createGitHub(repository: RepositoryRef): Promise<FugueGitHub> {
  const token = await resolveGitHubToken();
  return {
    repository,
    octokit: new Octokit(token ? { auth: token } : {}),
  };
}

export async function requireWritableGitHub(repository: RepositoryRef): Promise<FugueGitHub> {
  const token = await resolveGitHubToken();
  if (!token) {
    throw new Error("GitHub authentication required. Set GITHUB_TOKEN/GH_TOKEN or authenticate gh CLI.");
  }
  return { repository, octokit: new Octokit({ auth: token }) };
}

export async function readRepositoryFile(
  github: FugueGitHub,
  path: string,
  ref: string,
): Promise<string> {
  const { owner, repo } = github.repository;
  const response = await github.octokit.rest.repos.getContent({ owner, repo, path, ref });
  const data = response.data;

  if (Array.isArray(data) || data.type !== "file" || !("content" in data)) {
    throw new Error(`Expected ${path} at ${ref} to be a file.`);
  }

  return Buffer.from(data.content, data.encoding as BufferEncoding).toString("utf8");
}
