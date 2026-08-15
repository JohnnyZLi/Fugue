# Fugue Protocol v0.1

This document is the compact implementation reference for Fugue v0.1. The protocol exists so multiple replaceable ChatGPT engineering sessions can behave like a coordinated software team without relying on one conversation's memory.

## Durable model

```text
GitHub
  = durable operational state

protected-base AGENTS.md
  = repository baseline + invariants

protected-base .fugue/config.yml
  = workflow policy

protected-base .fugue/VERSION
  = protocol compatibility declaration

Fugue CLI
  = protocol implementation

ChatGPT sessions
  = replaceable execution contexts
```

No critical operational state may live only in chat history, hidden reasoning, terminal output, or an uncommitted local file.

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
fugue/integration PASS
  ↓
Human merge
```

The Coordinator owns decomposition and allocation. Each Worker owns one bounded issue. QA sessions independently reconstruct and review the durable state. Integration is a system gate rather than another generic code review.

## Work identity

Every managed issue has a stable `work_id` and machine metadata split into two classes:

```yaml
spec:
  dependencies: []
  ownership: {}
  qa: {}
  authorized_changes: {}

execution:
  worker_id: wkr-...
  branch: agent/123-example
```

Specification metadata affects the work-spec digest. Execution bookkeeping does not.

A changed requirement invalidates review. A replacement chat resuming the same Worker claim does not.

## Worker claims and replacement chats

Normal allocation:

```bash
fugue handoff worker --issue 123
```

creates a new Worker claim only when the issue is eligible and unclaimed.

Replacement session:

```bash
fugue handoff worker --issue 123 --resume
```

reconstructs the existing `work_id`, `worker_id`, branch, PR, current head, QA findings, and next action. `--resume` does not create a second claim.

This distinction is fundamental: chat death replaces an execution context, not the durable Worker identity.

## Issue states

Open implementation issues use exactly one of:

```text
state:ready
state:working
state:blocked
```

Review/integration state is derived from the PR and current attestations/statuses rather than duplicated into another issue label.

## Control plane

Typical control-plane paths:

```text
AGENTS.md
.fugue/**
.github/workflows/**
.github/ISSUE_TEMPLATE/**
.github/pull_request_template.md
```

For a PR under review:

```text
protected-base control plane
  = active policy

candidate control-plane changes
  = proposed future policy only
```

A PR may not weaken the rules used to evaluate itself.

Control-plane changes require Code QA, Security QA, and current head-bound Human acknowledgement.

## AGENTS semantics

Protected-base `AGENTS.md` contains both baseline repository truth and invariants.

A candidate may update baseline truth to describe the intended post-merge architecture. Existing invariants may change only when the authoritative work specification explicitly authorizes that change.

## QA resolution

Required QA is recomputed from the actual PR changes:

```text
base-policy changed-file analysis
UNION
explicit additive issue requirements
UNION
control-plane requirements
UNION
validation-control requirements
```

Explicit metadata may add QA but may not remove policy-required QA.

## Validation-control changes

Protected-base policy chooses validation commands, but candidate files can alter what those commands execute. Repositories therefore declare validation-control paths such as:

```text
package.json
package-lock.json
scripts/**
Makefile
*.csproj
pyproject.toml
vitest.config.*
```

Reviewers explicitly assess whether such changes weaken or bypass validation.

## QA evidence

Reserved commit-status contexts:

```text
fugue/code-qa
fugue/security-qa
fugue/visual-qa
fugue/integration
```

Statuses are small verdicts. Structured PR attestations hold durable evidence.

Review evidence binds to the current evaluation identity, including at least:

```text
role
PR
head SHA
policy digest
protocol version
work-spec digest
verdict
```

A new head or changed work specification makes old evidence stale.

## Integration identity

Integration evaluates a captured snapshot:

```text
PR
+ head SHA
+ base SHA
+ policy digest
+ protocol version
+ work-spec digest
```

Integration must never trust the caller's current working directory.

It creates a clean detached worktree at the exact captured head, runs protected-base-selected validation there, verifies required external CI, and performs a final snapshot recheck before publishing success.

If head, base, policy, protocol, or work spec changes during Integration, no PASS is published.

## Dependencies

Dependencies are machine-readable and must form an acyclic graph.

A dependent PR may be implemented early when the Coordinator explicitly permits it, but final Integration may not PASS until declared dependencies are satisfied.

v0.1 does not synthesize multi-PR merge trees.

## Metadata drift

Metadata describes intended workflow relationships. Live GitHub resources describe actual resource state.

When they conflict:

```text
live GitHub wins
+ Fugue reports STATE DRIFT
+ Coordinator repairs metadata
```

Fugue must not silently guess.

## Required QA that cannot run

A required QA role is never silently downgraded because the current environment cannot execute it.

The workflow must either provide a suitable environment, route the same required review to an authorized Human capable of producing a current attestation, or remain blocked.

## Enforced and Advisory modes

ENFORCED means GitHub repository rules actually require the composite Fugue Integration gate and current-base behavior for the normal merging identity.

ADVISORY means Fugue computes the same engineering state but GitHub does not technically prevent bypass.

The two modes must never be presented as equivalent.

## Bootstrap trust root

The first install is a special case:

```text
Human reviews initial Fugue control plane
→ baseline merges
→ status namespace/rules configured
→ fugue doctor verifies setup
→ repository becomes ENFORCED or ADVISORY
```

Subsequent control-plane changes are evaluated under the prior protected-base policy.

## Emergency path

Normal `fugue/integration = success` always means all required normal gates passed.

Emergency bypass is a separate Human-only, head/base/policy/spec-bound authorization with a durable audit record and mandatory post-merge verification work. It never produces a fake normal PASS.

## Core command surface

```bash
fugue status
fugue validate

fugue handoff coordinator
fugue handoff worker --issue <n>
fugue handoff worker --issue <n> --resume
fugue handoff code-qa --pr <n>
fugue handoff security-qa --pr <n>
fugue handoff visual-qa --pr <n>
fugue handoff integration --pr <n>

fugue review <pr> --role code --approve|--changes-requested
fugue review <pr> --role security --approve|--changes-requested
fugue review <pr> --role visual --approve|--changes-requested

fugue acknowledge <pr> --control-plane
fugue integrate <pr>

fugue doctor
fugue sync
fugue init
```

## v0.1 implementation order

Build the protocol before convenience automation:

1. CLI/config/schema foundation.
2. Protected-base policy/protocol resolution.
3. Policy and work-spec digesting.
4. Clean worktree utility.
5. Work/PR metadata schemas.
6. GitHub issue/PR/status/comment layer.
7. Issue state and Worker claim logic.
8. Metadata/live-state drift detection.
9. Handoff generation, including `--resume`.
10. `fugue status` reconstruction.
11. Changed-file QA and validation-control resolver.
12. Structured attestations and current-evidence selection.
13. SHA/spec-bound `fugue review`.
14. Dependency/cycle checks.
15. AGENTS/control-plane attestations.
16. Base-current detection.
17. Integration snapshot + clean validation + final race recheck.
18. `fugue integrate`.
19. Use Path as the first real governed repository.
20. Only after the protocol survives real work: `doctor`, `sync`, stack detection, and `init` automation.

## Non-goals for v0.1

Do not build automatic ChatGPT session creation, autonomous scheduling, automatic merging, distributed locks, a web dashboard, an MCP server, a vector database, hostile-PR sandboxing, or multi-repo orchestration yet.

The protocol/state engine is the product. Automation comes later.
