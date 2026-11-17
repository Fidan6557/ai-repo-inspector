#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./mcp-app.js";

// stdout carries the MCP protocol; nothing else may be written to it.
await createMcpServer().connect(new StdioServerTransport());
