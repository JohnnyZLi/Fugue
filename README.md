# Fugue

Fugue is a GitHub-backed coordination protocol and CLI for running multiple engineering agent sessions as a recoverable software team.

The core idea is simple:

> Agent sessions are disposable. Durable engineering state lives in GitHub and protected repository policy.

A fresh Coordinator, Worker, QA, or Integration execution should be able to reconstruct what it needs from the repository and GitHub instead of depending on another session's hidden memory.

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

## Repository bootstrap and enforcement

Once a repository already contains its protected-base `AGENTS.md` and `.fugue/**` policy, initialize the GitHub-side protocol state with:

```bash
fugue init
```

`fugue init` is idempotent. It creates any missing Fugue protocol labels and configures protection for the policy's default branch. The hard gate requires the configured CI contexts plus `fugue/integration`, requires an up-to-date branch when policy says so, enforces the gate for administrators, requires linear history, and blocks force-push/deletion bypass.

Applying branch protection requires repository-owner/admin GitHub authentication with Administration write permission. If branch protection must be managed separately, `fugue init --no-protection` creates the protocol labels only.

## Normal workflow

`fugue run` is the foreground orchestrator. Start it in a governed repository and leave it running while work advances. It polls GitHub, performs deterministic transitions automatically, promotes reviewed draft PRs, runs Integration, and reports merge readiness.

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
  -> execute Worker
  -> create/link draft PR
  -> start required QA
  -> execute QA
  -> mark reviewed draft PR ready
  -> run Integration
  -> ready for human merge
```

If QA requests changes, the planner routes work back to the existing Worker identity. Control-plane acknowledgement, state drift, QA errors, Visual QA, and failed Integration remain explicit intervention boundaries where required.

If a Codex Worker pushed its assigned branch but the process died before PR publication completed, Fugue recovers the existing committed result, revalidates its ownership and protected-base checks, and publishes/links the PR instead of blindly rerunning the Worker.

## Executors

Fugue separates workflow planning from the runtime used to execute engineering roles.

### Manual ChatGPT sessions

The default remains `manual-chat`:

```bash
fugue run --executor manual-chat
```

Fugue emits compact reconstruction prompts for fresh Worker or QA chats and keeps watching GitHub for durable results.

### Codex CLI

For substantially less human orchestration, use the Codex CLI executor:

```bash
npm install -g @openai/codex
codex --login

fugue run --executor codex
```

Optional model override:

```bash
fugue run --executor codex --model <model>
```

The Codex executor currently launches:

```text
Worker       autonomous
Code QA      autonomous
Security QA  autonomous
Visual QA    manual/runtime boundary
Integration  Fugue-owned
Final merge  Human-owned
```

Fugue does not give Codex GitHub publication authority. Worker agents run in isolated temporary worktrees with workspace-write access; Fugue verifies changed paths against issue ownership, runs protected-base validation, commits, pushes the assigned branch, and creates the draft PR itself. Code/Security QA run as fresh processes on clean exact-head worktrees with structured output; Fugue records the resulting identity-bound attestation.

Visual QA remains manual until a runtime/browser executor can prove exact-head rendering evidence rather than reducing visual review to source inspection.

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

fugue review 456 --role code --approve --agents-update not-required --validation-control acceptable
fugue review 456 --role security --approve
fugue review 456 --role visual --approve --runtime-tested --viewports 1440x900,390x844

fugue acknowledge 456 --control-plane
fugue integrate 456
```

`doctor` and `sync` remain intentionally deferred. The state protocol, repository bootstrap, and autonomous coordination layer are implemented first.

## Local installation

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

## Working on Fugue with Fugue

Fugue is itself a governed repository. After updating the local checkout and linking the current CLI, bootstrap GitHub enforcement once and then use the normal orchestrator:

```bash
git switch main
git pull --ff-only origin main
npm ci
npm run build
npm link

fugue init
fugue status
fugue run --executor codex
```

After `fugue init`, normal Fugue issues use the same `state:*`, `agent:*`, ownership metadata, independent QA, and `fugue/integration` gate as any other governed repository. Final merge remains Human-controlled.

## Using Fugue on another repository

Clone a Fugue-governed repository and let the planner handle subsequent deterministic transitions:

```bash
git clone https://github.com/JohnnyZLi/Path.git
cd Path
fugue init
fugue status
fugue run --executor codex
```

Read-only repository discovery can also use:

```bash
FUGUE_REPOSITORY=JohnnyZLi/Path fugue status
```

Integration and launchable local executors deliberately require a local Git checkout because trusted validation and agent execution use temporary worktrees at specific repository identities.

## Replacement sessions

A Worker execution does **not** create another Worker claim when the same work identity already exists. QA handoffs are idempotent for the same role and exact evaluation identity. Older orphaned sessions are superseded chronologically when a newer session is completed.

A Coordinator process can be replaced and reconstruct state again. Integration that dies mid-run is restarted from a fresh snapshot rather than trusting partial terminal output.

## Review identity

QA evidence is tied to the exact evaluated state, including the PR head and authoritative work specification. Integration additionally binds the base and protected policy.

A changed head, changed work specification, changed base, or changed active policy causes old evidence to become historical rather than silently approving the new state. `fugue status` surfaces the current Integration verdict and the planner's derived next action.

## First proving ground

[Path](https://github.com/JohnnyZLi/Path) is the first external project used to prove Fugue. It is a visual algorithm playground whose implementation naturally exercises parallel Workers, Code QA, Visual QA, strict Integration, and replacement-session recovery.

See [`docs/protocol-v0.1.md`](docs/protocol-v0.1.md), [`docs/chatgpt-project.md`](docs/chatgpt-project.md), and [`docs/autonomous-coordination.md`](docs/autonomous-coordination.md).
