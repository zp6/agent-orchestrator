import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { execSync } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1_000;
const DEFAULT_CACHE_PATH = `${homedir()}/.claude-orchestrator/preflight-url-cache.json`;
const SKIP_MARKER = "@preflight-skip-url-check";

const URL_PATTERN = /https?:\/\/[^\s"'`<>\])}]+/gi;

export interface PreflightCliOptions {
  cwd?: string;
  baseRef?: string;
  diffText?: string;
  diffFile?: string;
  checkUrls?: boolean;
  skipUrlCheck?: boolean;
  help?: boolean;
  timeoutMs?: number;
  cachePath?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface PreflightCliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface DiffLine {
  lineNumber: number;
  text: string;
}

interface DiffFileBlock {
  filePath: string;
  lines: DiffLine[];
  hasSkipMarker: boolean;
}

interface PreflightUrlCandidate {
  url: string;
  filePath: string;
  lineNumber: number;
  sourceLine: string;
}

interface ProbeResult {
  url: string;
  ok: boolean;
  statusCode: number | null;
  errorCode: string | null;
  errorMessage: string | null;
}

interface CacheEntry {
  checkedAt: number;
  result: ProbeResult;
}

interface CacheFile {
  version: number;
  entries: Record<string, CacheEntry>;
}

export interface PreflightFailure {
  url: string;
  hostname: string;
  filePath: string;
  lineNumber: number;
  reason: string;
  rootStatus: string;
  pathStatus?: string;
}

export interface PreflightReport {
  checked: number;
  skipped: number;
  failures: PreflightFailure[];
}

const USAGE = [
  "Usage:",
  "  orch preflight [--check-urls] [--skip-url-check] [--base <ref>] [--diff-file <path>]",
  "",
  "Options:",
  "  --check-urls       Run the external-URL reachability gate.",
  "  --skip-url-check   Skip the URL gate for intentional stubs or offline work.",
  "  --base <ref>       Base ref for the git diff fallback (default: origin/main, then main).",
  "  --diff-file <path>  Read a precomputed unified diff from a file.",
  "  --help, -h         Show this help text.",
  "",
  "Behavior:",
  "  - Scans added/modified string literals for URL patterns.",
  "  - Probes each unique hostname with HEAD first, then GET on 405/501.",
  "  - Probes documented URL paths when a root host succeeds.",
  "  - Caches probe results for 1 hour in ~/.claude-orchestrator/preflight-url-cache.json.",
  `  - Respect inline stub markers: // ${SKIP_MARKER}`,
].join("\n");

export function formatPreflightHelp(): string {
  return [
    "orch preflight",
    "",
    "Run preflight checks before submitting a PR.",
    "The URL gate scans the diff for external URL literals and probes them for reachability before review starts.",
    "",
    USAGE,
  ].join("\n");
}

export function parsePreflightArgs(argv: string[]): PreflightCliOptions {
  const opts: PreflightCliOptions = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--check-urls") {
      opts.checkUrls = true;
      continue;
    }
    if (arg === "--skip-url-check") {
      opts.skipUrlCheck = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      opts.help = true;
      continue;
    }
    if (arg === "--base") {
      const value = argv[++i];
      if (!value) throw new Error("Missing value for --base.");
      opts.baseRef = value;
      continue;
    }
    if (arg === "--diff-file") {
      const value = argv[++i];
      if (!value) throw new Error("Missing value for --diff-file.");
      opts.diffFile = value;
      continue;
    }
    if (arg === "--cwd") {
      const value = argv[++i];
      if (!value) throw new Error("Missing value for --cwd.");
      opts.cwd = value;
      continue;
    }
    if (arg === "--timeout-ms") {
      const value = argv[++i];
      if (!value) throw new Error("Missing value for --timeout-ms.");
      const timeoutMs = Number(value);
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new Error("--timeout-ms must be a positive number.");
      }
      opts.timeoutMs = timeoutMs;
      continue;
    }
    throw new Error(`Unknown argument "${arg}".`);
  }

  return opts;
}

export function scanPreflightUrlCandidates(diffText: string): PreflightUrlCandidate[] {
  const blocks = parseDiffBlocks(diffText);
  const candidates: PreflightUrlCandidate[] = [];

  for (const block of blocks) {
    if (block.hasSkipMarker) {
      continue;
    }
    for (const line of block.lines) {
      for (const match of line.text.matchAll(URL_PATTERN)) {
        const url = trimTrailingPunctuation(match[0] ?? "");
        if (!url) continue;
        candidates.push({
          url,
          filePath: block.filePath,
          lineNumber: line.lineNumber,
          sourceLine: line.text,
        });
      }
    }
  }

  return candidates;
}

export async function checkUrlsInDiff(
  diffText: string,
  options: PreflightCliOptions = {},
): Promise<PreflightReport> {
  const candidates = scanPreflightUrlCandidates(diffText);
  const now = options.now ?? (() => Date.now());
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const cachePath = options.cachePath ?? DEFAULT_CACHE_PATH;
  const cache = loadCache(cachePath);
  const cacheChanged = { value: false };
  const failures: PreflightFailure[] = [];

  const byHost = new Map<string, PreflightUrlCandidate[]>();
  for (const candidate of candidates) {
    const host = new URL(candidate.url).hostname.toLowerCase();
    const list = byHost.get(host) ?? [];
    list.push(candidate);
    byHost.set(host, list);
  }

  const pathResults = new Map<string, ProbeResult>();

  for (const [hostname, items] of byHost.entries()) {
    if (isInternalHostname(hostname)) {
      continue;
    }

    const rootUrl = buildRootUrl(items[0]!.url);
    const rootKey = cacheKey("root", rootUrl);
    const rootResult = await getOrProbeUrl(
      rootKey,
      rootUrl,
      fetchImpl,
      now,
      timeoutMs,
      cache,
      cacheChanged,
    );

    if (!rootResult.ok) {
      for (const candidate of items) {
        failures.push({
          url: candidate.url,
          hostname,
          filePath: candidate.filePath,
          lineNumber: candidate.lineNumber,
          reason: `${hostname} unreachable: ${rootResult.errorCode ?? rootResult.statusCode ?? "unknown"}`,
          rootStatus: formatProbeStatus(rootResult),
        });
      }
      continue;
    }

    for (const candidate of items) {
      const url = normalizeProbeUrl(candidate.url);
      if (isRootPath(url.pathname, url.search)) {
        continue;
      }

      const pathKey = cacheKey("path", url.href);
      let pathResult = pathResults.get(pathKey);
      if (!pathResult) {
        pathResult = await getOrProbeUrl(
          pathKey,
          url.href,
          fetchImpl,
          now,
          timeoutMs,
          cache,
          cacheChanged,
        );
        pathResults.set(pathKey, pathResult);
      }

      if (isPathFailure(pathResult)) {
        failures.push({
          url: candidate.url,
          hostname,
          filePath: candidate.filePath,
          lineNumber: candidate.lineNumber,
          reason: `${candidate.url} unreachable: ${pathResult.errorCode ?? pathResult.statusCode ?? "unknown"}`,
          rootStatus: formatProbeStatus(rootResult),
          pathStatus: formatProbeStatus(pathResult),
        });
      }
    }
  }

  if (cacheChanged.value) {
    saveCache(cachePath, cache);
  }

  return {
    checked: candidates.length,
    skipped: countSkippedFiles(diffText),
    failures,
  };
}

export function formatPreflightFailureReport(report: PreflightReport): string {
  const lines: string[] = [
    "Preflight failed.",
    "",
    `URL reachability check failed for ${report.failures.length} candidate${report.failures.length === 1 ? "" : "s"}.`,
    "",
  ];

  for (const failure of report.failures) {
    lines.push(
      `- \`${failure.filePath}:${failure.lineNumber}\` \`${failure.url}\``,
      `  - reason: ${failure.reason}`,
      `  - root probe: ${failure.rootStatus}`,
    );
    if (failure.pathStatus) {
      lines.push(`  - path probe: ${failure.pathStatus}`);
    }
    lines.push(
      `  - suggestion: verify the endpoint exists before submitting this PR; if this is intentional stub code, mark it with \`// ${SKIP_MARKER}\` adjacent to the constant.`,
    );
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function parseDiffBlocks(diffText: string): DiffFileBlock[] {
  const blocks: DiffFileBlock[] = [];
  let current: DiffFileBlock | null = null;
  let currentLineNumber = 0;

  for (const rawLine of diffText.split(/\r?\n/)) {
    const headerMatch = rawLine.match(/^diff --git a\/(.+?) b\/.+$/);
    if (headerMatch) {
      current = {
        filePath: headerMatch[1]!,
        lines: [],
        hasSkipMarker: false,
      };
      blocks.push(current);
      currentLineNumber = 0;
      continue;
    }

    const plusMatch = rawLine.match(/^\+\+\+ b\/(.+)$/);
    if (plusMatch && (!current || current.filePath === "")) {
      current = {
        filePath: plusMatch[1]!,
        lines: [],
        hasSkipMarker: false,
      };
      blocks.push(current);
      currentLineNumber = 0;
      continue;
    }

    const hunkMatch = rawLine.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      currentLineNumber = Number(hunkMatch[1]);
      continue;
    }

    if (!current) {
      continue;
    }

    if (rawLine.startsWith("+") && !rawLine.startsWith("+++")) {
      const text = rawLine.slice(1);
      current.lines.push({ lineNumber: currentLineNumber, text });
      if (text.includes(SKIP_MARKER)) {
        current.hasSkipMarker = true;
      }
      currentLineNumber += 1;
      continue;
    }

    if (rawLine.startsWith(" ")) {
      currentLineNumber += 1;
    }
  }

  return blocks;
}

function countSkippedFiles(diffText: string): number {
  return parseDiffBlocks(diffText).filter((block) => block.hasSkipMarker).length;
}

function trimTrailingPunctuation(url: string): string {
  return url.replace(/[.,;:!?]+$/g, "").replace(/[)\]}]+$/g, "");
}

function normalizeProbeUrl(value: string): URL {
  const url = new URL(value);
  url.hash = "";
  return url;
}

function buildRootUrl(value: string): string {
  const url = normalizeProbeUrl(value);
  url.pathname = "/";
  url.search = "";
  return url.href;
}

function isRootPath(pathname: string, search: string): boolean {
  return (pathname === "/" || pathname === "") && search === "";
}

function isInternalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "host.docker.internal" ||
    normalized === "example.com" ||
    normalized.endsWith(".example.com") ||
    normalized.endsWith(".test")
  );
}

function cacheKey(kind: "root" | "path", url: string): string {
  return `${kind}:${url}`;
}

function loadCache(cachePath: string): CacheFile {
  try {
    const raw = readFileSync(cachePath, "utf-8");
    const parsed = JSON.parse(raw) as CacheFile;
    if (!parsed || parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== "object") {
      return { version: 1, entries: {} };
    }
    return parsed;
  } catch {
    return { version: 1, entries: {} };
  }
}

function saveCache(cachePath: string, cache: CacheFile): void {
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, `${JSON.stringify(cache, null, 2)}\n`);
}

async function getOrProbeUrl(
  key: string,
  url: string,
  fetchImpl: typeof fetch,
  now: () => number,
  timeoutMs: number,
  cache: CacheFile,
  cacheChanged: { value: boolean },
): Promise<ProbeResult> {
  const cached = cache.entries[key];
  if (cached && now() - cached.checkedAt <= DEFAULT_CACHE_TTL_MS) {
    return cached.result;
  }

  const result = await probeUrl(url, fetchImpl, timeoutMs);
  cache.entries[key] = { checkedAt: now(), result };
  cacheChanged.value = true;
  return result;
}

async function probeUrl(url: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<ProbeResult> {
  const headResult = await probeWithMethod(url, "HEAD", fetchImpl, timeoutMs);
  if (headResult.ok || !shouldFallbackToGet(headResult)) {
    return headResult;
  }
  return probeWithMethod(url, "GET", fetchImpl, timeoutMs);
}

async function probeWithMethod(
  url: string,
  method: "HEAD" | "GET",
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method,
      signal: controller.signal,
    });
    return {
      url,
      ok: response.ok,
      statusCode: response.status,
      errorCode: null,
      errorMessage: null,
    };
  } catch (error) {
    const { code, message } = extractErrorDetails(error);
    return {
      url,
      ok: false,
      statusCode: null,
      errorCode: code,
      errorMessage: message,
    };
  } finally {
    clearTimeout(timer);
  }
}

function shouldFallbackToGet(result: ProbeResult): boolean {
  return result.statusCode === 405 || result.statusCode === 501;
}

function isPathFailure(result: ProbeResult): boolean {
  if (result.errorCode) return true;
  if (result.statusCode === 404) return true;
  return typeof result.statusCode === "number" && result.statusCode >= 500;
}

function formatProbeStatus(result: ProbeResult): string {
  if (result.errorCode) {
    return result.errorCode;
  }
  if (typeof result.statusCode === "number") {
    return String(result.statusCode);
  }
  return "unknown";
}

function extractErrorDetails(error: unknown): { code: string | null; message: string } {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (typeof current === "object" && current !== null) {
      const maybe = current as { code?: unknown; message?: unknown; cause?: unknown };
      if (typeof maybe.code === "string") {
        return {
          code: maybe.code,
          message: typeof maybe.message === "string" ? maybe.message : String(error),
        };
      }
      current = maybe.cause;
      continue;
    }
    break;
  }
  return {
    code: null,
    message: error instanceof Error ? error.message : String(error),
  };
}
