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
5. The final manifest status reveals the exact key and nonce, and after GitHub assigns that manifest its server ID, protected Fugue publishes a signed create-only Authority-variable commit witness that binds the exact manifest/chunk identity and second proof. The record is committed only when that witness is durable; a status-only manifest remains prospective transport.

A candidate that observes or copies pre-commit statuses cannot finish an aborted prospective publication because it never learns the signed key/nonce. After a genuine commit, copying the body into a fresh candidate-chosen manifest does not work either: the signature binds the original manifest key and commit nonce. The final manifest proof binds the ordered exact server-assigned ID of every protected data status. Recovery accepts a chunk only when both its status ID and secret-derived context match that list, so a hostile same-context status interleaved between protected writes is skipped rather than substituted.

### Bounded recovery

Fake/status-only manifests must not create read amplification or become authority, and an attacker with `issues:write`, `statuses:write`, or `contents:write` must not be able to erase or starve recovery. Locator comments, live status page numbers, and every `refs/fugue/**` custom Git ref are presentation/untrusted only. After the protected manifest write obtains its exact server ID, the Authority App writes an OIDC-signed create-only commit witness containing the current greatest authority body and exact manifest/chunk IDs, manifest proof, digest/order/key/nonce. Recovery validates that witness and the original proofs directly instead of traversing moving reverse-chronological status pages, so appends between individual would-be seek/scan reads cannot starve older frozen authority. The plane retains one greatest signed witness/cursor per resumable identity and never treats caught-up state as retirement. Immutable content-addressed packs retain the original signed bodies. Hard-cap compaction is slot-preserving rather than eight-slot-dependent: an occupied verified source is atomically renamed/replaced into its pack before source cleanup, and a redundant source or optional reserve can be atomically transferred to a waiting checkpoint. Concurrent/failed compaction cannot steal a delete/create gap, drain the only headroom, delete any sole-greatest cursor or unrelated variable, or require Human repository surgery.

The same durable-record primitive backs work-state, Coordinator snapshots, and Integration state. Ordinary locator/result comments and all custom Fugue refs can therefore be deleted or redirected without rolling authority backward; protected recovery recreates presentation from d3 plus the separate authority-variable checkpoint plane.

## Protected Coordinator intent

Coordinator intent is accepted only from the exact immutable GitHub Actions `issues` event payload for an authorized write/maintain/admin actor. Fugue does not authenticate one Human event and later fetch mutable issue contents.

GitHub Actions allows only one pending run per concurrency group, so issue-event runs do **not** share the repository-wide pending slot. Each authorized issue event has a run-specific non-replacing concurrency identity. The run commits its full event snapshot—title, body, labels, actor, action, issue revision, protected delivery sequence, and content-bound event ID—to d3 durable authority before canonical work-state mutation. Ordering uses `issue_updated_at`, then that protected sequence and event ID, so two distinct edits in the same GitHub timestamp second and action still have one total causal order. Scheduled reconciliation recovers and replays the newest protected edit; a slower older run cannot re-canonicalize over it.

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

Control-plane changes remain an explicit Human boundary. `control_plane.paths` includes workflow/policy files **and** source-level trust runtime: CLI dispatch and local recovery entrypoints (including `src/commands/advance.ts` and `src/commands/run.ts`), validation, configuration, ownership, reconciliation, state/provenance, submissions/gates, repository discovery/authentication, evaluation/QA/review code, and Integration control.

The Human only decides whether to acknowledge the current exact evaluation identity. The Leader re-fetches the identity and submits the structured request through GitHub; the Human does not copy SHAs or run a terminal command.

Security-QA conditional coverage likewise includes direct trust primitives and mutation/recovery entrypoints such as `src/cli.ts`, `src/commands/advance.ts`, `src/commands/run.ts`, `src/core/validation.ts`, `src/core/config.ts`, `src/core/ownership.ts`, and `src/core/git.ts` in addition to the existing state/provenance/QA/CI/Integration modules.

## Required CI provenance

Required CI is executed by the configured workflow from the protected base using `pull_request_target`, not by candidate-controlled PR workflow code. Candidate commands run from the exact head with read-only contents permission, no persisted checkout credential, and blank publication tokens. Fugue accepts the configured job only from the protected-base workflow run bound to the exact PR/head.

## GitHub-hosted Integration

`.github/workflows/fugue-integration.yml` runs Integration from protected-base code after current required QA and Human acknowledgement are satisfied.

The durable lifecycle is:

```text
REQUEST
    protected Fugue creates an unpredictable signed request ID plus a fresh
    one-use 256-bit dispatch capability; only its digest is durable in d3
    and a signed dispatch anchor is stored in the bounded request-specific Authority anchor

RUN START
    before checkout/setup/build, attempt 1 proves the one-use capability
    from its request-specific immutable anchor and creates a request-specific
    OIDC-signed run-start record with create-only first-wins semantics carrying
    GITHUB_RUN_ID + attempt 1; after d3 binds that run, transient request records are reclaimed

VALIDATE
    candidate checkout is read-only and credential-separated
    validation evidence carries the exact request ID + run ID + attempt 1

TERMINAL
    protected Fugue commits PASS/failure/error to the d3 Integration record first
    then writes presentation attestation comment / fugue/integration status
```

Filtered workflow-run search and custom Git refs are not binding authority. Concurrent protected reconcilers converge through one deterministic create-only election, then use immutable request-specific anchor/run-start names; no live Authority variable is PATCHed or reused. Same-request flood runs do not know the one-use capability and cannot replace the first create-only run-start, while reruns are rejected because only attempt 1 may consume it. Fugue caps active request anchors, safely scavenges aged pre-d3 orphans repository-wide, and reclaims each request's transient records as soon as d3 contains the protected run binding or terminal abort, so cancellation/retry or abandoned-PR residue cannot consume the finite Variables namespace. The exact run ID comes from the signed run-start value, so GitHub list caps and hostile ref movement do not affect first-run identity.

If transport never crosses the run-start boundary, protected recovery may abort that unused request and create a fresh one. Once run-start is durable, however, deletion of the exact Actions run cannot become a retry: after the recovery grace period Fugue seals terminal failure unless it already has durable PASS/failure/error or an actually observed cancellation/abortion. A `workflow_run` consumer can seal outcomes promptly, but cancelling or deleting that consumer cannot erase the run-start evidence or turn a possible genuine failure into retryable transport.

Terminal PASS/failure is stored in the durable record and therefore survives deletion of the workflow run, request comment, Integration result/attestation comment, or UI status. A terminal PASS embeds the full Integration attestation plus exact request ID, run ID, and attempt 1. `fugue/integration` remains the branch-protection/UI signal; it is not durable authority by itself.

## Local CLI and recovery

The CLI remains useful for bootstrap, status inspection, and protocol debugging. Because recovery progress now lives on the separate Authority-Variables plane, local state reconstruction must be given an explicit **read-only** repository credential with **Variables: read** as `FUGUE_AUTHORITY_TOKEN`; do not export the Authority App private key into a local shell. This credential can read checkpoint/run-start working state but cannot create canonical Fugue authority, because authoritative publication still requires the protected GitHub workflow/OIDC identity and the hosted App write token.

```bash
# Export a short-lived/fine-grained repository token with Variables: read.
export FUGUE_AUTHORITY_TOKEN="$FUGUE_VARIABLES_READ_TOKEN"

# Read/debug operations that reconstruct d3 state inherit the read-only Authority credential.
fugue status
fugue advance --dry-run

# Debug/bootstrap surfaces; protected workflows still own authoritative mutation.
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
export FUGUE_AUTHORITY_TOKEN="$FUGUE_VARIABLES_READ_TOKEN"
fugue status
```

Normal work after bootstrap is coordinated through the Leader/GitHub control plane.

The hosted control plane additionally requires a dedicated **Fugue Authority** GitHub App installed only on the governed repository with repository **Variables: write** (and metadata read) permission. **Before the App private key is installed**, repository administrators must create `fugue-authority`, configure its deployment policy to allow exactly the protected default branch, and verify that restriction externally. Only then is the private key installed as an environment secret. A workflow's in-job environment-policy audit is drift detection only: it runs after GitHub has already gated that job and cannot make a broadly configured environment safe from a candidate workflow that references the environment directly. `FUGUE_AUTHORITY_APP_CLIENT_ID` is provided through the environment/repository `vars` context and `FUGUE_AUTHORITY_APP_PRIVATE_KEY` through the environment `secrets` context. The protected workflows mint short-lived installation tokens and pass them only to authority-variable operations; candidate jobs never receive that credential.

## First proving grounds

Fugue governs its own repository. [Path](https://github.com/JohnnyZLi/Path) remains the visual-product dogfood target for parallel work and artifact-backed Visual QA.

See [`docs/protocol-v0.1.md`](docs/protocol-v0.1.md), [`docs/chatgpt-project.md`](docs/chatgpt-project.md), and [`docs/leader-chat.md`](docs/leader-chat.md).


### d3 recovery and Integration ordering

D3 manifests authenticate the ordered exact server status ID of every committed chunk plus authority order. Recovery freezes a status-ID ceiling and advances a bounded, self-compacting signed low-water cursor without resetting when hostile statuses are appended; locator/receipt comments are repaired presentation hints only. Coordinator snapshots order by immutable issue `updated_at` plus protected sequence/event identity. Integration binds from the one-use App-owned request-specific run-start record—not workflow-run list scanning—and then commits that exact run ID into d3; protected `workflow_run` completion events can seal terminal failure even if the Actions run is subsequently deleted. Work-spec identity is produced by the single `canonicalWorkSpecIdentity` normalization/hash path and review-start attestations carry that exact digest.
