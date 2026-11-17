import { spawn, type ChildProcess } from "node:child_process";

/** Raw outcome of one command; core.ts applies the final output limit. */
export type CommandResult = {
  command: string;
  status: "passed" | "failed" | "timed_out" | "error";
  exitCode: number | null;
  durationMs: number;
  output: string;
  outputTruncated: boolean;
};

export type RunOptions = {
  timeoutMs: number;
  /** Characters kept from both the start and the end of the output. */
  maxCaptureChars: number;
};

const isWindows = process.platform === "win32";
// After the shell exits, wait briefly for remaining output, then stop waiting
// even if an orphaned grandchild still holds the pipes open.
const DRAIN_MS = 1000;

/** Keeps the head and tail of a stream in bounded memory. */
class OutputCapture {
  private head = "";
  private tail = "";
  private total = 0;

  constructor(private readonly limit: number) {}

  push(chunk: string): void {
    this.total += chunk.length;
    if (this.head.length < this.limit) {
      const take = chunk.slice(0, this.limit - this.head.length);
      this.head += take;
      chunk = chunk.slice(take.length);
    }
    if (chunk) this.tail = (this.tail + chunk).slice(-this.limit);
  }

  result(): { text: string; truncated: boolean } {
    const omitted = this.total - this.head.length - this.tail.length;
    if (omitted <= 0) return { text: this.head + this.tail, truncated: false };
    return { text: `${this.head}\n[... ${omitted} characters omitted ...]\n${this.tail}`, truncated: true };
  }
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (isWindows) {
    // child.kill() would only end cmd.exe and leave the real process running.
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on(
      "error",
      () => child.kill(),
    );
  } else {
    try {
      process.kill(-child.pid, "SIGKILL"); // whole process group (detached below)
    } catch {
      child.kill("SIGKILL");
    }
  }
}

/**
 * Runs one trusted, operator-supplied shell command. It never rejects: a
 * failing, hanging or unstartable command is reported as data so the review
 * can still be produced.
 */
export function runValidation(command: string, cwd: string, options: RunOptions): Promise<CommandResult> {
  const started = performance.now();
  const capture = new OutputCapture(options.maxCaptureChars);

  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let spawnError: Error | undefined;
    let exitCode: number | null = null;

    const child = spawn(command, {
      cwd,
      shell: true,
      // No stdin: commands waiting for input fail fast instead of hanging.
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: !isWindows,
      // CI=1 keeps test runners (vitest, jest) out of interactive watch mode.
      env: { ...process.env, CI: process.env.CI ?? "1", NO_COLOR: "1", FORCE_COLOR: "0" },
    });

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      const { text, truncated } = capture.result();
      const status = spawnError ? "error" : timedOut ? "timed_out" : exitCode === 0 ? "passed" : "failed";
      resolve({
        command,
        status,
        exitCode,
        durationMs: Math.round(performance.now() - started),
        output: spawnError ? `Failed to start command: ${spawnError.message}` : text,
        outputTruncated: truncated,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, options.timeoutMs);

    for (const stream of [child.stdout, child.stderr]) {
      stream?.setEncoding("utf8");
      stream?.on("data", (chunk: string) => capture.push(chunk));
    }
    child.on("error", (error) => {
      spawnError = error;
      finish();
    });
    child.on("exit", (code) => {
      exitCode = code;
      setTimeout(finish, DRAIN_MS).unref();
    });
    child.on("close", finish);
  });
}

export async function runValidations(commands: string[], cwd: string, options: RunOptions): Promise<CommandResult[]> {
  const results: CommandResult[] = [];
  for (const command of commands) {
    // Sequential, and always continue: one failure must not hide the rest.
    results.push(await runValidation(command, cwd, options));
  }
  return results;
}
