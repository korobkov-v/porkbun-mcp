# Scenario Tools (Composite)

This file documents the higher-level tools that orchestrate multiple low-level Porkbun calls.

These tools are designed for common operator workflows, not one-off API probing.

## Global Rules

- `dry_run` should be `true` by default for mutating scenarios.
- Mutating execution requires write mode (`--get-muddy` or `PORKBUN_GET_MUDDY=true`).
- Every mutating tool should return a plan summary before returning apply results.
- Every destructive tool should include explicit `safety_level` and match counts.

## `dns_query`

Status:
- Implemented.

Purpose:
- One read tool for record lookup by either `record_id` or `(type, subdomain)`.

Why it exists:
- Replaces split decision between `dns_get` and `dns_get_by_name_type`.

Risk level:
- Low (read-only).

Suggested input:
- `domain` (string, required)
- `selector` (object, required)
- `selector.record_id` (string, optional)
- `selector.type` (string, optional)
- `selector.subdomain` (string, optional)

Rule:
- Accept exactly one selector strategy: `record_id` OR `type(+subdomain)`.

Output:
- `matches[]`, `count`, `selector_used`.

## `dns_upsert`

Status:
- Implemented.

Purpose:
- Ensure a DNS record exists in desired state (create if missing, edit if present).

Why it exists:
- Covers the most common “set this record correctly” operation.

Risk level:
- Medium (mutating).

Suggested input:
- `domain` (string, required)
- `match` (object, required)
- `match.type` (string, required)
- `match.subdomain` (string, optional)
- `target` (object, required)
- `target.content` (string, required)
- `target.ttl` (number, optional)
- `target.prio` (number, optional)
- `target.notes` (string, optional)
- `dry_run` (boolean, default `true`)

Output:
- `action` (`noop` | `create` | `edit`)
- `before`, `after`, `changes[]`.

Guardrails:
- If multiple records match and caller did not allow multi-edit, fail with guidance.

## `dns_remove`

Status:
- Implemented.

Purpose:
- Unified delete by either `record_id` or `(type, subdomain)`.

Why it exists:
- Removes ambiguous choice between two delete APIs.

Risk level:
- Medium-High (destructive).

Suggested input:
- `domain` (string, required)
- `selector` (object, required)
- `selector.record_id` OR `selector.type(+subdomain)`
- `max_delete` (number, default `1`)
- `dry_run` (boolean, default `true`)

Output:
- `planned_deletes`, `applied_deletes`, `matches`.

Guardrails:
- Hard fail if planned deletions exceed `max_delete`.

## `domain_redirect_ensure`

Status:
- Implemented.

Purpose:
- Converge URL forwarding rules to desired state.

Why it exists:
- “Make redirects correct” is a frequent admin task.

Risk level:
- Medium (mutating).

Suggested input:
- `domain` (string, required)
- `desired[]` (array of forward definitions, required)
- `strategy` (`merge` | `replace`, default `merge`)
- `confirm_replace` (required when strategy is `replace`)
- `dry_run` (boolean, default `true`)

Output:
- `to_add[]`, `to_keep[]`, `to_remove[]`, `summary`.

Guardrails:
- `replace` requires explicit confirmation flag to prevent accidental mass cleanup.

## `domain_cutover_web`

Status:
- Implemented.

Purpose:
- Guided cutover flow for moving web traffic to new target records.

Why it exists:
- Turns a manual DNS migration checklist into one repeatable operation.

Risk level:
- High (mutating, infra-sensitive).

Suggested input:
- `domain` (string, required)
- `target_records[]` (required)
- `pre_cutover_ttl` (number, optional)
- `verify` (boolean, default `true`)
- `allow_multi` (boolean, default `false`)
- `dry_run` (boolean, default `true`)

Output:
- `steps[]`, `planned_changes[]`, `verification[]`, `warnings[]`.

Guardrails:
- Should never hide propagation caveats.
- Must report that DNS propagation timing cannot be guaranteed by the tool.

## `domain_health_check`

Status:
- Implemented.

Purpose:
- Read-only diagnostic snapshot for domain configuration health.

Why it exists:
- Gives one report instead of several manual calls.

Risk level:
- Low (read-only).

Suggested input:
- `domain` (string, required)
- `checks` (array, optional): `ns`, `dns`, `dnssec`, `ssl`, `forwards`

Output:
- `checks[]` with per-check status/details
- `overall` (`ok` | `warning` | `error`)
- `recommendations[]`.

Guardrails:
- Avoid binary “healthy/unhealthy” without evidence lines.

## `dns_batch_apply`

Status:
- Implemented.

Purpose:
- Apply desired-state DNS changes in batch with explicit planning.

Why it exists:
- Best for migrations and large record sets.

Risk level:
- High (mutating, partial-failure risk).

Suggested input:
- `domain` (string, required)
- `desired_records[]` (required)
- `mode` (`plan` | `apply`, default `plan`)
- `strategy` (`merge` | `replace`, default `merge`)
- `max_changes` (number, optional safety limit)
- `confirm_apply` (required when mode is `apply`)

Output:
- `diff` (`create[]`, `edit[]`, `delete[]`, `noop[]`)
- `apply_results[]` (for apply mode)
- `failed[]`, `rollback_hints[]`.

Guardrails:
- Two-phase flow only: `plan` first, then `apply`.
- Fail if projected changes exceed `max_changes`.
