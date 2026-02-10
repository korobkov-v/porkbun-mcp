# porkbun-mcp

An MCP server for Porkbun that runs in a Node.js world (`npx`), not `uvx`.

No magic. No hidden sync jobs. Just API calls to Porkbun for domains, DNS, DNSSEC, SSL, and pricing.

## What This Project Is

- A practical port of [`major/porkbun-mcp`](https://github.com/major/porkbun-mcp)
- Same goal: let AI tools operate your Porkbun account through MCP
- Different runtime: `npx porkbun-mcp`

## Quick Start

```bash
npm install
npm run build
```

Run in read-only mode (default behavior):

```bash
PORKBUN_API_KEY=your_key \
PORKBUN_SECRET_KEY=your_secret \
node dist/index.js
```

Enable write operations:

```bash
PORKBUN_API_KEY=your_key \
PORKBUN_SECRET_KEY=your_secret \
PORKBUN_GET_MUDDY=true \
node dist/index.js --get-muddy
```

## MCP Client Config (`npx`)

```json
{
  "mcpServers": {
    "porkbun-mcp": {
      "command": "npx",
      "args": ["-y", "porkbun-mcp"],
      "env": {
        "PORKBUN_API_KEY": "your_porkbun_api_key",
        "PORKBUN_SECRET_KEY": "your_porkbun_secret_api_key"
      }
    }
  }
}
```

## NOTE

Porkbun API keys are account-level, but domain actions still depend on each domain's API access setting in Porkbun.  
If a domain is set to no API access, write calls will fail even if your keys are valid.

## WARNING

Write mode is intentionally not default.  
If you enable `--get-muddy`, treat your MCP client as production access to DNS and domain settings.

## Environment Variables

- `PORKBUN_API_KEY` (required)
- `PORKBUN_SECRET_KEY` (required)
- `PORKBUN_GET_MUDDY` (optional)
- `PORKBUN_API_BASE_URL` (optional)

## CLI Options

- `--get-muddy`
- `--transport stdio`
- `--api-base-url <url>`
- `--ipv4-only-api`
- `--help`

## Tool Coverage

- Connectivity and account: `ping`, `pricing_get`
- Domains: list, nameservers, URL forwarding, glue, availability
- DNS records: list/get/create/edit/delete (including by name/type helpers)
- DNSSEC: list/create/delete
- SSL: retrieve certificate bundle

## Scenario Tool Profiles

Separate documentation for higher-level workflow tools:

Implemented now:
- `dns_query`
- `dns_upsert`
- `domain_health_check`
- `dns_remove`
- `domain_redirect_ensure`
- `domain_cutover_web`
- `dns_batch_apply`

See: [`docs/scenario-tools.md`](docs/scenario-tools.md)

## Scenario Tool Examples

The examples below show tool input payloads.

`dns_query` by record id:

```json
{
  "domain": "example.com",
  "selector": {
    "record_id": "123456789"
  }
}
```

`dns_query` by type/subdomain:

```json
{
  "domain": "example.com",
  "selector": {
    "type": "A",
    "subdomain": "www"
  }
}
```

`dns_upsert` plan-only:

```json
{
  "domain": "example.com",
  "match": {
    "type": "A",
    "subdomain": "www"
  },
  "target": {
    "content": "203.0.113.10",
    "ttl": 300
  },
  "dry_run": true
}
```

`dns_remove` with deletion limit:

```json
{
  "domain": "example.com",
  "selector": {
    "type": "TXT",
    "subdomain": "_acme-challenge"
  },
  "max_delete": 2,
  "dry_run": true
}
```

`domain_health_check` targeted checks:

```json
{
  "domain": "example.com",
  "checks": ["dns", "dnssec", "ssl"]
}
```

`domain_redirect_ensure` merge mode:

```json
{
  "domain": "example.com",
  "desired": [
    {
      "subdomain": "",
      "location": "https://www.example.com",
      "type": "permanent",
      "include_path": true
    }
  ],
  "strategy": "merge",
  "dry_run": true
}
```

`domain_redirect_ensure` replace mode (apply):

```json
{
  "domain": "example.com",
  "desired": [
    {
      "subdomain": "",
      "location": "https://www.example.com",
      "type": "permanent",
      "include_path": true
    }
  ],
  "strategy": "replace",
  "confirm_replace": true,
  "dry_run": false
}
```

`domain_cutover_web` pre-cutover plan:

```json
{
  "domain": "example.com",
  "target_records": [
    {
      "type": "A",
      "subdomain": "",
      "content": "198.51.100.42"
    },
    {
      "type": "CNAME",
      "subdomain": "www",
      "content": "example.com"
    }
  ],
  "pre_cutover_ttl": 300,
  "verify": true,
  "dry_run": true
}
```

`dns_batch_apply` plan:

```json
{
  "domain": "example.com",
  "desired_records": [
    {
      "type": "A",
      "subdomain": "",
      "content": "198.51.100.42",
      "ttl": 300
    },
    {
      "type": "CNAME",
      "subdomain": "www",
      "content": "example.com",
      "ttl": 300
    }
  ],
  "mode": "plan",
  "strategy": "merge",
  "max_changes": 10
}
```

`dns_batch_apply` execute:

```json
{
  "domain": "example.com",
  "desired_records": [
    {
      "type": "A",
      "subdomain": "",
      "content": "198.51.100.42",
      "ttl": 300
    }
  ],
  "mode": "apply",
  "strategy": "merge",
  "confirm_apply": true,
  "max_changes": 5
}
```

## Why The Tone Is Different

Porkbun docs are direct and operator-focused: short steps, explicit notes/warnings, and minimal ceremony.  
This README follows that same pattern so setup is obvious and mistakes are harder to make.
