import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

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

export function createPorkbunServer(config: RuntimeConfig): McpServer {
  const server = new McpServer({
    name: "porkbun-mcp",
    version: "0.3.0",
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

  const wrap =
    <TArgs extends Record<string, unknown>>(
      handler: (args: TArgs) => Promise<unknown>,
    ) =>
    async (args: TArgs) => {
      try {
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
      for (;;) {
        const page = await client.domainsListAll(cursor, includeLabels);
        const domains = Array.isArray(page.domains) ? page.domains : [];
        allDomains.push(...domains);
        if (domains.length < 1000) {
          break;
        }
        cursor += 1000;
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
    "domains_get_glue_records",
    {
      domain: z.string().min(1),
    },
    wrap(async (args) => client.domainsGetGlueRecords(args.domain)),
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
