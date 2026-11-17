import { exec } from "node:child_process";
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
        reject(error);
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