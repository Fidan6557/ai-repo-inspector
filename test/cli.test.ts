import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli-app.js";
import { ReviewResultSchema } from "../src/schema.js";
import { cleanupRepos, createRepo } from "./helpers.js";

afterEach(cleanupRepos);

async function cli(argv: string[], cwd = process.cwd()) {
  let stdout = "";
  let stderr = "";
  const code = await runCli(argv, {
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
    cwd,
  });
  return { code, stdout, stderr };
}

function repoWithChange(dirName?: string) {
  const repo = createRepo({ dirName });
  repo.write("seed.txt");
  repo.commitAll("initial");
  repo.write("seed.txt", "changed\n");
  return repo;
}

describe("inspector CLI", () => {
  it("prints help", async () => {
    const { code, stdout } = await cli(["--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("Usage: inspector review --repo <path>");
  });

  it("keeps repository paths containing spaces intact and emits schema-valid JSON", async () => {
    const repo = repoWithChange("my repo");

    const { code, stdout } = await cli(["review", "--repo", repo.root, "--format", "json", "--output", "-"]);

    expect(code).toBe(0);
    const result = ReviewResultSchema.parse(JSON.parse(stdout));
    expect(result.repository.root).toBe(path.resolve(repo.root));
    expect(result.changedFiles).toEqual([{ path: "seed.txt", status: "modified" }]);
  });

  it("accepts --option=value syntax and resolves --repo against the working directory", async () => {
    const repo = repoWithChange();

    const { code, stdout } = await cli(["review", "--repo=.", "--format=json", "--output=-"], repo.root);

    expect(code).toBe(0);
    expect(JSON.parse(stdout).repository.root).toBe(path.resolve(repo.root));
  });

  it("writes the Markdown report to review-report.md by default and keeps stdout clean", async () => {
    const repo = repoWithChange();

    const { code, stdout, stderr } = await cli(["review", "--repo", repo.root], path.dirname(repo.root));

    expect(code).toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toContain("Review report written to");
    const report = readFileSync(path.join(path.dirname(repo.root), "review-report.md"), "utf8");
    expect(report).toContain("- modified: `seed.txt`");
  });

  it.each([
    [["review", "--repo", ".", "--valdiate", "npm test"], "Unknown option '--valdiate'"],
    [["review", "--repo", ".", "--validate"], "argument missing"],
    [["review", "--repo", ".", "--format", "xml"], '--format must be "markdown" or "json"'],
    [["review"], "--repo is required"],
    [["inspect", "--repo", "."], "Unknown command: inspect"],
  ])("rejects invalid usage %j with exit code 2", async (argv, message) => {
    const { code, stderr } = await cli(argv);
    expect(code).toBe(2);
    expect(stderr).toContain("error[INVALID_ARGUMENTS]");
    expect(stderr).toContain(message);
  });

  it("rejects an option-like base ref with exit code 2 and creates no file", async () => {
    const repo = repoWithChange();
    const before = readdirSync(repo.root).sort();

    const { code, stderr } = await cli(["review", "--repo", repo.root, "--base-ref=--output=pwned", "--output", "-"]);

    expect(code).toBe(2);
    expect(stderr).toContain("error[INVALID_BASE_REF]");
    expect(readdirSync(repo.root).sort()).toEqual(before);
  });

  it("reports a non-repository path as an input error", async () => {
    const repo = createRepo();
    const { code, stderr } = await cli(["review", "--repo", path.join(repo.root, "missing")]);
    expect(code).toBe(2);
    expect(stderr).toContain("error[INVALID_REPOSITORY]");
  });

  it("includes passing validation output and exits 0", async () => {
    const repo = repoWithChange();

    const { code, stdout } = await cli([
      "review", "--repo", repo.root, "--format", "json", "--output", "-",
      "--validate", `node -e "console.log('validated ok')"`,
    ]);

    expect(code).toBe(0);
    const [validation] = JSON.parse(stdout).validations;
    expect(validation).toMatchObject({ status: "passed", outputTruncated: false });
    expect(validation.output).toContain("validated ok");
  });

  it("still writes the report, runs remaining commands, and exits 1 when a validation fails", async () => {
    const repo = repoWithChange();

    const { code, stdout, stderr } = await cli([
      "review", "--repo", repo.root, "--output", "-",
      "--validate", `node -e "console.error('boom');process.exit(3)"`,
      "--validate", `node -e "console.log('second ran')"`,
    ]);

    expect(code).toBe(1);
    expect(stdout).toContain("### ❌ failed (exit 3,");
    expect(stdout).toContain("boom");
    expect(stdout).toContain("### ✅ passed (exit 0,");
    expect(stdout).toContain("second ran");
    expect(stderr).toContain("validations: 1 passed, 1 failed.");
    expect(stderr).not.toMatch(/\n\s+at /);
  });

  it("times out hanging validations instead of waiting forever", async () => {
    const repo = repoWithChange();

    const { code, stdout } = await cli([
      "review", "--repo", repo.root, "--format", "json", "--output", "-",
      "--timeout", "0.5", "--validate", `node -e "setTimeout(()=>{},60000)"`,
    ]);

    expect(code).toBe(1);
    expect(JSON.parse(stdout).validations[0]).toMatchObject({ status: "timed_out" });
  });

  it("rejects a non-positive timeout", async () => {
    const { code, stderr } = await cli(["review", "--repo", ".", "--timeout", "0"]);
    expect(code).toBe(2);
    expect(stderr).toContain("--timeout must be a positive number of seconds");
  });
});
