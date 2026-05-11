import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateStore } from "../../state/store.js";
import {
  renderSecurityExemptionsTable,
} from "./security-exemptions.js";

function makeStore() {
  const dbPath = join(tmpdir(), `orch-security-exemptions-${randomUUID()}.db`);
  const store = new StateStore(dbPath);
  return { store, dbPath };
}

afterEach(() => {
  // No-op: each test uses a unique temp DB path and closes the store.
});

describe("security-exemptions CLI helpers", () => {
  it("renders a table of exemptions", () => {
    const rows = [
      {
        id: 1,
        repo: "owner/repo",
        file_path: "docker-compose.generated.yml",
        pattern_name: "Docker Compose env_file referencing plaintext .env",
        reason: "confirmed false positive",
        created_at: "2026-05-11T13:00:00.000Z",
        updated_at: "2026-05-11T13:00:00.000Z",
      },
    ];

    const output = renderSecurityExemptionsTable(rows);
    expect(output).toContain("owner/repo");
    expect(output).toContain("docker-compose.generated.yml");
    expect(output).toContain("Docker Compose env_file refer");
    expect(output).toContain("confirmed false positive");
  });

  it("deletes exemptions by row ID", () => {
    const { store } = makeStore();
    try {
      const created = store.addSecurityFpExemption({
        repo: "owner/repo",
        file_path: "src/example.ts",
        pattern_name: "pattern-a",
        reason: "reason",
      });
      expect(store.listSecurityFpExemptions()).toHaveLength(1);

      const removed = store.removeSecurityFpExemptionById(created.id);
      expect(removed).toBe(true);
      expect(store.listSecurityFpExemptions()).toHaveLength(0);
    } finally {
      store.close();
    }
  });
});
