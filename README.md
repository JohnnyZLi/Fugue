# Fugue

Fugue is a GitHub-backed coordination protocol for running a software-engineering team across replaceable ChatGPT sessions without making the Human act as the message bus.

> **GitHub is durable operational state. ChatGPT sessions are replaceable execution contexts.**

The normal product is chat-first: one persistent Leader conversation coordinates work; disposable Worker and QA chats perform engineering; protected-base GitHub Actions reconcile workflow state and run Integration.

## Normal experience

```text
Human ↔ Leader chat
          │
          ├─ creates/specs GitHub work
          ├─ tracks Worker claims/branches/PRs
          ├─ reads current CI/QA/Integration evidence
          └─ asks for a new disposable chat only when needed

Worker / QA chats ──> GitHub durable state
                           │
                           ▼
                  protected Fugue automation
                           │
                           ▼
                     MERGE READY
                           │
                           ▼
                      Human decision
```

During normal work the Human should not need to run `fugue handoff`, `fugue review`, `fugue integrate`, copy SHAs/Worker IDs, manage branches, or relay verdicts between chats.

A typical cycle is:

1. Tell the Leader what to build.
2. The Leader prepares bounded GitHub work.
3. Protected Fugue durably captures the exact authorized Coordinator issue-event snapshot and canonicalizes it into protected work-state.
4. When required, the Leader gives one short Worker prompt to paste into a fresh ChatGPT chat.
5. The Worker reconstructs from GitHub, implements on the assigned branch, and opens/updates the PR.
6. Protected Fugue waits for exact-head CI and starts the required QA session.
7. QA submits its verdict directly to GitHub; Fugue canonicalizes it against the current review session/identity.
8. Fugue runs one protected Integration attempt for a signed durable request when prerequisites are current.
9. The Leader asks for the final Human merge decision only after current durable Integration PASS.

See [`docs/leader-chat.md`](docs/leader-chat.md) for the role contract and copy/paste prompts.

## Durable model

A governed repository keeps current policy on the protected base branch:

```text
AGENTS.md
    repository baseline + invariants

.fugue/config.yml
    validation, QA, allocation, and Integration policy

.fugue/VERSION
    protocol / runtime compatibility

d3 durable work-state record on protected base
    authoritative work specification, lifecycle, dependencies/ownership,
    Worker claim, assigned branch, and PR linkage

d3 durable Coordinator snapshot on protected base
    immutable authorized Human issue-event contents before canonicalization

d3 durable Integration record on candidate head
    exact request ID, one protected run ID / attempt 1, and terminal result

ordinary issue/PR/protocol comments
    repairable Human-facing mirrors unless explicitly canonical QA/Human evidence

commit statuses
    d3 transport chunks plus UI/branch signals such as fugue/integration
```

### d3 authority commit

Candidate workflows may have `statuses:write`, so a status context or Actions-bot creator cannot be authority by itself. Fugue's d3 record makes the **authority commit** protected as well as the body:

1. Protected Fugue chooses a fresh 128-bit bundle key and a separate 128-bit authority-commit nonce.
2. The OIDC-signed canonical body covers both values.
3. Every pre-commit status chunk contains a copy with both values redacted; data contexts are derived from the unrevealed key.
4. The protected writer verifies current base/publisher identity again.
5. Only the final manifest status reveals the exact key and nonce and therefore makes that signed body reconstructable.

A candidate that observes or copies pre-commit statuses cannot finish an aborted prospective publication because it never learns the signed key/nonce. After a genuine commit, copying the body into a fresh candidate-chosen manifest does not work either: the signature binds the original manifest key and commit nonce. Readers use the earliest server-assigned status in each exact secret-derived data context, so later same-context writes cannot replace protected chunks.

### Bounded recovery

Fake manifests must not create unbounded read amplification. Normal reconstruction uses a protected post-commit locator comment. If that mirror is deleted or tampered, recovery processes fixed-size status pages, at most a fixed small number of manifests per invocation, and resolves their bounded chunk sets entirely from the already-loaded adjacent pages. A signed protected recovery cursor advances across finite hostile history over scheduled runs. Permanent status spam can delay recovery, but it cannot force unbounded per-read pagination, make an older state current, or require Human repository surgery.

The same durable-record primitive backs work-state, Coordinator snapshots, and Integration state. Ordinary locator/result comments can therefore be recreated after `issues:write` deletion.

## Protected Coordinator intent

Coordinator intent is accepted only from the exact immutable GitHub Actions `issues` event payload for an authorized write/maintain/admin actor. Fugue does not authenticate one Human event and later fetch mutable issue contents.

GitHub Actions allows only one pending run per concurrency group, so issue-event runs do **not** share the repository-wide pending slot. Each authorized issue event has a run-specific non-replacing concurrency identity. The run commits its full event snapshot—title, body, labels, actor, action, and issue revision—to d3 durable authority before canonical work-state mutation. Scheduled reconciliation recovers and replays the latest protected issue revision. A crash after capture or deletion of the ordinary snapshot comment therefore does not erase the Human edit.

Other control-plane event classes remain repository-serialized.

## Worker chats

The Leader normally gives a prompt equivalent to:

```text
Fugue Worker for OWNER/REPO work-123.
Reconstruct the current assignment, Worker claim, assigned branch,
repository contract, and scope from GitHub. Implement only that work
on the assigned branch, use GitHub CI as authoritative remote validation,
and open or update the implementation PR. Do not merge or self-approve.
Do not ask the Human to operate Fugue from the terminal.
```

Fugue adopts the assigned-branch PR into protected canonical work-state and repairs issue/PR metadata as presentation mirrors. The Worker does not need to relay its result back to the Leader; GitHub is the handoff.

## QA chats

A QA chat receives a compact prompt such as:

```text
Fugue Code QA for OWNER/REPO PR #456.
Reconstruct the current pending Fugue review session from GitHub,
review the exact committed evaluation identity independently,
and submit the verdict as a fugue-review-submit PR comment for that session.
Do not implement fixes. Submit the result directly to GitHub; do not ask
the Human to use a terminal or relay the verdict.
```

QA submissions are requests, not canonical evidence. Protected Fugue verifies the actor, current session, and exact evaluation identity, then writes canonical QA evidence. A changed head/base/policy/spec makes old QA historical.

## Human control-plane acknowledgement

Control-plane changes remain an explicit Human boundary. `control_plane.paths` includes workflow/policy files **and** source-level trust runtime: CLI dispatch, validation, configuration, ownership, reconciliation, state/provenance, submissions/gates, repository discovery/authentication, evaluation/QA/review code, and Integration control.

The Human only decides whether to acknowledge the current exact evaluation identity. The Leader re-fetches the identity and submits the structured request through GitHub; the Human does not copy SHAs or run a terminal command.

Security-QA conditional coverage likewise includes direct trust primitives such as `src/cli.ts`, `src/core/validation.ts`, `src/core/config.ts`, `src/core/ownership.ts`, and `src/core/git.ts` in addition to the existing state/provenance/QA/CI/Integration modules.

## Required CI provenance

Required CI is executed by the configured workflow from the protected base using `pull_request_target`, not by candidate-controlled PR workflow code. Candidate commands run from the exact head with read-only contents permission, no persisted checkout credential, and blank publication tokens. Fugue accepts the configured job only from the protected-base workflow run bound to the exact PR/head.

## GitHub-hosted Integration

`.github/workflows/fugue-integration.yml` runs Integration from protected-base code after current required QA and Human acknowledgement are satisfied.

The durable lifecycle is:

```text
REQUEST
    protected Fugue creates an unpredictable signed request ID
    and commits it to the candidate head as a d3 Integration record

FIRST PROTECTED RUN
    exactly one causally valid workflow-run ID at attempt 1 may bind that request
    prepare proves GITHUB_RUN_ID / GITHUB_RUN_ATTEMPT match that first-run authority

VALIDATE
    candidate checkout is read-only and credential-separated
    validation evidence carries the exact request ID + run ID + attempt 1

TERMINAL
    protected Fugue commits PASS/failure/error to the d3 Integration record first
    then writes presentation attestation comment / fugue/integration status
```

A later dispatch with the same request ID cannot replace the bound run. Re-running the same run ID cannot replace attempt 1. If a genuine first run completes `failure`, that failure is terminal even if it happened before the prepare runtime could write its normal binding mirror. It never becomes an automatic retry.

Cancellation/abortion and deletion of a bound run are different: Fugue durably marks that request aborted, then recovery creates a **new request ID**. It never silently substitutes another workflow-run ID under the old request.

Terminal PASS/failure is stored in the durable record and therefore survives deletion of the workflow run, request comment, Integration result/attestation comment, or UI status. A terminal PASS embeds the full Integration attestation plus exact request ID, run ID, and attempt 1. `fugue/integration` remains the branch-protection/UI signal; it is not durable authority by itself.

## Local CLI and recovery

The CLI remains useful for bootstrap, status inspection, and protocol debugging. Authoritative publication requires protected GitHub workflow identity; a local Human/user token does not establish work-state, QA, acknowledgement, or Integration authority.

```bash
fugue status
fugue advance --dry-run

# Debug/bootstrap surfaces; protected workflows own authoritative mutation.
fugue reconcile ...
fugue run ...
fugue handoff ...
fugue link-pr ...
fugue review ...
fugue acknowledge ...
fugue integrate ...
```

## Review identity

QA and Integration evidence binds the exact evaluated state:

```text
PR number
head SHA
base branch + base SHA
protected policy digest
protocol version
issue number
work ID
work-spec digest
```

Integration additionally binds its exact request ID, protected workflow-run ID, and attempt 1.

## Repository bootstrap

```bash
git clone https://github.com/JohnnyZLi/Fugue.git
cd Fugue
npm ci
npm run build
npm link

fugue init
fugue status
```

Normal work after bootstrap is coordinated through the Leader/GitHub control plane.

## First proving grounds

Fugue governs its own repository. [Path](https://github.com/JohnnyZLi/Path) remains the visual-product dogfood target for parallel work and artifact-backed Visual QA.

See [`docs/protocol-v0.1.md`](docs/protocol-v0.1.md), [`docs/chatgpt-project.md`](docs/chatgpt-project.md), and [`docs/leader-chat.md`](docs/leader-chat.md).


### d3 recovery and Integration ordering

D3 manifests authenticate their exact committed chunk-ID range and authority order. Recovery freezes a status-ID ceiling and advances a signed low-water cursor without resetting when hostile statuses are appended; locator/receipt comments are repaired presentation hints only. Coordinator snapshots order by immutable issue `updated_at` plus event identity. Integration scans all workflow-run pages for the globally earliest attempt-1 run, and protected `workflow_run` completion events seal terminal failure even if the Actions run is subsequently deleted. Work-spec identity is produced by the single `canonicalWorkSpecIdentity` normalization/hash path and review-start attestations carry that exact digest.
