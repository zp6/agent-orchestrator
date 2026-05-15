#!/usr/bin/env node
import { runPreflightCli } from "./preflight.js";

const COMMAND_HELP = [
  "orch",
  "",
  "Usage:",
  "  orch preflight [options]",
  "",
  "Commands:",
  "  preflight   Run preflight checks before creating a PR.",
  "",
  "Run `orch preflight --help` for the URL reachability gate details.",
].join("\n");

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;

  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(`${COMMAND_HELP}\n`);
    return;
  }

  if (command === "preflight") {
    const result = await runPreflightCli(rest);
    if (result.stdout) {
      process.stdout.write(result.stdout);
    }
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }
    process.exitCode = result.exitCode;
    return;
  }

  process.stderr.write(`Unknown command "${command}".\n\n${COMMAND_HELP}\n`);
  process.exitCode = 1;
}

void main();
