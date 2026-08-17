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
          ├─ decides when independent QA is required
          ├─ reads current CI/QA/Integration evidence
          └─ asks for a new disposable chat only when needed

Worker chat ──────┐
Code QA chat ─────┼──> GitHub durable state
Security QA chat ─┤
Visual QA chat ───┘
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
3. Protected Fugue canonicalizes that exact Coordinator issue-event snapshot into signed work-state.
4. When required, the Leader gives one short Worker prompt to paste into a fresh ChatGPT chat.
5. The Worker reconstructs from GitHub, implements on the assigned branch, and opens/updates the PR.
6. Protected Fugue automation waits for exact-head CI, starts the required QA session, and updates the durable state dashboard.
7. The Leader gives one short QA prompt when you check in.
8. QA submits its verdict directly to GitHub; Fugue canonicalizes it against the current review session/identity.
9. Fugue automatically runs Integration when prerequisites are current.
10. The Leader asks for the final Human merge decision.

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

Signed canonical fugue-work-state transaction
    authoritative work specification, lifecycle, dependencies/ownership,
    Worker claim, assigned branch, and PR linkage

GitHub issue body/labels + fugue-work metadata
    Coordinator input and repairable presentation mirror only

GitHub PR body + fugue-pr metadata
    repairable implementation-association mirror only

PR comments + canonical Fugue attestations
    signed review sessions, QA verdicts, Human acknowledgement,
    Integration requests/results

commit statuses
    immutable work-state transaction checkpoints plus UI/branch signals:
    fugue/code-qa
    fugue/security-qa
    fugue/visual-qa
    fugue/integration
```

Canonical work-state publication is a two-phase protected-base transaction. Fugue first appends an immutable staging status with a server-assigned generation, signs a `fugue-work-state` comment that embeds that generation, then appends an immutable head status containing the exact comment ID and digest. Readers validate the newest head only. If the committed comment is deleted or modified, or if an untrusted workflow appends a forged newer head, work state becomes detectably non-current; Fugue never falls back to an older surviving state.

Canonical durable Fugue comments have one structural Fugue protocol marker and are content-bound using GitHub Actions OIDC proof to an approved Fugue workflow on the repository default branch at the required protected workflow revision. Historical work-state rollover additionally requires the proof's `workflow_sha` and the signed state's `base_sha` to equal the exact historical protected-base checkpoint being reused. The shared `github-actions[bot]` login, a re-run attempt, a stale workflow revision, or a matching status context is not authority by itself.

Candidate control-plane changes are proposed future policy. They do not weaken the protected-base rules or workflow code used to evaluate their own PR.

## Protected GitHub control plane

`.github/workflows/fugue-control-plane.yml` is the always-available reconciliation runtime. It reacts to issue/PR/comment/CI events and also runs periodically as recovery. Each invocation reconstructs GitHub state and performs idempotent deterministic transitions; it has no workflow database.

Coordinator issue edits are accepted only from the immutable GitHub Actions event payload for an authorized write/maintain/admin actor. Fugue does not authenticate an event and then fetch a later mutable issue body, so a candidate workflow cannot substitute different content between the Human event and canonicalization.

It automatically handles:

- ready-work allocation and Worker branch creation;
- signed checkpointed work-state publication and mirror repair;
- Worker PR adoption;
- central changed-file ownership enforcement;
- exact-head CI gating before QA;
- code-first QA sequencing;
- current review-session creation;
- QA/Human submission ingestion;
- stale evidence after head/base/spec changes;
- draft promotion;
- GitHub-hosted Integration dispatch and recovery after cancelled/aborted runs;
- one mutable issue state dashboard containing the current next action and copy/paste prompt.

The PR event uses `pull_request_target` so control-plane code and write authority come from the protected base instead of the candidate PR. Canonical comments additionally carry an OIDC proof whose audience binds the exact comment body, whose `workflow_ref` binds the approved workflow path on the repository default branch, and whose `workflow_sha` is checked against the protected revision required for that evidence.

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

Fugue adopts the assigned-branch PR into signed canonical work-state and writes/repairs the PR's `fugue-pr` metadata as a presentation mirror. The Worker does not need to relay its result back to the Leader; GitHub is the handoff.

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

The QA chat submits a request, for example:

```yaml
<!-- fugue-review-submit
version: 1
session_id: rev-code-12345678
role: code
verdict: approved
agents_update: not-required
validation_control: acceptable
summary: Exact-head review passed.
-->
```

Visual QA can add:

```yaml
runtime_tested: true
viewports:
  - 1440x900
  - 390x844
```

The submission does **not** carry canonical head/base/policy identity. Protected Fugue automation finds the current review session, reconstructs the exact evaluation identity, validates role-specific evidence, verifies the submitting actor has repository write/maintain/admin permission, and writes the canonical signed attestation/status. Untrusted submission fields cannot contain Fugue protocol markers, and canonical publication refuses bodies with more than one protocol marker, so a rejection path cannot become a signing oracle. Malformed, stale, unauthorized, or conflicting submissions are durably rejected rather than silently reused.

## Changes requested

A current QA `changes_requested` verdict moves the work back to **NEEDS WORKER CHAT**. A replacement Worker chat reconstructs the same canonical Worker claim/branch/PR plus current QA findings. When the Worker pushes a new head, historical QA naturally becomes stale and the next current QA session is created after exact-head CI passes.

## Human control-plane acknowledgement

Control-plane changes remain an explicit Human boundary. The Leader explains the material protected-policy/workflow change and asks the Human whether they acknowledge the **current exact evaluation identity**. The Human only answers the decision; they do not copy SHAs, digests, or protocol fields.

After approval, the Leader re-fetches the current evaluation from GitHub and posts an identity-bound request such as:

```yaml
<!-- fugue-human-submit
version: 1
kind: control_plane_ack
identity:
  prNumber: 456
  headSha: <current exact PR head>
  baseBranch: main
  baseSha: <current protected-base SHA>
  policyDigest: <current protected policy digest>
  protocolVersion: 1
  issueNumber: 123
  workId: work-123
  workSpecDigest: <current work-spec digest>
-->
```

The request itself is not canonical acknowledgement evidence. Protected Fugue automation verifies the GitHub actor has repository write/maintain/admin permission and that every evaluation-identity field still matches the current PR. It then writes the workflow-bound canonical Human acknowledgement. A changed head, base, policy, protocol, issue/work identity, or work specification makes the old request stale rather than carrying approval forward.

No terminal command is required in normal operation.

## Required CI provenance

Required CI is executed by the configured workflow from the protected base using `pull_request_target`, not by candidate-controlled PR workflow code. The protected workflow checks out the exact candidate head with only `contents: read`, no persisted checkout credential, and blank `GITHUB_TOKEN` / `GH_TOKEN` for candidate commands. Fugue accepts the required job only from the protected-base workflow run whose durable run name binds both the exact PR number and candidate head SHA. A candidate workflow file, arbitrary lookalike check/status, or run for another PR/head cannot satisfy the internal Fugue CI gate or gain a pre-gate write-capable durable-state path.

## GitHub-hosted Integration

`.github/workflows/fugue-integration.yml` runs Integration from protected-base code after current required QA and Human acknowledgement are satisfied.

The workflow separates authority:

```text
PREPARE (write-capable trusted Fugue)
    accept only the current signed durable Integration request
    capture exact identity
    verify base / ownership / QA / dependencies / policy evidence
    verify trusted workflow/runtime SHA matches current protected base
    publish integration pending UI/status signal
    write immutable validation plan

VALIDATE (candidate checkout, read-only GitHub permission)
    checkout exact prepared head
    run protected-base install/check commands
    blank GitHub publication tokens for candidate commands
    never interpolate untrusted workflow inputs directly into shell program text
    produce validation evidence

FINALIZE (write-capable trusted Fugue)
    verify validation evidence matches the protected command plan
    re-fetch exact identity
    re-check prerequisites / CI / mergeability
    reject drift
    publish signed canonical Integration attestation + fugue/integration UI/status signal
```

The candidate is never used as the source of the workflow code that judges it, and candidate validation does not receive Fugue publication authority.

Authoritative Integration state is reconstructed from the signed exact-identity Integration request, its causally later protected workflow run bound to both `request_id` and the expected PR input, and the signed Integration attestation. Completed workflow runs that were merely cancelled/aborted are treated as recoverable transport failures: they are ignored for authoritative result selection and the durable request becomes eligible for redispatch instead of becoming terminal. `fugue/integration` remains the GitHub branch-protection/UI signal, but the shared Actions status context is not treated as durable Fugue truth by itself.

## Repository bootstrap

Fugue CLI is still used for one-time repository setup and status/protocol inspection.

```bash
git clone https://github.com/JohnnyZLi/Fugue.git
cd Fugue
npm ci
npm run build
npm link

fugue init
fugue status
```

`fugue init` provisions protocol labels and branch protection. Normal work after bootstrap is coordinated through the Leader/GitHub control plane.

GitHub authentication lookup order remains:

```text
GITHUB_TOKEN
GH_TOKEN
gh auth token
```

## Local CLI and recovery

Local commands remain useful for bootstrap, status inspection, protocol development, and debugging. Canonical publication requires the protected GitHub workflow identity, so a local invocation using a Human/user token does **not** establish authoritative QA, acknowledgement, state, or Integration evidence.

```bash
fugue status
fugue advance --dry-run

# Protocol-development/debug surfaces; authoritative mutation/recovery
# should be routed through the protected GitHub workflows.
fugue reconcile ...
fugue run ...
fugue handoff ...
fugue link-pr ...
fugue review ...
fugue acknowledge ...
fugue integrate ...
```

The protected workflows are restart-safe because GitHub remains durable truth.

## Review identity

QA and Integration evidence is tied to the exact evaluated state, including:

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

A changed head, changed base, changed policy, or changed work specification makes older evidence historical rather than silently carrying approval forward.

## First proving grounds

Fugue now governs its own repository. [Path](https://github.com/JohnnyZLi/Path) remains the visual-product dogfood target for parallel work and artifact-backed Visual QA.

See [`docs/protocol-v0.1.md`](docs/protocol-v0.1.md), [`docs/chatgpt-project.md`](docs/chatgpt-project.md), and [`docs/leader-chat.md`](docs/leader-chat.md).
