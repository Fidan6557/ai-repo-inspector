# Submission

## What did you investigate first, and why?

1. **Baseline.** The agent read every file, then ran the baseline (`npm ci`,
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
4. **Git argv.** `baseRef` was interpolated as `${base}...HEAD`. The option
   injection was reproduced in a scratch repo:
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

One commit per problem. Each code change ships with its own tests, and
milestones were pushed only after verification:

1. `build:` builds `src/` straight into `dist/` so the bin works, and Vitest
   collects only `test/`. Test: every `bin` target corresponds to a `src/`
   file that the build config compiles into `dist/`.
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
   Markdown and identical error lines. To show the test is not vacuous, the
   agent temporarily gave the MCP adapter a different file cap: the test
   failed, and the change was reverted.
7. `fix(validation)` (the optional step; it fit in the time):
   - Failures are reported as data: `passed`, `failed`, `timed_out`, `error`,
     with exit code and duration.
   - Remaining commands still run, and the CLI writes the report and exits 1.
   - Per-command timeout with process-tree kill: `taskkill /T` on Windows, a
     process-group kill on POSIX. One test covers both: it checks that a
     grandchild process is gone after the timeout, and it runs on Windows and
     Ubuntu in CI.
   - Output is captured in bounded memory. Validations get `CI=1` (unless `CI`
     is already set), so test runners don't hang in watch mode.
8. `docs:` the README covers the decision, the capability table, usage, exit
   and error codes, limits and safety.

Second pass, added after the first submission draft:

9. `ci:` "Public checks" now runs as a matrix on `ubuntu-latest` **and**
   `windows-latest`, with `fail-fast` off. The Windows-specific `taskkill /T /F`
   tree kill and the Windows path and git behaviour are now verified in CI, not
   only on my machine.
10. `feat(mcp):` operator-configured `--allowed-root` scoping, enforced in
    `src/path-policy.ts`.
    - Roots are canonicalized with `realpath` and must exist. An invalid root
      makes the server exit 2 rather than start unrestricted (fail closed).
    - `repo_path` is checked lexically first, so there is no existence oracle
      outside the roots. It is then canonicalized with `realpath` and checked
      again, which blocks symlink and junction escapes.
    - After git resolves the repository, both the work-tree top level and the
      git common directory must be inside a root. This blocks a subdirectory of
      a repository that sits above the root, and a `.git` file redirecting to
      an object store elsewhere.
    - Containment uses `path.relative`, not string prefixes.
    - MCP remains strictly read-only.

## What did you intentionally not do?

- **Validations over MCP.** I removed them rather than allowlisting them.
  Even an allowlisted `npm test` runs code the repository controls, and the
  caller may be prompt-injected.
- **Default-deny for MCP.** Without `--allowed-root` the server still accepts
  any absolute path, with a stderr warning. This was kept so existing setups
  don't break. Requiring a root would be the safer default for a real release.
- **Client-provided MCP Roots.** Scope comes only from the operator's
  `--allowed-root` for now.
- **MCP over HTTP, authentication, progress notifications, and cancellation of
  in-flight git calls.** Git calls have timeouts instead.
- **Diff content or line counts in the report.** The original scope was kept:
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
  - MCP can be confined with `--allowed-root`. The operator sets it in the MCP
    client config; the caller can't change it. Paths, link targets, repository
    top levels and git directories outside the roots return
    `PATH_NOT_ALLOWED`.
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
  - Latency: all git queries are local. In the parity tests, one complete
    real-process call takes about 1.1–1.5 s locally, including Node/tsx
    startup.
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

I used Claude Code (Claude Opus) throughout. The agent carried out the
investigation, implementation and verification steps described in this
document. I set the direction, corrected the plan, and approved it before any
code was written.

- **Planning.**
  - The agent read the repository and ran the baseline.
  - A separate review subagent audited the code independently. It was given
    the code but not the first audit's conclusions.
  - Two key claims were then verified rather than assumed:
    - the `registerTool` signature, checked in the installed SDK package;
    - Vitest 4 collecting `dist/` test files, observed in the baseline run.
- **Approval and corrections.** I approved the plan only after changing its
  scope and order (see below).
- **Implementation.**
  - The agent implemented each commit together with its tests.
  - Before each code commit it ran `typecheck` and `test`, plus `build` where
    relevant.
  - It reviewed the staged changes before every commit.
  - It pushed only verified milestones and checked GitHub Actions after each
    push.
- **Second pass.** I asked for MCP `--allowed-root` scoping (`realpath`
  canonicalization, traversal and symlink protection, positive and negative
  tests) and for Windows CI coverage.

## Where did you check, correct, or reject an AI suggestion? (required)

- **Changed the agent's first plan for MCP.**
  - The plan proposed that MCP could run validation commands from an
    operator-configured allowlist.
  - I did not accept that design and required a strictly read-only MCP.
  - I also reordered the work: a working CLI first, then MCP with a real
    CLI/MCP parity test, with CLI validation-failure handling made optional.
  - This removes the residual risk the plan itself had noted: even an
    allowlisted `npm test` executes repository-controlled code on behalf of a
    caller that may be prompt-injected.
- **A lockfile rewrite was caught and reverted.**
  - The agent ran `npm install --package-lock-only` to raise the `zod` range.
    That also rewrote `package-lock.json`, dropping the `libc` fields from
    about ten optional native packages.
  - The local npm 10.9.2 does not record those fields; a newer npm had
    written them. Without them, the set of native binaries installed on Linux
    CI could change.
  - Reviewing the staged diff caught this. The rewrite was reverted, only the
    root `zod` range was edited by hand, and `npm ci` was used to verify it.
- **The review subagent's claims were verified, not trusted.**
  - "Vitest 4 collects `dist/test`": confirmed, because the baseline run showed
    2 test files.
  - "`--output=` injection writes a file": confirmed by reproducing it in a
    scratch repository.
  - Its warnings against two unsafe shortcuts were followed:
    - adding `-c safe.directory=*`;
    - splitting `--validate` commands on spaces for `execFile`, which breaks
      quoting and fails on `npm.cmd`.
- **A wrong test was fixed instead of the code.** One generated test expected
  `\r\n` in a filename to become two spaces. The renderer correctly collapses
  it to one, so the test expectation was corrected.
- **The agent checked whether my `realpath` requirement was sufficient.**
  - While implementing my second-pass requirement to canonicalize paths with
    `realpath`, it noted that `realpath` alone still allows two escapes:
    - a directory inside the root that belongs to a repository above it;
    - a `.git` file redirecting to an object store outside the root.
  - It added checks on git's resolved top level and common directory, with a
    test for each.
  - It then mutation-checked all five layers on its own initiative: it
    disabled each one, confirmed that its specific test failed, and restored
    it. The results are in the verification table below.
- **A silent scripted-edit failure was caught.**
  - A scripted text replacement did nothing on two files checked out with
    CRLF line endings (`core.autocrlf=true`).
  - Inspecting the diff before committing caught it, and the edits were redone
    exactly.

## Commands used to verify the result, with outcomes

The local checks were run on Windows 11 (Node 22.15, git 2.53). The rows from
`npm ci` through the stdio client script were re-run during the final
documentation review, on `main` at `8cb45df`. The last code change is
`294c5fa`. CI runs on Ubuntu and
Windows with Node 20.

| Command | Outcome |
|---|---|
| `npm ci` | Installed 143 packages from the lockfile. |
| `npm run typecheck` | Passed, no errors. |
| `npm run build` | Emitted `dist/cli.js` and `dist/mcp-server.js`, among other files. |
| `npm test` | **9 files, 77 tests passed.** Covers git (temp repos), report, core, CLI, MCP (in-memory), validation, packaging, real-process parity, and allowed-root security (positive and negative). |
| `node dist/cli.js --help` | Printed usage, exit 0. |
| `node dist/cli.js review --repo . --format json --output -` | Valid JSON. Summary: "0 changed files compared with origin/main …" (clean tree). |
| `node dist/cli.js review --repo . --output - --validate "node -e \"process.exit(1)\""` | Report written to stdout. Summary: "validations: 0 passed, 1 failed". **Exit 1.** |
| `node dist/cli.js review --repo . --base-ref=--output=pwned` | `error[INVALID_BASE_REF]`, **exit 2**, no `pwned*` file created. |
| `node dist/mcp-server.js --allowed-root ./definitely-missing` | `error[INVALID_ARGUMENTS]: Allowed root does not exist…`, **exit 2**; the server did not start. |
| A stdio SDK client script against `node dist/mcp-server.js` | **Unscoped:** lists only `repo_path`/`base_ref` with `readOnlyHint: true`. A review call returns `structuredContent`. A call with `validationCommands` returns `isError` (input validation error).<br>**With `--allowed-root <repo>`:** the repository itself is reviewed; its parent directory returns `error[PATH_NOT_ALLOWED]`. |
| Mutation check: MCP given a different file cap | The parity test failed as expected; then reverted. |
| Mutation checks on `src/path-policy.ts`, one layer disabled at a time | Each failed exactly its target test, then the file was restored (verified with `cmp`):<br>• post-realpath check → symlink/junction escape<br>• git-dir check → `.git` redirect<br>• top-level check → repository above the root<br>• string-prefix containment → `allowed-evil` sibling<br>• lexical check → existence-oracle test |
| GitHub Actions "Public checks", Ubuntu only | Passed on the pushes of `aa98b62`, `f4f756d`, `64e39ae` and `fdd1b83`. From `64e39ae` on, this includes the POSIX process-group kill test. |
| GitHub Actions "Public checks", Ubuntu + Windows | Both jobs passed on `fb5354a` (CI matrix), `294c5fa` (allowed-root) and `8cb45df` (docs). The Windows log shows all 8 test files passing at `fb5354a`, including "kills a hanging command, including its child processes" (2.1 s), i.e. the `taskkill /T /F` path. At `294c5fa` both platforms ran all 9 test files, including the 24 allowed-root tests; on Windows the escape test uses a directory junction. |

## A blocker you hit and how you approached it

This Windows machine's **system** git config sets `init.defaultBranch=master`
and `core.autocrlf=true`, and CI runners do not configure a git identity. Test
fixtures that depend on ambient git config would therefore behave differently
locally and in CI. The same setting also makes a real bug easy to hit: the
tool's hard-coded `main` failed on `master` repositories.

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
- MCP scoping is opt-in. Without `--allowed-root`, any absolute path the user
  can read can be inspected; the server only prints a warning.
- The path checks are check-then-use. Someone who can write inside an allowed
  root could swap a directory for a link between the check and git running.
  Read-only access limits the impact to file names.
- While locating a repository, git may read metadata of a repository *above* a
  root before the top-level check rejects it. No data is returned to the
  caller. Setting `GIT_CEILING_DIRECTORIES` would stop git walking up at all.
- Validation commands inherit the operator's full environment, including any
  secrets. That is acceptable only because the CLI operator is trusted.
- MCP cancellation doesn't abort an in-flight git call. Git calls are bounded
  by 30 s timeouts.
- Renames are detected only when staged. An unstaged `mv` shows up as
  `deleted` plus `untracked`, which matches git's own semantics.
- `durationMs` is the only non-deterministic field.

**Next three:**
1. Harden the scope further:
   - make `--allowed-root` required (default-deny);
   - set `GIT_CEILING_DIRECTORIES` from the roots;
   - intersect operator roots with client-provided MCP **Roots**.
2. If validations are needed through MCP: operator-allowlisted *named* commands
   in a sandbox, with a scrubbed environment and request cancellation wired to
   the process-tree kill.
3. Richer, still bounded review content: a per-file diffstat and line counts,
   per-file size caps, and progress notifications for large repositories.

## Approximate focused-work time

Recorded from the commit and CI history (local time, UTC+4):

- Planning (repository review and the approved plan, before implementation):
  *candidate to record*
- First implementation pass: 21:13–21:43
- Second implementation pass (Windows CI and `--allowed-root`): 22:01–22:11
- Final documentation review: *candidate to record*

Total focused time, including planning: *candidate to confirm*

- Start: *candidate to confirm*
- Finish: *candidate to confirm*
