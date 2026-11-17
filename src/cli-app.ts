import { writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { reviewRepository } from "./core.js";
import { InspectorError } from "./errors.js";
import { renderJson, renderMarkdown } from "./report.js";

export type CliIO = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  cwd: string;
};

export const USAGE = `Usage: inspector review --repo <path> [options]

Reports every file that differs between the working tree and the merge-base
of HEAD with a base ref (committed, staged, unstaged and untracked changes).

Options:
  --repo <path>        Repository to inspect (required).
  --base-ref <ref>     Base branch, tag or commit. Default: origin/HEAD, then
                       main, then master.
  --validate <cmd>     Shell command to run in the repository root. Repeatable.
                       Runs with your full permissions.
  --format <format>    markdown (default) or json.
  --output <file|->    Where to write the report. Default: review-report.md
                       (or review-report.json) in the current directory.
                       Use "-" for stdout.
  -h, --help           Show this help.

Exit codes: 0 review completed, 1 a validation command failed,
2 the review could not run (usage, input or internal error).`;

const OPTIONS = {
  repo: { type: "string" },
  "base-ref": { type: "string" },
  validate: { type: "string", multiple: true },
  format: { type: "string" },
  output: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

function usageError(io: CliIO, message: string): number {
  io.stderr(`error[INVALID_ARGUMENTS]: ${message}\nRun "inspector --help" for usage.\n`);
  return 2;
}

export async function runCli(argv: string[], io: CliIO): Promise<number> {
  let parsed;
  try {
    // strict: unknown flags and missing option values are errors instead of
    // being silently ignored (a misspelled --validate must not look like a pass).
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    return usageError(io, (error as Error).message);
  }
  const { values, positionals } = parsed;

  if (values.help) {
    io.stdout(`${USAGE}\n`);
    return 0;
  }
  const [command, ...extra] = positionals;
  if (command !== "review") return usageError(io, command ? `Unknown command: ${command}` : "Missing command.");
  if (extra.length > 0) return usageError(io, `Unexpected argument: ${extra[0]}`);
  if (!values.repo) return usageError(io, "--repo is required.");
  const format = values.format ?? "markdown";
  if (format !== "markdown" && format !== "json") {
    return usageError(io, `--format must be "markdown" or "json", got "${format}".`);
  }

  try {
    const result = await reviewRepository({
      repositoryPath: path.resolve(io.cwd, values.repo),
      baseRef: values["base-ref"],
      validationCommands: values.validate ?? [],
    });
    const rendered = format === "json" ? renderJson(result) : renderMarkdown(result);
    const output = values.output ?? (format === "json" ? "review-report.json" : "review-report.md");

    if (output === "-") {
      io.stdout(rendered);
    } else {
      const target = path.resolve(io.cwd, output);
      try {
        writeFileSync(target, rendered, "utf8");
      } catch (error) {
        throw new InspectorError("OUTPUT_FAILED", `Could not write report to ${target}: ${(error as Error).message}`);
      }
      io.stderr(`Review report written to ${target}\n`);
    }
    io.stderr(`${result.summary}\n`);
    return result.validations.some((validation) => validation.status !== "passed") ? 1 : 0;
  } catch (error) {
    if (error instanceof InspectorError) {
      io.stderr(`${error.format()}\n`);
      return error.code === "VALIDATION_FAILED" ? 1 : 2;
    }
    io.stderr(`error[INTERNAL]: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}
