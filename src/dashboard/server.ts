import express from "express";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { loadConfig, type OrchestratorConfig } from "../config/schema.js";
import { StateStore } from "../state/store.js";
import { ManagementClient } from "../client/management-client.js";
import { isRunning, readPid } from "../service/pid.js";
import { getLogPath } from "../service/logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createDashboardServer(configPath?: string) {
  const config = loadConfig(configPath);
  const store = new StateStore();
  const management = new ManagementClient(config.proxy);
  const app = express();

  const viewsDir = resolve(__dirname, "views");
  const publicDir = resolve(__dirname, "public");

  app.use("/public", express.static(publicDir));

  // HTML pages — serve from views directory
  app.get("/", (_req, res) => res.sendFile(resolve(viewsDir, "index.html")));
  app.get("/tasks", (_req, res) => res.sendFile(resolve(viewsDir, "tasks.html")));
  app.get("/agents", (_req, res) => res.sendFile(resolve(viewsDir, "agents.html")));
  app.get("/logs", (_req, res) => res.sendFile(resolve(viewsDir, "logs.html")));

  // === API Routes ===

  app.get("/api/dashboard", async (_req, res) => {
    const tasks = store.listTasks({ limit: 100 });
    const stats = store.getAgentStats();
    const recent = store.listTasks({ limit: 10 });
    const active = tasks.filter((t) => t.status === "dispatched" || t.status === "planning");
    const verified = tasks.filter((t) => t.verification_status !== null);
    const approved = verified.filter((t) => t.verification_status === "approved");

    let proxyOnline = false;
    let liveAgents: Array<{ name: string; status: string }> = [];
    try {
      proxyOnline = await management.isReachable();
      if (proxyOnline) {
        liveAgents = (await management.listAgents()).map((a) => ({ name: a.name, status: a.status }));
      }
    } catch {}

    res.json({
      daemon: { running: isRunning(), pid: readPid() },
      proxy: { online: proxyOnline, agents: liveAgents },
      stats: {
        totalTasks: tasks.length,
        active: active.length,
        done: tasks.filter((t) => t.status === "done").length,
        failed: tasks.filter((t) => t.status === "failed").length,
        verified: verified.length,
        approved: approved.length,
        avgScore: approved.length > 0
          ? approved.reduce((sum, t) => sum + (t.quality_score ?? 0), 0) / approved.length
          : null,
      },
      agentStats: stats,
      recent: recent.map(formatTask),
      activeWork: active.map(formatTask),
    });
  });

  app.get("/api/tasks", (req, res) => {
    const { status, agent, limit } = req.query;
    const tasks = store.listTasks({
      status: status as any,
      agent_name: agent as string | undefined,
      limit: limit ? parseInt(limit as string, 10) : 50,
    });
    res.json(tasks.map(formatTask));
  });

  app.get("/api/tasks/:id", (req, res) => {
    const task = store.getTask(req.params.id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    const logs = store.getLogs(task.id);
    const subTasks = store.getSubTasks(task.id);
    res.json({ ...formatTask(task), logs, subTasks: subTasks.map(formatTask) });
  });

  app.get("/api/agents", async (_req, res) => {
    let liveStatus = new Map<string, string>();
    try {
      const proxyAgents = await management.listAgents();
      liveStatus = new Map(proxyAgents.map((a) => [a.name, a.status]));
    } catch {}

    const agents = Object.entries(config.agents).map(([name, agent]) => {
      const stats = store.getAgentStats().find((s) => s.agent_name === name);
      return {
        name,
        description: agent.description,
        capabilities: agent.capabilities,
        github: agent.github,
        docker: agent.docker,
        containerStatus: liveStatus.get(name) ?? "not deployed",
        stats: stats ?? { total: 0, done: 0, failed: 0, avg_score: null },
      };
    });

    res.json(agents);
  });

  app.get("/api/logs", (_req, res) => {
    try {
      const logPath = getLogPath();
      const content = readFileSync(logPath, "utf-8");
      const lines = content.trim().split("\n").slice(-200);
      res.json(lines);
    } catch {
      res.json([]);
    }
  });

  function formatTask(t: ReturnType<typeof store.getTask> & {}) {
    return {
      id: t.id,
      title: t.title,
      description: t.description,
      source: t.source,
      source_ref: t.source_ref,
      status: t.status,
      agent_name: t.agent_name,
      result: t.result,
      verification_status: t.verification_status,
      quality_score: t.quality_score,
      verification_notes: t.verification_notes,
      parent_task_id: t.parent_task_id,
      step_id: t.step_id,
      created_at: t.created_at,
      updated_at: t.updated_at,
    };
  }

  return app;
}
