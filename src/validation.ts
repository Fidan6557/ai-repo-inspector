import { exec } from "node:child_process";
import { InspectorError } from "./errors.js";

/** Raw outcome of one command; core.ts applies output limits. */
export type CommandResult = {
  command: string;
  status: "passed" | "failed";
  output: string;
};

export function runValidation(command: string, cwd: string): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    exec(command, { cwd }, (error, stdout, stderr) => {
      if (error) {
        // Known limitation: a failing command still aborts the review (no
        // report). It is surfaced as a typed error so the CLI can exit 1 with
        // a clear message instead of a stack trace.
        const detail = `${stderr || stdout || error.message}`.trim().slice(-2000);
        reject(new InspectorError("VALIDATION_FAILED", `Validation command failed (exit ${error.code ?? "unknown"}): ${command}\n${detail}`));
        return;
      }
      resolve({ command, status: "passed", output: stdout || stderr });
    });
  });
}

export async function runValidations(commands: string[], cwd: string): Promise<CommandResult[]> {
  const results: CommandResult[] = [];
  for (const command of commands) {
    results.push(await runValidation(command, cwd));
  }
  return results;
}