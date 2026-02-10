# Changelog

All notable changes to this project are documented in this file.

## 0.3.0 - 2026-02-10

### Added

- Scenario tools: `dns_query`, `dns_upsert`, `dns_remove`, `domain_health_check`, `domain_redirect_ensure`, `domain_cutover_web`, `dns_batch_apply`.
- DNS and forwarding normalization helpers for stable matching/diff behavior.
- `docs/scenario-tools.md` with per-tool intent, risk level, inputs, outputs, and guardrails.
- README examples for all scenario tools.

### Changed

- Project version updated to `0.3.0`.
- README reorganized to separate core API tools and scenario tool workflows.
- Safety defaults for mutating workflows: `dry_run` defaults, explicit confirmation flags (`confirm_replace`, `confirm_apply`), and projected change limits (`max_delete`, `max_changes`).

### Notes

- Runtime remains `npx`/Node.js-first and MCP `stdio` transport.
- Write operations still require `--get-muddy` or `PORKBUN_GET_MUDDY=true`.
