import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

/**
 * Persistent audit trail for every signing decision.
 *
 * Append-only JSONL at ~/.fleet-signer/audit.log. Each entry records the
 * decision (approve/reject/error), the operation, and the result. Operator
 * can grep / tail / review.
 */
export interface AuditEntry {
  timestamp: string;
  operation: string;
  decision: "approve" | "reject" | "error";
  reason?: string;
  txHash?: string;
  /** Raw payload (sensitive fields redacted) for forensics. */
  payload?: Record<string, unknown>;
  /** Cumulative spend in USD-equivalent for the day. */
  daySpendUsd?: number;
}

export function defaultAuditPath(): string {
  return path.join(os.homedir(), ".fleet-signer", "audit.log");
}

export class AuditLog {
  constructor(private readonly logPath: string = defaultAuditPath()) {}

  /** Append one decision to the log. Crash-safe via append-only fs.appendFile. */
  async append(entry: Omit<AuditEntry, "timestamp">): Promise<void> {
    await fs.mkdir(path.dirname(this.logPath), { recursive: true, mode: 0o700 });
    const full: AuditEntry = { timestamp: new Date().toISOString(), ...entry };
    await fs.appendFile(this.logPath, JSON.stringify(full) + "\n", { mode: 0o600 });
  }

  /** Read all entries from the log. Newest last. */
  async readAll(): Promise<AuditEntry[]> {
    try {
      const raw = await fs.readFile(this.logPath, "utf8");
      return raw
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as AuditEntry);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  /** Sum approved-spend in USD across all entries from the given UTC day. */
  async daySpendUsd(date: Date = new Date()): Promise<number> {
    const dayStr = date.toISOString().slice(0, 10);
    const entries = await this.readAll();
    return entries
      .filter((e) => e.decision === "approve" && e.timestamp.startsWith(dayStr))
      .reduce((sum, e) => sum + (e.daySpendUsd ?? 0), 0);
  }
}
