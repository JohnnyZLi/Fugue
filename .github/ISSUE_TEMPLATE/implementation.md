---
name: Fugue implementation work
about: Bounded implementation work coordinated through Fugue
title: ""
labels: "state:ready,agent:ready"
assignees: "JohnnyZLi"
---

> Coordinator: after GitHub assigns the issue number, replace `work-ISSUE_NUMBER` in the machine block before Worker allocation. Fill ownership, dependencies, and additive QA intentionally.

## Outcome

What must be observably true when this work is complete?

## Context

Why does this work exist?

## Scope

What should change?

## Ownership

### Owned

Paths/components this issue may change without additional coordination.

### Coordinate Before Modifying

Shared paths requiring Coordinator action before editing.

### Do Not Touch

Explicit exclusions.

## Constraints

Protocol, architecture, security, compatibility, or implementation constraints.

## Acceptance Criteria

- [ ] Observable completion condition.

## Validation

Expected tests, builds, runtime checks, or other verification.

## Required QA

Explicit additive QA only. Protected-base policy and changed files may require more.

## Dependencies

Issues that must be satisfied before final Integration.

## Authorized Invariant Changes

List any `AGENTS.md` invariant explicitly authorized to change. Otherwise: None.

## Repository Documentation Impact

Describe expected `AGENTS.md` impact, if any.

## Notes

Additional durable context.

<!-- fugue-work
version: 1
work_id: work-ISSUE_NUMBER
spec:
  dependencies: []
  ownership:
    owned: []
    coordinate: []
    forbidden: []
  qa:
    force: []
  authorized_changes:
    agents_invariants: []
execution: {}
-->
