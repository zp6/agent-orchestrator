#!/usr/bin/env node

import { Command } from "commander";
import { registerAgentsCommand } from "./commands/agents.js";
import { registerDispatchCommand } from "./commands/dispatch.js";
import { registerAskCommand } from "./commands/ask.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerServiceCommand } from "./commands/service.js";
import { registerImproveCommand } from "./commands/improve.js";
import { registerSuperviseCommand } from "./commands/supervise.js";

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

program.parse();
