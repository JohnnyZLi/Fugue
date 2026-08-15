# Autonomous Coordination

Fugue's low-level `handoff`, `review`, and `integrate` commands remain recovery and debugging primitives. Normal coordination should use the workflow planner instead of requiring a human to choose every transition.

## One-shot orchestration

`fugue advance` reconstructs durable GitHub state, derives the next valid action, performs deterministic transitions, and stops at an external or human boundary.

```bash
fugue advance
fugue advance --issue 12
fugue advance --pr 18
fugue advance --issue 12 --dry-run
```

The planner derives states rather than adding more issue labels. Typical transitions are:

```text
ready + unclaimed
  -> allocate Worker

claimed + no PR
  -> wait for Worker execution

PR + required QA missing
  -> create the missing QA review sessions

QA changes requested
  -> resume the existing Worker identity

all required QA approved
  -> run Integration

current Integration PASS
  -> ready for human merge
```

Repository drift, QA errors, failed Integration, explicit blocks, and control-plane acknowledgements stop automatic progress and surface the reason.

## Executors

Workflow planning does not depend on a particular agent runtime. The initial executor is `manual-chat`, which emits a compact prompt that tells a fresh ChatGPT session to reconstruct its Worker or QA assignment from GitHub.

Future executors can launch Codex/API agents without changing workflow planning semantics.

## Restart safety

`advance` has no hidden workflow database. A crash or replacement Coordinator simply runs it again. The next action is always recomputed from protected-base policy, GitHub issues/PRs, exact-head attestations, and commit statuses.

## QA session idempotence

Starting the same QA role twice for the same evaluation identity no longer creates another active session. Fugue reuses the existing pending review session. A current completed verdict also prevents an unnecessary same-identity handoff.

## Current boundary

This slice does not launch ChatGPT UI tabs or merge PRs. External execution and final merge remain explicit boundaries. A future `run` loop and launchable executor can automate those remaining transitions while using the same planner.
