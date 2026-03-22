import type { Command } from "commander";
import chalk from "chalk";
import { createDashboardServer } from "../../dashboard/server.js";

export function registerDashboardCommand(program: Command): void {
  program
    .command("dashboard")
    .description("Start the web dashboard")
    .option("-p, --port <port>", "Port to listen on", "3500")
    .action((opts: { port: string }) => {
      const configPath = program.opts().config;
      const port = parseInt(opts.port, 10);
      const app = createDashboardServer(configPath);

      app.listen(port, () => {
        console.log(chalk.green(`Dashboard running at http://localhost:${port}`));
        console.log(chalk.dim("Press Ctrl+C to stop."));
      });
    });
}
