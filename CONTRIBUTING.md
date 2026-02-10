# Contributing to porkbun-mcp

Thanks for helping improve this project.

## Ground Rules

- Keep changes focused and minimal.
- Prefer safety over convenience for DNS and domain operations.
- Preserve read-only-by-default behavior.
- For mutating flows, keep explicit confirmation and guardrails.

## Local Setup

```bash
npm install
npm run build
```

Optional local run:

```bash
npm run dev
```

## Branches and Pull Requests

1. Create a branch from `main`.
2. Make small, reviewable commits.
3. Open a PR with:
   - problem statement
   - implementation summary
   - test plan
   - risk notes (especially for mutating tools)

## What to Include in Every PR

- Clear behavior change description.
- Updated docs for user-visible changes.
- Backward-compatibility notes if behavior changed.
- Examples for new MCP tools or new parameters.

## Safety Expectations

If your change affects writes (`dns_create`, `dns_edit`, `dns_delete`, scenario apply paths), verify:

- write mode gating still works
- dry-run behavior is preserved where expected
- max-change limits and confirmation flags remain explicit
- error porkbun-mcp-logomessages are operator-friendly

## Testing Checklist

Before opening a PR, run:

```bash
npm run build
npm pack --dry-run
```

If you changed tool semantics, also include manual test steps in the PR description:

- inputs used
- expected output shape
- failure/edge case checked

## Documentation

When adding or changing tools:

- update `README.md` (high-level usage)
- update `docs/scenario-tools.md` (detailed behavior and guardrails)

## Style Notes

- TypeScript strict mode is enabled; avoid `any`.
- Keep helper functions small and explicit.
- Prefer descriptive error messages over generic failures.

## Reporting Issues

When filing an issue, include:

- what you tried
- expected behavior
- actual behavior
- relevant tool input payload (redacted)
- environment details (Node version, MCP client)

## Security

- Do not commit secrets, API keys, or tokens.
- If you discover a credential leak in history, open a security issue immediately and rotate secrets.

## Code of Conduct

Be respectful and constructive.
