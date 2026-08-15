# Fugue

Fugue is a GitHub-backed coordination protocol and CLI for running multiple ChatGPT engineering sessions as a recoverable software team.

The core idea is simple: ChatGPT sessions are disposable; durable engineering state lives in GitHub and protected repository policy.

## Goals

- Coordinate a persistent Coordinator with task-scoped implementation Workers.
- Support independent Code, Security, and Visual/UX QA roles.
- Reconstruct active work after any chat/session disappears.
- Bind review evidence to exact Git commits and authoritative work specifications.
- Evaluate Integration against the current PR head, base, policy, protocol, and work specification.
- Keep candidate workflow changes from weakening their own review.
- Run final validation against an exact clean committed candidate.

## Early CLI surface

```bash
fugue status
fugue handoff worker --issue 123
fugue handoff worker --issue 123 --resume
fugue review 456 --role code --approve
fugue integrate 456
fugue doctor
```

Fugue is currently in bootstrap development. The first external project used to prove the protocol is [Path](https://github.com/JohnnyZLi/Path), an algorithm visualization playground.
