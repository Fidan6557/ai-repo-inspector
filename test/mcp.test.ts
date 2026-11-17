import { existsSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpServer } from "../src/mcp-app.js";
import { ReviewResultSchema } from "../src/schema.js";
import { cleanupRepos, createRepo } from "./helpers.js";

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  cleanupRepos();
});

async function connect() {
  const server = createMcpServer();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  closers.push(async () => {
    await client.close();
    await server.close();
  });
  // Listing tools also primes the client's validation of structuredContent.
  const { tools } = await client.listTools();
  return { client, tools };
}

function repoWithChange() {
  const repo = createRepo();
  repo.write("seed.txt");
  repo.commitAll("initial");
  repo.write("seed.txt", "changed\n");
  return repo;
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const [first] = result.content as Array<{ type: string; text: string }>;
  return first.text;
}

describe("MCP review_repository", () => {
  it("advertises a single read-only tool with a snake_case, closed input schema", async () => {
    const { tools } = await connect();

    expect(tools.map((tool) => tool.name)).toEqual(["review_repository"]);
    const [tool] = tools;
    expect(Object.keys(tool.inputSchema.properties ?? {}).sort()).toEqual(["base_ref", "repo_path"]);
    expect(tool.inputSchema.required).toEqual(["repo_path"]);
    expect(tool.inputSchema.additionalProperties).toBe(false);
    expect(tool.outputSchema).toBeDefined();
    expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    expect(tool.description).toContain("never runs commands");
  });

  it("reviews the repository named by repo_path, not the server's working directory", async () => {
    const repo = repoWithChange();
    const { client } = await connect();

    const result = await client.callTool({ name: "review_repository", arguments: { repo_path: repo.root } });

    expect(result.isError).toBeFalsy();
    const structured = ReviewResultSchema.parse(result.structuredContent);
    expect(structured.repository.root).toBe(path.resolve(repo.root));
    expect(structured.repository.root).not.toBe(path.resolve(process.cwd()));
    expect(structured.changedFiles).toEqual([{ path: "seed.txt", status: "modified" }]);
    expect(structured.validations).toEqual([]);
    expect(textOf(result)).toContain("- modified: `seed.txt`");
  });

  it("rejects command arguments instead of running them", async () => {
    const repo = repoWithChange();
    const { client } = await connect();
    const marker = path.join(repo.root, "marker.txt");

    const result = await client.callTool({
      name: "review_repository",
      arguments: {
        repo_path: repo.root,
        validationCommands: [`node -e "require('fs').writeFileSync('marker.txt', 'ran')"`],
      },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("validationCommands");
    expect(existsSync(marker)).toBe(false);
  });

  it("rejects the old camelCase field instead of silently reviewing the wrong directory", async () => {
    const repo = repoWithChange();
    const { client } = await connect();

    const result = await client.callTool({ name: "review_repository", arguments: { repoPath: repo.root } });

    expect(result.isError).toBe(true);
  });

  it.each([
    [{ repo_path: "relative/repo" }, "error[INVALID_REPOSITORY]: repo_path must be an absolute path"],
    [{ repo_path: path.resolve("definitely-missing-dir") }, "error[INVALID_REPOSITORY]"],
  ])("returns actionable tool errors for bad repository paths %j", async (args, message) => {
    const { client } = await connect();

    const result = await client.callTool({ name: "review_repository", arguments: args });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(message);
  });

  it("rejects option-like base refs as a tool error", async () => {
    const repo = repoWithChange();
    const { client } = await connect();

    const result = await client.callTool({
      name: "review_repository",
      arguments: { repo_path: repo.root, base_ref: "--output=pwned" },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("error[INVALID_BASE_REF]");
  });
});
