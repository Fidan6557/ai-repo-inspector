import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tempDirs: string[] = [];

export type Fixture = {
  root: string;
  git: (...args: string[]) => string;
  write: (relativePath: string, content?: string) => void;
  commitAll: (message: string) => void;
};

/**
 * Creates a throwaway repository that ignores the machine's system/global git
 * config (this dev machine sets init.defaultBranch=master and autocrlf=true;
 * CI runners have no identity configured).
 */
export function createRepo(options: { branch?: string; dirName?: string } = {}): Fixture {
  const parent = realpathSync.native(mkdtempSync(path.join(tmpdir(), "inspector-test-")));
  tempDirs.push(parent);
  const emptyGlobalConfig = path.join(parent, "empty.gitconfig");
  writeFileSync(emptyGlobalConfig, "");

  const root = path.join(parent, options.dirName ?? "repo");
  mkdirSync(root);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: emptyGlobalConfig,
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
    GIT_TERMINAL_PROMPT: "0",
  };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;

  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: root, env, encoding: "utf8" });

  git("init", "-q", "-b", options.branch ?? "main");

  const write = (relativePath: string, content = `${relativePath}\n`) => {
    const target = path.join(root, relativePath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  };
  const commitAll = (message: string) => {
    git("add", "-A");
    git("commit", "-q", "-m", message);
  };

  return { root, git, write, commitAll };
}

export function cleanupRepos(): void {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
}
