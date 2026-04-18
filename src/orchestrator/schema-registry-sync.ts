/**
 * Schema Registry Auto-Sync: detect merged PRs that update src/config/schema-registry.json
 * and create GitHub issues in affected consumer repos.
 *
 * Flow:
 *   1. Get recent merged PRs from orchestrator repo
 *   2. For PRs that touched schema-registry.json, fetch the diff
 *   3. Parse old and new registry JSON from the diff
 *   4. Compute delta (which tables changed, which columns added/removed/renamed)
 *   5. For each affected consumer repo, create a notification issue
 *   6. Use IssueCreator dedup/throttle to avoid spam
 */

import { execSync } from "node:child_process";
import type { OrchestratorConfig } from "../config/schema.js";
import type { StateStore } from "../state/store.js";
import { IssueCreator, type CreatedIssue } from "./issue-creator.js";
import { createLogger } from "../service/logger.js";

const log = createLogger("schema-registry-sync");

// ── Type Definitions ───────────────────────────────────────────────────

interface SchemaRegistryTable {
  table: string;
  writer_repo: string;
  consumer_repos: string[];
  canonical_columns: string[];
  notes?: string;
}

interface SchemaRegistry {
  version: number;
  description: string;
  tables: SchemaRegistryTable[];
}

interface TableChange {
  table: string;
  oldColumns: string[];
  newColumns: string[];
  added: string[];
  removed: string[];
  consumersAffected: string[];
}

interface RegistryDelta {
  changedTables: TableChange[];
  orchestratorPRNumber: number;
  orchestratorPRRepo: string;
}

interface MergedPRWithFiles {
  number: number;
  title: string;
  files: Array<{ path: string; changeType: string }>;
}

// ── Main Class ────────────────────────────────────────────────────────

export class SchemaRegistrySyncDetector {
  private log = createLogger("schema-registry-sync");

  constructor(
    private config: OrchestratorConfig,
    private store: StateStore,
    private issueCreator: IssueCreator,
  ) {}

  /**
   * Detect schema-registry.json changes in recently merged PRs
   * and create issues in affected consumer repos.
   */
  async detectSchemaRegistryChanges(): Promise<CreatedIssue[]> {
    const created: CreatedIssue[] = [];

    try {
      // Get the orchestrator repo from the config
      // First try to find the orchestrator agent, then fall back to environment or hardcoded value
      const orchestratorAgent = Object.entries(this.config.agents).find(
        ([name]) => name === "claude-agent-orchestrator" || name.includes("orchestrator"),
      )?.[1];

      const orchestratorRepo = orchestratorAgent?.github ?? process.env.ORCHESTRATOR_REPO ?? "rapartlu/agent-orchestrator";

      if (!orchestratorRepo) {
        this.log.warn("No orchestrator repo configured — skipping schema registry sync");
        return [];
      }

      // Get recent merged PRs
      const mergedPRs = this.getMergedPRs(orchestratorRepo);
      if (mergedPRs.length === 0) {
        this.log.debug("No merged PRs found");
        return [];
      }

      // Filter for PRs that touched schema-registry.json
      const schemaChangePRs = mergedPRs.filter((pr) =>
        pr.files?.some((f) => f.path === "src/config/schema-registry.json")
      );

      if (schemaChangePRs.length === 0) {
        this.log.debug("No merged PRs touched schema-registry.json");
        return [];
      }

      this.log.info("Found merged PRs with schema-registry.json changes", {
        count: schemaChangePRs.length,
        prNumbers: schemaChangePRs.map((pr) => pr.number),
      });

      // For each schema-changing PR, detect changes and create issues
      for (const pr of schemaChangePRs) {
        const delta = this.detectSchemaChangesInPR(orchestratorRepo, pr.number);
        if (!delta || delta.changedTables.length === 0) {
          continue;
        }

        // Collect all affected consumer repos
        const affectedRepos = new Set<string>();
        for (const change of delta.changedTables) {
          for (const repo of change.consumersAffected) {
            affectedRepos.add(repo);
          }
        }

        // Create one issue per affected consumer repo
        for (const repo of affectedRepos) {
          try {
            const issue = this.createSchemaChangeIssue(repo, delta, pr.number, orchestratorRepo);
            if (issue) {
              created.push(issue);
            }
          } catch (error) {
            this.log.error("Failed to create schema change issue", {
              repo,
              prNumber: pr.number,
              error,
            });
            // Continue to next repo
          }
        }
      }

      if (created.length > 0) {
        this.log.info("Created schema registry change notifications", {
          count: created.length,
          issues: created.map((i) => `${i.repo}#${i.number}`),
        });
      }
    } catch (error) {
      this.log.error("Unexpected error in schema registry sync detection", { error });
    }

    return created;
  }

  /**
   * Get recent merged PRs from orchestrator repo.
   * Returns array with files metadata to identify schema-touching PRs.
   */
  private getMergedPRs(repo: string): MergedPRWithFiles[] {
    try {
      const output = execSync(
        `gh pr list --repo ${shellEscape(repo)} --state merged --json number,title,files -L 50`,
        { encoding: "utf-8", timeout: 30000 },
      ).trim();

      if (!output) {
        return [];
      }

      const prs = JSON.parse(output) as Array<{
        number: number;
        title: string;
        files?: Array<{ path: string; changeType: string }>;
      }>;

      return prs.map((pr) => ({
        number: pr.number,
        title: pr.title,
        files: pr.files ?? [],
      }));
    } catch (error) {
      this.log.error("Failed to fetch merged PRs", { error });
      return [];
    }
  }

  /**
   * Detect schema changes in a specific PR.
   * Fetches the diff, extracts old/new registry JSON, and computes delta.
   */
  private detectSchemaChangesInPR(repo: string, prNumber: number): RegistryDelta | null {
    try {
      const diff = execSync(
        `gh pr diff ${prNumber} --repo ${shellEscape(repo)}`,
        { encoding: "utf-8", timeout: 30000 },
      ).trim();

      if (!diff) {
        this.log.warn("Empty diff for PR", { repo, prNumber });
        return null;
      }

      // Extract old and new registry from the diff
      const registries = this.extractSchemaRegistryFromDiff(diff);
      if (!registries) {
        this.log.warn("Could not extract schema-registry.json versions from diff", {
          repo,
          prNumber,
        });
        return null;
      }

      const { old: oldRegistry, new: newRegistry } = registries;
      const changedTables = this.computeTableChanges(oldRegistry, newRegistry);

      if (changedTables.length === 0) {
        this.log.debug("No table-level changes detected", { repo, prNumber });
        return null;
      }

      this.log.info("Detected schema changes", {
        repo,
        prNumber,
        changes: changedTables.map((c) => ({
          table: c.table,
          columnsAdded: c.added.length,
          columnsRemoved: c.removed.length,
          consumersCount: c.consumersAffected.length,
        })),
      });

      return {
        changedTables,
        orchestratorPRNumber: prNumber,
        orchestratorPRRepo: repo,
      };
    } catch (error) {
      this.log.error("Error detecting schema changes in PR", { repo, prNumber, error });
      return null;
    }
  }

  /**
   * Extract old and new schema-registry.json from a unified diff.
   *
   * Looks for:
   *   --- a/src/config/schema-registry.json
   *   +++ b/src/config/schema-registry.json
   *
   * Then parses JSON objects from diff lines: context lines (space prefix) go to both,
   * removed lines (-) go to old only, added lines (+) go to new only.
   */
  private extractSchemaRegistryFromDiff(
    diff: string,
  ): { old: SchemaRegistry; new: SchemaRegistry } | null {
    // Find the schema-registry.json diff section
    const schemaRegex = /^--- a\/src\/config\/schema-registry\.json[\s\S]*?\n\+\+\+ b\/src\/config\/schema-registry\.json/m;
    const match = diff.match(schemaRegex);

    if (!match) {
      return null;
    }

    // Split diff into sections and extract JSON
    const lines = diff.split("\n");
    let inSchemaDiff = false;
    let oldJson = "";
    let newJson = "";

    for (const line of lines) {
      if (line.startsWith("--- a/src/config/schema-registry.json")) {
        inSchemaDiff = true;
        continue;
      }

      if (inSchemaDiff && line.startsWith("diff --git")) {
        break; // End of schema-registry.json diff
      }

      if (!inSchemaDiff) continue;

      // Context lines (unchanged) — must go to BOTH old and new
      if (line.startsWith(" ")) {
        oldJson += line.slice(1) + "\n";
        newJson += line.slice(1) + "\n";
      }

      // Removed lines (old version only)
      if (line.startsWith("-") && !line.startsWith("---")) {
        oldJson += line.slice(1) + "\n";
      }

      // Added lines (new version only)
      if (line.startsWith("+") && !line.startsWith("+++")) {
        newJson += line.slice(1) + "\n";
      }
    }

    // Try to parse the JSON objects
    try {
      const oldRegistry = this.parseRegistryJSON(oldJson);
      const newRegistry = this.parseRegistryJSON(newJson);

      if (oldRegistry && newRegistry) {
        return { old: oldRegistry, new: newRegistry };
      }
    } catch (error) {
      this.log.debug("Failed to parse registry JSON from diff", { error });
    }

    return null;
  }

  /**
   * Parse schema-registry.json from a text blob (may contain incomplete lines).
   * Tries to extract a valid JSON object.
   */
  private parseRegistryJSON(text: string): SchemaRegistry | null {
    if (!text.trim()) {
      return null;
    }

    try {
      // Try to extract a JSON object from the text
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return null;
      }

      const registry = JSON.parse(jsonMatch[0]) as SchemaRegistry;

      // Validate structure
      if (registry.version && registry.tables && Array.isArray(registry.tables)) {
        return registry;
      }
    } catch {
      // JSON parse failed
    }

    return null;
  }

  /**
   * Compute table-level changes by comparing old and new registry.
   * Returns array of tables that changed (added/removed/column changes).
   */
  private computeTableChanges(
    oldRegistry: SchemaRegistry,
    newRegistry: SchemaRegistry,
  ): TableChange[] {
    const changes: TableChange[] = [];

    // Build lookup maps
    const oldTableMap = new Map(oldRegistry.tables.map((t) => [t.table, t]));
    const newTableMap = new Map(newRegistry.tables.map((t) => [t.table, t]));

    // Check for added, removed, and modified tables
    const allTableNames = new Set([...oldTableMap.keys(), ...newTableMap.keys()]);

    for (const tableName of allTableNames) {
      const oldTable = oldTableMap.get(tableName);
      const newTable = newTableMap.get(tableName);

      // Table was removed
      if (oldTable && !newTable) {
        if (oldTable.consumer_repos.length > 0) {
          changes.push({
            table: tableName,
            oldColumns: oldTable.canonical_columns,
            newColumns: [],
            added: [],
            removed: oldTable.canonical_columns,
            consumersAffected: oldTable.consumer_repos,
          });
        }
        continue;
      }

      // Table was added
      if (!oldTable && newTable) {
        if (newTable.consumer_repos.length > 0) {
          changes.push({
            table: tableName,
            oldColumns: [],
            newColumns: newTable.canonical_columns,
            added: newTable.canonical_columns,
            removed: [],
            consumersAffected: newTable.consumer_repos,
          });
        }
        continue;
      }

      // Table exists in both — check for column changes
      if (oldTable && newTable) {
        // Skip if table has no consumers and won't have any
        if (newTable.consumer_repos.length === 0) {
          continue;
        }

        const oldCols = new Set(oldTable.canonical_columns);
        const newCols = new Set(newTable.canonical_columns);

        const added = Array.from(newCols).filter((c) => !oldCols.has(c));
        const removed = Array.from(oldCols).filter((c) => !newCols.has(c));

        // Include if there are column changes OR consumer list changes
        if (added.length > 0 || removed.length > 0 || this.consumersChanged(oldTable, newTable)) {
          changes.push({
            table: tableName,
            oldColumns: oldTable.canonical_columns,
            newColumns: newTable.canonical_columns,
            added,
            removed,
            // Report to all current consumers (they may need to update their code)
            consumersAffected: newTable.consumer_repos,
          });
        }
      }
    }

    return changes;
  }

  /**
   * Check if consumer_repos list changed for a table.
   */
  private consumersChanged(oldTable: SchemaRegistryTable, newTable: SchemaRegistryTable): boolean {
    const oldSet = new Set(oldTable.consumer_repos);
    const newSet = new Set(newTable.consumer_repos);

    if (oldSet.size !== newSet.size) {
      return true;
    }

    for (const repo of oldSet) {
      if (!newSet.has(repo)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Create and post a GitHub issue for schema changes in a consumer repo.
   */
  private createSchemaChangeIssue(
    repo: string,
    delta: RegistryDelta,
    prNumber: number,
    prRepo: string,
  ): CreatedIssue | null {
    // Check throttle and dedup
    const openCount = this.issueCreator.getOpenOrchestratorIssueCount(repo);
    if (openCount >= 10) {
      this.log.warn("Skipping issue creation: too many open orchestrator issues", {
        repo,
        openCount,
      });
      return null;
    }

    // Generate title and body
    const tableNames = delta.changedTables.map((t) => `\`${t.table}\``).join(", ");
    const title = `[Orchestrator] Schema contract updated: ${tableNames}`;

    if (this.issueCreator.isDuplicate(repo, title)) {
      this.log.info("Skipping issue creation: similar issue already exists", { repo, title });
      return null;
    }

    const body = this.formatSchemaChangeBody(delta, prNumber, prRepo);

    try {
      return this.issueCreator.createIssue(repo, title, body, ["orchestrator", "schema-change"]);
    } catch (error) {
      this.log.error("Failed to create issue", { repo, title, error });
      return null;
    }
  }

  /**
   * Format the GitHub issue body for schema change notifications.
   */
  private formatSchemaChangeBody(delta: RegistryDelta, prNumber: number, prRepo: string): string {
    const prLink = `https://github.com/${prRepo}/pull/${prNumber}`;
    const changeDetails = delta.changedTables
      .map((change) => {
        const summary = [];
        if (change.removed.length > 0) {
          summary.push(`**Removed columns:** ${change.removed.join(", ")}`);
        }
        if (change.added.length > 0) {
          summary.push(`**Added columns:** ${change.added.join(", ")}`);
        }
        if (summary.length === 0) {
          summary.push("*Column structure unchanged*");
        }

        return `\n### Table: \`${change.table}\`\n${summary.join("\n")}`;
      })
      .join("\n");

    return `## Schema Contract Updated

The orchestrator's schema registry (\`src/config/schema-registry.json\`) was updated in a merged PR. This repo reads from one or more of the affected tables, so you may need to update your reader queries.

**Merged PR:** [${prRepo}#${prNumber}](${prLink})

${changeDetails}

---

**Action Items:**
1. Review the merged PR to understand the schema changes
2. If you read from any of these tables, update your reader queries accordingly
3. Run tests to ensure compatibility with the new schema
4. Close this issue when updated

*This issue was automatically created by the orchestrator based on schema registry changes.*`;
  }
}

/**
 * Shell escape a string for safe use in execSync.
 */
function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
