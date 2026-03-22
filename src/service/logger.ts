import { appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_DIR = join(homedir(), ".claude-orchestrator", "logs");
const LOG_FILE = join(LOG_DIR, "orchestrator.log");

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let minLevel: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[minLevel];
}

function formatEntry(level: LogLevel, component: string, message: string, data?: Record<string, unknown>): string {
  const timestamp = new Date().toISOString();
  const dataStr = data ? " " + JSON.stringify(data) : "";
  return `${timestamp} [${level.toUpperCase().padEnd(5)}] [${component}] ${message}${dataStr}`;
}

function writeLog(entry: string): void {
  try {
    mkdirSync(dirname(LOG_FILE), { recursive: true });
    appendFileSync(LOG_FILE, entry + "\n");
  } catch {
    // Don't fail on log write errors
  }
}

export function createLogger(component: string) {
  return {
    debug(message: string, data?: Record<string, unknown>): void {
      if (!shouldLog("debug")) return;
      const entry = formatEntry("debug", component, message, data);
      writeLog(entry);
    },

    info(message: string, data?: Record<string, unknown>): void {
      if (!shouldLog("info")) return;
      const entry = formatEntry("info", component, message, data);
      writeLog(entry);
      console.log(entry);
    },

    warn(message: string, data?: Record<string, unknown>): void {
      if (!shouldLog("warn")) return;
      const entry = formatEntry("warn", component, message, data);
      writeLog(entry);
      console.warn(entry);
    },

    error(message: string, data?: Record<string, unknown>): void {
      if (!shouldLog("error")) return;
      const entry = formatEntry("error", component, message, data);
      writeLog(entry);
      console.error(entry);
    },
  };
}

export function getLogPath(): string {
  return LOG_FILE;
}
