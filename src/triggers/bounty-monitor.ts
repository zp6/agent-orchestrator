/**
 * Bounty Monitor — periodic poller that stocks `bounty_opportunities` from
 * crypto-native sources only (Layer 2 of #1512).
 *
 * Per CLAUDE.md "Hustle discipline" and the discipline-drift rejection on the
 * parent issue, the monitor's source list is constrained to paths whose payout
 * rails do NOT touch operator-held fiat banking, Stripe Connect, Wise, or KYC
 * handlers:
 *
 *   ✅ Immunefi (USDC / DAI payouts, sanctioned security research)
 *   ✅ GitHub search for fresh `/bounty` comments and bounty-labeled issues
 *      on public repos (read-only, no signup, on-chain payout if any)
 *
 * Out of scope:
 *   ❌ Algora RSS — Algora payouts route through Stripe Connect (KYC chain)
 *   ❌ Any source whose payout requires fiat banking or KYC handler
 *
 * Feature flags (loaded from `~/.claude-orchestrator/.env` per #1539):
 *   BOUNTY_MONITOR_ENABLED          — master switch, default "false"
 *   BOUNTY_MONITOR_IMMUNEFI         — per-source override, default "true" when master is on
 *   BOUNTY_MONITOR_GITHUB           — per-source override, default "true" when master is on
 *   BOUNTY_MONITOR_IMMUNEFI_FEED_URL — operator-supplied feed URL. Required to
 *                                      enable the Immunefi source: there is no
 *                                      hard-coded default because the team has
 *                                      not yet verified a stable endpoint
 *                                      (see #1642's hallucinated-endpoint lesson).
 *   BOUNTY_MONITOR_GITHUB_QUERY     — operator-tunable search query
 *                                     (default: `is:issue is:open label:bounty`)
 *
 * Design decisions:
 * - Fail-open: any HTTP / parse error is logged and the function returns
 *   without crashing the daemon. The next poll cycle retries.
 * - Dedupe by `source_url` UNIQUE constraint on `bounty_opportunities`.
 * - Sanitizer flagged items are inserted with status='quarantined' so the
 *   queue review cycle can surface them (mirrors the executor pattern in
 *   trigger-dispatcher.ts).
 * - No retroactive backfill: each source returns at most ~25 recent items;
 *   anything older that lapses out of the feed is simply not picked up.
 * - Telemetry: logs `scanned / new-inserted / deny-listed / quarantined`
 *   counts per cycle.
 *
 * Related: #1598 (this issue), #1527 (Layer 1 dispatcher), #1557 (deny-list +
 * sanitizer), #1562 (Layer 4 on-chain revenue watcher), #1273 (full sanitizer).
 */

import { createLogger } from "../service/logger.js";
import { sanitizeBountyContent } from "../orchestrator/bounty-sanitizer.js";
import { scoreBountyOpportunity } from "../orchestrator/bounty-matcher.js";
import { buildClaimBrief } from "../orchestrator/bounty-matcher.js";
import type { StateStore } from "../state/store.js";

const log = createLogger("bounty-monitor");

// ── Types ──────────────────────────────────────────────────────────────────────

export interface BountyMonitorResult {
  dispatched: number;
  skipped: number;
  errors: string[];
}

/**
 * Normalized intermediate shape produced by each source adapter. The monitor
 * lifts these into `bounty_opportunities` rows, scoring + sanitizing along the
 * way.
 */
export interface BountySourceItem {
  source_url: string;
  title: string;
  platform: string;
  scope: string | null;
  payout_amount_usd: number | null;
  payout_currency: string | null;
  payout_terms: string | null;
  deadline: string | null;
  capabilities: string[];
  notes: string | null;
}

export interface BountyMonitorOptions {
  /**
   * Inject a fetch implementation for testing. Defaults to the global `fetch`.
   */
  fetchImpl?: typeof fetch;
  /**
   * Override Immunefi feed URL. Falls back to `BOUNTY_MONITOR_IMMUNEFI_FEED_URL`.
   */
  immunefiFeedUrl?: string;
  /**
   * Override GitHub search query. Falls back to `BOUNTY_MONITOR_GITHUB_QUERY`
   * or the default `is:issue is:open label:bounty`.
   */
  githubQuery?: string;
  /**
   * Override the registered source adapters. Used by tests to inject canned
   * BountySourceItem lists without touching the network.
   */
  sourceOverride?: () => Promise<BountySourceItem[]>;
}

// ── Adapters ──────────────────────────────────────────────────────────────────

/**
 * Parse a (very small subset of) RSS / Atom feed XML into BountySourceItem[].
 *
 * Intentionally hand-rolled to avoid pulling a heavy XML dep into the monitor
 * for what amounts to title + link + description extraction. If a feed
 * deviates from these conventions the adapter returns an empty list and logs
 * a parse warning — fail-open.
 */
export function parseRssItems(xml: string, platform: string): BountySourceItem[] {
  const items: BountySourceItem[] = [];
  // Try `<item>` (RSS 2.0) first; fall back to `<entry>` (Atom).
  const itemRe = /<(item|entry)\b[\s\S]*?<\/\1>/gi;
  const matches = xml.match(itemRe) ?? [];

  for (const block of matches) {
    const title = extractTag(block, "title") ?? extractTag(block, "summary") ?? "";
    let link = extractTag(block, "link") ?? "";
    if (!link) {
      // Atom-style <link href="..." />
      const hrefMatch = block.match(/<link\b[^>]*\bhref=["']([^"']+)["']/i);
      if (hrefMatch) link = hrefMatch[1] ?? "";
    }
    const description =
      extractTag(block, "description") ?? extractTag(block, "summary") ?? extractTag(block, "content") ?? "";

    if (!title.trim() || !link.trim()) continue;

    items.push({
      source_url: link.trim(),
      title: stripCdata(title).trim().slice(0, 280),
      platform,
      scope: stripCdata(description).trim() || null,
      payout_amount_usd: null,
      payout_currency: "USDC", // Immunefi pays in stablecoin by default
      payout_terms: null,
      deadline: null,
      capabilities: ["security-review", "audit", "smart-contracts"],
      notes: `discovered via ${platform} feed`,
    });
  }
  return items;
}

function extractTag(block: string, tag: string): string | null {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = block.match(re);
  return m ? m[1] : null;
}

function stripCdata(text: string): string {
  return text.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "");
}

/**
 * Fetch and parse the Immunefi feed.
 *
 * Per the #1642 lesson on hallucinated external endpoints, this adapter
 * REQUIRES an operator-supplied URL via `BOUNTY_MONITOR_IMMUNEFI_FEED_URL`
 * (or `opts.immunefiFeedUrl`). It does not fall back to a guessed default —
 * if the URL is missing the adapter returns an empty list and the cycle skips.
 */
export async function fetchImmunefi(
  opts: {
    fetchImpl: typeof fetch;
    feedUrl: string | null;
  },
): Promise<BountySourceItem[]> {
  if (!opts.feedUrl) {
    log.info("bounty-monitor: Immunefi source enabled but no feed URL configured; set BOUNTY_MONITOR_IMMUNEFI_FEED_URL");
    return [];
  }

  const res = await opts.fetchImpl(opts.feedUrl, {
    headers: { "User-Agent": "fleet-bounty-monitor/1.0" },
  });
  if (!res.ok) {
    throw new Error(`Immunefi feed HTTP ${res.status}`);
  }
  const xml = await res.text();
  return parseRssItems(xml, "immunefi");
}

interface GitHubSearchResponse {
  items?: Array<{
    html_url?: string;
    title?: string;
    body?: string | null;
    labels?: Array<{ name?: string }>;
    repository_url?: string;
  }>;
}

/**
 * Fetch fresh GitHub issues matching a bounty-related search query.
 *
 * Uses the documented Search Issues endpoint:
 *   https://docs.github.com/en/rest/search/search#search-issues-and-pull-requests
 *
 * Authorization is optional but increases rate limits. When `GITHUB_TOKEN`
 * (or `GH_TOKEN`) is set the adapter sends it as a Bearer token.
 *
 * Default query: `is:issue is:open label:bounty` — targets repos that
 * explicitly tag bounty-labeled issues. Operators can override via
 * `BOUNTY_MONITOR_GITHUB_QUERY`.
 */
export async function fetchGitHubBounties(
  opts: {
    fetchImpl: typeof fetch;
    query: string;
  },
): Promise<BountySourceItem[]> {
  const url = new URL("https://api.github.com/search/issues");
  url.searchParams.set("q", opts.query);
  url.searchParams.set("sort", "created");
  url.searchParams.set("order", "desc");
  url.searchParams.set("per_page", "25");

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "fleet-bounty-monitor/1.0",
  };
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await opts.fetchImpl(url.toString(), { headers });
  if (!res.ok) {
    throw new Error(`GitHub search HTTP ${res.status}`);
  }
  const data = (await res.json()) as GitHubSearchResponse;
  const out: BountySourceItem[] = [];
  for (const item of data.items ?? []) {
    if (!item.html_url || !item.title) continue;
    const labelNames = (item.labels ?? [])
      .map((l) => (l.name ?? "").toLowerCase())
      .filter(Boolean);
    out.push({
      source_url: item.html_url,
      title: item.title.slice(0, 280),
      platform: "github",
      scope: item.body ? item.body.slice(0, 4000) : null,
      payout_amount_usd: null,
      payout_currency: null,
      payout_terms: null,
      deadline: null,
      capabilities: inferCapabilitiesFromLabels(labelNames),
      notes: `discovered via GitHub search: ${opts.query}`,
    });
  }
  return out;
}

function inferCapabilitiesFromLabels(labels: string[]): string[] {
  const caps = new Set<string>();
  for (const l of labels) {
    if (l.includes("typescript") || l.includes("ts")) caps.add("typescript");
    if (l.includes("javascript") || l.includes("js")) caps.add("javascript");
    if (l.includes("rust")) caps.add("rust");
    if (l.includes("python") || l.includes("py")) caps.add("python");
    if (l.includes("solidity") || l.includes("contract")) caps.add("smart-contracts");
    if (l.includes("security") || l.includes("audit")) caps.add("security-review");
    if (l.includes("bug")) caps.add("bug-fix");
    if (l.includes("docs")) caps.add("docs");
    if (l.includes("test")) caps.add("testing");
  }
  return Array.from(caps);
}

// ── Main export ────────────────────────────────────────────────────────────────

/**
 * Truthy-string check matching the existing pattern in trigger-dispatcher.ts.
 */
function envEnabled(name: string, defaultWhenMasterOn: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return defaultWhenMasterOn;
  const normalized = raw.trim().toLowerCase();
  if (["", "0", "false", "no", "off"].includes(normalized)) return false;
  return true;
}

/**
 * Periodic crypto-native bounty source poller.
 *
 * Lifts new opportunities from each enabled source into `bounty_opportunities`,
 * scoring, sanitizing, and deny-list-filtering along the way.
 *
 * Governed by `BOUNTY_MONITOR_ENABLED` (default: false). Fail-open: per-source
 * errors are logged and counted but do not abort the cycle.
 */
export async function dispatchBountyMonitor(
  store: StateStore,
  opts: BountyMonitorOptions = {},
): Promise<BountyMonitorResult> {
  const result: BountyMonitorResult = { dispatched: 0, skipped: 0, errors: [] };

  // Master feature flag — disabled by default.
  if (process.env.BOUNTY_MONITOR_ENABLED !== "true") {
    result.skipped = 1;
    return result;
  }

  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    result.errors.push("bounty-monitor: no fetch implementation available");
    return result;
  }

  // Collect items from each enabled source.
  const items: BountySourceItem[] = [];

  if (opts.sourceOverride) {
    try {
      items.push(...(await opts.sourceOverride()));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn("bounty-monitor: source override failed", { error: msg });
      result.errors.push(`source-override: ${msg}`);
    }
  } else {
    if (envEnabled("BOUNTY_MONITOR_IMMUNEFI", true)) {
      try {
        const fetched = await fetchImmunefi({
          fetchImpl,
          feedUrl:
            opts.immunefiFeedUrl ?? process.env.BOUNTY_MONITOR_IMMUNEFI_FEED_URL ?? null,
        });
        items.push(...fetched);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn("bounty-monitor: Immunefi fetch failed — fail-open", { error: msg });
        result.errors.push(`immunefi: ${msg}`);
      }
    }

    if (envEnabled("BOUNTY_MONITOR_GITHUB", true)) {
      try {
        const fetched = await fetchGitHubBounties({
          fetchImpl,
          query:
            opts.githubQuery ??
            process.env.BOUNTY_MONITOR_GITHUB_QUERY ??
            "is:issue is:open label:bounty",
        });
        items.push(...fetched);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn("bounty-monitor: GitHub fetch failed — fail-open", { error: msg });
        result.errors.push(`github: ${msg}`);
      }
    }
  }

  // Counters for the per-cycle telemetry line.
  let scanned = 0;
  let newInserted = 0;
  let denyListed = 0;
  let quarantined = 0;
  let duplicates = 0;

  for (const item of items) {
    scanned++;

    // 1. Deny-list check — reuses #1557 plumbing.
    const denyEntry = store.isBountySourceDenylisted(item.source_url);
    if (denyEntry) {
      denyListed++;
      log.info("bounty-monitor: skipping deny-listed source", {
        sourceUrl: item.source_url,
        denylistEntry: denyEntry.org_or_repo,
      });
      continue;
    }

    // 2. Sanitizer — pre-#1273 conservative pattern library.
    const contentToCheck = [item.title, item.scope, item.notes].filter(Boolean).join("\n");
    const sanitizeResult = sanitizeBountyContent(contentToCheck);
    const isQuarantined = !sanitizeResult.safe;

    // 3. Insert. addBountyOpportunity throws on duplicate source_url; we
    // treat that as a normal dedupe-skip.
    let inserted;
    try {
      inserted = store.addBountyOpportunity({
        source_url: item.source_url,
        title: item.title,
        platform: item.platform,
        scope: item.scope ?? undefined,
        payout_amount_usd: item.payout_amount_usd ?? undefined,
        payout_currency: item.payout_currency ?? undefined,
        payout_terms: item.payout_terms ?? undefined,
        deadline: item.deadline ?? undefined,
        capabilities: item.capabilities,
        notes: item.notes ?? undefined,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("already tracked")) {
        duplicates++;
        continue;
      }
      log.warn("bounty-monitor: insert failed", { sourceUrl: item.source_url, error: msg });
      result.errors.push(`insert ${item.source_url}: ${msg}`);
      continue;
    }

    if (isQuarantined) {
      store.updateBountyOpportunityStatus(inserted.id, "quarantined");
      quarantined++;
      log.info("bounty-monitor: inserted quarantined (injection pattern)", {
        opportunityId: inserted.id,
        sourceUrl: inserted.source_url,
        sanitizerReason: sanitizeResult.reason,
      });
      continue;
    }

    // 4. Score and write the brief so Layer 1 can pick it up immediately.
    try {
      const score = scoreBountyOpportunity({
        title: inserted.title,
        scope: inserted.scope,
        payout_amount_usd: inserted.payout_amount_usd,
        payout_currency: inserted.payout_currency,
        payout_terms: inserted.payout_terms,
        deadline: inserted.deadline,
        capabilities: inserted.capabilities,
        notes: inserted.notes,
      });
      const brief = buildClaimBrief(inserted, score);
      store.updateBountyOpportunityScore(inserted.id, score.score, score.rationale, brief);
    } catch (scoreErr) {
      // Scoring failure is non-fatal — leave the row with status='open' and a
      // null score; the executor's filter already skips unscored rows.
      log.warn("bounty-monitor: scoring failed (row left unscored)", {
        opportunityId: inserted.id,
        error: scoreErr instanceof Error ? scoreErr.message : String(scoreErr),
      });
    }

    newInserted++;
  }

  result.dispatched = newInserted;
  result.skipped = duplicates + denyListed + quarantined;

  log.info("bounty-monitor: cycle complete", {
    scanned,
    newInserted,
    denyListed,
    quarantined,
    duplicates,
    errors: result.errors.length,
  });

  return result;
}
