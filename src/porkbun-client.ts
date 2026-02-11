export type PorkbunApiResponse = Record<string, unknown>;

export interface PorkbunClientOptions {
  apiKey: string;
  secretKey: string;
  baseUrl: string;
}

interface RequestOptions {
  auth?: boolean;
}

type EndpointPart = string | number | undefined | null;
const REQUEST_TIMEOUT_MS = 30_000;

export class PorkbunClient {
  private readonly apiKey: string;
  private readonly secretKey: string;
  private readonly baseUrl: string;

  constructor(options: PorkbunClientOptions) {
    this.apiKey = options.apiKey;
    this.secretKey = options.secretKey;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
  }

  async ping(): Promise<PorkbunApiResponse> {
    return this.post(this.endpoint("ping"));
  }

  async pricingGet(): Promise<PorkbunApiResponse> {
    return this.post(this.endpoint("pricing", "get"), {}, { auth: false });
  }

  async domainsListAll(
    start?: number,
    includeLabels?: boolean,
  ): Promise<PorkbunApiResponse> {
    const payload: Record<string, unknown> = {};
    if (typeof start === "number") {
      payload.start = String(start);
    }
    if (typeof includeLabels === "boolean") {
      payload.includeLabels = includeLabels ? "yes" : "no";
    }
    return this.post(this.endpoint("domain", "listAll"), payload);
  }

  async domainsGetNameservers(domain: string): Promise<PorkbunApiResponse> {
    return this.post(this.endpoint("domain", "getNs", domain));
  }

  async domainsUpdateNameservers(
    domain: string,
    nameservers: string[],
  ): Promise<PorkbunApiResponse> {
    return this.post(this.endpoint("domain", "updateNs", domain), {
      ns: nameservers,
    });
  }

  async domainsGetUrlForwards(domain: string): Promise<PorkbunApiResponse> {
    return this.post(this.endpoint("domain", "getUrlForwarding", domain));
  }

  async domainsAddUrlForward(args: {
    domain: string;
    subdomain?: string;
    location: string;
    type?: "temporary" | "permanent";
    includePath?: boolean;
    wildcard?: boolean;
  }): Promise<PorkbunApiResponse> {
    const payload: Record<string, unknown> = {
      location: args.location,
    };

    if (args.subdomain !== undefined) {
      payload.subdomain = args.subdomain;
    }
    if (args.type !== undefined) {
      payload.type = args.type;
    }
    if (args.includePath !== undefined) {
      payload.includePath = args.includePath ? "yes" : "no";
    }
    if (args.wildcard !== undefined) {
      payload.wildcard = args.wildcard ? "yes" : "no";
    }

    return this.post(
      this.endpoint("domain", "addUrlForward", args.domain),
      payload,
    );
  }

  async domainsDeleteUrlForward(
    domain: string,
    recordId: string,
  ): Promise<PorkbunApiResponse> {
    return this.post(
      this.endpoint("domain", "deleteUrlForward", domain, recordId),
    );
  }

  async domainsCheckAvailability(domain: string): Promise<PorkbunApiResponse> {
    return this.post(this.endpoint("domain", "checkDomain", domain));
  }

  async domainsUpdateAutoRenew(args: {
    status: "on" | "off";
    domain?: string;
    domains?: string[];
  }): Promise<PorkbunApiResponse> {
    const payload: Record<string, unknown> = { status: args.status };
    if (args.domains && args.domains.length > 0) {
      payload.domains = args.domains;
    }
    return this.post(this.endpoint("domain", "updateAutoRenew", args.domain), payload);
  }

  async domainsCreate(args: {
    domain: string;
    cost: number;
    agreeToTerms: "yes" | "1";
  }): Promise<PorkbunApiResponse> {
    return this.post(this.endpoint("domain", "create", args.domain), {
      cost: String(args.cost),
      agreeToTerms: args.agreeToTerms,
    });
  }

  async domainsGetGlueRecords(domain: string): Promise<PorkbunApiResponse> {
    return this.post(this.endpoint("domain", "getGlue", domain));
  }

  async domainsCreateGlueRecord(
    domain: string,
    hostSubdomain: string,
    ips: string[],
  ): Promise<PorkbunApiResponse> {
    return this.post(this.endpoint("domain", "createGlue", domain, hostSubdomain), {
      ips,
    });
  }

  async domainsUpdateGlueRecord(
    domain: string,
    hostSubdomain: string,
    ips: string[],
  ): Promise<PorkbunApiResponse> {
    return this.post(this.endpoint("domain", "updateGlue", domain, hostSubdomain), {
      ips,
    });
  }

  async domainsDeleteGlueRecord(
    domain: string,
    hostSubdomain: string,
  ): Promise<PorkbunApiResponse> {
    return this.post(this.endpoint("domain", "deleteGlue", domain, hostSubdomain));
  }

  async dnsList(domain: string): Promise<PorkbunApiResponse> {
    return this.post(this.endpoint("dns", "retrieve", domain));
  }

  async dnsGet(domain: string, recordId: string): Promise<PorkbunApiResponse> {
    return this.post(this.endpoint("dns", "retrieve", domain, recordId));
  }

  async dnsGetByNameType(
    domain: string,
    type: string,
    subdomain?: string,
  ): Promise<PorkbunApiResponse> {
    return this.post(
      this.endpoint("dns", "retrieveByNameType", domain, type, subdomain),
    );
  }

  async dnsCreate(args: {
    domain: string;
    type: string;
    content: string;
    name?: string;
    ttl?: number;
    prio?: number;
    notes?: string;
  }): Promise<PorkbunApiResponse> {
    const payload: Record<string, unknown> = {
      type: args.type,
      content: args.content,
    };

    if (args.name !== undefined) {
      payload.name = args.name;
    }
    if (args.ttl !== undefined) {
      payload.ttl = String(args.ttl);
    }
    if (args.prio !== undefined) {
      payload.prio = String(args.prio);
    }
    if (args.notes !== undefined) {
      payload.notes = args.notes;
    }

    return this.post(this.endpoint("dns", "create", args.domain), payload);
  }

  async dnsEdit(args: {
    domain: string;
    recordId: string;
    type: string;
    content: string;
    name?: string;
    ttl?: number;
    prio?: number;
    notes?: string;
  }): Promise<PorkbunApiResponse> {
    const payload: Record<string, unknown> = {
      type: args.type,
      content: args.content,
    };

    if (args.name !== undefined) {
      payload.name = args.name;
    }
    if (args.ttl !== undefined) {
      payload.ttl = String(args.ttl);
    }
    if (args.prio !== undefined) {
      payload.prio = String(args.prio);
    }
    if (args.notes !== undefined) {
      payload.notes = args.notes;
    }

    return this.post(
      this.endpoint("dns", "edit", args.domain, args.recordId),
      payload,
    );
  }

  async dnsEditByNameType(args: {
    domain: string;
    type: string;
    content: string;
    subdomain?: string;
    ttl?: number;
    prio?: number;
    notes?: string;
  }): Promise<PorkbunApiResponse> {
    const payload: Record<string, unknown> = {
      content: args.content,
    };

    if (args.ttl !== undefined) {
      payload.ttl = String(args.ttl);
    }
    if (args.prio !== undefined) {
      payload.prio = String(args.prio);
    }
    if (args.notes !== undefined) {
      payload.notes = args.notes;
    }

    return this.post(
      this.endpoint("dns", "editByNameType", args.domain, args.type, args.subdomain),
      payload,
    );
  }

  async dnsDelete(domain: string, recordId: string): Promise<PorkbunApiResponse> {
    return this.post(this.endpoint("dns", "delete", domain, recordId));
  }

  async dnsDeleteByNameType(
    domain: string,
    type: string,
    subdomain?: string,
  ): Promise<PorkbunApiResponse> {
    return this.post(
      this.endpoint("dns", "deleteByNameType", domain, type, subdomain),
    );
  }

  async dnssecList(domain: string): Promise<PorkbunApiResponse> {
    return this.post(this.endpoint("dns", "getDnsSec", domain));
  }

  async dnssecCreate(args: {
    domain: string;
    keyTag: number;
    alg: string;
    digestType: string;
    digest: string;
    maxSigLife?: number;
    keyDataFlags?: string;
    keyDataProtocol?: string;
    keyDataAlgo?: string;
    keyDataPubKey?: string;
  }): Promise<PorkbunApiResponse> {
    const payload: Record<string, unknown> = {
      keyTag: String(args.keyTag),
      alg: args.alg,
      digestType: args.digestType,
      digest: args.digest,
    };

    if (args.maxSigLife !== undefined) {
      payload.maxSigLife = String(args.maxSigLife);
    }
    if (args.keyDataFlags !== undefined) {
      payload.keyDataFlags = args.keyDataFlags;
    }
    if (args.keyDataProtocol !== undefined) {
      payload.keyDataProtocol = args.keyDataProtocol;
    }
    if (args.keyDataAlgo !== undefined) {
      payload.keyDataAlgo = args.keyDataAlgo;
    }
    if (args.keyDataPubKey !== undefined) {
      payload.keyDataPubKey = args.keyDataPubKey;
    }

    return this.post(this.endpoint("dns", "createDnsSec", args.domain), payload);
  }

  async dnssecDelete(domain: string, keyTag: number): Promise<PorkbunApiResponse> {
    return this.post(this.endpoint("dns", "deleteDnsSec", domain, keyTag));
  }

  async sslRetrieve(domain: string): Promise<PorkbunApiResponse> {
    return this.post(this.endpoint("ssl", "retrieve", domain));
  }

  private endpoint(...parts: EndpointPart[]): string {
    return parts
      .filter(
        (part): part is string | number =>
          part !== undefined && part !== null && String(part).length > 0,
      )
      .map((part) => encodeURIComponent(String(part)))
      .join("/");
  }

  private async post(
    endpoint: string,
    payload: Record<string, unknown> = {},
    options: RequestOptions = {},
  ): Promise<PorkbunApiResponse> {
    const auth = options.auth !== false;
    const requestPayload = auth
      ? {
          secretapikey: this.secretKey,
          apikey: this.apiKey,
          ...payload,
        }
      : payload;

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/${endpoint}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(requestPayload),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError")
      ) {
        throw new Error(
          `Porkbun API request timed out after ${REQUEST_TIMEOUT_MS}ms (${endpoint}).`,
        );
      }
      throw error;
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Error(
        `Porkbun API returned a non-JSON response (HTTP ${response.status}).`,
      );
    }

    if (!response.ok) {
      throw new Error(
        `Porkbun API request failed with HTTP ${response.status} ${response.statusText}.`,
      );
    }

    if (!isRecord(body)) {
      throw new Error("Porkbun API returned an invalid JSON object.");
    }

    const status = typeof body.status === "string" ? body.status : "";
    if (status.toUpperCase() !== "SUCCESS") {
      const message =
        typeof body.message === "string"
          ? body.message
          : `Porkbun API error (status: ${status || "UNKNOWN"}).`;
      throw new Error(message);
    }

    return body;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
