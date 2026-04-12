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
import { registerPRResetCommand } from "./commands/pr-reset.js";
import { registerDecisionsCommand } from "./commands/decisions.js";
import { registerBudgetCommand } from "./commands/budget.js";
import { registerIssueStatusCommand } from "./commands/issue-status.js";
import { registerDispatchEfficiencyCommand } from "./commands/dispatch-efficiency.js";
import { registerSupervisorLogCommand } from "./commands/supervisor-log.js";
import { registerConfigCommand } from "./commands/config.js";
import { registerBorrowCommand } from "./commands/borrow.js";
import { registerFleetCommand } from "./commands/fleet.js";
import { registerLearnedRulesCommand } from "./commands/learned-rules.js";
import { registerAuditInfraCommand } from "./commands/audit-infra.js";
import { registerRoutingAccuracyCommand } from "./commands/routing-accuracy.js";
import { registerSignalsCommand } from "./commands/signals.js";
import { registerLearnedPatternsCommand } from "./commands/learned-patterns.js";
import { registerLineageCommand } from "./commands/lineage.js";
import { registerAntibodiesCommand } from "./commands/antibodies.js";

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
registerPRResetCommand(program);
registerDecisionsCommand(program);
registerBudgetCommand(program);
registerIssueStatusCommand(program);
registerDispatchEfficiencyCommand(program);
registerSupervisorLogCommand(program);
registerConfigCommand(program);
registerBorrowCommand(program);
registerFleetCommand(program);
registerLearnedRulesCommand(program);
registerAuditInfraCommand(program);
registerRoutingAccuracyCommand(program);
registerSignalsCommand(program);
registerLearnedPatternsCommand(program);
registerLineageCommand(program);
registerAntibodiesCommand(program);

program.parse();
