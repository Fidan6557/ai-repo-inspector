import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InspectorError } from "../src/errors.js";
import { changedFiles, resolveBase, resolveRepository } from "../src/git.js";
import { cleanupRepos, createRepo } from "./helpers.js";

afterEach(cleanupRepos);

async function inspect(root: string, baseRef?: string) {
  const repository = await resolveRepository(root);
  const base = await resolveBase(repository.root, baseRef);
  return { repository, base, files: await changedFiles(repository.root, base.mergeBase) };
}

async function expectInspectorError(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(InspectorError);
  expect((error as InspectorError).code).toBe(code);
}

describe("change detection", () => {
  it("reports committed, staged, unstaged, deleted and untracked changes against the merge-base", async () => {
    const repo = createRepo();
    repo.write("a.txt");
    repo.write("b.txt");
    repo.write("c.txt");
    repo.write(".gitignore", "*.log\n");
    repo.commitAll("initial");

    repo.git("checkout", "-q", "-b", "feature");
    repo.write("a.txt", "committed change\n");
    repo.commitAll("feature work");
    repo.write("staged.txt");
    repo.git("add", "staged.txt");
    repo.write("b.txt", "unstaged change\n");
    repo.git("rm", "-q", "c.txt");
    repo.write("untracked.txt");
    repo.write("ignored.log");

    const { repository, base, files } = await inspect(repo.root);

    expect(repository.root).toBe(path.resolve(repo.root));
    expect(repository.branch).toBe("feature");
    expect(base).toMatchObject({ ref: "main", resolvedFrom: "main" });
    expect(files).toEqual([
      { path: "a.txt", status: "modified" },
      { path: "b.txt", status: "modified" },
      { path: "c.txt", status: "deleted" },
      { path: "staged.txt", status: "added" },
      { path: "untracked.txt", status: "untracked" },
    ]);
  });

  it("reports renames with their previous path instead of a tab-joined string", async () => {
    const repo = createRepo();
    repo.write("old-name.txt", "same content across the rename\n".repeat(5));
    repo.commitAll("initial");
    repo.git("mv", "old-name.txt", "new-name.txt");

    const { files } = await inspect(repo.root);

    expect(files).toEqual([{ path: "new-name.txt", previousPath: "old-name.txt", status: "renamed" }]);
  });

  it("handles spaces and non-ASCII characters in repository and file paths", async () => {
    const repo = createRepo({ dirName: "my repo" });
    repo.write("seed.txt");
    repo.commitAll("initial");
    repo.write("dir with space/naïve file.txt");

    const { repository, files } = await inspect(repo.root);

    expect(repository.root).toBe(path.resolve(repo.root));
    expect(files).toEqual([{ path: "dir with space/naïve file.txt", status: "untracked" }]);
  });

  it("falls back to master when there is no main branch", async () => {
    const repo = createRepo({ branch: "master" });
    repo.write("seed.txt");
    repo.commitAll("initial");
    repo.write("seed.txt", "changed\n");

    const { base, files } = await inspect(repo.root);

    expect(base).toMatchObject({ ref: "master", resolvedFrom: "master" });
    expect(files).toEqual([{ path: "seed.txt", status: "modified" }]);
  });

  it("accepts an explicit revision expression as the base", async () => {
    const repo = createRepo();
    repo.write("one.txt");
    repo.commitAll("one");
    repo.write("two.txt");
    repo.commitAll("two");

    const { base, files } = await inspect(repo.root, "HEAD~1");

    expect(base).toMatchObject({ ref: "HEAD~1", resolvedFrom: "argument" });
    expect(files).toEqual([{ path: "two.txt", status: "added" }]);
  });
});

describe("input validation", () => {
  it("rejects base refs that git would parse as options, without touching the filesystem", async () => {
    const repo = createRepo();
    repo.write("seed.txt");
    repo.commitAll("initial");
    const before = readdirSync(repo.root).sort();

    await expectInspectorError(resolveBase(repo.root, "--output=pwned.txt"), "INVALID_BASE_REF");
    await expectInspectorError(resolveBase(repo.root, "main\n--output=x"), "INVALID_BASE_REF");

    expect(readdirSync(repo.root).sort()).toEqual(before);
    expect(existsSync(path.join(repo.root, "pwned.txt...HEAD"))).toBe(false);
  });

  it("reports an unknown base ref clearly", async () => {
    const repo = createRepo();
    repo.write("seed.txt");
    repo.commitAll("initial");

    await expectInspectorError(resolveBase(repo.root, "does-not-exist"), "BASE_REF_NOT_FOUND");
  });

  it("asks for an explicit base when no default branch exists", async () => {
    const repo = createRepo({ branch: "trunk" });
    repo.write("seed.txt");
    repo.commitAll("initial");

    await expectInspectorError(resolveBase(repo.root), "BASE_REF_NOT_FOUND");
  });

  it("rejects missing paths, non-repositories and empty repositories", async () => {
    const repo = createRepo();
    const outside = path.dirname(repo.root);

    await expectInspectorError(resolveRepository(path.join(outside, "missing")), "INVALID_REPOSITORY");
    await expectInspectorError(resolveRepository(outside), "INVALID_REPOSITORY");
    await expectInspectorError(resolveRepository(repo.root), "INVALID_REPOSITORY");
    await expectInspectorError(resolveRepository(""), "INVALID_REPOSITORY");
  });
});
