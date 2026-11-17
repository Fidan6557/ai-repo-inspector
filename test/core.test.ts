import { afterEach, describe, expect, it } from "vitest";
import { reviewRepository, truncateMiddle } from "../src/core.js";
import { ReviewResultSchema } from "../src/schema.js";
import { cleanupRepos, createRepo } from "./helpers.js";

afterEach(cleanupRepos);

describe("reviewRepository", () => {
  it("returns a deterministic result that matches the shared schema", async () => {
    const repo = createRepo();
    repo.write("seed.txt");
    repo.commitAll("initial");
    repo.write("seed.txt", "changed\n");
    repo.write("new.txt");

    const first = await reviewRepository({ repositoryPath: repo.root });
    const second = await reviewRepository({ repositoryPath: repo.root });

    expect(ReviewResultSchema.parse(first)).toEqual(first);
    expect(second).toEqual(first);
    expect(first.totals).toEqual({ changedFiles: 2, byStatus: { modified: 1, untracked: 1 } });
    expect(first.summary).toMatch(/^2 changed files compared with main \(merge-base [0-9a-f]{12}\); no validation/);
  });

  it("caps the file list and reports the true total", async () => {
    const repo = createRepo();
    repo.write("seed.txt");
    repo.commitAll("initial");
    for (const name of ["a.txt", "b.txt", "c.txt"]) repo.write(name);

    const result = await reviewRepository({ repositoryPath: repo.root, limits: { maxFiles: 2 } });

    expect(result.changedFiles.map((file) => file.path)).toEqual(["a.txt", "b.txt"]);
    expect(result.totals.changedFiles).toBe(3);
    expect(result.truncated.changedFiles).toBe(true);
  });
});

describe("truncateMiddle", () => {
  it("keeps the head and the tail of long output", () => {
    const { text, truncated } = truncateMiddle(`START${"x".repeat(10_000)}END`, 100);

    expect(truncated).toBe(true);
    expect(text.startsWith("START")).toBe(true);
    expect(text.endsWith("END")).toBe(true);
    expect(text).toContain("characters omitted");
  });
});
