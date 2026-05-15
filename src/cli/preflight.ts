import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import {
  checkUrlsInDiff,
  formatPreflightHelp,
  formatPreflightFailureReport,
  parsePreflightArgs,
  type PreflightCliOptions,
  type PreflightCliResult,
} from "../reviewer/preflight.js";

export { formatPreflightHelp };

export async function runPreflightCli(
  argv: string[],
  options: PreflightCliOptions = {},
): Promise<PreflightCliResult> {
  try {
    const parsed = parsePreflightArgs(argv);
    const merged: PreflightCliOptions = { ...options, ...parsed };

    if (merged.help) {
      return {
        exitCode: 0,
        stdout: `${formatPreflightHelp()}\n`,
        stderr: "",
      };
    }

    const shouldCheckUrls = merged.skipUrlCheck ? false : (merged.checkUrls ?? true);

    if (!shouldCheckUrls) {
      return {
        exitCode: 0,
        stdout: "URL check skipped.\n",
        stderr: "",
      };
    }

    const diffText = resolveDiffText(merged);
    const report = await checkUrlsInDiff(diffText, merged);
    if (report.failures.length === 0) {
      const suffix =
        report.checked > 0
          ? ` Checked ${report.checked} URL candidate${report.checked === 1 ? "" : "s"}.`
          : " No URL candidates found.";
      return {
        exitCode: 0,
        stdout: `Preflight passed.${suffix}\n`,
        stderr: "",
      };
    }

    return {
      exitCode: 1,
      stdout: "",
      stderr: formatPreflightFailureReport(report),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      exitCode: 1,
      stdout: "",
      stderr: `${message}\n\n${formatPreflightHelp()}\n`,
    };
  }
}

function resolveDiffText(options: PreflightCliOptions): string {
  if (options.diffText !== undefined) {
    return options.diffText;
  }

  if (options.diffFile) {
    return readFileSync(options.diffFile, "utf-8");
  }

  const cwd = options.cwd;
  const baseRefs = options.baseRef ? [options.baseRef] : ["origin/main", "main", "master"];
  let lastError: unknown = null;

  for (const baseRef of baseRefs) {
    try {
      return execSync(`git diff --no-ext-diff --unified=0 ${baseRef}...HEAD`, {
        cwd,
        encoding: "utf-8",
      });
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(
    `Unable to resolve a git diff for preflight.${lastError instanceof Error ? ` Last error: ${lastError.message}` : ""}`,
  );
}
