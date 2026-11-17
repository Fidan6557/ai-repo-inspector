import { spawn } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InspectorError } from "../src/errors.js";
import { createMcpServer, parseServerArgs } from "../src/mcp-app.js";
import { isWithin, PathPolicy } from "../src/path-policy.js";
import { ReviewResultSchema } from "../src/schema.js";
import { cleanupRepos, createRepo, makeTempDir, type Fixture } from "./helpers.js";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  cleanupRepos();
});

/** Directory links that work without elevated rights on Windows (junctions). */
function linkDirectory(target: string, linkPath: string): void {
  symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
}

function repoWithChange(options: Parameters<typeof createRepo>[0]): Fixture {
  const repo = createRepo(options);
  repo.write("seed.txt");
  repo.commitAll("initial");
  repo.write("seed.txt", "changed\n");
  return repo;
}

async function connect(policy: PathPolicy) {
  const server = createMcpServer({ policy });
  const client = new Client({ name: "policy-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  closers.push(async () => {
    await client.close();
    await server.close();
  });
  const { tools } = await client.listTools();
  const review = async (repoPath: string) => {
    const result = await client.callTool({ name: "review_repository", arguments: { repo_path: repoPath } });
    const text = (result.content as Array<{ text: string }>)[0].text;
    return { result, text };
  };
  return { tools, review };
}

describe("isWithin", () => {
  const root = path.resolve("/srv/allowed");

  it.each([
    [root, true],
    [path.join(root, "repo"), true],
    [path.join(root, "..hidden-but-inside"), true],
    [path.resolve("/srv/allowed-evil"), false],
    [path.resolve("/srv"), false],
    [path.join(root, "..", "other"), false],
  ])("isWithin(root, %s) is %s", (target, expected) => {
    expect(isWithin(root, target)).toBe(expected);
  });
});

describe("MCP allowed-root scoping", () => {
  let base: string;
  let allowed: string;
  let inside: Fixture;
  let outside: Fixture;
  let policy: PathPolicy;

  beforeEach(() => {
    base = makeTempDir();
    allowed = path.join(base, "allowed");
    mkdirSync(allowed);
    inside = repoWithChange({ parentDir: allowed, dirName: "inside-repo" });
    outside = repoWithChange({ parentDir: base, dirName: "outside-repo" });
    policy = PathPolicy.fromRoots([allowed]);
  });

  describe("allows", () => {
    it("a repository inside the root, reporting its canonical path, and advertises the scope", async () => {
      const { tools, review } = await connect(policy);

      const { result } = await review(inside.root);

      expect(result.isError).toBeFalsy();
      const structured = ReviewResultSchema.parse(result.structuredContent);
      expect(structured.repository.root).toBe(inside.root);
      expect(structured.changedFiles).toEqual([{ path: "seed.txt", status: "modified" }]);
      expect(tools[0].description).toContain(`Only repositories inside these directories may be inspected: ${allowed}`);
      expect(tools[0].annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    });

    it("non-canonical spellings that stay inside the root", async () => {
      const { review } = await connect(policy);
      const spelled = `${allowed}${path.sep}.${path.sep}x${path.sep}..${path.sep}inside-repo`;

      const { result } = await review(spelled);

      expect(result.isError).toBeFalsy();
      expect(ReviewResultSchema.parse(result.structuredContent).repository.root).toBe(inside.root);
    });

    it("a subdirectory of an allowed repository", async () => {
      inside.write("pkg/sub/file.txt");
      const { review } = await connect(policy);

      const { result } = await review(path.join(inside.root, "pkg", "sub"));

      expect(result.isError).toBeFalsy();
    });

    it("a link inside the root that points elsewhere inside the root", async () => {
      const link = path.join(allowed, "link-to-inside");
      linkDirectory(inside.root, link);
      const { review } = await connect(policy);

      const { result } = await review(link);

      expect(result.isError).toBeFalsy();
      expect(ReviewResultSchema.parse(result.structuredContent).repository.root).toBe(inside.root);
    });

    it("any of several roots, including a root that is itself the repository", async () => {
      const { review } = await connect(PathPolicy.fromRoots([allowed, outside.root]));

      expect((await review(inside.root)).result.isError).toBeFalsy();
      expect((await review(outside.root)).result.isError).toBeFalsy();
    });
  });

  describe("rejects", () => {
    async function expectNotAllowed(repoPath: string, what: string) {
      const { review } = await connect(policy);
      const { result, text } = await review(repoPath);
      expect(result.isError).toBe(true);
      expect(text).toContain("error[PATH_NOT_ALLOWED]");
      expect(text).toContain(what);
      expect(result.structuredContent).toBeUndefined();
    }

    it("a repository outside the root", async () => {
      await expectNotAllowed(outside.root, "repo_path is outside the allowed roots");
    });

    it("path traversal out of the root", async () => {
      await expectNotAllowed(`${allowed}${path.sep}..${path.sep}outside-repo`, "repo_path is outside");
    });

    it("a sibling directory that merely shares the root's name as a prefix", async () => {
      const evil = repoWithChange({ parentDir: base, dirName: "allowed-evil" });
      await expectNotAllowed(evil.root, "repo_path is outside");
    });

    it("a symlink or junction inside the root that escapes it", async () => {
      const link = path.join(allowed, "escape");
      linkDirectory(outside.root, link);
      await expectNotAllowed(link, "after resolving links");
    });

    it("a directory inside the root whose repository top level is outside it", async () => {
      outside.write("sub/file.txt");
      outside.commitAll("add sub");
      const { review } = await connect(PathPolicy.fromRoots([path.join(outside.root, "sub")]));

      const { result, text } = await review(path.join(outside.root, "sub"));

      expect(result.isError).toBe(true);
      expect(text).toContain("error[PATH_NOT_ALLOWED]: Repository root is outside the allowed roots");
    });

    it("a .git file inside the root that redirects to a git directory outside it", async () => {
      const redirected = path.join(allowed, "redirected");
      mkdirSync(redirected);
      writeFileSync(path.join(redirected, ".git"), `gitdir: ${path.join(outside.root, ".git").replaceAll("\\", "/")}\n`);
      await expectNotAllowed(redirected, "Repository git directory is outside the allowed roots");
    });

    it("missing paths outside the root without revealing whether they exist", async () => {
      await expectNotAllowed(path.join(base, "does-not-exist"), "repo_path is outside");

      const { review } = await connect(policy);
      const { text } = await review(path.join(allowed, "does-not-exist"));
      expect(text).toContain("error[INVALID_REPOSITORY]: Repository path does not exist");
    });
  });
});

describe("server configuration", () => {
  it("is unrestricted without --allowed-root and canonicalizes configured roots", () => {
    expect(parseServerArgs([]).policy.restricted).toBe(false);

    const dir = makeTempDir();
    const spelled = path.join(dir, "x", "..");
    const { policy } = parseServerArgs(["--allowed-root", spelled, "--allowed-root", dir]);
    expect(policy.roots).toEqual([dir]);
  });

  it.each([
    [["--allowed-root", path.join(PROJECT_ROOT, "definitely-missing")], "Allowed root does not exist"],
    [["--allowed-root", path.join(PROJECT_ROOT, "package.json")], "not a directory"],
    [["--allowd-root", PROJECT_ROOT], "Unknown option"],
    [["--allowed-root"], "argument missing"],
  ])("fails closed for %j", (argv, message) => {
    let caught: unknown;
    try {
      parseServerArgs(argv);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InspectorError);
    expect((caught as InspectorError).code).toBe("INVALID_ARGUMENTS");
    expect((caught as InspectorError).message).toContain(message);
  });

  it("the real server process refuses to start with an invalid root", async () => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", path.join(PROJECT_ROOT, "src", "mcp-server.ts"), "--allowed-root", path.join(PROJECT_ROOT, "missing")],
      { cwd: PROJECT_ROOT, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));

    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("error[INVALID_ARGUMENTS]: Allowed root does not exist");
    expect(existsSync(path.join(PROJECT_ROOT, "missing"))).toBe(false);
  }, 60_000);
});
