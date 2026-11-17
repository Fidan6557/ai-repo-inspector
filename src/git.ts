import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";
import { InspectorError } from "./errors.js";
import type { ChangedFile, ChangeStatus } from "./types.js";

const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

// The inspected repository is untrusted. Its .git/config could configure an
// fsmonitor hook or external diff driver that executes arbitrary programs, so
// every call disables those code paths explicitly.
const HARDENING_ARGS = ["-c", "core.fsmonitor=false"];
const DIFF_SAFETY_ARGS = ["--no-ext-diff", "--no-textconv"];

type GitResult = { ok: true; stdout: string } | { ok: false; stderr: string };

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
  // These would make git ignore `cwd` and operate on a different repository.
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  return env;
}

function runGit(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      "git",
      [...HARDENING_ARGS, ...args],
      {
        cwd,
        encoding: "utf8",
        env: gitEnv(),
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr?.trim() || error.message;
          resolve({ ok: false, stderr: detail });
        } else {
          resolve({ ok: true, stdout });
        }
      },
    );
  });
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await runGit(cwd, args);
  if (!result.ok) {
    throw new InspectorError("GIT_FAILED", `git ${args[0]} failed: ${result.stderr.slice(0, 500)}`);
  }
  return result.stdout;
}

async function tryGit(cwd: string, args: string[]): Promise<string | null> {
  const result = await runGit(cwd, args);
  return result.ok ? result.stdout.trim() : null;
}

export type RepositoryInfo = {
  root: string;
  head: string;
  branch: string | null;
};

export type RepositoryAuthorizer = (root: string) => Promise<void>;

/**
 * Resolves the work-tree top level for `repositoryPath`. When `authorize` is
 * given it runs as soon as the top level is known and before any further
 * repository data is read.
 */
export async function resolveRepository(
  repositoryPath: string,
  authorize?: RepositoryAuthorizer,
): Promise<RepositoryInfo> {
  if (!repositoryPath) {
    throw new InspectorError("INVALID_REPOSITORY", "A repository path is required.");
  }
  const absolute = path.resolve(repositoryPath);
  let isDirectory = false;
  try {
    isDirectory = statSync(absolute).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) {
    throw new InspectorError("INVALID_REPOSITORY", `Repository path does not exist or is not a directory: ${absolute}`);
  }

  const topLevel = await tryGit(absolute, ["rev-parse", "--show-toplevel"]);
  if (!topLevel) {
    throw new InspectorError("INVALID_REPOSITORY", `Not inside a Git work tree: ${absolute}`);
  }
  const root = path.resolve(topLevel);
  if (authorize) await authorize(root);

  const head = await tryGit(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  if (!head) {
    throw new InspectorError("INVALID_REPOSITORY", "Repository has no commits yet, so there is nothing to compare.");
  }
  const branch = await tryGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return { root, head, branch: branch || null };
}

/** Absolute path of the repository's shared git directory (object store). */
export async function gitCommonDir(root: string): Promise<string> {
  const output = await git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return path.resolve(output.trim());
}

export type BaseInfo = {
  ref: string;
  resolvedFrom: "argument" | "origin/HEAD" | "main" | "master";
  commit: string;
  mergeBase: string;
};

// Revision expressions such as `HEAD~2` or `origin/main` are allowed, but
// anything git could parse as an option (leading "-") or that contains
// whitespace/control characters is rejected before it reaches git.
function assertSafeRef(ref: string): void {
  if (ref.length === 0 || ref.length > 256 || ref.startsWith("-") || /[\s\x00-\x1f\x7f]/.test(ref)) {
    throw new InspectorError(
      "INVALID_BASE_REF",
      "Base ref must be a branch, tag, or commit (no leading '-', whitespace, or control characters).",
    );
  }
}

async function verifyCommit(root: string, ref: string): Promise<string | null> {
  return tryGit(root, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]);
}

export async function resolveBase(root: string, baseRef?: string): Promise<BaseInfo> {
  let ref: string;
  let resolvedFrom: BaseInfo["resolvedFrom"];
  let commit: string | null;

  if (baseRef !== undefined) {
    assertSafeRef(baseRef);
    ref = baseRef;
    resolvedFrom = "argument";
    commit = await verifyCommit(root, baseRef);
    if (!commit) {
      throw new InspectorError("BASE_REF_NOT_FOUND", `Base ref does not resolve to a commit in this repository: ${baseRef}`);
    }
  } else {
    const candidates: Array<{ ref: string; from: BaseInfo["resolvedFrom"] }> = [];
    const originHead = await tryGit(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
    if (originHead) candidates.push({ ref: originHead, from: "origin/HEAD" });
    candidates.push({ ref: "main", from: "main" }, { ref: "master", from: "master" });

    const found = await firstResolvable(root, candidates);
    if (!found) {
      throw new InspectorError(
        "BASE_REF_NOT_FOUND",
        "Could not determine a base branch (tried origin/HEAD, main, master). Pass a base ref explicitly.",
      );
    }
    ({ ref, from: resolvedFrom, commit } = found);
  }

  const mergeBase = await tryGit(root, ["merge-base", commit, "HEAD"]);
  if (!mergeBase) {
    throw new InspectorError("BASE_REF_NOT_FOUND", `Base ref has no common ancestor with HEAD: ${ref}`);
  }
  return { ref, resolvedFrom, commit, mergeBase };
}

async function firstResolvable(
  root: string,
  candidates: Array<{ ref: string; from: BaseInfo["resolvedFrom"] }>,
): Promise<{ ref: string; from: BaseInfo["resolvedFrom"]; commit: string } | null> {
  for (const candidate of candidates) {
    const commit = await verifyCommit(root, candidate.ref);
    if (commit) return { ...candidate, commit };
  }
  return null;
}

const STATUS_BY_CODE: Record<string, ChangeStatus> = {
  A: "added",
  M: "modified",
  D: "deleted",
  T: "type_changed",
  U: "unmerged",
};

/**
 * Everything that differs between the merge-base and the working tree:
 * committed, staged, and unstaged changes to tracked files, plus untracked
 * files that are not ignored.
 */
export async function changedFiles(root: string, mergeBase: string): Promise<ChangedFile[]> {
  const files: ChangedFile[] = [];

  // -z gives NUL-separated, unquoted paths, so spaces, tabs, and non-ASCII
  // names survive intact. Rename/copy records carry two paths.
  const diff = await git(root, ["diff", "--name-status", "-z", "-M", ...DIFF_SAFETY_ARGS, mergeBase, "--"]);
  const tokens = diff.split("\0");
  for (let index = 0; index < tokens.length && tokens[index]; ) {
    const code = tokens[index++];
    const letter = code[0];
    if (letter === "R" || letter === "C") {
      const previousPath = tokens[index++];
      const newPath = tokens[index++];
      files.push({ path: newPath, previousPath, status: letter === "R" ? "renamed" : "copied" });
    } else {
      files.push({ path: tokens[index++], status: STATUS_BY_CODE[letter] ?? "modified" });
    }
  }

  const untracked = await git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  for (const file of untracked.split("\0")) {
    if (file) files.push({ path: file, status: "untracked" });
  }

  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
