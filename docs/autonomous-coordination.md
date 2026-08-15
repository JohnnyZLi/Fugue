# Autonomous Coordination

Fugue's low-level `handoff`, `review`, and `integrate` commands remain recovery and debugging primitives. Normal coordination uses the workflow planner instead of requiring a human to choose every transition.

## Foreground orchestration

`fugue run` is the normal interactive control loop. It continuously reconstructs GitHub state, performs deterministic transitions, and watches for Worker/QA results. It only prints a new external or Human instruction when that required action changes.

```bash
fugue run
fugue run --issue 12
fugue run --pr 18
fugue run --issue 12 --interval 10
```

The process is deliberately foreground and disposable. `Ctrl-C` is safe: restarting `fugue run` reconstructs workflow state from GitHub rather than relying on a local database.

With the current `manual-chat` executor, the loop still cannot create ChatGPT tabs itself. It prints one compact reconstruction prompt when a Worker or QA session is needed, then keeps watching GitHub while that external session works. When QA becomes current and approved, the same running process can promote a draft PR, run Integration, and report merge readiness without another command from the user.

## One-shot orchestration

`fugue advance` uses the same planner for a single coordination pass. It is useful for scripting, debugging, and explicit control:

```bash
fugue advance
fugue advance --issue 12
fugue advance --pr 18
fugue advance --issue 12 --dry-run
```

One invocation chains deterministic transitions until it reaches an external or Human boundary.

## Derived workflow

The planner derives states rather than adding more issue labels. Typical transitions are:

```text
ready + unclaimed
  -> allocate Worker

claimed + no PR
  -> wait for Worker execution

PR + required QA missing
  -> create missing QA review sessions

QA changes requested
  -> resume the existing Worker identity

all required QA approved + draft PR
  -> mark PR ready for review

all required QA approved + ready PR
  -> run Integration

current Integration PASS
  -> ready for human merge
```

Repository drift, QA errors, failed Integration, explicit blocks, and control-plane acknowledgements remain intervention boundaries.

## Executors

Workflow planning does not depend on a particular agent runtime. The initial executor is `manual-chat`, which emits a compact prompt that tells a fresh ChatGPT session to reconstruct its Worker or QA assignment from GitHub.

Future Codex/API executors can launch agents directly without changing workflow planning semantics. When such an executor is configured, the `run` loop can cross the current external-session boundary itself.

## Restart safety

Neither `advance` nor `run` owns durable workflow truth. A crash or replacement Coordinator simply starts again. The next action is recomputed from protected-base policy, GitHub issues/PRs, exact-head attestations, and commit statuses.

The `run` process keeps only a small in-memory notification fingerprint so it does not repeat the same prompt every poll. Losing that cache can repeat a message after restart, but cannot change workflow correctness.

## QA session idempotence

Starting the same QA role twice for the same evaluation identity no longer creates another ambiguous active session. Fugue reuses the latest pending session. If a newer session is explicitly created after a completed verdict, chronology determines which session is active; older orphaned starts are reported as superseded rather than becoming active again.

## Current boundary

This slice still does not launch ChatGPT UI tabs or auto-merge final PRs. Those remain explicit boundaries. The executor abstraction is the seam for removing the tab-creation boundary later, while final merge remains Human-controlled by design.
