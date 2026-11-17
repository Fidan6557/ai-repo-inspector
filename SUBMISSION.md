# Submission

## What did you investigate first, and why?

1. **Baseline.** I read every file, then ran the baseline (`npm ci`,
   `typecheck`, `build`, `test`). It showed two problems:
   - `tsc` emitted `dist/src/cli.js`, while `package.json` `bin` points to
     `dist/cli.js`.
   - Vitest ran **2** test files after a build, because Vitest 4 no longer
     excludes `dist/`.
2. **The MCP adapter**, because it is the interface agents use and nothing
   tested it. The schema declares `repo_path` but the handler reads
   `input.repoPath` (hidden by `input: any`). So every MCP call ran git in the
   **server's own working directory** and silently reviewed the wrong
   repository.
3. **Trust boundary.** MCP `validationCommands` went straight to `exec()` with a
   shell. Any agent, including one prompt-injected by repository content, could
   run arbitrary commands.
4. **Git argv.** `baseRef` was interpolated as `${base}...HEAD`. I reproduced the
   option injection in a scratch repo:
   `git diff --name-status --output=pwned...HEAD` creates a file named
   `pwned...HEAD`. That is an arbitrary file write, reachable from MCP.
5. **The rest of the happy path:**
   - A failing validation rejected, so the whole review aborted with no report.
   - `--repo` was split on spaces.
   - `--format json` was ignored.
   - `main` was hard-coded, and this machine's git defaults to `master`.
   - Only committed changes were seen.
   - Renames were mis-parsed.
   - The report had no pass/fail status and allowed Markdown fence breakout.

## What did you choose to implement or fix?

One commit per problem, each with its own tests, pushed at verified milestones:

1. `build:` builds `src/` straight into `dist/` so the bin works, and Vitest
   collects only `test/`. Test: bin targets map to emitted files.
2. `fix(git):`
   - Base refs are validated and resolved with
     `rev-parse --verify --end-of-options`; only the SHA is passed on.
   - Default base: `origin/HEAD`, then `main`, then `master`.
   - Changes are the merge-base vs the working tree (committed + staged +
     unstaged + untracked), parsed NUL-separated, with renames and
     `previousPath`.
   - Git calls are async with timeouts and bounded buffers. `fsmonitor`,
     external diff and textconv are disabled because the repository's config
     is untrusted.
3. `fix(report):`
   - One zod `ReviewResultSchema` is the shared contract.
   - The report puts the summary first, shows a status per validation, and
     caps the file list (200) and command output (head + tail).
   - Code spans and fences are longer than any backtick run in the content,
     and control/ANSI characters are stripped.
   - Empty states are explicit, and there is a JSON renderer.
4. `fix(cli):`
   - Argument parsing uses `node:util` `parseArgs` in strict mode, so paths
     with spaces work and unknown or misspelled flags are errors.
   - `--format json` now works, `--output <file|->` and `--help` were added,
     and status lines go to stderr.
   - Exit codes: 0 completed, 1 validation failed, 2 usage/input error.
5. `fix(mcp):`
   - **Read-only** `review_repository` via `registerTool`, with a strict
     snake_case input (absolute `repo_path`, optional `base_ref`).
   - Unknown fields such as `validationCommands` are rejected.
   - `outputSchema` plus `structuredContent`, read-only annotations, and
     `isError` results that carry the same `error[CODE]` line as the CLI.
6. `test(parity):` spawns the **real** CLI process and the **real** stdio MCP
   server on one fixture repository, and requires identical JSON, identical
   Markdown and identical error lines. I checked that the test is meaningful
   by temporarily giving the MCP adapter a different file cap: the test
   failed.
7. `fix(validation)` (the optional step; it fit in the time):
   - Failures are reported as data: `passed`, `failed`, `timed_out`, `error`,
     with exit code and duration.
   - Remaining commands still run, and the CLI writes the report and exits 1.
   - Per-command timeout with process-tree kill: `taskkill /T` on Windows, a
     process-group kill on POSIX. Both are tested, with a grandchild process.
   - Output is captured in bounded memory. Validations run with `CI=1`, so
     test runners don't hang in watch mode.
8. `docs:` the README covers the decision, the capability table, usage, exit
   and error codes, limits and safety.

## What did you intentionally not do?

- **Validations over MCP.** I removed them rather than allowlisting them.
  Even an allowlisted `npm test` runs code the repository controls, and the
  caller may be prompt-injected.
- **Filesystem scoping for MCP** (`--allowed-root` / MCP Roots). The tool is
  read-only and returns file names only, but any absolute path the user can
  read can be inspected. This is the first next step.
- **MCP over HTTP, authentication, progress notifications, and cancellation of
  in-flight git calls.** Git calls have timeouts instead.
- **Diff content or line counts in the report.** I kept the original scope:
  file list plus validations.
- **Rewriting the lockfile.** See the blocker below.

## Interface decision

- **Decision: hybrid.**
- **Primary user and execution environment:**
  - Developers and CI run the CLI locally or in pipelines.
  - AI coding agents call the MCP server over stdio, launched by the
    developer's MCP client on the same machine.
- **Trust boundary and allowed capabilities:**
  - Trusted: whoever writes the CLI arguments or the MCP client configuration.
  - Untrusted: MCP tool arguments, which model output steers, and repository
    contents, including `.git/config` and npm scripts.
  - The CLI has the invoking user's capabilities: free-form `--validate`, and
    it writes the report to `--output`.
  - MCP may only run fixed, hardened git queries. It never runs commands,
    never writes files, rejects unknown arguments, and requires absolute
    paths.
- **Reliability, discoverability, latency/context, and output tradeoffs:**
  - Reliability:
    - Every subprocess has a timeout and bounded buffers.
    - A failing check is data, not a crash.
    - Errors use stable `error[CODE]` lines.
    - The CLI's exit codes distinguish "checks failed" (1) from "the tool
      could not run" (2).
  - Discoverability:
    - MCP advertises per-field descriptions, a closed input schema, an
      `outputSchema`, and read-only/idempotent annotations.
    - The CLI has `--help` and the README.
  - Context and output size:
    - Reports are summary-first, with the file list capped at 200 and true
      totals, and command output reduced to its head and tail.
    - MCP returns Markdown text plus `structuredContent`. That deliberately
      deviates from also serialising the JSON as text, which would double the
      context cost.
  - Latency: all git queries are local. Most of the cost is process startup.
- **How supported interfaces remain consistent:**
  - Both adapters only translate input into a `reviewRepository()` call and
    render the same `ReviewResult` (one zod schema) with the same renderers
    and the same `InspectorError` codes.
  - `test/parity.test.ts` enforces this end to end on real processes.
  - Two differences are intentional and documented:
    - MCP has no validations.
    - MCP requires an absolute path.
- **Evidence that would change this decision:**
  - If usage shows agents mostly call the CLI through their own shell, go
    CLI-first and drop the MCP upkeep.
  - If agents genuinely need validations through MCP, add operator-allowlisted
    *named* commands run in a sandbox (container, scrubbed env), never raw
    strings.
  - Remote or multi-tenant use calls for MCP-first over HTTP with
    authentication.
  - If clients broadly support MCP Roots, use them to scope repository access.

## How did you use an AI coding agent?

I used Claude Code (Claude Opus) throughout:

- **Planning.** It read the repository and ran the baseline. A separate review
  subagent independently audited the code, given the code but not the first
  audit's conclusions. Its claims about SDK 1.29 and Vitest 4 were checked
  against the installed sources.
- **Approval and corrections.** I approved the plan only after correcting it
  (see below).
- **Implementation.** The agent implemented each commit with its tests. It ran
  `typecheck` and `test` (and `build` where relevant) before each commit, and
  reviewed `git diff --staged` before committing. It pushed only verified
  milestones and checked GitHub Actions after each push.

## Where did you check, correct, or reject an AI suggestion? (required)

- **Rejected the agent's first plan for MCP.** It proposed letting MCP run
  validation commands from an operator-configured allowlist. I rejected that
  and required a strictly read-only MCP. I also reordered the work: a working
  CLI first, then MCP with a real CLI/MCP parity test, with validation
  handling made optional. An allowlisted `npm test` still executes
  repository-controlled code on behalf of a possibly prompt-injected caller.
- **Rejected a lockfile change.** Running `npm install --package-lock-only` to
  bump the zod range rewrote `package-lock.json`, dropping the `libc` fields
  from about ten optional native packages. npm 10 writes an older lockfile
  format, and those fields could change which native binaries Linux CI
  installs. Reviewing the staged diff caught this. The rewrite was reverted
  and only the root `zod` range was edited, then verified with `npm ci`.
- **Verified the review subagent's claims instead of trusting them:**
  - "Vitest 4 collects `dist/test`" was confirmed: the baseline showed 2 test
    files.
  - "`--output=` injection writes a file" was confirmed by reproducing it.
  - I rejected suggestions that would weaken safety:
    - `-c safe.directory=*`;
    - splitting `--validate` commands on spaces for `execFile`, which breaks
      quoting and fails on `npm.cmd`.
- **Corrected a wrong test rather than the code.** One generated test expected
  `\r\n` in a filename to become two spaces. The renderer correctly collapses
  it to one, so the test was fixed.
- **Caught a silent scripted-edit failure.** A scripted edit silently did
  nothing on files checked out with CRLF line endings (`core.autocrlf=true`).
  The pre-commit diff review caught it, and it was redone with exact edits.

## Commands used to verify the result, with outcomes

Run locally on Windows 11 (Node 22.15, git 2.53). CI runs on ubuntu with
Node 20.

| Command | Outcome |
|---|---|
| `npm ci` | Installed 143 packages from the lockfile. |
| `npm run typecheck` | Passed, no errors. |
| `npm run build` | Emitted `dist/cli.js` and `dist/mcp-server.js`, among other files. |
| `npm test` | **8 files, 53 tests passed.** Covers git (temp repos), report, core, CLI, MCP (in-memory), validation, packaging, and real-process parity. |
| `node dist/cli.js --help` | Printed usage, exit 0. |
| `node dist/cli.js review --repo . --format json --output -` | Valid JSON. Summary: "1 changed file compared with origin/main …" |
| `node dist/cli.js review --repo . --output - --validate "node -e \"process.exit(1)\""` | Report written to stdout. Summary: "0 passed, 1 failed". **Exit 1.** |
| `node dist/cli.js review --repo . --base-ref=--output=pwned` | `error[INVALID_BASE_REF]`, **exit 2**, no `pwned*` file created. |
| A stdio SDK client script against `node dist/mcp-server.js` | Lists only `repo_path`/`base_ref` with read-only annotations. A call returns `structuredContent`. A call with `validationCommands` returns `isError` (input validation error). |
| Mutation check: MCP given a different file cap | The parity test failed as expected; then reverted. |
| GitHub Actions "Public checks" | Passed on every milestone push (`aa98b62`, `f4f756d`, `64e39ae`), including the POSIX process-group kill test. |

## A blocker you hit and how you approached it

This Windows machine's **system** git config sets `init.defaultBranch=master`
and `core.autocrlf=true`, and CI runners have no git identity. That made temp
repository fixtures behave differently locally and in CI. It also hid a real
bug: the tool's hard-coded `main` fails on `master` repositories.

**Approach:**
- The fixture helper ignores system and global config (`GIT_CONFIG_NOSYSTEM`
  plus an empty `GIT_CONFIG_GLOBAL`), sets the identity through environment
  variables, and creates the branch explicitly.
- Dedicated tests cover the `master` fallback and the "no default branch" case.
- The production code does *not* isolate config, because users'
  `safe.directory` lives there. It only overrides the dangerous keys.

A second, smaller blocker was the npm 10 lockfile rewrite, described in the AI
corrections section.

## Known limitations and the next three things you would do

**Known limitations:**
- MCP has no filesystem scoping.
- Validation commands inherit the operator's full environment, including any
  secrets. That is acceptable only because the CLI operator is trusted.
- MCP cancellation doesn't abort an in-flight git call. Git calls are bounded
  by 30 s timeouts.
- There is no Windows CI job; Windows was verified locally only.
- Renames are detected only when staged. An unstaged `mv` shows up as
  `deleted` plus `untracked`, which matches git's own semantics.
- `durationMs` is the only non-deterministic field.

**Next three:**
1. Scope MCP to client **Roots** or an operator `--allowed-root`, and add a
   Windows job to the CI matrix.
2. If validations are needed through MCP: operator-allowlisted *named* commands
   in a sandbox, with a scrubbed environment and request cancellation wired to
   the process-tree kill.
3. Richer, still bounded review content: a per-file diffstat and line counts,
   per-file size caps, and progress notifications for large repositories.

## Approximate focused-work time

- Start: 21:13 (UTC+4), when implementation began after the plan was approved.
  *Candidate: confirm, and add earlier planning time if you count it.*
- Finish: *candidate to fill in at submission*
