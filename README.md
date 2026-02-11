# porkbun-mcp

![porkbun-mcp logo](./porkbun-mcp_logo.png)

MCP server for Porkbun domains and DNS.

Use it from any MCP-compatible client to inspect and manage:
- domains and nameservers
- DNS records
- DNSSEC
- SSL certificate bundle
- URL forwarding

Built for safe operations:
- read-only behavior by default
- mutating tools require explicit write mode
- scenario tools default to `dry_run: true`

## Why This Exists

Porkbun operations are often repetitive and risky under time pressure.
This project exposes Porkbun APIs as MCP tools so AI assistants can execute domain workflows consistently and with guardrails.

## 3-Minute Setup

### 1) Prerequisites

- Node.js `>=20`
- Porkbun API credentials:
  - `PORKBUN_API_KEY`
  - `PORKBUN_SECRET_KEY`
- In Porkbun panel, the target domain must be marked as API accessible ("available via API").
  Account-level keys are not enough if domain-level API access is disabled.

Where to get the keys:
- Log in to Porkbun.
- Open account settings and go to API Access.
- Generate/copy:
  - `PORKBUN_API_KEY` (API Key)
  - `PORKBUN_SECRET_KEY` (Secret API Key)
- In the domain settings, ensure API access is enabled for each domain you want to manage.

Install dependencies locally (for development):

```bash
npm install
npm run build
```

### 2) Quick local run (stdio)

Read-only mode:

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

### 3) Verify CLI wiring

```bash
node dist/index.js --help
```

## MCP Client Config (npx)

Use this in your MCP client config:

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

Write mode with `npx`:

```json
{
  "mcpServers": {
    "porkbun-mcp": {
      "command": "npx",
      "args": ["-y", "porkbun-mcp", "--get-muddy"],
      "env": {
        "PORKBUN_API_KEY": "your_porkbun_api_key",
        "PORKBUN_SECRET_KEY": "your_porkbun_secret_api_key"
      }
    }
  }
}
```

Domain create enabled (dangerous):

```json
{
  "mcpServers": {
    "porkbun-mcp": {
      "command": "npx",
      "args": ["-y", "porkbun-mcp", "--get-muddy", "--enable-domain-create"],
      "env": {
        "PORKBUN_API_KEY": "your_porkbun_api_key",
        "PORKBUN_SECRET_KEY": "your_porkbun_secret_api_key"
      }
    }
  }
}
```

## First Successful Call

Once configured in your MCP client, start with:
- `ping`
- `pricing_get`

Then try one read flow:
- `dns_list` for your domain

Before any write call, run a scenario tool in `dry_run` mode first.

## Safety Model

- Write actions are blocked unless `--get-muddy` or `PORKBUN_GET_MUDDY=true` is set.
- Scenario tools are designed to plan before apply.
- Destructive tools include explicit limits and confirmations.
- API credentials are account-level. Domain-level API permissions in Porkbun still apply.
- Domain registration (`domains_create`) is disabled by default. It requires:
  - write mode (`--get-muddy`)
  - explicit enable flag (`--enable-domain-create` or `PORKBUN_ENABLE_DOMAIN_CREATE=true`)
  - `dry_run=false` + `confirm_apply=true` + `agree_to_terms=true`

## Environment Variables

- `PORKBUN_API_KEY` (required)
- `PORKBUN_SECRET_KEY` (required)
- `PORKBUN_GET_MUDDY` (optional)
- `PORKBUN_ENABLE_DOMAIN_CREATE` (optional, dangerous)

## CLI Options

- `--get-muddy`
- `--enable-domain-create` (dangerous)
- `--transport stdio`
- `--ipv4-only-api`
- `--help`

## What `--get-muddy` Means

`--get-muddy` enables write mode.

Without it, the server stays in safe read-only behavior.
With it, mutating tools are allowed (create/edit/delete/update operations for DNS and domain settings).

Use this mode only when:
- you are ready to apply real infrastructure changes
- your domain is API-enabled in Porkbun
- you have already validated the plan with read calls or `dry_run` flows

## Tool Coverage

- Connectivity: `ping`, `pricing_get`
- Domains: list, nameservers, URL forwarding, glue records (get/create/update/delete), availability
- DNS: list/get/create/edit/delete (including by name/type)
- DNSSEC: list/create/delete
- SSL: certificate bundle retrieval

Scenario tools:
- `dns_query`
- `dns_upsert`
- `domain_health_check`
- `dns_remove`
- `domain_redirect_ensure`
- `domain_cutover_web`
- `dns_batch_apply`

Beginner helpers:
- `dns_audit`
- `dns_setup`
- `email_dns_setup`
- `update_server_ip`
- `subdomain_setup`

Detailed docs: [`docs/scenario-tools.md`](docs/scenario-tools.md)

## Practical Examples

`dns_query` by record id:

```json
{
  "domain": "example.com",
  "selector": {
    "record_id": "123456789"
  }
}
```

`dns_upsert` plan mode:

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
    }
  ],
  "mode": "plan",
  "strategy": "merge",
  "max_changes": 5
}
```

## Security Notes

- Never commit real API keys to git.
- Prefer local environment variables or a secret manager.
- Treat write mode as production access.

## Development

```bash
npm install
npm run build
```

Run locally:

```bash
npm run dev
```

## Contributing

Contributions are welcome.
Read [`CONTRIBUTING.md`](CONTRIBUTING.md) before opening a PR.

## License

MIT
