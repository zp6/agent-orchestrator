import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../../config/schema.js";
import { Dispatcher } from "../../orchestrator/dispatcher.js";
import { StateStore } from "../../state/store.js";

export function registerDispatchCommand(program: Command): void {
  program
    .command("dispatch")
    .description("Dispatch a task to an agent")
    .argument("<message>", "Task description to send to the agent")
    .option("-a, --agent <name>", "Target agent (auto-routed if omitted)")
    .option("-t, --title <title>", "Task title (defaults to first 100 chars of message)")
    .option("-p, --plan", "Use the task planner to break complex tasks into sub-tasks")
    .option("--dry-run", "Show the plan without executing (requires --plan)")
    .action(async (message: string, opts: { agent?: string; title?: string; plan?: boolean; dryRun?: boolean }) => {
      const config = loadConfig(program.opts().config);
      const store = new StateStore();
      const dispatcher = new Dispatcher(config, store);

      try {
        if (opts.plan) {
          await handlePlanDispatch(dispatcher, store, message, opts);
        } else {
          await handleDirectDispatch(dispatcher, store, message, opts);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Dispatch failed: ${msg}`));
        store.close();
        process.exit(1);
      }
    });
}

async function handleDirectDispatch(
  dispatcher: Dispatcher,
  store: StateStore,
  message: string,
  opts: { agent?: string; title?: string },
): Promise<void> {
  console.log(chalk.dim("Dispatching...\n"));

  const result = await dispatcher.dispatch(message, {
    agentName: opts.agent,
    title: opts.title,
  });

  console.log(chalk.green(`Task ${result.taskId} completed`));
  console.log(chalk.dim(`Agent: ${result.agentName}`));
  console.log(
    chalk.dim(
      `Tokens: ${result.response.usage.input_tokens} in / ${result.response.usage.output_tokens} out`,
    ),
  );
  console.log(`\n${result.response.content}`);
  store.close();
}

async function handlePlanDispatch(
  dispatcher: Dispatcher,
  store: StateStore,
  message: string,
  opts: { agent?: string; title?: string; dryRun?: boolean },
): Promise<void> {
  console.log(chalk.dim("Planning...\n"));

  const plan = await dispatcher.planTask(message);
  const parallel = plan.parallel ?? plan.steps.filter((step) => step.depends_on.length === 0);
  const sequential = plan.sequential ?? plan.steps.filter((step) => step.depends_on.length > 0);

  // Display the plan
  console.log(
    chalk.bold(
      `Plan: ${plan.is_multi_agent ? "multi-agent" : "single-agent"} (` +
      `${parallel.length} parallel, ${sequential.length} sequential)\n`,
    ),
  );

  if (parallel.length > 0) {
    console.log(chalk.bold("Parallel batch"));
    for (const step of parallel) {
      console.log(`  ${chalk.cyan(step.id)} ${chalk.yellow(step.agent)}`);
      console.log(`    ${step.task}\n`);
    }
  }

  if (sequential.length > 0) {
    console.log(chalk.bold("Sequential follow-up"));
    for (const step of sequential) {
      const deps = step.depends_on.length > 0
        ? chalk.dim(` (after ${step.depends_on.join(", ")})`)
        : "";
      console.log(`  ${chalk.cyan(step.id)} ${chalk.yellow(step.agent)}${deps}`);
      console.log(`    ${step.task}\n`);
    }
  }

  if (parallel.length === 0 && sequential.length === 0) {
    for (const step of plan.steps) {
      const deps = step.depends_on.length > 0
        ? chalk.dim(` (after ${step.depends_on.join(", ")})`)
        : "";
      console.log(`  ${chalk.cyan(step.id)} ${chalk.yellow(step.agent)}${deps}`);
      console.log(`    ${step.task}\n`);
    }
  } else if (plan.steps.length > 0) {
    console.log(chalk.dim(`Normalized execution order: ${plan.steps.map((step) => step.id).join(" -> ")}\n`));
  }

  if (opts.dryRun) {
    console.log(chalk.dim("Dry run — no tasks dispatched."));
    store.close();
    return;
  }

  // Execute the plan
  console.log(chalk.dim("Executing plan...\n"));

  const result = await dispatcher.dispatchWithPlan(message, {
    title: opts.title,
  });

  if (result.status === "done") {
    console.log(chalk.green(`Plan completed (${result.stepResults.length} steps)`));
    console.log(chalk.dim(`Parent task: ${result.parentTaskId}`));

    for (const step of result.stepResults) {
      console.log(chalk.dim(`\n--- ${step.stepId} (${step.agentName}) ---`));
      const preview = step.response.content.length > 300
        ? step.response.content.slice(0, 300) + "..."
        : step.response.content;
      console.log(preview);
    }
  } else {
    console.error(chalk.red(`Plan failed at step ${result.failedStep}: ${result.error}`));
  }

  store.close();
}
