import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupRepos, createRepo } from "./helpers.js";

// These tests run the two shipped entry points as separate processes, exactly
// as a developer (shell) and an MCP client (stdio) would, and require them to
// produce the same result from the same repository state.

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const RUN_TS = ["--import", "tsx"];

afterEach(cleanupRepos);

function runRealCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...RUN_TS, path.join(PROJECT_ROOT, "src", "cli.ts"), ...args], {
      cwd: PROJECT_ROOT,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function withRealMcpServer<T>(use: (client: Client) => Promise<T>): Promise<T> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [...RUN_TS, path.join(PROJECT_ROOT, "src", "mcp-server.ts")],
    cwd: PROJECT_ROOT,
    stderr: "pipe",
  });
  const client = new Client({ name: "parity-test", version: "0.0.0" });
  await client.connect(transport);
  try {
    await client.listTools();
    return await use(client);
  } finally {
    await client.close();
  }
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as Array<{ type: string; text: string }>)[0].text;
}

function featureBranchRepo() {
  const repo = createRepo({ dirName: "parity repo" });
  repo.write("keep.txt");
  repo.write("edit.txt");
  repo.write("rename-me.txt", "content that survives the rename\n".repeat(4));
  repo.commitAll("initial");
  repo.git("checkout", "-q", "-b", "feature");
  repo.write("committed.txt");
  repo.commitAll("feature commit");
  repo.git("mv", "rename-me.txt", "renamed.txt");
  repo.write("staged.txt");
  repo.git("add", "staged.txt");
  repo.write("edit.txt", "unstaged edit\n");
  repo.write("untracked.txt");
  return repo;
}

// Spawning tsx processes takes ~1.5 s alone but can exceed the 20 s default
// when the whole suite runs in parallel on a loaded machine.
describe("CLI and MCP parity (real processes)", { timeout: 60_000 }, () => {
  it("return identical structured results and identical Markdown for the same repository", async () => {
    const repo = featureBranchRepo();

    const [cliJson, cliMarkdown, mcp] = await Promise.all([
      runRealCli(["review", "--repo", repo.root, "--format", "json", "--output", "-"]),
      runRealCli(["review", "--repo", repo.root, "--format", "markdown", "--output", "-"]),
      withRealMcpServer((client) =>
        client.callTool({ name: "review_repository", arguments: { repo_path: repo.root } }),
      ),
    ]);

    expect(cliJson.code, cliJson.stderr).toBe(0);
    expect(cliMarkdown.code, cliMarkdown.stderr).toBe(0);
    expect(mcp.isError).toBeFalsy();

    const cliResult = JSON.parse(cliJson.stdout);
    expect(cliResult).toEqual(mcp.structuredContent);
    expect(cliMarkdown.stdout).toBe(textOf(mcp));

    // Sanity-check that the shared result really covers every change kind.
    expect(cliResult.changedFiles.map((file: { status: string; path: string }) => `${file.status} ${file.path}`)).toEqual([
      "added committed.txt",
      "modified edit.txt",
      "renamed renamed.txt",
      "added staged.txt",
      "untracked untracked.txt",
    ]);
  });

  it.each([
    ["does-not-exist", "BASE_REF_NOT_FOUND"],
    ["--output=pwned", "INVALID_BASE_REF"],
  ])("report the same error for base ref %s", async (baseRef, code) => {
    const repo = featureBranchRepo();

    const [cli, mcp] = await Promise.all([
      runRealCli(["review", "--repo", repo.root, `--base-ref=${baseRef}`, "--output", "-"]),
      withRealMcpServer((client) =>
        client.callTool({ name: "review_repository", arguments: { repo_path: repo.root, base_ref: baseRef } }),
      ),
    ]);

    expect(cli.code).toBe(2);
    expect(cli.stdout).toBe("");
    expect(mcp.isError).toBe(true);
    expect(textOf(mcp).startsWith(`error[${code}]:`)).toBe(true);
    expect(cli.stderr.trim()).toBe(textOf(mcp));
  });
});
