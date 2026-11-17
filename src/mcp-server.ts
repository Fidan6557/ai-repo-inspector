#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { InspectorError } from "./errors.js";
import { createMcpServer, parseServerArgs, SERVER_USAGE } from "./mcp-app.js";

// stdout carries the MCP protocol; diagnostics go to stderr only.
let parsed;
try {
  parsed = parseServerArgs(process.argv.slice(2));
} catch (error) {
  // Fail closed: a misconfigured scope must not start an unrestricted server.
  const message = error instanceof InspectorError ? error.format() : String(error);
  process.stderr.write(`${message}\n${SERVER_USAGE}\n`);
  process.exit(2);
}

if (parsed.help) {
  process.stderr.write(`${SERVER_USAGE}\n`);
} else {
  if (!parsed.policy.restricted) {
    process.stderr.write(
      "repository-inspector: no --allowed-root configured; any absolute path readable by this user can be inspected.\n",
    );
  }
  await createMcpServer({ policy: parsed.policy }).connect(new StdioServerTransport());
}
