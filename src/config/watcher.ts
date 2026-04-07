/**
 * Config Watcher — watches agents.yaml for changes and produces a diff of
 * what changed.  The Daemon subscribes to changes and applies them at runtime.
 *
 * Uses fs.watch (inotify on Linux, FSEvents on macOS) with debouncing to
 * avoid rapid-fire reloads during editor save sequences.
 */

import { watch, type FSWatcher } from "node:fs";
import { loadConfig, type OrchestratorConfig } from "./schema.js";
import { validateConfig, type ValidationError } from "./validator.js";
import { createLogger } from "../service/logger.js";

const log = createLogger("config-watcher");

/** Describes a single field that changed between two config snapshots. */
export interface ConfigChange {
  path: string;
  oldValue: unknown;
  newValue: unknown;
}

/** Result of a reload attempt. */
export interface ReloadResult {
  success: boolean;
  changes: ConfigChange[];
  errors: ValidationError[];
  /** ISO timestamp of the reload. */
  timestamp: string;
}

export type ConfigChangeHandler = (newConfig: OrchestratorConfig, changes: ConfigChange[]) => void;

// ── Diffing ────────────────────────────────────────────────────────────────

/**
 * Shallow-diff two config objects and return a list of changed paths.
 * Recurses into objects but treats arrays as atomic values.
 */
export function diffConfig(
  oldConfig: OrchestratorConfig,
  newConfig: OrchestratorConfig,
  prefix = "",
): ConfigChange[] {
  const changes: ConfigChange[] = [];
  const oldObj = oldConfig as unknown as Record<string, unknown>;
  const newObj = newConfig as unknown as Record<string, unknown>;

  const allKeys = new Set([...Object.keys(oldObj), ...Object.keys(newObj)]);
  for (const key of allKeys) {
    const path = prefix ? `${prefix}.${key}` : key;
    const oldVal = oldObj[key];
    const newVal = newObj[key];

    // Skip functions and the agents map (too noisy for top-level diff)
    if (typeof oldVal === "function" || typeof newVal === "function") continue;

    if (oldVal === newVal) continue;

    // Both are plain objects (not arrays) — recurse
    if (
      oldVal != null &&
      newVal != null &&
      typeof oldVal === "object" &&
      typeof newVal === "object" &&
      !Array.isArray(oldVal) &&
      !Array.isArray(newVal)
    ) {
      // For the agents map, diff each agent individually
      if (key === "agents") {
        const oldAgents = oldVal as Record<string, unknown>;
        const newAgents = newVal as Record<string, unknown>;
        const agentNames = new Set([...Object.keys(oldAgents), ...Object.keys(newAgents)]);
        for (const agentName of agentNames) {
          if (!(agentName in oldAgents)) {
            changes.push({ path: `${path}.${agentName}`, oldValue: undefined, newValue: newAgents[agentName] });
          } else if (!(agentName in newAgents)) {
            changes.push({ path: `${path}.${agentName}`, oldValue: oldAgents[agentName], newValue: undefined });
          } else if (JSON.stringify(oldAgents[agentName]) !== JSON.stringify(newAgents[agentName])) {
            changes.push({ path: `${path}.${agentName}`, oldValue: oldAgents[agentName], newValue: newAgents[agentName] });
          }
        }
        continue;
      }

      // Recurse into sub-objects
      const subChanges = diffConfig(
        oldVal as unknown as OrchestratorConfig,
        newVal as unknown as OrchestratorConfig,
        path,
      );
      changes.push(...subChanges);
      continue;
    }

    // Primitive or array — compare via JSON serialization
    if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
      changes.push({ path, oldValue: oldVal, newValue: newVal });
    }
  }

  return changes;
}

// ── Watcher ────────────────────────────────────────────────────────────────

const DEBOUNCE_MS = 500;

export class ConfigWatcher {
  private watcher: FSWatcher | null = null;
  private configPath: string;
  private currentConfig: OrchestratorConfig;
  private handler: ConfigChangeHandler;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastReload: ReloadResult | null = null;

  constructor(
    configPath: string,
    currentConfig: OrchestratorConfig,
    handler: ConfigChangeHandler,
  ) {
    this.configPath = configPath;
    this.currentConfig = currentConfig;
    this.handler = handler;
  }

  /** Start watching agents.yaml for changes. */
  start(): void {
    if (this.watcher) return;

    try {
      this.watcher = watch(this.configPath, (_eventType) => {
        // Debounce — editors often write multiple times in quick succession
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => this.reload(), DEBOUNCE_MS);
      });

      // Don't let the watcher prevent Node from exiting
      this.watcher.unref();
      log.info("Config watcher started", { path: this.configPath });
    } catch (err) {
      log.error("Failed to start config watcher", {
        path: this.configPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Stop watching. */
  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
      log.info("Config watcher stopped");
    }
  }

  /** Get the result of the last reload attempt. */
  getLastReload(): ReloadResult | null {
    return this.lastReload;
  }

  /**
   * Force a reload of agents.yaml.  Called by the file watcher (debounced)
   * or explicitly via SIGUSR1 / `orch config reload`.
   */
  reload(): ReloadResult {
    const timestamp = new Date().toISOString();

    try {
      const newConfig = loadConfig(this.configPath);

      // Validate before applying
      const errors = validateConfig(newConfig);
      if (errors.length > 0) {
        log.error("Config reload rejected — validation failed", {
          errorCount: errors.length,
          errors: errors.map((e) => `${e.path}: ${e.message}`),
        });
        this.lastReload = { success: false, changes: [], errors, timestamp };
        return this.lastReload;
      }

      // Diff
      const changes = diffConfig(this.currentConfig, newConfig);

      if (changes.length === 0) {
        log.info("Config reload: no changes detected");
        this.lastReload = { success: true, changes: [], errors: [], timestamp };
        return this.lastReload;
      }

      // Apply
      log.info("Config reload: applying changes", {
        changeCount: changes.length,
        paths: changes.map((c) => c.path),
      });

      this.currentConfig = newConfig;
      this.handler(newConfig, changes);

      this.lastReload = { success: true, changes, errors: [], timestamp };
      return this.lastReload;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Config reload failed", { error: message });
      this.lastReload = {
        success: false,
        changes: [],
        errors: [{ path: "(file)", message }],
        timestamp,
      };
      return this.lastReload;
    }
  }
}
