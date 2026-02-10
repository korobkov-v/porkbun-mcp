#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import {
  parseCliOptions,
  printHelp,
  resolveRuntimeConfig,
} from "./config.js";
import { createPorkbunServer } from "./server.js";

async function main(): Promise<void> {
  const cli = parseCliOptions(process.argv.slice(2));
  if (cli.help) {
    printHelp();
    return;
  }

  const runtimeConfig = resolveRuntimeConfig(cli);
  const server = createPorkbunServer(runtimeConfig);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`porkbun-mcp startup failed: ${message}\n`);
  process.exit(1);
});
