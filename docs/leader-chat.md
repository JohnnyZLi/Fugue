# Fugue Leader Chat

The Leader chat is the Human-facing coordinator for a Fugue-governed repository. It may be long-lived for convenience, but it must be replaceable: GitHub and protected-base policy are durable truth.

## Leader contract

The Leader:

1. Reconstructs current repository/work/PR/QA/Integration state from protected durable GitHub evidence whenever the Human returns.
2. Converts Human intent into bounded `fugue-work` issue events with explicit dependencies, ownership, forced QA, and authorized invariant changes.
3. Uses GitHub for coordination mutations rather than asking the Human to run Fugue CLI commands.
4. Never makes the Human ferry SHAs, Worker IDs, session IDs, CI output, or QA verdicts between chats.
5. Requests a new disposable ChatGPT chat only when independent Worker or QA execution is actually required.
6. Gives exactly one compact reconstruction prompt for that chat.
7. Reads the result back from GitHub rather than asking the Human to copy the other chat's output.
8. Surfaces genuine product/architecture decisions, control-plane acknowledgement, blocked execution, and final merge decisions.
9. Never merges without an explicit Human merge instruction.

## Durable work and Coordinator authority

The Leader must distinguish **presentation** from **authority**.

- Work specification, lifecycle, Worker ID/branch, and PR linkage come from the current protected d3 work-state record. On one current base, each successor carries the exact digest of its durable predecessor plus the next logical sequence. Publication/completion time is not work-state authority order, so a slower overlapping publisher derived from an older state cannot erase a later Worker claim, lifecycle transition, dependency/spec change, PR linkage, or accepted Human intent after that later state is durable.
- The ordinary `fugue-work-state` issue comment, issue body/labels, `fugue-work` metadata, PR body, and `fugue-pr` metadata are repairable mirrors.
- A Human Coordinator edit is captured from the exact immutable GitHub Actions event payload. Issue-event runs have non-replacing concurrency identities so GitHub's single-pending replacement cannot discard that event before execution.
- Before canonicalizing work state, protected Fugue commits the full authorized event snapshot to d3 durable authority. Scheduled reconciliation can recover and replay the latest protected issue revision after a crash or comment deletion. Replaying that snapshot advances only from the current exact work-state predecessor; a stale overlapping replay loses rather than being re-parented over newer state.
- The d3 authority commit uses an OIDC-signed random bundle key plus independent commit nonce that are both hidden from every pre-commit chunk and revealed only by the protected final manifest. Its second protected proof binds the ordered exact server ID of every data status, so a candidate cannot substitute an interleaved same-context status. Candidate `statuses:write` code cannot finish an aborted prospective publication.
- Status-only/fake manifests never become authority. After the manifest receives its exact server ID, protected Fugue proves the expected protected default-branch revision is current before signing the Authority witness. The repository-variable create or slot-preserving rename is provisional until Fugue immediately re-proves the exact protected revision after GitHub applies it; if the base advanced inside that final mutation window, the exact new witness is removed or the exact rename is rolled back before publication can report success. The witness binds the exact manifest ID, exact chunk IDs, second manifest proof, and current greatest authority body. Readers validate that witness directly instead of walking live reverse-chronological status pages, so hostile appends cannot move a seek/scan frontier during recovery.
- For a scope, greatest authority is selected by the protocol's signed logical authority order rather than manifest ID, variable name, hash, or completion timing. A not-yet-durable same-order sibling that observes another winner before Authority allocation cannot leave a conflicting witness or locator; already-durable equal-order conflicting logical bodies fail closed.
- Greatest signed witnesses remain packed into immutable content-addressed Authority buckets. Every member of a source pack must independently revalidate before that source can be renamed, deleted, or compacted. If one sibling is transiently unverifiable, verified siblings remain readable but the original mixed-validity pack is quarantined unchanged so the failed sibling's only durable copy cannot be destroyed. Hard-cap compaction atomically transforms an occupied fully verified source slot into its replacement pack, can atomically transfer a redundant source/reserve slot to a required checkpoint, and can replace a partial fully verified pack in place with a content-addressed pack containing a representable new/newer witness. Fixed reserve count, free-slot headroom, and delete-then-create gaps are not correctness assumptions, and concurrent compactors cannot reset another scope or require Human repository surgery while pack capacity remains.
- Authorized Coordinator snapshots are totally ordered by immutable issue revision, protected workflow delivery sequence, and a content-bound event ID, so distinct same-second/same-action Human edits cannot collide or be reordered by a slower run.

A replacement Leader should read reconstructed Fugue state first, never infer authority from whatever issue/PR comments happen to remain visible.

## Normal check-in

When the Human says `status?`, `continue`, or similar, inspect current GitHub state first. Typical responses are:

```text
#123 Worker is still implementing. Nothing needed from you.
```

```text
#123 PR #456 is green and waiting for Code QA.

Open one fresh chat and paste:

Fugue Code QA for OWNER/REPO PR #456. Reconstruct the current pending
Fugue review session from GitHub, review the exact committed evaluation
identity independently, and submit the verdict as a fugue-review-submit
PR comment for that session. Do not implement fixes.
```

```text
#123 Code QA requested changes. Open/resume a Worker chat and paste:

Fugue Worker resume for OWNER/REPO work-123. Reconstruct the existing
assigned branch, PR, current CI state, and current QA findings from GitHub.
Address only the blocking findings within the existing ownership contract.
```

```text
#123 passed current durable Integration. PR #456 is ready to merge.
```

If bounded durable recovery is still progressing, report that protected reconciliation is recovering current authority. Do not reconstruct from stale mirrors and do not ask the Human to perform repository surgery.

## Worker prompt

```text
Fugue Worker for OWNER/REPO work-123.
Reconstruct the current assignment, Worker claim, assigned branch,
repository contract, and scope from GitHub. Implement only that work on
the assigned branch, use GitHub CI as authoritative remote validation,
and open or update the implementation PR. Do not merge or self-approve.
Do not ask the Human to operate Fugue from the terminal.
```

A replacement Worker uses the same work ID and reconstructs the protected canonical claim. Visible issue/PR metadata is a mirror.

## QA prompts

### Code QA

```text
Fugue Code QA for OWNER/REPO PR #456.
Reconstruct the current pending Fugue review session from GitHub, review
the exact committed evaluation identity independently, and submit the
verdict as a fugue-review-submit PR comment for that session.
Do not implement fixes. Submit the result directly to GitHub; do not ask
the Human to use a terminal or relay the verdict.
```

### Security QA

```text
Fugue Security QA for OWNER/REPO PR #456.
Reconstruct the current pending Fugue review session from GitHub, review
the exact committed evaluation identity independently for security/trust
boundary regressions, and submit the verdict as a fugue-review-submit PR
comment for that session. Do not implement fixes. Submit the result directly
to GitHub; do not ask the Human to relay it.
```

## Control-plane acknowledgement

When any configured `control_plane.paths` change, explain the material change to the Human and request acknowledgement of the **current exact evaluation identity**. The configured set includes CLI dispatch and local recovery mutation entrypoints (including `src/commands/advance.ts` and `src/commands/run.ts`), validation, configuration, ownership, reconciliation, state/provenance, submissions/gates, repository discovery/authentication, QA/evaluation/review code, and Integration runtime in addition to workflow/policy files.

The Human only says whether they acknowledge it. The Leader re-fetches the current identity and posts a fresh structured `fugue-human-submit` request through GitHub. Protected Fugue accepts QA/Human request comments only when immutable GitHub comment provenance shows no editor/`lastEditedAt`; an edited body is non-authoritative even when the original author had write permission. A changed head/base/policy/spec makes the old acknowledgement stale.

## Integration recovery

Integration authority is a d3 durable record plus protected one-use dispatch/run-start authority-variable evidence, not a request/result comment, custom Git ref, or the mutable workflow-run list.

- An unpredictable signed request ID and fresh 256-bit one-use dispatch capability are created first; only the capability digest is stored durably.
- The dedicated Fugue Authority GitHub App uses a deterministic create-only election to make concurrent protected reconcilers converge on one request, then creates a request-specific immutable anchor. Its Variables permission is not available to candidate `GITHUB_TOKEN`. The `fugue-authority` environment must already have its default-branch-only deployment policy before the App private key is installed; the workflow audit is only drift detection.
- Before dispatch, protected Authority creates request-local create-only `FUGUE_INT_F_*` may-have-dispatched authority. The synchronous `return_run_details: true` response is the primary exact binding; request-local Authority-App `FUGUE_INT_B_*` and OIDC run-start evidence are independent protected exact-L recovery sources. Live Authority names are never PATCHed or reused.
- Deployment/Deployment Status and workflow-run/history enumeration are never binding authority. Recovery reads only request-local protected exact evidence, so later same-request flooding, deletion, or page shifting cannot elect or replace L.
- PASS/failure/error is committed to the durable record before its presentation comment/status.
- A terminal PASS embeds the full Integration attestation plus request ID, run ID, and attempt 1.
- Deleting the workflow run or any request/result/attestation comment cannot erase terminal PASS/failure; protected recovery recreates mirrors from durable evidence.
- If an exact returned binding, request-local protected binding witness, or OIDC run-start proves attempt 1 existed and the Actions run later disappears before terminal publication, recovery retains that exact run identity and fails closed to terminal failure after its grace period.
- If no pre-dispatch fence exists, provably pre-POST transport may recover with a **new request ID** after grace. Once the create-only fence exists, automatic retry/replacement is forbidden. Exact B/run-start/returned evidence always binds L if it survives before terminalization. If F remains but exact run identity is unavailable through bounded grace, Fugue commits irreversible terminal `identity_lost` with request/evaluation identity, attempt 1, and F-boundary evidence but intentionally no numeric run ID. A fresh Integration then requires explicit Human action/new request.

`fugue/integration = success` remains the GitHub branch-protection/UI signal but is not durable authority by itself.

## Final merge

Only ask after Fugue reconstructs a current exact-identity durable Integration PASS and current merge prerequisites. Re-fetch mutable PR/head state immediately before merging. Merge only after the Human says to merge.

## Local CLI

Local Fugue remains useful for bootstrap, status inspection, and protocol debugging. Local d3 reconstruction must supply `FUGUE_AUTHORITY_TOKEN` using a short-lived/fine-grained repository credential with **Variables: read**; the Authority App private key must not be exported locally. That token only supplies the read side of the checkpoint/run-start plane. Canonical publication still requires protected GitHub workflow/OIDC identity plus the hosted App write credential, so local inspection cannot become authoritative mutation evidence.

## Replacement Leader

A replacement Leader can start with:

```text
Fugue Leader for OWNER/REPO. Reconstruct all current coordination state from GitHub and continue. Do not rely on prior chat memory.
```

No additional handoff packet is required.

## Canonical work-spec identity

Leader, Worker, and QA sessions use the exact work-spec digest carried by current Fugue evaluation/review-start evidence. The digest is computed by the repository's single canonical work-spec normalization/hash function; reviewers do not invent a parallel digest. D3 receipt comments remain presentation hints and must never be used to choose authority over the durable record ordering.


### Durable review and final-mutation recovery

Current review-start/QA verdicts and explicit Human control-plane acknowledgement are protected d3 records; their GitHub comments/statuses are repairable mirrors. Edited QA/Human request bodies never inherit the original comment author's authority, and rejected hostile requests advance a fixed-size exact-identity semantic d3 filter rather than unbounded raw comment IDs/body hashes. Canonical work state also carries the immutable Coordinator issue revision identity, so Human event replay is ordered by issue revision/sequence/event ID rather than work-state publication time. Final Authority-variable recovery writes are fenced through a dedicated protocol guard slot while provisional so concurrent compaction/reserve maintenance cannot preserve a stale-base witness during rollback or crash recovery; optional reserve depletion cannot disable that fence. A protected attempt-1 Integration failure observed before custom run-start evidence is sealed terminal against its exact durable request/run instead of becoming an unstarted retry.

### Final transaction and Integration recovery

D3 readers pin the dedicated recovery-guard idle epoch and revalidate it before accepting authority; compaction and reserve maintenance hold the same guard slot while mutating, so a writer that starts after an idle observation invalidates the in-flight read instead of exposing provisional authority. Integration keeps durable request authorization distinct from attempt existence: no pre-dispatch fence means a genuine pre-POST crash can recover after grace, while first-create of `FUGUE_INT_F_*` is an irreversible may-have-dispatched boundary and forbids redispatch. The synchronous `return_run_details: true` response is immediately d3-bound when available; a request-local Authority-App-authenticated `FUGUE_INT_B_*` witness or OIDC run-start can independently recover the same exact L. Deployment/Deployment Status and mutable workflow/history pagination are presentation only and cannot participate in election, so arbitrary later records and page shifts are irrelevant. If F crosses the may-have-dispatched boundary but the synchronous response and every attacker-resistant exact-run witness are unavailable through grace, Fugue commits terminal `identity_lost` instead of wedging or consulting mutable history. That outcome never becomes PASS, retry, replacement, or later-run election; request-specific Authority slots are reclaimed only after the durable terminal commits, and crash recovery resumes cleanup without altering it. Human acknowledgement remains deletion-resistant d3 authority, and submission-rejection progress remains bounded semantic d3 state.