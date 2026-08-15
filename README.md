# Fugue

Fugue is a GitHub-backed coordination protocol and CLI for running multiple ChatGPT engineering sessions as a recoverable software team.

The core idea is simple:

> ChatGPT sessions are disposable. Durable engineering state lives in GitHub and protected repository policy.

A fresh Coordinator, Worker, QA, or Integration chat should be able to reconstruct what it needs from the repository and GitHub instead of depending on another chat's hidden memory.

## Roles

```text
User
  ↓
Coordinator
  ├─ Implementation Worker × N
  ↓
Independent QA
  ├─ Code QA
  ├─ Security QA
  └─ Visual / UX QA
  ↓
Integration
  ↓
Human merge
```

## Durable model

A Fugue-governed repository keeps its current policy on the protected base branch:

```text
AGENTS.md
    repository baseline + invariants

.fugue/config.yml
    validation, QA, allocation, and Integration policy

.fugue/VERSION
    protocol / CLI compatibility

GitHub issues + machine metadata
    work specifications, dependencies, ownership, Worker claims

GitHub PRs + machine metadata
    implementation association

commit statuses + structured PR attestations
    QA and Integration evidence
```

Candidate control-plane changes are proposed future policy; they do not weaken the rules used to review their own PR.

## Normal workflow

`fugue run` is the foreground orchestrator. Start it in a governed repository and leave it running while Workers and QA sessions operate. It polls GitHub, performs deterministic transitions automatically, suppresses duplicate prompts, promotes reviewed draft PRs, runs Integration, and reports merge readiness.

```bash
fugue status
fugue run
fugue run --issue 123
fugue run --pr 456
fugue run --issue 123 --interval 10
```

`Ctrl-C` is safe. The process keeps no durable workflow database; restarting it reconstructs state from GitHub.

Typical progression:

```text
ready work
  -> allocate Worker
  -> wait for Worker PR
  -> create missing QA sessions
  -> wait for QA
  -> mark reviewed draft PR ready
  -> run Integration
  -> ready for human merge
```

If QA requests changes, the planner routes work back to the existing Worker identity. Control-plane acknowledgement, state drift, QA errors, and failed Integration remain explicit intervention boundaries.

The current executor is `manual-chat`: Fugue emits one compact prompt for a fresh ChatGPT Worker or QA session to reconstruct everything else from GitHub, then the same `fugue run` process keeps watching for its durable result. Future Codex/API executors can remove the manual tab-creation boundary without changing workflow planning semantics.

For one-shot coordination, use the same planner through:

```bash
fugue advance
fugue advance --issue 123
fugue advance --pr 456
fugue advance --issue 123 --dry-run
```

## Low-level recovery commands

The original commands remain available for debugging, explicit role handoff, and recovery:

```bash
fugue handoff coordinator
fugue handoff worker --issue 123
fugue handoff worker --issue 123 --resume
fugue handoff code-qa --pr 456
fugue handoff security-qa --pr 456
fugue handoff visual-qa --pr 456
fugue handoff integration --pr 456

fugue link-pr 456 --issue 123

fugue review 456 --role code --approve --agents-update not-required
fugue review 456 --role security --approve
fugue review 456 --role visual --approve --runtime-tested --viewports 1440x900,390x844

fugue acknowledge 456 --control-plane
fugue integrate 456
```

`doctor`, `sync`, and `init` are intentionally not part of the implemented bootstrap yet. The state protocol and autonomous coordination layer are being proven first.

## Local bootstrap installation

Fugue currently runs from a local checkout.

```bash
git clone https://github.com/JohnnyZLi/Fugue.git
cd Fugue
npm ci
npm run build
npm link

fugue --help
```

Writing GitHub state requires authentication. Fugue checks, in order:

```text
GITHUB_TOKEN
GH_TOKEN
gh auth token
```

For normal local use, authenticating the GitHub CLI is sufficient:

```bash
gh auth login
```

## Using Fugue on a repository

Clone a Fugue-governed repository and let the planner handle subsequent deterministic transitions:

```bash
git clone https://github.com/JohnnyZLi/Path.git
cd Path
fugue status
fugue run
```

Read-only repository discovery can also use:

```bash
FUGUE_REPOSITORY=JohnnyZLi/Path fugue status
```

Integration deliberately requires a local Git checkout because trusted validation runs in a temporary clean worktree at the exact PR head SHA.

## Replacement chats

If a Worker chat hits its context limit, do **not** create another Worker claim. `fugue run` continues to identify the existing Worker as the execution target, and the low-level recovery form remains:

```bash
fugue handoff worker --issue 123 --resume
```

That reconstructs the existing:

```text
work ID
Worker ID
branch
issue specification
base policy identity
```

QA handoffs are idempotent for the same role and exact evaluation identity. Re-running the same handoff reuses the current pending session instead of creating another ambiguous active session. Older orphaned sessions are superseded chronologically when a newer session is completed.

A Coordinator process or chat can be replaced and reconstruct state again. Integration that dies mid-run is restarted from a fresh snapshot rather than trusting partial terminal output.

## Review identity

QA evidence is tied to the exact evaluated state, including the PR head and authoritative work specification. Integration additionally binds the base and protected policy.

A changed head, changed work specification, changed base, or changed active policy causes old evidence to become historical rather than silently approving the new state. `fugue status` surfaces the current Integration verdict and the planner's derived next action.

## First proving ground

[Path](https://github.com/JohnnyZLi/Path) is the first external project used to prove Fugue. It is a visual algorithm playground whose implementation naturally exercises parallel Workers, Code QA, Visual QA, strict Integration, and replacement-session recovery.

See [`docs/protocol-v0.1.md`](docs/protocol-v0.1.md), [`docs/chatgpt-project.md`](docs/chatgpt-project.md), and [`docs/autonomous-coordination.md`](docs/autonomous-coordination.md).
