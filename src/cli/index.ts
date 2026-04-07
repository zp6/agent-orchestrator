#!/usr/bin/env node

import { Command } from "commander";
import { registerAgentsCommand } from "./commands/agents.js";
import { registerDispatchCommand } from "./commands/dispatch.js";
import { registerAskCommand } from "./commands/ask.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerServiceCommand } from "./commands/service.js";
import { registerImproveCommand } from "./commands/improve.js";
import { registerSuperviseCommand } from "./commands/supervise.js";
import { registerReviewCommand } from "./commands/review.js";
import { registerCreateCommand } from "./commands/create.js";
import { registerPRsCommand } from "./commands/prs.js";
import { registerResearchCommand } from "./commands/research.js";
import { registerHealthCommand } from "./commands/health.js";
import { registerMetricsCommand } from "./commands/metrics.js";
import { registerPreflightCommand } from "./commands/preflight.js";
import { registerAuditCommand } from "./commands/audit.js";
import { registerDigestCommand } from "./commands/digest.js";
import { registerTimeoutsCommand } from "./commands/timeouts.js";
import { registerDirectivesCommand } from "./commands/directives.js";
import { registerDeescalateCommand } from "./commands/deescalate.js";
import { registerDecisionsCommand } from "./commands/decisions.js";
import { registerBudgetCommand } from "./commands/budget.js";
import { registerIssueStatusCommand } from "./commands/issue-status.js";
import { registerDispatchEfficiencyCommand } from "./commands/dispatch-efficiency.js";
import { registerSupervisorLogCommand } from "./commands/supervisor-log.js";
import { registerConfigCommand } from "./commands/config.js";

const program = new Command();

program
  .name("orch")
  .description("Orchestrator for Claude Code agent directories")
  .version("0.1.0")
  .option("-c, --config <path>", "Path to agents.yaml config file");

// Commands read configPath from program.opts() at execution time
registerAgentsCommand(program);
registerDispatchCommand(program);
registerAskCommand(program);
registerStatusCommand(program);
registerServiceCommand(program);
registerImproveCommand(program);
registerSuperviseCommand(program);
registerReviewCommand(program);
registerCreateCommand(program);
registerPRsCommand(program);
registerResearchCommand(program);
registerHealthCommand(program);
registerMetricsCommand(program);
registerPreflightCommand(program);
registerAuditCommand(program);
registerDigestCommand(program);
registerTimeoutsCommand(program);
registerDirectivesCommand(program);
registerDeescalateCommand(program);
registerDecisionsCommand(program);
registerBudgetCommand(program);
registerIssueStatusCommand(program);
registerDispatchEfficiencyCommand(program);
registerSupervisorLogCommand(program);
registerConfigCommand(program);

program.parse();
