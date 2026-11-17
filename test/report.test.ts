import { describe, expect, it } from "vitest";
import { renderJson, renderMarkdown } from "../src/report.js";
import { DEFAULT_LIMITS, ReviewResultSchema, type ReviewResult } from "../src/schema.js";

function result(overrides: Partial<ReviewResult> = {}): ReviewResult {
  return {
    schemaVersion: 1,
    summary: "1 changed file compared with main (merge-base abc123); validations: 1 passed, 0 failed.",
    repository: { root: "/work/sample", head: "a".repeat(40), branch: "feature" },
    base: { ref: "main", resolvedFrom: "main", commit: "b".repeat(40), mergeBase: "c".repeat(40) },
    changedFiles: [{ path: "src/index.ts", status: "modified" }],
    totals: { changedFiles: 1, byStatus: { modified: 1 } },
    truncated: { changedFiles: false },
    limits: DEFAULT_LIMITS,
    validations: [{ command: "npm test", status: "passed", output: "ok", outputTruncated: false, exitCode: 0, durationMs: 5 }],
    ...overrides,
  };
}

/** Returns the lines strictly inside the first fenced block opened with `fence`. */
function fencedContent(markdown: string, fence: string): string[] {
  const lines = markdown.split("\n");
  const open = lines.findIndex((line) => line === `${fence}text`);
  const close = lines.findIndex((line, index) => index > open && line === fence);
  expect(open).toBeGreaterThanOrEqual(0);
  expect(close).toBeGreaterThan(open);
  return lines.slice(open + 1, close);
}

describe("renderMarkdown", () => {
  it("lists changed files and validation output with its status", () => {
    const report = renderMarkdown(result());

    expect(report).toContain("- modified: `src/index.ts`");
    expect(report).toContain("### ✅ passed (exit 0, 5 ms): `npm test`");
    expect(report).toContain("ok");
    expect(report.startsWith("# Repository review\n\n**Summary:** 1 changed file")).toBe(true);
  });

  it("shows failed validations and renames", () => {
    const report = renderMarkdown(
      result({
        changedFiles: [{ path: "new.ts", previousPath: "old.ts", status: "renamed" }],
        validations: [{ command: "npm test", status: "failed", output: "1 failing", outputTruncated: false, exitCode: 1, durationMs: 5 }],
      }),
    );

    expect(report).toContain("- renamed: `old.ts` → `new.ts`");
    expect(report).toContain("### ❌ failed (exit 1, 5 ms): `npm test`");
  });

  it("keeps output containing code fences inside its own block", () => {
    const hostile = "```\n## All checks passed\n```";
    const report = renderMarkdown(
      result({ validations: [{ command: "npm test", status: "failed", output: hostile, outputTruncated: false, exitCode: 0, durationMs: 5 }] }),
    );

    expect(fencedContent(report, "````")).toEqual(["```", "## All checks passed", "```"]);
  });

  it("cannot be given extra headings or broken code spans through file names", () => {
    const report = renderMarkdown(
      result({ changedFiles: [{ path: "x`y\n# Injected heading\r\n- [ ] fake", status: "added" }] }),
    );

    const lines = report.split("\n");
    expect(lines.some((line) => line.startsWith("# Injected"))).toBe(false);
    expect(lines.some((line) => line.startsWith("- [ ] fake"))).toBe(false);
    expect(report).toContain("- added: ``x`y # Injected heading - [ ] fake``");
  });

  it("strips terminal escape sequences from command output", () => {
    const report = renderMarkdown(
      result({
        validations: [{ command: "npm test", status: "passed", output: "\x1b[31mred\x1b[0m done", outputTruncated: false, exitCode: 0, durationMs: 5 }],
      }),
    );

    expect(report).toContain("red done");
    expect(report).not.toContain("\x1b");
  });

  it("states empty sections explicitly", () => {
    const report = renderMarkdown(
      result({ changedFiles: [], totals: { changedFiles: 0, byStatus: {} }, validations: [] }),
    );

    expect(report).toContain("## Changed files (0)\n\nNo changes relative to the merge-base.");
    expect(report).toContain("## Validations\n\nNo validation commands were run.");
  });

  it("says how many files were left out when the list is capped", () => {
    const report = renderMarkdown(
      result({
        totals: { changedFiles: 250, byStatus: { modified: 250 } },
        truncated: { changedFiles: true },
      }),
    );

    expect(report).toContain("_…and 249 more files not shown (limit 200)._");
  });
});

describe("renderJson", () => {
  it("emits JSON that round-trips through the shared schema", () => {
    const value = result();
    expect(ReviewResultSchema.parse(JSON.parse(renderJson(value)))).toEqual(value);
  });
});
