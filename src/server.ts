import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { domainToASCII } from "node:url";

import type { RuntimeConfig } from "./config.js";
import { PorkbunClient } from "./porkbun-client.js";
import {
  extractDnsRecords,
  recordsEqual,
  type PorkbunDnsRecord,
} from "./porkbun-types.js";
import { errorResult, successResult } from "./result.js";

type HealthCheckStatus = "ok" | "warning" | "error";
type HealthCheckName = "ns" | "dns" | "dnssec" | "ssl" | "forwards";
type DnsBatchMode = "plan" | "apply";
type ReconcileStrategy = "merge" | "replace";
const DOMAINS_LIST_PAGE_SIZE = 1000;
const DOMAINS_LIST_MAX_PAGES = 100;
const DOMAINS_BULK_CHECK_MAX = 100;
const DOMAINS_BULK_CHECK_FALLBACK_DELAY_MS = 11_000;

export function createPorkbunServer(config: RuntimeConfig): McpServer {
  const server = new McpServer({
    name: "porkbun-mcp",
    version: "0.3.3",
  });

  const client = new PorkbunClient({
    apiKey: config.apiKey,
    secretKey: config.secretKey,
    baseUrl: config.baseUrl,
  });

  const ensureWritable = (toolName: string): void => {
    if (!config.getMuddy) {
      throw new Error(
        `${toolName} is disabled in read-only mode. Set PORKBUN_GET_MUDDY=true or pass --get-muddy.`,
      );
    }
  };

  const ensureDomainCreateEnabled = (): void => {
    if (!config.enableDomainCreate) {
      throw new Error(
        'domains_create is disabled by default. Enable it with PORKBUN_ENABLE_DOMAIN_CREATE=true or pass --enable-domain-create.',
      );
    }
  };

  const wrap =
    <TArgs extends Record<string, unknown>>(
      handler: (args: TArgs) => Promise<unknown>,
    ) =>
    async (args: TArgs) => {
      try {
        const maybeDomain = args.domain;
        if (typeof maybeDomain === "string") {
          assertValidDomain(maybeDomain);
        }
        const data = await handler(args);
        return successResult(data);
      } catch (error) {
        return errorResult(error);
      }
    };

  server.tool("ping", {}, wrap(async () => client.ping()));

  server.tool(
    "pricing_get",
    {},
    wrap(async () => client.pricingGet()),
  );

  server.tool(
    "domains_list",
    {
      start: z.number().int().nonnegative().optional(),
      include_labels: z.boolean().optional(),
      fetch_all: z.boolean().optional(),
    },
    wrap(async (args) => {
      const fetchAll = args.fetch_all ?? true;
      const start = args.start ?? 0;
      const includeLabels = args.include_labels;

      if (!fetchAll) {
        return client.domainsListAll(start, includeLabels);
      }

      const allDomains: unknown[] = [];
      let cursor = start;
      for (let pageIndex = 0; pageIndex < DOMAINS_LIST_MAX_PAGES; pageIndex += 1) {
        const page = await client.domainsListAll(cursor, includeLabels);
        const domains = Array.isArray(page.domains) ? page.domains : [];
        allDomains.push(...domains);
        if (domains.length < DOMAINS_LIST_PAGE_SIZE) {
          break;
        }
        cursor += DOMAINS_LIST_PAGE_SIZE;
        if (pageIndex === DOMAINS_LIST_MAX_PAGES - 1) {
          throw new Error(
            `domains_list hit safety limit of ${DOMAINS_LIST_MAX_PAGES} pages.`,
          );
        }
      }

      return {
        status: "SUCCESS",
        start,
        fetchedAll: true,
        count: allDomains.length,
        domains: allDomains,
      };
    }),
  );

  server.tool(
    "domains_get_nameservers",
    {
      domain: z.string().min(1),
    },
    wrap(async (args) => client.domainsGetNameservers(args.domain)),
  );

  server.tool(
    "domains_update_nameservers",
    {
      domain: z.string().min(1),
      nameservers: z.array(z.string().min(1)).min(1),
    },
    wrap(async (args) => {
      ensureWritable("domains_update_nameservers");
      return client.domainsUpdateNameservers(args.domain, args.nameservers);
    }),
  );

  server.tool(
    "domains_get_url_forwards",
    {
      domain: z.string().min(1),
    },
    wrap(async (args) => client.domainsGetUrlForwards(args.domain)),
  );

  server.tool(
    "domains_add_url_forward",
    {
      domain: z.string().min(1),
      location: z.string().min(1),
      subdomain: z.string().optional(),
      type: z.enum(["temporary", "permanent"]).optional(),
      include_path: z.boolean().optional(),
      wildcard: z.boolean().optional(),
    },
    wrap(async (args) => {
      ensureWritable("domains_add_url_forward");
      return client.domainsAddUrlForward({
        domain: args.domain,
        subdomain: args.subdomain,
        location: args.location,
        type: args.type,
        includePath: args.include_path,
        wildcard: args.wildcard,
      });
    }),
  );

  server.tool(
    "domains_delete_url_forward",
    {
      domain: z.string().min(1),
      record_id: z.string().min(1),
    },
    wrap(async (args) => {
      ensureWritable("domains_delete_url_forward");
      return client.domainsDeleteUrlForward(args.domain, args.record_id);
    }),
  );

  server.tool(
    "domains_check_availability",
    {
      domain: z.string().min(1),
    },
    wrap(async (args) => client.domainsCheckAvailability(args.domain)),
  );

  server.tool(
    "domains_check_bulk",
    {
      domains: z.array(z.string().min(1)).min(1).max(DOMAINS_BULK_CHECK_MAX),
      concurrency: z.number().int().positive().max(10).optional(),
      delay_ms: z.number().int().nonnegative().max(60_000).optional(),
      respect_limits: z.boolean().optional(),
      stop_on_error: z.boolean().optional(),
      stop_on_rate_limit: z.boolean().optional(),
    },
    wrap(async (args) => {
      const concurrency = args.concurrency ?? 1;
      const delayMs = args.delay_ms ?? DOMAINS_BULK_CHECK_FALLBACK_DELAY_MS;
      const respectLimits = args.respect_limits ?? true;
      const stopOnError = args.stop_on_error ?? false;
      const stopOnRateLimit = args.stop_on_rate_limit ?? true;

      const domains = args.domains.map((d) => d.trim()).filter((d) => d.length > 0);
      if (domains.length === 0) {
        throw new Error("domains_check_bulk requires at least one non-empty domain.");
      }
      if (domains.length > DOMAINS_BULK_CHECK_MAX) {
        throw new Error(
          `domains_check_bulk supports up to ${DOMAINS_BULK_CHECK_MAX} domains per call.`,
        );
      }

      // Validate all domains upfront so we fail fast on obvious input issues.
      for (const domain of domains) {
        assertValidDomain(domain);
      }

      const items = domains.map((domain) => ({ domain }));
      const resultsByIndex: Array<
        | {
        domain: string;
        ok: boolean;
        error?: string;
        response?: unknown;
          }
        | undefined
      > = new Array(items.length).fill(undefined);

      let aborted = false;
      let nextIndex = 0;

      const isRateLimitError = (message: string): boolean => {
        const m = message.toLowerCase();
        return m.includes("rate") && m.includes("limit");
      };

      const readLimitTtlMs = (payload: unknown): number | null => {
        if (!isRecord(payload) || !isRecord(payload.limits)) {
          return null;
        }
        const ttlRaw = payload.limits.TTL;
        const seconds =
          typeof ttlRaw === "number"
            ? ttlRaw
            : typeof ttlRaw === "string"
              ? Number(ttlRaw)
              : NaN;
        if (!Number.isFinite(seconds) || seconds <= 0) {
          return null;
        }
        // Cap to avoid extremely long sleeps on malformed payloads.
        return Math.min(Math.floor(seconds * 1000), 60_000);
      };

      const sleep = async (ms: number): Promise<void> =>
        new Promise((resolve) => setTimeout(resolve, ms));

      const worker = async (): Promise<void> => {
        for (;;) {
          if (aborted) return;
          const index = nextIndex;
          nextIndex += 1;
          if (index >= items.length) return;

          const domain = items[index].domain;
          try {
            const response = await client.domainsCheckAvailability(domain);
            resultsByIndex[index] = { domain, ok: true, response };

            // Respect server-provided rate limit hints when available.
            if (respectLimits) {
              const limitDelay = readLimitTtlMs(response);
              if (limitDelay !== null && limitDelay > 0) {
                await sleep(limitDelay);
                continue;
              }
            }
          } catch (error) {
            const message = toMessage(error);
            resultsByIndex[index] = { domain, ok: false, error: message };

            if (stopOnRateLimit && isRateLimitError(message)) {
              aborted = true;
              return;
            }
            if (stopOnError) {
              aborted = true;
              return;
            }
          }

          if (delayMs > 0) {
            await sleep(delayMs);
          }
        }
      };

      const workers = Array.from({ length: Math.min(concurrency, items.length) }, () =>
        worker(),
      );
      await Promise.all(workers);

      const results = resultsByIndex.filter(
        (item): item is NonNullable<(typeof resultsByIndex)[number]> => item !== undefined,
      );
      const okCount = results.filter((r) => r.ok).length;
      const errorCount = results.length - okCount;

      return {
        status: "SUCCESS",
        count: domains.length,
        concurrency,
        delay_ms: delayMs,
        respect_limits: respectLimits,
        stop_on_error: stopOnError,
        stop_on_rate_limit: stopOnRateLimit,
        completed: results.length,
        ok: okCount,
        errors: errorCount,
        aborted,
        results,
      };
    }),
  );

  server.tool(
    "domains_update_auto_renew",
    {
      status: z.enum(["on", "off"]),
      domain: z.string().min(1).optional(),
      domains: z.array(z.string().min(1)).min(1).optional(),
      dry_run: z.boolean().optional(),
      confirm_apply: z.boolean().optional(),
    },
    wrap(async (args) => {
      ensureWritable("domains_update_auto_renew");

      const dryRun = args.dry_run ?? true;
      if (!dryRun && !args.confirm_apply) {
        throw new Error(
          "domains_update_auto_renew dry_run=false requires confirm_apply=true.",
        );
      }

      const hasDomain = typeof args.domain === "string" && args.domain.trim().length > 0;
      const hasDomains = Array.isArray(args.domains) && args.domains.length > 0;
      if (!hasDomain && !hasDomains) {
        throw new Error("domains_update_auto_renew requires domain or domains[].");
      }

      const plan = {
        status: "SUCCESS",
        dry_run: dryRun,
        action: "update_auto_renew",
        desired: {
          status: args.status,
          domain: args.domain,
          domains: args.domains,
        },
        note:
          "This tool does not fetch current auto-renew state. It issues an update request to Porkbun.",
      };

      if (dryRun) {
        return plan;
      }

      const response = await client.domainsUpdateAutoRenew({
        status: args.status,
        domain: args.domain,
        domains: args.domain ? undefined : args.domains,
      });

      return { ...plan, dry_run: false, response };
    }),
  );

  server.tool(
    "domains_create",
    {
      domain: z.string().min(1),
      cost: z.number().int().positive(),
      agree_to_terms: z.boolean().optional(),
      dry_run: z.boolean().optional(),
      confirm_apply: z.boolean().optional(),
    },
    wrap(async (args) => {
      ensureWritable("domains_create");
      ensureDomainCreateEnabled();

      const dryRun = args.dry_run ?? true;
      if (!dryRun && !args.confirm_apply) {
        throw new Error("domains_create dry_run=false requires confirm_apply=true.");
      }

      // Must be explicitly accepted to reduce accidental registration.
      if (args.agree_to_terms !== true) {
        throw new Error("domains_create requires agree_to_terms=true.");
      }

      const plan = {
        status: "SUCCESS",
        dry_run: dryRun,
        action: "domain_create",
        domain: args.domain,
        cost: args.cost,
        warnings: [
          "This operation registers a domain and can spend real money.",
          "Porkbun enforces rate limits and eligibility requirements for API registrations.",
        ],
      };

      if (dryRun) {
        return plan;
      }

      let response: unknown;
      try {
        response = await client.domainsCreate({
          domain: args.domain,
          cost: args.cost,
          agreeToTerms: "yes",
        });
      } catch (error) {
        const message = toMessage(error);
        throw new Error(
          [
            message,
            "",
            "Porkbun API domain registration prerequisites (per official docs):",
            "- Your account must have registered at least one domain in the past (new accounts may need to buy the first domain via the web UI).",
            "- Your email address and phone number must be verified.",
            "- You must have enough account credit (API registrations are billed from account credit).",
            "- `cost` must be in pennies and must match the value returned by Domain Check (minimum duration * price).",
            "- You must accept terms (this tool requires `agree_to_terms=true`).",
            "",
            "Docs: https://porkbun.com/api/json/v3/documentation",
          ].join("\n"),
        );
      }

      return { ...plan, dry_run: false, response };
    }),
  );

  server.tool(
    "domains_get_glue_records",
    {
      domain: z.string().min(1),
    },
    wrap(async (args) => client.domainsGetGlueRecords(args.domain)),
  );

  server.tool(
    "domains_create_glue_record",
    {
      domain: z.string().min(1),
      glue_host_subdomain: z.string().min(1),
      ips: z.array(z.string().min(1)).min(1),
    },
    wrap(async (args) => {
      ensureWritable("domains_create_glue_record");
      return client.domainsCreateGlueRecord(
        args.domain,
        args.glue_host_subdomain,
        args.ips,
      );
    }),
  );

  server.tool(
    "domains_update_glue_record",
    {
      domain: z.string().min(1),
      glue_host_subdomain: z.string().min(1),
      ips: z.array(z.string().min(1)).min(1),
    },
    wrap(async (args) => {
      ensureWritable("domains_update_glue_record");
      return client.domainsUpdateGlueRecord(
        args.domain,
        args.glue_host_subdomain,
        args.ips,
      );
    }),
  );

  server.tool(
    "domains_delete_glue_record",
    {
      domain: z.string().min(1),
      glue_host_subdomain: z.string().min(1),
    },
    wrap(async (args) => {
      ensureWritable("domains_delete_glue_record");
      return client.domainsDeleteGlueRecord(args.domain, args.glue_host_subdomain);
    }),
  );

  server.tool(
    "dns_list",
    {
      domain: z.string().min(1),
    },
    wrap(async (args) => client.dnsList(args.domain)),
  );

  server.tool(
    "dns_get",
    {
      domain: z.string().min(1),
      record_id: z.string().min(1),
    },
    wrap(async (args) => client.dnsGet(args.domain, args.record_id)),
  );

  server.tool(
    "dns_get_by_name_type",
    {
      domain: z.string().min(1),
      type: z.string().min(1),
      subdomain: z.string().optional(),
    },
    wrap(async (args) =>
      client.dnsGetByNameType(args.domain, args.type, args.subdomain),
    ),
  );

  server.tool(
    "dns_create",
    {
      domain: z.string().min(1),
      type: z.string().min(1),
      content: z.string().min(1),
      name: z.string().optional(),
      ttl: z.number().int().positive().optional(),
      prio: z.number().int().nonnegative().optional(),
      notes: z.string().optional(),
    },
    wrap(async (args) => {
      ensureWritable("dns_create");
      return client.dnsCreate(args);
    }),
  );

  server.tool(
    "dns_edit",
    {
      domain: z.string().min(1),
      record_id: z.string().min(1),
      type: z.string().min(1),
      content: z.string().min(1),
      name: z.string().optional(),
      ttl: z.number().int().positive().optional(),
      prio: z.number().int().nonnegative().optional(),
      notes: z.string().optional(),
    },
    wrap(async (args) => {
      ensureWritable("dns_edit");
      return client.dnsEdit({
        domain: args.domain,
        recordId: args.record_id,
        type: args.type,
        content: args.content,
        name: args.name,
        ttl: args.ttl,
        prio: args.prio,
        notes: args.notes,
      });
    }),
  );

  server.tool(
    "dns_edit_by_name_type",
    {
      domain: z.string().min(1),
      type: z.string().min(1),
      content: z.string().min(1),
      subdomain: z.string().optional(),
      ttl: z.number().int().positive().optional(),
      prio: z.number().int().nonnegative().optional(),
      notes: z.string().optional(),
    },
    wrap(async (args) => {
      ensureWritable("dns_edit_by_name_type");
      return client.dnsEditByNameType({
        domain: args.domain,
        type: args.type,
        content: args.content,
        subdomain: args.subdomain,
        ttl: args.ttl,
        prio: args.prio,
        notes: args.notes,
      });
    }),
  );

  server.tool(
    "dns_delete",
    {
      domain: z.string().min(1),
      record_id: z.string().min(1),
    },
    wrap(async (args) => {
      ensureWritable("dns_delete");
      return client.dnsDelete(args.domain, args.record_id);
    }),
  );

  server.tool(
    "dns_delete_by_name_type",
    {
      domain: z.string().min(1),
      type: z.string().min(1),
      subdomain: z.string().optional(),
    },
    wrap(async (args) => {
      ensureWritable("dns_delete_by_name_type");
      return client.dnsDeleteByNameType(args.domain, args.type, args.subdomain);
    }),
  );

  server.tool(
    "dnssec_list",
    {
      domain: z.string().min(1),
    },
    wrap(async (args) => client.dnssecList(args.domain)),
  );

  server.tool(
    "dnssec_create",
    {
      domain: z.string().min(1),
      key_tag: z.number().int().nonnegative(),
      alg: z.string().min(1),
      digest_type: z.string().min(1),
      digest: z.string().min(1),
      max_sig_life: z.number().int().positive().optional(),
      key_data_flags: z.string().optional(),
      key_data_protocol: z.string().optional(),
      key_data_algo: z.string().optional(),
      key_data_pub_key: z.string().optional(),
    },
    wrap(async (args) => {
      ensureWritable("dnssec_create");
      return client.dnssecCreate({
        domain: args.domain,
        keyTag: args.key_tag,
        alg: args.alg,
        digestType: args.digest_type,
        digest: args.digest,
        maxSigLife: args.max_sig_life,
        keyDataFlags: args.key_data_flags,
        keyDataProtocol: args.key_data_protocol,
        keyDataAlgo: args.key_data_algo,
        keyDataPubKey: args.key_data_pub_key,
      });
    }),
  );

  server.tool(
    "dnssec_delete",
    {
      domain: z.string().min(1),
      key_tag: z.number().int().nonnegative(),
    },
    wrap(async (args) => {
      ensureWritable("dnssec_delete");
      return client.dnssecDelete(args.domain, args.key_tag);
    }),
  );

  server.tool(
    "ssl_retrieve",
    {
      domain: z.string().min(1),
    },
    wrap(async (args) => client.sslRetrieve(args.domain)),
  );

  server.tool(
    "dns_query",
    {
      domain: z.string().min(1),
      selector: z
        .object({
          record_id: z.string().min(1).optional(),
          type: z.string().min(1).optional(),
          subdomain: z.string().optional(),
        })
        .strict(),
    },
    wrap(async (args) => {
      const hasRecordId = !!args.selector.record_id;
      const hasTypeSelector = !!args.selector.type;
      if (hasRecordId && hasTypeSelector) {
        throw new Error(
          "dns_query selector must use exactly one strategy: record_id OR type/subdomain.",
        );
      }
      if (!hasRecordId && !hasTypeSelector) {
        throw new Error(
          "dns_query selector requires either record_id or type.",
        );
      }

      const result = hasRecordId
        ? await client.dnsGet(args.domain, args.selector.record_id as string)
        : await client.dnsGetByNameType(
            args.domain,
            args.selector.type as string,
            args.selector.subdomain,
          );

      const matches = extractDnsRecords(result);
      return {
        status: "SUCCESS",
        selector_used: hasRecordId ? "record_id" : "type_subdomain",
        count: matches.length,
        matches,
        raw: result,
      };
    }),
  );

  server.tool(
    "domain_health_check",
    {
      domain: z.string().min(1),
      checks: z
        .array(z.enum(["ns", "dns", "dnssec", "ssl", "forwards"]))
        .min(1)
        .optional(),
    },
    wrap(async (args) => {
      const checks: HealthCheckName[] = args.checks ?? [
        "ns",
        "dns",
        "dnssec",
        "ssl",
        "forwards",
      ];

      const results: Array<{
        check: HealthCheckName;
        status: HealthCheckStatus;
        details: Record<string, unknown>;
      }> = [];

      for (const check of checks) {
        if (check === "ns") {
          try {
            const response = await client.domainsGetNameservers(args.domain);
            const nameservers = readStringArray(response.ns ?? response.nameservers);
            results.push({
              check,
              status: nameservers.length > 0 ? "ok" : "warning",
              details: { nameservers, count: nameservers.length },
            });
          } catch (error) {
            results.push({
              check,
              status: "error",
              details: { error: toMessage(error) },
            });
          }
          continue;
        }

        if (check === "dns") {
          try {
            const response = await client.dnsList(args.domain);
            const records = extractDnsRecords(response);
            const types = summarizeRecordTypes(records);
            results.push({
              check,
              status: records.length > 0 ? "ok" : "warning",
              details: { count: records.length, types },
            });
          } catch (error) {
            results.push({
              check,
              status: "error",
              details: { error: toMessage(error) },
            });
          }
          continue;
        }

        if (check === "dnssec") {
          try {
            const response = await client.dnssecList(args.domain);
            const entries = readArrayLength(
              response.records ?? response.ds ?? response.entries,
            );
            results.push({
              check,
              status: entries > 0 ? "ok" : "warning",
              details: {
                entries,
                note:
                  entries === 0
                    ? "No DNSSEC entries found."
                    : "DNSSEC entries detected.",
              },
            });
          } catch (error) {
            results.push({
              check,
              status: "error",
              details: { error: toMessage(error) },
            });
          }
          continue;
        }

        if (check === "ssl") {
          try {
            const response = await client.sslRetrieve(args.domain);
            const hasCert =
              typeof response.certificatechain === "string" ||
              typeof response.certificate === "string";
            results.push({
              check,
              status: hasCert ? "ok" : "warning",
              details: {
                has_certificate: hasCert,
                keys: Object.keys(response),
              },
            });
          } catch (error) {
            results.push({
              check,
              status: "error",
              details: { error: toMessage(error) },
            });
          }
          continue;
        }

        if (check === "forwards") {
          try {
            const response = await client.domainsGetUrlForwards(args.domain);
            const count = readArrayLength(
              response.forwards ?? response.urlForwarding ?? response.records,
            );
            results.push({
              check,
              status: "ok",
              details: {
                count,
                note:
                  count > 0
                    ? "Forwarding rules detected."
                    : "No forwarding rules configured.",
              },
            });
          } catch (error) {
            results.push({
              check,
              status: "error",
              details: { error: toMessage(error) },
            });
          }
        }
      }

      const overall: HealthCheckStatus = results.some((item) => item.status === "error")
        ? "error"
        : results.some((item) => item.status === "warning")
          ? "warning"
          : "ok";

      return {
        status: "SUCCESS",
        domain: args.domain,
        overall,
        checks: results,
        recommendations: recommendationsFromChecks(results),
      };
    }),
  );

  server.tool(
    "dns_upsert",
    {
      domain: z.string().min(1),
      match: z
        .object({
          type: z.string().min(1),
          subdomain: z.string().optional(),
        })
        .strict(),
      target: z
        .object({
          content: z.string().min(1),
          ttl: z.number().int().positive().optional(),
          prio: z.number().int().nonnegative().optional(),
          notes: z.string().optional(),
        })
        .strict(),
      allow_multi: z.boolean().optional(),
      dry_run: z.boolean().optional(),
    },
    wrap(async (args) => {
      const dryRun = args.dry_run ?? true;
      const allowMulti = args.allow_multi ?? false;

      const lookup = await client.dnsGetByNameType(
        args.domain,
        args.match.type,
        args.match.subdomain,
      );
      const existing = extractDnsRecords(lookup);

      if (existing.length === 0) {
        const plan = {
          action: "create",
          reason: "No matching records found.",
          desired: {
            type: args.match.type,
            name: args.match.subdomain,
            content: args.target.content,
            ttl: args.target.ttl,
            prio: args.target.prio,
            notes: args.target.notes,
          },
        };

        if (dryRun) {
          return { status: "SUCCESS", dry_run: true, ...plan };
        }

        ensureWritable("dns_upsert");
        const response = await client.dnsCreate({
          domain: args.domain,
          type: args.match.type,
          name: args.match.subdomain,
          content: args.target.content,
          ttl: args.target.ttl,
          prio: args.target.prio,
          notes: args.target.notes,
        });

        return { status: "SUCCESS", dry_run: false, ...plan, response };
      }

      if (existing.length > 1 && !allowMulti) {
        throw new Error(
          `dns_upsert matched ${existing.length} records. Set allow_multi=true to edit all matches.`,
        );
      }

      const recordsToUpdate = existing.filter((item) => !recordsEqual(item, args.target));
      if (recordsToUpdate.length === 0) {
        return {
          status: "SUCCESS",
          dry_run: dryRun,
          action: "noop",
          reason: "Records already match target state.",
          count: existing.length,
          records: existing,
        };
      }

      const plan = {
        action: "edit",
        matched: existing.length,
        to_change: recordsToUpdate.length,
        desired: {
          type: args.match.type,
          content: args.target.content,
          ttl: args.target.ttl,
          prio: args.target.prio,
          notes: args.target.notes,
        },
        before: recordsToUpdate,
      };

      if (dryRun) {
        return { status: "SUCCESS", dry_run: true, ...plan };
      }

      ensureWritable("dns_upsert");

      const updates: unknown[] = [];
      for (const record of recordsToUpdate) {
        const response = await client.dnsEdit({
          domain: args.domain,
          recordId: record.id,
          type: args.match.type,
          content: args.target.content,
          name: args.match.subdomain,
          ttl: args.target.ttl,
          prio: args.target.prio,
          notes: args.target.notes,
        });
        updates.push({
          record_id: record.id,
          response,
        });
      }

      const afterState = await client.dnsGetByNameType(
        args.domain,
        args.match.type,
        args.match.subdomain,
      );

      return {
        status: "SUCCESS",
        dry_run: false,
        ...plan,
        updates,
        after: extractDnsRecords(afterState),
      };
    }),
  );

  server.tool(
    "dns_remove",
    {
      domain: z.string().min(1),
      selector: z
        .object({
          record_id: z.string().min(1).optional(),
          type: z.string().min(1).optional(),
          subdomain: z.string().optional(),
        })
        .strict(),
      max_delete: z.number().int().positive().optional(),
      dry_run: z.boolean().optional(),
    },
    wrap(async (args) => {
      const dryRun = args.dry_run ?? true;
      const maxDelete = args.max_delete ?? 1;
      const hasRecordId = !!args.selector.record_id;
      const hasTypeSelector = !!args.selector.type;

      if (hasRecordId && hasTypeSelector) {
        throw new Error(
          "dns_remove selector must use exactly one strategy: record_id OR type/subdomain.",
        );
      }
      if (!hasRecordId && !hasTypeSelector) {
        throw new Error("dns_remove selector requires either record_id or type.");
      }

      const lookup = hasRecordId
        ? await client.dnsGet(args.domain, args.selector.record_id as string)
        : await client.dnsGetByNameType(
            args.domain,
            args.selector.type as string,
            args.selector.subdomain,
          );
      const matches = extractDnsRecords(lookup);

      if (matches.length === 0) {
        return {
          status: "SUCCESS",
          dry_run: dryRun,
          action: "noop",
          planned_deletes: 0,
          matches: [],
        };
      }

      if (matches.length > maxDelete) {
        throw new Error(
          `dns_remove planned ${matches.length} deletions, which exceeds max_delete=${maxDelete}.`,
        );
      }

      if (dryRun) {
        return {
          status: "SUCCESS",
          dry_run: true,
          action: "delete",
          planned_deletes: matches.length,
          record_ids: matches.map((item) => item.id),
          matches,
        };
      }

      ensureWritable("dns_remove");

      const deletes: Array<{ record_id: string; response: unknown }> = [];
      for (const record of matches) {
        const response = await client.dnsDelete(args.domain, record.id);
        deletes.push({
          record_id: record.id,
          response,
        });
      }

      return {
        status: "SUCCESS",
        dry_run: false,
        action: "delete",
        planned_deletes: matches.length,
        applied_deletes: deletes.length,
        deletes,
      };
    }),
  );

  server.tool(
    "domain_redirect_ensure",
    {
      domain: z.string().min(1),
      desired: z
        .array(
          z
            .object({
              subdomain: z.string().optional(),
              location: z.string().min(1),
              type: z.enum(["temporary", "permanent"]).optional(),
              include_path: z.boolean().optional(),
              wildcard: z.boolean().optional(),
            })
            .strict(),
        )
        .min(1),
      strategy: z.enum(["merge", "replace"]).optional(),
      confirm_replace: z.boolean().optional(),
      dry_run: z.boolean().optional(),
    },
    wrap(async (args) => {
      const dryRun = args.dry_run ?? true;
      const strategy: ReconcileStrategy = args.strategy ?? "merge";
      if (strategy === "replace" && !args.confirm_replace) {
        throw new Error(
          "domain_redirect_ensure strategy=replace requires confirm_replace=true.",
        );
      }

      const currentResponse = await client.domainsGetUrlForwards(args.domain);
      const current = extractUrlForwards(currentResponse, args.domain);
      const desired = args.desired.map((item) =>
        normalizeDesiredForward(item, args.domain),
      );

      const usedCurrent = new Set<number>();
      const toAdd: UrlForwardRule[] = [];
      const toKeep: UrlForwardRule[] = [];

      for (const desiredRule of desired) {
        const desiredKey = forwardKey(desiredRule);
        const matchIndex = current.findIndex(
          (candidate, idx) =>
            !usedCurrent.has(idx) && forwardKey(candidate) === desiredKey,
        );
        if (matchIndex >= 0) {
          usedCurrent.add(matchIndex);
          toKeep.push(current[matchIndex]);
        } else {
          toAdd.push(desiredRule);
        }
      }

      const unmatchedCurrent = current.filter((_, idx) => !usedCurrent.has(idx));
      const toRemove = strategy === "replace" ? unmatchedCurrent : [];

      const summary = {
        status: "SUCCESS",
        strategy,
        dry_run: dryRun,
        current_count: current.length,
        desired_count: desired.length,
        to_add: toAdd.map(publicForwardRule),
        to_keep: [...toKeep, ...(strategy === "merge" ? unmatchedCurrent : [])].map(
          publicForwardRule,
        ),
        to_remove: toRemove.map(publicForwardRule),
      };

      if (dryRun || (toAdd.length === 0 && toRemove.length === 0)) {
        return summary;
      }

      ensureWritable("domain_redirect_ensure");

      const adds: Array<{ desired: ReturnType<typeof publicForwardRule>; response: unknown }> =
        [];
      for (const rule of toAdd) {
        const response = await client.domainsAddUrlForward({
          domain: args.domain,
          subdomain: emptyToUndefined(rule.subdomain),
          location: rule.location,
          type: rule.type,
          includePath: rule.include_path,
          wildcard: rule.wildcard,
        });
        adds.push({
          desired: publicForwardRule(rule),
          response,
        });
      }

      const removes: Array<{ record_id: string; response: unknown }> = [];
      const skipped: Array<{ reason: string; rule: ReturnType<typeof publicForwardRule> }> = [];
      for (const rule of toRemove) {
        if (!rule.record_id) {
          skipped.push({
            reason: "Missing record_id in Porkbun forward payload; cannot delete.",
            rule: publicForwardRule(rule),
          });
          continue;
        }

        const response = await client.domainsDeleteUrlForward(args.domain, rule.record_id);
        removes.push({
          record_id: rule.record_id,
          response,
        });
      }

      return {
        ...summary,
        dry_run: false,
        applied: {
          adds,
          removes,
          skipped,
        },
      };
    }),
  );

  server.tool(
    "domain_cutover_web",
    {
      domain: z.string().min(1),
      target_records: z
        .array(
          z
            .object({
              type: z.string().min(1),
              subdomain: z.string().optional(),
              content: z.string().min(1),
              ttl: z.number().int().positive().optional(),
              prio: z.number().int().nonnegative().optional(),
              notes: z.string().optional(),
            })
            .strict(),
        )
        .min(1),
      pre_cutover_ttl: z.number().int().positive().optional(),
      verify: z.boolean().optional(),
      allow_multi: z.boolean().optional(),
      dry_run: z.boolean().optional(),
    },
    wrap(async (args) => {
      const dryRun = args.dry_run ?? true;
      const verify = args.verify ?? true;
      const allowMulti = args.allow_multi ?? false;

      type PlannedCreate = {
        domain: string;
        type: string;
        subdomain?: string;
        content: string;
        ttl?: number;
        prio?: number;
        notes?: string;
      };
      type PlannedEdit = {
        record_id: string;
        domain: string;
        type: string;
        subdomain?: string;
        content: string;
        ttl?: number;
        prio?: number;
        notes?: string;
      };

      const creates: PlannedCreate[] = [];
      const edits: PlannedEdit[] = [];
      const noop: Array<{ key: string; matched: number }> = [];
      const steps: string[] = [];

      for (const input of args.target_records) {
        const desired = normalizeDesiredDnsRecord(
          {
            ...input,
            ttl: input.ttl ?? args.pre_cutover_ttl,
          },
          args.domain,
        );

        const lookup = await client.dnsGetByNameType(
          args.domain,
          desired.type,
          emptyToUndefined(desired.subdomain),
        );
        const existing = extractDnsRecords(lookup).filter(
          (record) =>
            record.type.toUpperCase() === desired.type &&
            normalizeDnsSubdomain(record.name, args.domain) === desired.subdomain,
        );

        const key = dnsRecordKey(desired.type, desired.subdomain);
        if (existing.length === 0) {
          creates.push({
            domain: args.domain,
            type: desired.type,
            subdomain: emptyToUndefined(desired.subdomain),
            content: desired.content,
            ttl: desired.ttl,
            prio: desired.prio,
            notes: desired.notes,
          });
          steps.push(`Create ${key} -> ${desired.content}`);
          continue;
        }

        if (existing.length > 1 && !allowMulti) {
          throw new Error(
            `domain_cutover_web found ${existing.length} records for ${key}. Set allow_multi=true to update all.`,
          );
        }

        const candidates = allowMulti ? existing : [existing[0]];
        const toUpdate = candidates.filter(
          (record) => !recordMatchesDesired(record, desired, args.domain),
        );

        if (toUpdate.length === 0) {
          noop.push({ key, matched: existing.length });
          continue;
        }

        for (const record of toUpdate) {
          edits.push({
            record_id: record.id,
            domain: args.domain,
            type: desired.type,
            subdomain: emptyToUndefined(desired.subdomain),
            content: desired.content,
            ttl: desired.ttl,
            prio: desired.prio,
            notes: desired.notes,
          });
          steps.push(`Edit ${key} record ${record.id} -> ${desired.content}`);
        }
      }

      const plan = {
        status: "SUCCESS",
        dry_run: dryRun,
        steps,
        planned_changes: {
          create: creates.length,
          edit: edits.length,
          noop: noop.length,
        },
        creates,
        edits,
        noop,
      };

      if (dryRun || (creates.length === 0 && edits.length === 0)) {
        return plan;
      }

      ensureWritable("domain_cutover_web");

      const appliedCreates: Array<{ request: PlannedCreate; response: unknown }> = [];
      for (const create of creates) {
        const response = await client.dnsCreate({
          domain: create.domain,
          type: create.type,
          name: create.subdomain,
          content: create.content,
          ttl: create.ttl,
          prio: create.prio,
          notes: create.notes,
        });
        appliedCreates.push({ request: create, response });
      }

      const appliedEdits: Array<{ request: PlannedEdit; response: unknown }> = [];
      for (const edit of edits) {
        const response = await client.dnsEdit({
          domain: edit.domain,
          recordId: edit.record_id,
          type: edit.type,
          name: edit.subdomain,
          content: edit.content,
          ttl: edit.ttl,
          prio: edit.prio,
          notes: edit.notes,
        });
        appliedEdits.push({ request: edit, response });
      }

      const verification: Array<{
        key: string;
        matched: number;
        ok: boolean;
      }> = [];
      const warnings: string[] = [];

      if (verify) {
        for (const input of args.target_records) {
          const desired = normalizeDesiredDnsRecord(
            {
              ...input,
              ttl: input.ttl ?? args.pre_cutover_ttl,
            },
            args.domain,
          );
          const lookup = await client.dnsGetByNameType(
            args.domain,
            desired.type,
            emptyToUndefined(desired.subdomain),
          );
          const existing = extractDnsRecords(lookup);
          const matched = existing.filter((record) =>
            recordMatchesDesired(record, desired, args.domain),
          ).length;
          const key = dnsRecordKey(desired.type, desired.subdomain);
          verification.push({
            key,
            matched,
            ok: matched > 0,
          });
          if (matched === 0) {
            warnings.push(
              `Verification could not confirm desired state for ${key}. DNS propagation may still be in progress.`,
            );
          }
        }
      }

      return {
        ...plan,
        dry_run: false,
        applied: {
          creates: appliedCreates,
          edits: appliedEdits,
        },
        verification,
        warnings,
      };
    }),
  );

  server.tool(
    "dns_batch_apply",
    {
      domain: z.string().min(1),
      desired_records: z
        .array(
          z
            .object({
              type: z.string().min(1),
              subdomain: z.string().optional(),
              content: z.string().min(1),
              ttl: z.number().int().positive().optional(),
              prio: z.number().int().nonnegative().optional(),
              notes: z.string().optional(),
            })
            .strict(),
        )
        .min(1),
      mode: z.enum(["plan", "apply"]).optional(),
      strategy: z.enum(["merge", "replace"]).optional(),
      max_changes: z.number().int().positive().optional(),
      confirm_apply: z.boolean().optional(),
    },
    wrap(async (args) => {
      const mode: DnsBatchMode = args.mode ?? "plan";
      const strategy: ReconcileStrategy = args.strategy ?? "merge";
      const maxChanges = args.max_changes;

      if (mode === "apply" && !args.confirm_apply) {
        throw new Error("dns_batch_apply mode=apply requires confirm_apply=true.");
      }

      const current = extractDnsRecords(await client.dnsList(args.domain));
      const desired = args.desired_records.map((item) =>
        normalizeDesiredDnsRecord(item, args.domain),
      );

      const currentByKey = groupDnsRecordsByKey(current, args.domain);
      const desiredByKey = groupDesiredRecordsByKey(desired);
      const allKeys = new Set<string>([
        ...Array.from(currentByKey.keys()),
        ...Array.from(desiredByKey.keys()),
      ]);

      const diff = {
        create: [] as Array<DesiredDnsRecord>,
        edit: [] as Array<{ record_id: string; before: PorkbunDnsRecord; desired: DesiredDnsRecord }>,
        delete: [] as Array<PorkbunDnsRecord>,
        noop: [] as Array<{ record_id: string; record: PorkbunDnsRecord }>,
      };

      for (const key of allKeys) {
        const currentBucket = [...(currentByKey.get(key) ?? [])];
        const desiredBucket = [...(desiredByKey.get(key) ?? [])];

        const unmatchedDesired: DesiredDnsRecord[] = [];
        for (const desiredRecord of desiredBucket) {
          const matchIndex = currentBucket.findIndex((record) =>
            recordMatchesDesired(record, desiredRecord, args.domain),
          );
          if (matchIndex >= 0) {
            const matched = currentBucket.splice(matchIndex, 1)[0];
            diff.noop.push({
              record_id: matched.id,
              record: matched,
            });
          } else {
            unmatchedDesired.push(desiredRecord);
          }
        }

        const editsCount = Math.min(currentBucket.length, unmatchedDesired.length);
        for (let index = 0; index < editsCount; index += 1) {
          const before = currentBucket[index];
          const desiredRecord = unmatchedDesired[index];
          diff.edit.push({
            record_id: before.id,
            before,
            desired: desiredRecord,
          });
        }

        for (let index = editsCount; index < unmatchedDesired.length; index += 1) {
          diff.create.push(unmatchedDesired[index]);
        }

        const remainingCurrent = currentBucket.slice(editsCount);
        if (strategy === "replace") {
          diff.delete.push(...remainingCurrent);
        }
      }

      const projectedChanges = diff.create.length + diff.edit.length + diff.delete.length;
      if (maxChanges !== undefined && projectedChanges > maxChanges) {
        throw new Error(
          `dns_batch_apply projected ${projectedChanges} changes, exceeding max_changes=${maxChanges}.`,
        );
      }

      const plan = {
        status: "SUCCESS",
        mode,
        strategy,
        projected_changes: projectedChanges,
        diff,
      };

      if (mode === "plan" || projectedChanges === 0) {
        return plan;
      }

      ensureWritable("dns_batch_apply");

      const applied = {
        create: [] as Array<{ request: DesiredDnsRecord; response: unknown }>,
        edit: [] as Array<{ record_id: string; desired: DesiredDnsRecord; response: unknown }>,
        delete: [] as Array<{ record_id: string; response: unknown }>,
        failed: [] as Array<{ op: "create" | "edit" | "delete"; key: string; error: string }>,
      };

      for (const create of diff.create) {
        try {
          const response = await client.dnsCreate({
            domain: args.domain,
            type: create.type,
            name: emptyToUndefined(create.subdomain),
            content: create.content,
            ttl: create.ttl,
            prio: create.prio,
            notes: create.notes,
          });
          applied.create.push({
            request: create,
            response,
          });
        } catch (error) {
          applied.failed.push({
            op: "create",
            key: dnsRecordKey(create.type, create.subdomain),
            error: toMessage(error),
          });
        }
      }

      for (const edit of diff.edit) {
        try {
          const response = await client.dnsEdit({
            domain: args.domain,
            recordId: edit.record_id,
            type: edit.desired.type,
            name: emptyToUndefined(edit.desired.subdomain),
            content: edit.desired.content,
            ttl: edit.desired.ttl,
            prio: edit.desired.prio,
            notes: edit.desired.notes,
          });
          applied.edit.push({
            record_id: edit.record_id,
            desired: edit.desired,
            response,
          });
        } catch (error) {
          applied.failed.push({
            op: "edit",
            key: dnsRecordKey(edit.desired.type, edit.desired.subdomain),
            error: toMessage(error),
          });
        }
      }

      for (const record of diff.delete) {
        try {
          const response = await client.dnsDelete(args.domain, record.id);
          applied.delete.push({
            record_id: record.id,
            response,
          });
        } catch (error) {
          applied.failed.push({
            op: "delete",
            key: dnsRecordKey(record.type, normalizeDnsSubdomain(record.name, args.domain)),
            error: toMessage(error),
          });
        }
      }

      return {
        ...plan,
        mode: "apply" as const,
        apply_status: applied.failed.length > 0 ? "partial_success" : "success",
        applied,
      };
    }),
  );

  const upsertSingleRecord = async (input: {
    tool_name: string;
    domain: string;
    type: string;
    subdomain: string;
    target: {
      content: string;
      ttl?: number;
      prio?: number;
      notes?: string;
    };
    dry_run: boolean;
  }): Promise<unknown> => {
    const lookup = await client.dnsGetByNameType(
      input.domain,
      input.type,
      emptyToUndefined(input.subdomain),
    );
    const existing = extractDnsRecords(lookup);

    if (existing.length === 0) {
      const plan = {
        action: "create",
        reason: "No matching records found.",
        desired: {
          type: input.type,
          name: input.subdomain,
          content: input.target.content,
          ttl: input.target.ttl,
          prio: input.target.prio,
          notes: input.target.notes,
        },
      };

      if (input.dry_run) {
        return { status: "SUCCESS", dry_run: true, ...plan };
      }

      ensureWritable(input.tool_name);
      const response = await client.dnsCreate({
        domain: input.domain,
        type: input.type,
        name: input.subdomain,
        content: input.target.content,
        ttl: input.target.ttl,
        prio: input.target.prio,
        notes: input.target.notes,
      });

      return { status: "SUCCESS", dry_run: false, ...plan, response };
    }

    if (existing.length > 1) {
      throw new Error(
        `${input.tool_name} matched ${existing.length} records for ${input.type} ${input.subdomain || "@"}. Refusing to edit multiple records.`,
      );
    }

    const current = existing[0];
    if (recordsEqual(current, input.target)) {
      return {
        status: "SUCCESS",
        dry_run: input.dry_run,
        action: "noop",
        reason: "Record already matches target state.",
        record: current,
      };
    }

    const plan = {
      action: "edit",
      record_id: current.id,
      desired: {
        type: input.type,
        name: input.subdomain,
        content: input.target.content,
        ttl: input.target.ttl,
        prio: input.target.prio,
        notes: input.target.notes,
      },
      before: current,
    };

    if (input.dry_run) {
      return { status: "SUCCESS", dry_run: true, ...plan };
    }

    ensureWritable(input.tool_name);
    const response = await client.dnsEdit({
      domain: input.domain,
      recordId: current.id,
      type: input.type,
      name: input.subdomain,
      content: input.target.content,
      ttl: input.target.ttl,
      prio: input.target.prio,
      notes: input.target.notes,
    });

    const afterState = await client.dnsGetByNameType(
      input.domain,
      input.type,
      emptyToUndefined(input.subdomain),
    );

    return {
      status: "SUCCESS",
      dry_run: false,
      ...plan,
      response,
      after: extractDnsRecords(afterState),
    };
  };

  const ensureRecordPresent = async (input: {
    tool_name: string;
    domain: string;
    desired: DesiredDnsRecord;
    dry_run: boolean;
  }): Promise<unknown> => {
    const lookup = await client.dnsGetByNameType(
      input.domain,
      input.desired.type,
      emptyToUndefined(input.desired.subdomain),
    );
    const existing = extractDnsRecords(lookup);

    const hasExactMatch = existing.some((record) =>
      recordMatchesDesired(record, input.desired, input.domain),
    );
    if (hasExactMatch) {
      return {
        status: "SUCCESS",
        dry_run: input.dry_run,
        action: "noop",
        reason: "Matching record already exists.",
        desired: input.desired,
      };
    }

    const plan = {
      action: "create",
      reason: "No exact match found. Will add desired record.",
      desired: input.desired,
    };

    if (input.dry_run) {
      return { status: "SUCCESS", dry_run: true, ...plan };
    }

    ensureWritable(input.tool_name);
    const response = await client.dnsCreate({
      domain: input.domain,
      type: input.desired.type,
      name: emptyToUndefined(input.desired.subdomain),
      content: input.desired.content,
      ttl: input.desired.ttl,
      prio: input.desired.prio,
      notes: input.desired.notes,
    });

    return { status: "SUCCESS", dry_run: false, ...plan, response };
  };

  server.tool(
    "update_server_ip",
    {
      domain: z.string().min(1),
      subdomain: z.string().optional(),
      ipv4: z.string().min(1),
      ipv6: z.string().min(1).optional(),
      ttl: z.number().int().positive().optional(),
      dry_run: z.boolean().optional(),
    },
    wrap(async (args) => {
      const dryRun = args.dry_run ?? true;
      const subdomain = normalizeDnsSubdomain(args.subdomain, args.domain);

      const results: unknown[] = [];
      results.push(
        await upsertSingleRecord({
          tool_name: "update_server_ip",
          domain: args.domain,
          type: "A",
          subdomain,
          target: { content: args.ipv4, ttl: args.ttl },
          dry_run: dryRun,
        }),
      );

      if (args.ipv6) {
        results.push(
          await upsertSingleRecord({
            tool_name: "update_server_ip",
            domain: args.domain,
            type: "AAAA",
            subdomain,
            target: { content: args.ipv6, ttl: args.ttl },
            dry_run: dryRun,
          }),
        );
      }

      return { status: "SUCCESS", dry_run: dryRun, domain: args.domain, subdomain, results };
    }),
  );

  server.tool(
    "subdomain_setup",
    {
      domain: z.string().min(1),
      subdomain: z.string().min(1),
      type: z.enum(["A", "AAAA", "CNAME", "TXT"]),
      content: z.string().min(1),
      ttl: z.number().int().positive().optional(),
      prio: z.number().int().nonnegative().optional(),
      notes: z.string().optional(),
      dry_run: z.boolean().optional(),
    },
    wrap(async (args) => {
      const dryRun = args.dry_run ?? true;
      const subdomain = normalizeDnsSubdomain(args.subdomain, args.domain);

      return upsertSingleRecord({
        tool_name: "subdomain_setup",
        domain: args.domain,
        type: args.type,
        subdomain,
        target: {
          content: args.content,
          ttl: args.ttl,
          prio: args.prio,
          notes: args.notes,
        },
        dry_run: dryRun,
      });
    }),
  );

  server.tool(
    "dns_setup",
    {
      domain: z.string().min(1),
      apex_ipv4: z.string().min(1).optional(),
      apex_ipv6: z.string().min(1).optional(),
      www_cname: z.boolean().optional(),
      www_target: z.string().min(1).optional(),
      ttl: z.number().int().positive().optional(),
      dry_run: z.boolean().optional(),
    },
    wrap(async (args) => {
      const dryRun = args.dry_run ?? true;
      const wwwCname = args.www_cname ?? true;

      if (!args.apex_ipv4 && !args.apex_ipv6 && !wwwCname) {
        throw new Error(
          "dns_setup requires at least one change: apex_ipv4, apex_ipv6, or www_cname=true.",
        );
      }

      const results: unknown[] = [];
      if (args.apex_ipv4) {
        results.push(
          await upsertSingleRecord({
            tool_name: "dns_setup",
            domain: args.domain,
            type: "A",
            subdomain: "",
            target: { content: args.apex_ipv4, ttl: args.ttl },
            dry_run: dryRun,
          }),
        );
      }
      if (args.apex_ipv6) {
        results.push(
          await upsertSingleRecord({
            tool_name: "dns_setup",
            domain: args.domain,
            type: "AAAA",
            subdomain: "",
            target: { content: args.apex_ipv6, ttl: args.ttl },
            dry_run: dryRun,
          }),
        );
      }
      if (wwwCname) {
        const target = (args.www_target ?? args.domain).trim();
        results.push(
          await upsertSingleRecord({
            tool_name: "dns_setup",
            domain: args.domain,
            type: "CNAME",
            subdomain: "www",
            target: { content: target, ttl: args.ttl },
            dry_run: dryRun,
          }),
        );
      }

      return { status: "SUCCESS", dry_run: dryRun, domain: args.domain, results };
    }),
  );

  server.tool(
    "dns_audit",
    {
      domain: z.string().min(1),
    },
    wrap(async (args) => {
      const response = await client.dnsList(args.domain);
      const records = extractDnsRecords(response);
      const types = summarizeRecordTypes(records);

      const subOf = (record: PorkbunDnsRecord) =>
        normalizeDnsSubdomain(record.name, args.domain);

      const apex = records.filter((r) => subOf(r) === "");
      const www = records.filter((r) => subOf(r) === "www");

      const hasApexA = apex.some((r) => r.type.toUpperCase() === "A");
      const hasApexAAAA = apex.some((r) => r.type.toUpperCase() === "AAAA");
      const hasApexCname = apex.some((r) => r.type.toUpperCase() === "CNAME");
      const hasWww = www.some((r) => ["A", "AAAA", "CNAME"].includes(r.type.toUpperCase()));
      const hasMx = records.some((r) => r.type.toUpperCase() === "MX");

      const rootTxt = records.filter((r) => r.type.toUpperCase() === "TXT" && subOf(r) === "");
      const dmarcTxt = records.filter(
        (r) => r.type.toUpperCase() === "TXT" && subOf(r) === "_dmarc",
      );
      const hasSpf = rootTxt.some((r) => r.content.trim().toLowerCase().startsWith("v=spf1"));
      const hasDmarc = dmarcTxt.some((r) => r.content.trim().toLowerCase().startsWith("v=dmarc1"));

      const warnings: string[] = [];
      const recommendations: string[] = [];

      if (!hasApexA && !hasApexAAAA && !hasApexCname) {
        warnings.push("No apex A/AAAA/CNAME record detected. Web may not resolve.");
        recommendations.push("Add an apex A or AAAA record (or a CNAME if appropriate).");
      }
      if (!hasWww) {
        warnings.push('No "www" A/AAAA/CNAME record detected.');
        recommendations.push('Add a "www" CNAME or A record if you intend to use www.');
      }
      if (!hasMx) {
        recommendations.push("If you use email on this domain, configure MX and SPF records.");
      }
      if (hasMx && !hasSpf) {
        warnings.push("MX records exist but no SPF TXT record detected at root.");
      }
      if (hasMx && !hasDmarc) {
        recommendations.push("Consider adding a DMARC record (_dmarc TXT).");
      }

      const overall: HealthCheckStatus = warnings.length > 0 ? "warning" : "ok";
      return {
        status: "SUCCESS",
        domain: args.domain,
        overall,
        dns: {
          count: records.length,
          types,
          apex: { has_a: hasApexA, has_aaaa: hasApexAAAA, has_cname: hasApexCname },
          www: { present: hasWww },
          email: { has_mx: hasMx, has_spf: hasSpf, has_dmarc: hasDmarc },
        },
        warnings,
        recommendations,
      };
    }),
  );

  server.tool(
    "email_dns_setup",
    {
      domain: z.string().min(1),
      provider: z.enum(["google_workspace", "protonmail", "custom"]),
      custom_records: z
        .array(
          z
            .object({
              type: z.string().min(1),
              subdomain: z.string().optional(),
              content: z.string().min(1),
              ttl: z.number().int().positive().optional(),
              prio: z.number().int().nonnegative().optional(),
              notes: z.string().optional(),
            })
            .strict(),
        )
        .optional(),
      ttl: z.number().int().positive().optional(),
      confirm_apply: z.boolean().optional(),
      dry_run: z.boolean().optional(),
    },
    wrap(async (args) => {
      const dryRun = args.dry_run ?? true;

      const desired: DesiredDnsRecord[] = [];
      if (args.provider === "google_workspace") {
        desired.push(
          normalizeDesiredDnsRecord(
            { type: "MX", subdomain: "", content: "ASPMX.L.GOOGLE.COM", prio: 1, ttl: args.ttl },
            args.domain,
          ),
          normalizeDesiredDnsRecord(
            { type: "MX", subdomain: "", content: "ALT1.ASPMX.L.GOOGLE.COM", prio: 5, ttl: args.ttl },
            args.domain,
          ),
          normalizeDesiredDnsRecord(
            { type: "MX", subdomain: "", content: "ALT2.ASPMX.L.GOOGLE.COM", prio: 5, ttl: args.ttl },
            args.domain,
          ),
          normalizeDesiredDnsRecord(
            { type: "MX", subdomain: "", content: "ALT3.ASPMX.L.GOOGLE.COM", prio: 10, ttl: args.ttl },
            args.domain,
          ),
          normalizeDesiredDnsRecord(
            { type: "MX", subdomain: "", content: "ALT4.ASPMX.L.GOOGLE.COM", prio: 10, ttl: args.ttl },
            args.domain,
          ),
        );
        desired.push(
          normalizeDesiredDnsRecord(
            {
              type: "TXT",
              subdomain: "",
              content: "v=spf1 include:_spf.google.com ~all",
              ttl: args.ttl,
            },
            args.domain,
          ),
        );
      } else if (args.provider === "protonmail") {
        desired.push(
          normalizeDesiredDnsRecord(
            { type: "MX", subdomain: "", content: "mail.protonmail.ch", prio: 10, ttl: args.ttl },
            args.domain,
          ),
          normalizeDesiredDnsRecord(
            { type: "MX", subdomain: "", content: "mailsec.protonmail.ch", prio: 20, ttl: args.ttl },
            args.domain,
          ),
        );
        desired.push(
          normalizeDesiredDnsRecord(
            {
              type: "TXT",
              subdomain: "",
              content: "v=spf1 include:_spf.protonmail.ch ~all",
              ttl: args.ttl,
            },
            args.domain,
          ),
        );
      } else {
        if (!args.custom_records || args.custom_records.length === 0) {
          throw new Error("email_dns_setup provider=custom requires custom_records.");
        }
        for (const record of args.custom_records) {
          desired.push(normalizeDesiredDnsRecord(record, args.domain));
        }
      }

      // Safety: avoid silently adding a second SPF record unless explicitly confirmed.
      const spfDesired = desired.find(
        (r) => r.type === "TXT" && r.subdomain === "" && r.content.toLowerCase().startsWith("v=spf1"),
      );
      if (spfDesired) {
        const lookup = await client.dnsGetByNameType(args.domain, "TXT", "");
        const existingTxt = extractDnsRecords(lookup).filter(
          (r) =>
            normalizeDnsSubdomain(r.name, args.domain) === "" &&
            r.content.trim().toLowerCase().startsWith("v=spf1"),
        );
        const hasExact = existingTxt.some((r) => r.content.trim() === spfDesired.content.trim());
        if (!hasExact && existingTxt.length > 0 && !dryRun && !args.confirm_apply) {
          throw new Error(
            "SPF record already exists. Refusing to add another without confirm_apply=true.",
          );
        }
      }

      const results: unknown[] = [];
      for (const record of desired) {
        // For MX, avoid creating duplicates if the same host already exists with a different priority.
        if (record.type === "MX") {
          const lookup = await client.dnsGetByNameType(args.domain, "MX", "");
          const existing = extractDnsRecords(lookup);
          const hasSameTarget = existing.some(
            (r) =>
              r.type.toUpperCase() === "MX" &&
              normalizeDnsSubdomain(r.name, args.domain) === "" &&
              r.content.trim().toLowerCase() === record.content.trim().toLowerCase(),
          );
          if (hasSameTarget) {
            results.push({
              status: "SUCCESS",
              dry_run: dryRun,
              action: "noop",
              reason: "MX target already exists.",
              desired: record,
            });
            continue;
          }
        }

        results.push(
          await ensureRecordPresent({
            tool_name: "email_dns_setup",
            domain: args.domain,
            desired: record,
            dry_run: dryRun,
          }),
        );
      }

      return { status: "SUCCESS", provider: args.provider, dry_run: dryRun, results };
    }),
  );

  return server;
}

type DesiredDnsRecord = {
  type: string;
  subdomain: string;
  content: string;
  ttl?: number;
  prio?: number;
  notes?: string;
};

type UrlForwardRule = {
  record_id?: string;
  subdomain: string;
  location: string;
  type: "temporary" | "permanent";
  include_path: boolean;
  wildcard: boolean;
};

function normalizeDesiredDnsRecord(
  input: {
    type: string;
    subdomain?: string;
    content: string;
    ttl?: number;
    prio?: number;
    notes?: string;
  },
  domain: string,
): DesiredDnsRecord {
  return {
    type: input.type.trim().toUpperCase(),
    subdomain: normalizeDnsSubdomain(input.subdomain, domain),
    content: input.content,
    ttl: input.ttl,
    prio: input.prio,
    notes: input.notes,
  };
}

function recordMatchesDesired(
  record: PorkbunDnsRecord,
  desired: DesiredDnsRecord,
  domain: string,
): boolean {
  if (record.type.toUpperCase() !== desired.type) {
    return false;
  }
  if (normalizeDnsSubdomain(record.name, domain) !== desired.subdomain) {
    return false;
  }
  return recordsEqual(record, {
    content: desired.content,
    ttl: desired.ttl,
    prio: desired.prio,
    notes: desired.notes,
  });
}

function groupDnsRecordsByKey(
  records: PorkbunDnsRecord[],
  domain: string,
): Map<string, PorkbunDnsRecord[]> {
  const groups = new Map<string, PorkbunDnsRecord[]>();
  for (const record of records) {
    const key = dnsRecordKey(record.type, normalizeDnsSubdomain(record.name, domain));
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(record);
    } else {
      groups.set(key, [record]);
    }
  }
  return groups;
}

function groupDesiredRecordsByKey(
  records: DesiredDnsRecord[],
): Map<string, DesiredDnsRecord[]> {
  const groups = new Map<string, DesiredDnsRecord[]>();
  for (const record of records) {
    const key = dnsRecordKey(record.type, record.subdomain);
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(record);
    } else {
      groups.set(key, [record]);
    }
  }
  return groups;
}

function dnsRecordKey(type: string, subdomain?: string): string {
  return `${type.trim().toUpperCase()}|${normalizeDnsSubdomain(subdomain)}`;
}

function normalizeDnsSubdomain(value: string | undefined, domain?: string): string {
  const raw = (value ?? "").trim().toLowerCase();
  if (raw.length === 0 || raw === "@") {
    return "";
  }

  const withoutTrailingDot = trimTrailingDot(raw);
  if (!domain) {
    return withoutTrailingDot;
  }

  const normalizedDomain = trimTrailingDot(domain.trim().toLowerCase());
  if (withoutTrailingDot === normalizedDomain) {
    return "";
  }
  if (withoutTrailingDot.endsWith(`.${normalizedDomain}`)) {
    return withoutTrailingDot.slice(0, -(normalizedDomain.length + 1));
  }
  return withoutTrailingDot;
}

function normalizeDesiredForward(
  input: {
    subdomain?: string;
    location: string;
    type?: "temporary" | "permanent";
    include_path?: boolean;
    wildcard?: boolean;
  },
  domain: string,
): UrlForwardRule {
  return {
    subdomain: normalizeDnsSubdomain(input.subdomain, domain),
    location: input.location.trim(),
    type: input.type ?? "temporary",
    include_path: input.include_path ?? false,
    wildcard: input.wildcard ?? false,
  };
}

function extractUrlForwards(payload: unknown, domain: string): UrlForwardRule[] {
  if (!isRecord(payload)) {
    return [];
  }

  const forwards = payload.forwards ?? payload.records ?? payload.urlForwarding;
  if (!Array.isArray(forwards)) {
    return [];
  }

  return forwards
    .map((item) => toUrlForwardRule(item, domain))
    .filter((item): item is UrlForwardRule => item !== null);
}

function toUrlForwardRule(value: unknown, domain: string): UrlForwardRule | null {
  if (!isRecord(value)) {
    return null;
  }

  const location =
    readString(value.location) ?? readString(value.url) ?? readString(value.to);
  if (!location || location.trim().length === 0) {
    return null;
  }

  return {
    record_id:
      readString(value.id) ??
      readString(value.record_id) ??
      readString(value.pk) ??
      undefined,
    subdomain: normalizeDnsSubdomain(
      readString(value.subdomain) ?? readString(value.name) ?? "",
      domain,
    ),
    location: location.trim(),
    type: normalizeForwardType(
      readString(value.type) ??
        readString(value.code) ??
        readString(value.statusCode) ??
        undefined,
    ),
    include_path: readBoolean(value.includePath ?? value.include_path, false),
    wildcard: readBoolean(value.wildcard, false),
  };
}

function forwardKey(rule: UrlForwardRule): string {
  return [
    rule.subdomain,
    rule.location,
    rule.type,
    rule.include_path ? "1" : "0",
    rule.wildcard ? "1" : "0",
  ].join("|");
}

function publicForwardRule(rule: UrlForwardRule): {
  record_id?: string;
  subdomain: string;
  location: string;
  type: "temporary" | "permanent";
  include_path: boolean;
  wildcard: boolean;
} {
  return {
    record_id: rule.record_id,
    subdomain: rule.subdomain,
    location: rule.location,
    type: rule.type,
    include_path: rule.include_path,
    wildcard: rule.wildcard,
  };
}

function normalizeForwardType(value: string | undefined): "temporary" | "permanent" {
  if (!value) {
    return "temporary";
  }
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "permanent" ||
    normalized === "301" ||
    normalized === "http_301"
  ) {
    return "permanent";
  }
  return "temporary";
}

function readString(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  return null;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (
      normalized === "1" ||
      normalized === "true" ||
      normalized === "yes" ||
      normalized === "on"
    ) {
      return true;
    }
    if (
      normalized === "0" ||
      normalized === "false" ||
      normalized === "no" ||
      normalized === "off"
    ) {
      return false;
    }
  }
  return fallback;
}

function emptyToUndefined(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function trimTrailingDot(value: string): string {
  return value.endsWith(".") ? value.slice(0, -1) : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function recommendationsFromChecks(
  checks: Array<{ check: HealthCheckName; status: HealthCheckStatus }>,
): string[] {
  const recommendations: string[] = [];

  if (checks.some((item) => item.check === "dns" && item.status !== "ok")) {
    recommendations.push("Review DNS records and confirm required A/AAAA/CNAME entries.");
  }
  if (checks.some((item) => item.check === "dnssec" && item.status === "warning")) {
    recommendations.push("DNSSEC appears to be absent. Enable it if your resolver strategy requires it.");
  }
  if (checks.some((item) => item.check === "ssl" && item.status !== "ok")) {
    recommendations.push("Check SSL provisioning state and verify certificate retrieval for this domain.");
  }
  if (checks.some((item) => item.status === "error")) {
    recommendations.push("One or more checks failed due to API errors. Retry and inspect credentials/access.");
  }

  return recommendations;
}

function summarizeRecordTypes(records: Array<{ type: string }>): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const record of records) {
    const key = record.type.toUpperCase();
    summary[key] = (summary[key] ?? 0) + 1;
  }
  return summary;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

function readArrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertValidDomain(domain: string): void {
  const normalizedInput = domain.trim();
  if (normalizedInput.length < 1 || normalizedInput.length > 253) {
    throw new Error("Domain must be between 1 and 253 characters.");
  }

  const ascii = domainToASCII(normalizedInput).toLowerCase();
  if (!ascii) {
    throw new Error(`Invalid domain format: "${domain}".`);
  }

  const normalized = ascii.endsWith(".") ? ascii.slice(0, -1) : ascii;
  const labels = normalized.split(".");
  if (labels.length < 2) {
    throw new Error(`Invalid domain format: "${domain}".`);
  }

  for (const label of labels) {
    if (label.length < 1 || label.length > 63) {
      throw new Error(`Invalid domain label length in "${domain}".`);
    }
    if (!/^[a-z0-9-]+$/.test(label) || label.startsWith("-") || label.endsWith("-")) {
      throw new Error(`Invalid domain label "${label}" in "${domain}".`);
    }
  }
}
