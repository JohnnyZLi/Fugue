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

- Work specification, lifecycle, Worker ID/branch, and PR linkage come from the current protected d3 work-state record.
- The ordinary `fugue-work-state` issue comment, issue body/labels, `fugue-work` metadata, PR body, and `fugue-pr` metadata are repairable mirrors.
- A Human Coordinator edit is captured from the exact immutable GitHub Actions event payload. Issue-event runs have non-replacing concurrency identities so GitHub's single-pending replacement cannot discard that event before execution.
- Before canonicalizing work state, protected Fugue commits the full authorized event snapshot to d3 durable authority. Scheduled reconciliation can recover and replay the latest protected issue revision after a crash or comment deletion.
- The d3 authority commit uses an OIDC-signed random bundle key plus independent commit nonce that are both hidden from every pre-commit chunk and revealed only by the protected final manifest. Candidate `statuses:write` code cannot finish an aborted prospective publication.
- Fake manifests are processed through bounded status-ID recovery slices. Progress is persisted as write-once OIDC-signed repository Actions Variables created by the dedicated Fugue Authority GitHub App, not in issue comments or `refs/fugue/**`. Candidate `GITHUB_TOKEN` permissions do not include repository Variables, and readers choose greatest validated progress, so deleting/moving custom refs and presentation comments while appending statuses cannot reset recovery to page 1, make an older record authoritative, or require Human repository surgery.
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

The Human only says whether they acknowledge it. The Leader re-fetches the current identity and posts the structured `fugue-human-submit` request through GitHub. A changed head/base/policy/spec makes the old acknowledgement stale.

## Integration recovery

Integration authority is a d3 durable record plus protected one-use dispatch/run-start authority-variable evidence, not a request/result comment, custom Git ref, or the mutable workflow-run list.

- An unpredictable signed request ID and fresh 256-bit one-use dispatch capability are created first; only the capability digest is stored durably.
- The dedicated Fugue Authority GitHub App creates an OIDC-signed dispatch-anchor repository variable for that digest; its Variables permission is not available to candidate `GITHUB_TOKEN`.
- Before repository checkout/setup/build, attempt 1 proves the capability and transitions that same protected variable once to an OIDC-signed run-start value carrying the exact `GITHUB_RUN_ID` and attempt 1.
- Filtered workflow-run search is not used to select the bound run, so arbitrary later same-request run flooding cannot change first-run identity.
- PASS/failure/error is committed to the durable record before its presentation comment/status.
- A terminal PASS embeds the full Integration attestation plus request ID, run ID, and attempt 1.
- Deleting the workflow run or any request/result/attestation comment cannot erase terminal PASS/failure; protected recovery recreates mirrors from durable evidence.
- If a run crossed the durable run-start boundary and later disappears before terminal publication, recovery fails closed to terminal failure after its grace period even if the `workflow_run` sealing consumer was cancelled or deleted.
- Only transport that never crossed run-start, or an actually observed cancellation/abortion, may recover with a **new request ID**. Deletion alone never means retry.

`fugue/integration = success` remains the GitHub branch-protection/UI signal but is not durable authority by itself.

## Final merge

Only ask after Fugue reconstructs a current exact-identity durable Integration PASS and current merge prerequisites. Re-fetch mutable PR/head state immediately before merging. Merge only after the Human says to merge.

## Local CLI

Local Fugue remains useful for bootstrap, status inspection, and protocol debugging. Canonical publication requires protected GitHub workflow identity, so a local user-token invocation must not be treated as authoritative mutation/recovery evidence.

## Replacement Leader

A replacement Leader can start with:

```text
Fugue Leader for OWNER/REPO. Reconstruct all current coordination state from GitHub and continue. Do not rely on prior chat memory.
```

No additional handoff packet is required.


## Canonical work-spec identity

Leader, Worker, and QA sessions use the exact work-spec digest carried by current Fugue evaluation/review-start evidence. The digest is computed by the repository's single canonical work-spec normalization/hash function; reviewers do not invent a parallel digest. D3 receipt comments remain presentation hints and must never be used to choose authority over the durable record ordering.
