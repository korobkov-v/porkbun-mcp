# Dependency security review — 2026-10-31

Dependency review for version 0.4.0, including the card-payment implementation.

## Result

Full npm audit (production and development): 13 vulnerable packages before, 0 after.
Before: 1 critical, 9 high, 2 moderate, 1 low. These counts are affected packages,
not individual advisories. Zero audit findings does not prove absence of unknown vulnerabilities.

## Changes

Direct minimum versions: MCP SDK 1.32.2, Zod 4.6.7, tsx 4.23.15.
Transitive dependencies were updated within permitted ranges, without forced overrides.
Node requirement remains >=20.0.0.

| Package | Previous severity | Installed version |
|---|---|---|
| @hono/node-server | high | 2.1.5 |
| @modelcontextprotocol/sdk | high | 1.32.2 |
| ajv | moderate | 8.20.0 |
| body-parser | high | 2.4.0 |
| esbuild | low | 0.28.2 |
| express-rate-limit | high | 8.7.2 |
| fast-uri | high | 3.1.9 |
| hono | high | 4.13.14 |
| ip-address | high | 10.7.5 |
| path-to-regexp | high | 8.4.2 |
| proxy-addr | critical | 2.0.8 |
| qs | moderate | 6.17.1 |
| zod | high | 4.6.7 |

## Applicability and compatibility

The application exposes stdio only. HTTP proxy trust, HTTP server, OAuth client
and web middleware advisories do not by themselves demonstrate an exploitable path
in this runtime; those vulnerable packages have nevertheless been updated.
Zod collection validation is relevant to tool input validation. The esbuild finding
concerned a development server on Windows; the project does not expose that server.

Zod 4 is a major update. Existing schemas compile without changes. Regression tests
verify all 40 tools advertise strict schemas, nested unknown fields and oversized
bulk requests are rejected before HTTP, optional selectors still work, and unsafe
integers are rejected. See https://zod.dev/v4/changelog for migration semantics.

## Validation

- Clean installation using npm ci --ignore-scripts.
- TypeScript build and all 33 tests pass, including card payment security tests.
- Full npm audit: 0 findings after clean install.
- npm pack --dry-run and git diff --check pass.
- No live DNS changes or payments were used in validation.

Audit source: npm registry advisory database via npm audit, checked 2026-10-31.
Re-run npm audit before any future release because advisories can change.
