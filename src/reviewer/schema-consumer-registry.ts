/**
 * Schema-consumer auto-discovery registry.
 *
 * Replaces reliance on the static SCHEMA_CONSUMER_MAP with a live map built from:
 *
 *   1. **PRAGMA discovery** — queries `sqlite_master` to enumerate all tables
 *      currently in state.db; no code maintenance required as tables are added.
 *   2. **StateStore instrumentation** — the `schema_table_access` table records
 *      which StateStore `call_type` values touch which tables at runtime. The
 *      map grows automatically as the fleet runs.
 *   3. **Static fallback** — `SCHEMA_CONSUMER_MAP` entries cover non-DB schemas
 *      (openapi.yaml, agents.yaml, src/index, proxy routes) that cannot be
 *      discovered from state.db alone.
 *
 * The registry exposes a framework-agnostic `getSchemaConsumersApiPayload()`
 * function that the orchestrator or dashboard server can mount as
 * `GET /api/schema-consumers` — one-liner wiring, no peer dependency.
 *
 * Usage (in the orchestrator or dashboard Express server):
 *
 *   import { getSchemaConsumersApiPayload } from 'claude-orchestrator-reviewer';
 *
 *   app.get('/api/schema-consumers', (_req, res) => {
 *     res.json(getSchemaConsumersApiPayload());
 *   });
 *
 * Usage (in detectSchemaChanges for a live map at PR-review time):
 *
 *   import { SchemaConsumerRegistry } from 'claude-orchestrator-reviewer';
 *
 *   const registry = new SchemaConsumerRegistry(dbPath);
 *   const hits = detectSchemaChanges(diff, changedFiles, registry.getConsumerMap());
 *   registry.close();
 */

import Database from "better-sqlite3";
import { SCHEMA_CONSUMER_MAP } from "./schema-impact.js";
import type { SchemaConsumerEntry } from "./schema-impact.js";

// ── Known consumer rules by table-name pattern ────────────────────────────────

/**
 * Maps table-name substrings to the repos that read that table.
 *
 * Rules are evaluated in order; the first match wins. Tables that don't match
 * any rule fall back to `["rapartlu/agent-orchestrator", "rapartlu/agent-dashboard"]`.
 *
 * Add rules here when a new shared table is introduced so the dynamic map stays
 * accurate — this is cheaper than updating SCHEMA_CONSUMER_MAP because a single
 * pattern covers every table that matches the substring.
 */
const TABLE_CONSUMER_RULES: ReadonlyArray<{
  pattern: string;
  consumers: string[];
}> = [
  {
    pattern: "task",
    consumers: [
      "rapartlu/agent-orchestrator",
      "rapartlu/agent-dashboard",
      "rapartlu/agent-reviewer",
    ],
  },
  {
    pattern: "pr_review",
    consumers: [
      "rapartlu/agent-orchestrator",
      "rapartlu/agent-dashboard",
      "rapartlu/agent-reviewer",
    ],
  },
  {
    pattern: "supervisor",
    consumers: [
      "rapartlu/agent-orchestrator",
      "rapartlu/agent-dashboard",
      "rapartlu/agent-reviewer",
    ],
  },
  {
    pattern: "verification",
    consumers: [
      "rapartlu/agent-orchestrator",
      "rapartlu/agent-dashboard",
      "rapartlu/agent-reviewer",
    ],
  },
  {
    pattern: "iteration",
    consumers: [
      "rapartlu/agent-orchestrator",
      "rapartlu/agent-dashboard",
      "rapartlu/agent-reviewer",
    ],
  },
  {
    pattern: "routing",
    consumers: ["rapartlu/agent-orchestrator", "rapartlu/agent-dashboard"],
  },
  {
    pattern: "calibration",
    consumers: ["rapartlu/agent-orchestrator", "rapartlu/agent-dashboard"],
  },
  {
    pattern: "merge_queue",
    consumers: ["rapartlu/agent-orchestrator", "rapartlu/agent-reviewer"],
  },
  {
    pattern: "dispatch",
    consumers: ["rapartlu/agent-orchestrator"],
  },
  {
    pattern: "llm_call",
    consumers: ["rapartlu/agent-dashboard"],
  },
  {
    pattern: "health",
    consumers: ["rapartlu/agent-orchestrator", "rapartlu/agent-dashboard"],
  },
  {
    pattern: "standup",
    consumers: ["rapartlu/agent-orchestrator", "rapartlu/agent-dashboard"],
  },
  {
    pattern: "metric",
    consumers: ["rapartlu/agent-dashboard"],
  },
  {
    pattern: "secret",
    consumers: ["rapartlu/agent-orchestrator", "rapartlu/agent-dashboard"],
  },
  {
    pattern: "reroute",
    consumers: ["rapartlu/agent-orchestrator", "rapartlu/agent-dashboard"],
  },
  {
    pattern: "flag",
    consumers: ["rapartlu/agent-orchestrator"],
  },
];

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * A row from the `schema_table_access` instrumentation table.
 * Written by `StateStore.recordTableAccess()` as queries run.
 */
export interface TableAccessRecord {
  /** SQLite table name (e.g. "tasks", "pr_reviews"). */
  table_name: string;
  /**
   * The StateStore method category that touched this table
   * (e.g. "pr-review", "supervisor", "verification").
   */
  call_type: string;
  /** Total number of times this call_type has touched this table. */
  access_count: number;
  /** ISO-8601 timestamp of the most recent access. */
  last_seen_at: string;
}

/**
 * JSON payload returned by `GET /api/schema-consumers`.
 *
 * The `discovered_entries` array is what the reviewer uses instead of the
 * static constant — it reflects the current state.db schema automatically.
 */
export interface SchemaConsumerApiPayload {
  /** ISO-8601 timestamp when this payload was generated. */
  generated_at: string;
  /**
   * `"dynamic"` when state.db was successfully queried;
   * `"static-fallback"` when the DB was unreachable or empty.
   */
  source: "dynamic" | "static-fallback";
  /** All table names found in state.db (excluding sqlite_* internals). */
  db_tables: string[];
  /** Dynamically derived entries — one per discovered table. */
  discovered_entries: SchemaConsumerEntry[];
  /** Static entries from SCHEMA_CONSUMER_MAP (file-path patterns, non-DB schemas). */
  static_entries: SchemaConsumerEntry[];
  /** Call-type → table patterns recorded by StateStore instrumentation. */
  access_log: TableAccessRecord[];
}

// ── SchemaConsumerRegistry ────────────────────────────────────────────────────

export class SchemaConsumerRegistry {
  private db: Database.Database | null = null;

  /**
   * @param dbPath  Path to state.db. Defaults to `STATE_DB_PATH` env var or `"state.db"`.
   *                Pass `":memory:"` or a temp path in tests.
   */
  constructor(private readonly dbPath: string = process.env.STATE_DB_PATH ?? "state.db") {}

  // ── Internal helpers ────────────────────────────────────────────────────────

  private getDb(): Database.Database {
    if (!this.db) {
      // readonly + fileMustExist:false — safe even when state.db hasn't been
      // created yet (returns empty table list rather than throwing).
      this.db = new Database(this.dbPath, { readonly: true, fileMustExist: false });
    }
    return this.db;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Enumerate all user tables in state.db via `sqlite_master`.
   *
   * Safe to call with a non-existent or empty database — returns `[]`.
   */
  discoverTables(): string[] {
    try {
      const rows = this.getDb()
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as Array<{ name: string }>;
      return rows.map((r) => r.name);
    } catch {
      return [];
    }
  }

  /**
   * Build `SchemaConsumerEntry` items for a list of table names.
   *
   * Each entry targets `filePattern: "state/store"` (the file where tables are
   * defined) so `detectSchemaChanges()` will trigger on `state/store.ts` diffs
   * as before — but now consumers are inferred per-table rather than from a
   * single catch-all entry.
   *
   * `indicators` are set to SQL patterns specific to the table name so that
   * only actual schema-mutation diffs (CREATE TABLE, ALTER TABLE, …) trigger a
   * hit, not every store.ts refactor.
   */
  buildDynamicEntries(tables: string[]): SchemaConsumerEntry[] {
    return tables.map((tableName) => ({
      filePattern: "state/store",
      schemaLabel: `state.db table: ${tableName}`,
      consumers: inferConsumers(tableName),
      indicators: sqlIndicatorsForTable(tableName),
    }));
  }

  /**
   * Return the merged consumer map used by `detectSchemaChanges()`:
   *
   *   1. Dynamic per-table entries (from PRAGMA) — precise table-level matching
   *   2. Static SCHEMA_CONSUMER_MAP entries — covers non-DB schemas
   *
   * Falls back to `SCHEMA_CONSUMER_MAP` alone when state.db is unreachable.
   */
  getConsumerMap(): SchemaConsumerEntry[] {
    const tables = this.discoverTables();
    if (tables.length === 0) return [...SCHEMA_CONSUMER_MAP];
    return [...this.buildDynamicEntries(tables), ...SCHEMA_CONSUMER_MAP];
  }

  /**
   * Fetch the instrumentation log written by `StateStore.recordTableAccess()`.
   *
   * Returns `[]` when the `schema_table_access` table doesn't exist yet —
   * this is expected on fresh installs before any instrumented methods run.
   */
  getAccessLog(): TableAccessRecord[] {
    try {
      return this.getDb()
        .prepare(
          `SELECT table_name, call_type, access_count, last_seen_at
           FROM schema_table_access
           ORDER BY last_seen_at DESC
           LIMIT 500`,
        )
        .all() as TableAccessRecord[];
    } catch {
      return [];
    }
  }

  /**
   * Build the full payload for `GET /api/schema-consumers`.
   */
  toApiPayload(): SchemaConsumerApiPayload {
    const tables = this.discoverTables();
    const dynamicEntries = this.buildDynamicEntries(tables);
    const accessLog = this.getAccessLog();

    return {
      generated_at: new Date().toISOString(),
      source: tables.length > 0 ? "dynamic" : "static-fallback",
      db_tables: tables,
      discovered_entries: dynamicEntries,
      static_entries: [...SCHEMA_CONSUMER_MAP],
      access_log: accessLog,
    };
  }

  /** Close the SQLite connection. Safe to call multiple times. */
  close(): void {
    this.db?.close();
    this.db = null;
  }
}

// ── Framework-agnostic handler ────────────────────────────────────────────────

/**
 * Returns the `GET /api/schema-consumers` JSON payload without coupling to any
 * HTTP framework.
 *
 * Wire it up in the orchestrator or dashboard server:
 *
 * ```typescript
 * import { getSchemaConsumersApiPayload } from 'claude-orchestrator-reviewer';
 *
 * app.get('/api/schema-consumers', (_req, res) => {
 *   res.json(getSchemaConsumersApiPayload());
 * });
 * ```
 *
 * The reviewer fetches from this endpoint at PR-review time via
 * `fetchSchemaConsumerMap(apiBaseUrl)` and passes the result to
 * `detectSchemaChanges(diff, files, consumerMap)`.
 */
export function getSchemaConsumersApiPayload(
  dbPath: string = process.env.STATE_DB_PATH ?? "state.db",
): SchemaConsumerApiPayload {
  const registry = new SchemaConsumerRegistry(dbPath);
  try {
    return registry.toApiPayload();
  } finally {
    registry.close();
  }
}

/**
 * Fetch the consumer map from a running `GET /api/schema-consumers` endpoint.
 *
 * Called by the PR reviewer at review time to get a live map.
 * Falls back to `SCHEMA_CONSUMER_MAP` (static) on any network/parse error so
 * reviews continue even when the endpoint is unreachable.
 *
 * @param apiBaseUrl  Base URL of the server exposing the endpoint
 *                    (e.g. `"http://localhost:3472"` for the orchestrator daemon).
 * @param timeoutMs   Fetch timeout in milliseconds (default: 3000).
 */
export async function fetchSchemaConsumerMap(
  apiBaseUrl: string,
  timeoutMs = 3000,
): Promise<SchemaConsumerEntry[]> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`${apiBaseUrl}/api/schema-consumers`, {
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) return [...SCHEMA_CONSUMER_MAP];

    const payload = (await res.json()) as SchemaConsumerApiPayload;

    // Prefer discovered_entries; fall back to static_entries if discovery failed
    const dynamic = payload.discovered_entries ?? [];
    const staticEntries = payload.static_entries ?? SCHEMA_CONSUMER_MAP;
    return dynamic.length > 0 ? [...dynamic, ...staticEntries] : [...staticEntries];
  } catch {
    // Network error, timeout, or parse error — return static map so reviews continue
    return [...SCHEMA_CONSUMER_MAP];
  }
}

// ── Private helpers ───────────────────────────────────────────────────────────

function inferConsumers(tableName: string): string[] {
  const lower = tableName.toLowerCase();
  for (const rule of TABLE_CONSUMER_RULES) {
    if (lower.includes(rule.pattern)) {
      return [...rule.consumers];
    }
  }
  // Conservative default: orchestrator writes, dashboard reads
  return ["rapartlu/agent-orchestrator", "rapartlu/agent-dashboard"];
}

function sqlIndicatorsForTable(tableName: string): string[] {
  // Case-insensitive matching is already handled by detectSchemaChanges(),
  // so we provide the canonical mixed-case forms here.
  return [
    `CREATE TABLE IF NOT EXISTS ${tableName}`,
    `CREATE TABLE ${tableName}`,
    `ALTER TABLE ${tableName}`,
    `DROP TABLE ${tableName}`,
  ];
}
