import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runValidation, runValidations } from "../src/validation.js";

// Commands use double quotes outside and single quotes inside so they behave
// the same under cmd.exe and sh.
const cwd = realpathSync.native(mkdtempSync(path.join(tmpdir(), "inspector-validation-")));
const options = { timeoutMs: 20_000, maxCaptureChars: 1000 };

afterAll(() => rmSync(cwd, { recursive: true, force: true, maxRetries: 5 }));

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("runValidation", () => {
  it("reports success with the exit code and output", async () => {
    const result = await runValidation(`node -e "console.log('all good')"`, cwd, options);

    expect(result).toMatchObject({ status: "passed", exitCode: 0, outputTruncated: false });
    expect(result.output).toContain("all good");
  });

  it("reports a failing command as data, keeping both stdout and stderr", async () => {
    const result = await runValidation(
      `node -e "console.log('to stdout');console.error('to stderr');process.exit(3)"`,
      cwd,
      options,
    );

    expect(result).toMatchObject({ status: "failed", exitCode: 3 });
    expect(result.output).toContain("to stdout");
    expect(result.output).toContain("to stderr");
  });

  it("kills a hanging command, including its child processes, at the timeout", async () => {
    const result = await runValidation(
      `node -e "const c=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'inherit'});console.log('child:'+c.pid);setTimeout(()=>{},60000)"`,
      cwd,
      { ...options, timeoutMs: 1500 },
    );

    expect(result.status).toBe("timed_out");
    expect(result.durationMs).toBeLessThan(10_000);
    const grandchild = Number(/child:(\d+)/.exec(result.output)?.[1]);
    expect(grandchild).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(isAlive(grandchild)).toBe(false);
  });

  it("keeps the head and tail of very large output in bounded memory", async () => {
    const result = await runValidation(
      `node -e "process.stdout.write('START'+'x'.repeat(5000000)+'END')"`,
      cwd,
      options,
    );

    expect(result.status).toBe("passed");
    expect(result.outputTruncated).toBe(true);
    expect(result.output.length).toBeLessThan(2 * options.maxCaptureChars + 100);
    expect(result.output.startsWith("START")).toBe(true);
    expect(result.output.endsWith("END")).toBe(true);
  });

  it("reports a command that cannot start as an error instead of throwing", async () => {
    const result = await runValidation(`node -e "1"`, path.join(cwd, "missing-dir"), options);

    expect(result.status).toBe("error");
    expect(result.output).toContain("Failed to start command");
  });
});

describe("runValidations", () => {
  it("keeps running after a failure", async () => {
    const results = await runValidations([`node -e "process.exit(1)"`, `node -e "console.log('second')"`], cwd, options);

    expect(results.map((result) => result.status)).toEqual(["failed", "passed"]);
  });
});
