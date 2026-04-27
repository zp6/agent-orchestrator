/**
 * Minimal structured logger.
 * Writes JSON lines to stdout; stderr for errors.
 */

type LogLevel = "info" | "warn" | "error";

export interface Logger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

function log(level: LogLevel, component: string, message: string, context?: Record<string, unknown>): void {
  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    component,
    message,
    ...context,
  });
  if (level === "error" || level === "warn") {
    process.stderr.write(entry + "\n");
  } else {
    process.stdout.write(entry + "\n");
  }
}

export function createLogger(component: string): Logger {
  return {
    info: (msg, ctx) => log("info", component, msg, ctx),
    warn: (msg, ctx) => log("warn", component, msg, ctx),
    error: (msg, ctx) => log("error", component, msg, ctx),
  };
}
