export const DEFAULT_API_BASE_URL = "https://api.porkbun.com/api/json/v3";
export const IPV4_API_BASE_URL = "https://api-ipv4.porkbun.com/api/json/v3";

export interface CliOptions {
  help: boolean;
  getMuddy: boolean;
  transport: "stdio";
  apiBaseUrl?: string;
  ipv4OnlyApi: boolean;
}

export interface RuntimeConfig {
  apiKey: string;
  secretKey: string;
  getMuddy: boolean;
  baseUrl: string;
}

export function parseCliOptions(args: string[]): CliOptions {
  const options: CliOptions = {
    help: false,
    getMuddy: false,
    transport: "stdio",
    apiBaseUrl: undefined,
    ipv4OnlyApi: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    if (arg === "--get-muddy") {
      options.getMuddy = true;
      continue;
    }

    if (arg === "--transport") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("Missing value for --transport.");
      }
      if (value !== "stdio") {
        throw new Error(
          `Unsupported transport "${value}". This project currently supports only "stdio".`,
        );
      }
      options.transport = value;
      index += 1;
      continue;
    }

    if (arg === "--api-base-url") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("Missing value for --api-base-url.");
      }
      options.apiBaseUrl = value;
      index += 1;
      continue;
    }

    if (arg === "--ipv4-only-api") {
      options.ipv4OnlyApi = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

export function resolveRuntimeConfig(cli: CliOptions): RuntimeConfig {
  const apiKey = process.env.PORKBUN_API_KEY?.trim();
  const secretKey = process.env.PORKBUN_SECRET_KEY?.trim();
  if (!apiKey || !secretKey) {
    throw new Error(
      "Missing PORKBUN_API_KEY or PORKBUN_SECRET_KEY environment variable.",
    );
  }

  const envGetMuddy = toBoolean(process.env.PORKBUN_GET_MUDDY);
  const getMuddy = cli.getMuddy || envGetMuddy;

  const envBaseUrl = process.env.PORKBUN_API_BASE_URL?.trim();
  const baseUrl =
    cli.apiBaseUrl ??
    envBaseUrl ??
    (cli.ipv4OnlyApi ? IPV4_API_BASE_URL : DEFAULT_API_BASE_URL);

  return {
    apiKey,
    secretKey,
    getMuddy,
    baseUrl: baseUrl.replace(/\/+$/, ""),
  };
}

export function printHelp(): void {
  const helpText = `porkbun-mcp

Usage:
  porkbun-mcp [options]

Options:
  --get-muddy            Enable write tools
  --transport stdio      MCP transport
  --api-base-url <url>   Override Porkbun API base URL
  --ipv4-only-api        Use api-ipv4.porkbun.com endpoint
  -h, --help             Show this help

Environment variables:
  PORKBUN_API_KEY        Required
  PORKBUN_SECRET_KEY     Required
  PORKBUN_GET_MUDDY      Optional (true/false)
  PORKBUN_API_BASE_URL   Optional
`;

  process.stdout.write(helpText);
}

function toBoolean(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  switch (value.trim().toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    default:
      return false;
  }
}
