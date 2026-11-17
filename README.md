# Repository Inspector

A small TypeScript developer tool that reports what changed on the current
branch of a Git repository, optionally runs validation commands, and produces
a summary-first report as Markdown or JSON. It has two interfaces that share
one core: a **CLI** for developers and CI, and a **read-only MCP server** for AI
coding agents.

The assessment write-up (investigation, decisions, verification and
limitations) is in [`SUBMISSION.md`](SUBMISSION.md).

## Interface decision: hybrid

| | CLI (`inspector`) | MCP (`review_repository` tool) |
|---|---|---|
| Primary user | Developer at a shell, CI pipeline | AI coding agent through a local MCP client (stdio) |
| Who controls the input | Trusted operator | Model output, which untrusted repository content can influence |
| Inspects git changes | Yes | Yes (identical result) |
| Runs commands | Yes, `--validate <cmd>` (your permissions) | **Never** |
| Writes files | Report to `--output` (or stdout) | **Never** (returns the report inline) |
| Repository path | Absolute or relative to the cwd | Absolute only (the server's cwd is meaningless to the agent) |
| Repository scope | Any path you pass | Only inside operator-set `--allowed-root` directories (recommended); otherwise any absolute path the user can read |
| Output | Markdown or JSON (`--format`) | Markdown text + the same JSON as `structuredContent` |
| Errors | `error[CODE]: message` on stderr, exit 2 | `isError: true` with the same `error[CODE]: message` line |

**Why these capabilities differ.** A developer who runs the CLI already has a
shell, so `--validate` adds no new power. An MCP caller is a model whose
arguments can be steered by text in the repository (README files, filenames,
earlier test output). If MCP accepted command strings, a prompt-injected agent
could execute anything. So the MCP tool is limited to fixed, hardened git
queries.

**How they stay consistent.**
- Both adapters translate their input into the same `reviewRepository()` call.
- Both render the same `ReviewResult`, defined once as a zod schema in
  `src/schema.ts`.
- Both report the same `InspectorError` codes.
- `test/parity.test.ts` runs the real CLI process and the real stdio MCP server
  against one repository and requires identical JSON, identical Markdown and
  identical error lines.

## Setup

```bash
npm install
npm run typecheck
npm test
npm run build      # emits dist/cli.js and dist/mcp-server.js
```

## CLI

```bash
npm run inspector -- review --repo ./path/to/repo
npm run inspector -- review --repo ./path/to/repo --format json --output -
npm run inspector -- review --repo . --base-ref origin/main --validate "npm test" --validate "npm run typecheck"
```

| Option | Meaning |
|---|---|
| `--repo <path>` | Repository (or a directory inside it). Required. |
| `--base-ref <ref>` | Branch, tag or commit to compare against. Default: `origin/HEAD`, then `main`, then `master`. |
| `--validate <cmd>` | Shell command run in the repository root. Repeatable. Each command runs even if an earlier one failed. |
| `--timeout <seconds>` | Per-command validation timeout (default 300). The whole process tree is killed on timeout. |
| `--format markdown\|json` | Report format (default `markdown`). |
| `--output <file\|->` | Report destination. Default `review-report.md` / `review-report.json` in the cwd; `-` means stdout. Status lines always go to stderr. |
| `-h, --help` | Usage. |

Exit codes:
- **0**: the review completed and every validation passed.
- **1**: the review completed but a validation failed, timed out or could not
  start. The report is still written.
- **2**: the review could not run (bad arguments, not a Git repository, unknown
  or unsafe base ref, unwritable output).

Validation commands run with `CI=1`, `NO_COLOR=1` and no stdin, so test runners
don't enter watch mode or wait for input.

## MCP

```bash
npm run mcp-server -- --allowed-root ~/code    # development (tsx)
node dist/mcp-server.js --allowed-root ~/code  # after npm run build
```

| Server option | Meaning |
|---|---|
| `--allowed-root <dir>` | Only repositories inside `<dir>` may be inspected. Repeatable. Each root must exist; otherwise the server exits with code 2 instead of starting unrestricted. Without any root, the server warns on stderr and accepts any absolute path. |
| `-h, --help` | Usage (on stderr). |

Example client configuration:

```json
{
  "mcpServers": {
    "repository-inspector": {
      "command": "node",
      "args": [
        "/absolute/path/to/ai-repo-inspector/dist/mcp-server.js",
        "--allowed-root", "/home/me/code"
      ]
    }
  }
}
```

Tool `review_repository`:

| | |
|---|---|
| Input | `repo_path` (absolute, required), `base_ref` (optional). Unknown fields are rejected. |
| Output | Markdown summary as text, plus `structuredContent` matching `ReviewResultSchema` (advertised as `outputSchema`). |
| Annotations | `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`. The description lists the allowed roots when they are configured. |
| Errors | `isError: true` with `error[CODE]: message` (capped at 2000 characters). Paths outside the allowed roots return `PATH_NOT_ALLOWED`. |

## What "changed files" means

The tool lists every file that differs between the **working tree** and the
**merge-base** of `HEAD` with the base ref. That covers commits on the branch
plus staged, unstaged and untracked (non-ignored) changes, which is exactly
what an agent or developer has in progress.

Each file has one status: `added`, `modified`, `deleted`, `renamed` (with
`previousPath`), `copied`, `type_changed`, `unmerged` or `untracked`. Paths are
read NUL-separated, so spaces and non-ASCII names survive intact.

## Output contract and limits

- **Summary first:** every report and JSON result starts with a one-line
  `summary`.
- **File cap:** the file list is capped at **200** entries.
  `totals.changedFiles` gives the real count and `truncated.changedFiles` says
  whether the cap applied.
- **Output cap:** validation output keeps the head and tail, up to **8000**
  characters, and sets `outputTruncated` when it was cut.
- **Untrusted text is contained:** paths, refs and command output are rendered
  in code spans or fences that untrusted text cannot close, with control and
  ANSI sequences stripped. The report labels this text as data, not
  instructions.
- **Deterministic:** results carry no timestamps. Validation `durationMs` is the
  only value that varies between runs.

## Safety measures

- **Base refs:**
  - refs starting with `-`, or containing whitespace or control characters,
    are rejected;
  - the rest are resolved with `git rev-parse --verify --end-of-options`;
  - only the resulting SHA is passed to later git commands.
- **Git hardening:**
  - every git call disables `core.fsmonitor` and uses `--no-ext-diff
    --no-textconv`, so a malicious repository config can't execute programs
    during a read-only review;
  - `GIT_DIR`, `GIT_WORK_TREE` and `GIT_INDEX_FILE` are cleared from git's
    environment;
  - git calls have timeouts and bounded buffers.
- **MCP repository scope** (`--allowed-root`, enforced by
  `src/path-policy.ts`):
  1. Roots are canonicalized once with `realpath` at startup.
  2. `repo_path` is checked lexically before anything touches the filesystem,
     so callers can't probe whether paths outside the roots exist.
  3. `repo_path` is then canonicalized with `realpath` (resolving symlinks and
     junctions) and checked again.
  4. Once git has resolved the repository, its top level and its git common
     directory must also be inside a root. This stops a subdirectory of an
     outside repository, or a `.git` file redirecting elsewhere, from
     escaping.
  5. Containment is computed with `path.relative`, not string prefixes, so
     `/code-evil` is outside `/code`.
- **Residual risk:** a validation command such as `npm test` executes code the
  repository controls. Only pass `--validate` for repositories you would run
  the tests of anyway.

## Error codes

| Code | Meaning |
|---|---|
| `INVALID_ARGUMENTS` | CLI usage error (unknown flag, missing value, bad `--format`/`--timeout`). |
| `INVALID_REPOSITORY` | Path missing, not a directory, not in a Git work tree, relative (MCP), or no commits. |
| `PATH_NOT_ALLOWED` | MCP only: the path, its resolved target, its repository top level or its git directory is outside the allowed roots. |
| `INVALID_BASE_REF` | Base ref looks like an option or contains whitespace/control characters. |
| `BASE_REF_NOT_FOUND` | Base ref doesn't resolve, no default base exists, or there is no common ancestor. |
| `GIT_FAILED` | An unexpected git failure (message includes git's stderr, truncated). |
| `OUTPUT_FAILED` | The CLI could not write the report file. |
| `INTERNAL` | Unexpected bug; please report it. |

## Project layout

```text
src/core.ts         shared review orchestration (returns ReviewResult)
src/schema.ts       ReviewResult zod schema and default limits (the shared contract)
src/errors.ts       InspectorError codes shared by both adapters
src/git.ts          hardened git inspection
src/validation.ts   validation command runner (timeouts, tree kill, bounded output)
src/report.ts       Markdown and JSON rendering
src/cli-app.ts      CLI adapter (runCli); src/cli.ts is the bin entry
src/mcp-app.ts      MCP adapter (createMcpServer, server options); src/mcp-server.ts is the stdio entry
src/path-policy.ts  MCP allowed-root scoping (canonicalization and containment checks)
test/               unit, integration (temp git repos), security and CLI/MCP parity tests
```

CI (`.github/workflows/public-checks.yml`) runs typecheck, build and the full
test suite on both `ubuntu-latest` and `windows-latest`.
