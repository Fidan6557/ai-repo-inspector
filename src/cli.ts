#!/usr/bin/env node
import { runCli } from "./cli-app.js";

const exitCode = await runCli(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  cwd: process.cwd(),
});
process.exitCode = exitCode;
