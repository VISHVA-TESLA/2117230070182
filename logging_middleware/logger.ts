export type Stack = "backend" | "frontend";

export type Level = "debug" | "info" | "warn" | "error" | "fatal";

export type BackendPackage =
  | "cache"
  | "controller"
  | "cron_job"
  | "db"
  | "domain"
  | "handler"
  | "repository"
  | "route"
  | "service";

export type FrontendPackage = "api" | "component" | "hook" | "page" | "state" | "style";

export type SharedPackage = "auth" | "config" | "middleware" | "utils";

export type Package = BackendPackage | FrontendPackage | SharedPackage;

export interface LogPayload {
  stack: Stack;
  level: Level;
  package: Package;
  message: string;
}

export interface LogResponse {
  logID: string;
  message: string;
}

export interface LoggerConfig {

  accessToken: string;

  baseUrl?: string;

  consoleOutput?: boolean;
}

const DEFAULT_BASE_URL = "http://20.207.122.201";
const LOG_ENDPOINT = "/evaluation-service/logs";

class Logger {
  private accessToken: string;
  private baseUrl: string;
  private consoleOutput: boolean;

  constructor(config: LoggerConfig) {
    this.accessToken = config.accessToken;
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.consoleOutput = config.consoleOutput ?? true;
  }

  async Log(
    stack: Stack,
    level: Level,
    pkg: Package,
    message: string
  ): Promise<LogResponse | null> {
    const payload: LogPayload = {
      stack,
      level,
      package: pkg,
      message,
    };

    if (this.consoleOutput) {
      const timestamp = new Date().toISOString();
      const prefix = `[${timestamp}] [${stack.toUpperCase()}] [${level.toUpperCase()}] [${pkg}]`;
      const consoleFn =
        level === "fatal" || level === "error"
          ? console.error
          : level === "warn"
          ? console.warn
          : level === "debug"
          ? console.debug
          : console.info;
      consoleFn(`${prefix} ${message}`);
    }

    try {
      const response = await fetch(`${this.baseUrl}${LOG_ENDPOINT}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.accessToken}`,
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(
          `[logging_middleware] Failed to send log. Status: ${response.status}. Body: ${errorText}`
        );
        return null;
      }

      const data: LogResponse = await response.json();
      return data;
    } catch (err) {

      console.error(`[logging_middleware] Network error while sending log:`, err);
      return null;
    }
  }

  debug(stack: Stack, pkg: Package, message: string): Promise<LogResponse | null> {
    return this.Log(stack, "debug", pkg, message);
  }

  info(stack: Stack, pkg: Package, message: string): Promise<LogResponse | null> {
    return this.Log(stack, "info", pkg, message);
  }

  warn(stack: Stack, pkg: Package, message: string): Promise<LogResponse | null> {
    return this.Log(stack, "warn", pkg, message);
  }

  error(stack: Stack, pkg: Package, message: string): Promise<LogResponse | null> {
    return this.Log(stack, "error", pkg, message);
  }

  fatal(stack: Stack, pkg: Package, message: string): Promise<LogResponse | null> {
    return this.Log(stack, "fatal", pkg, message);
  }
}

let _loggerInstance: Logger | null = null;

export function initLogger(config: LoggerConfig): Logger {
  _loggerInstance = new Logger(config);
  return _loggerInstance;
}

export function getLogger(): Logger {
  if (!_loggerInstance) {
    throw new Error(
      "[logging_middleware] Logger not initialised. Call initLogger(config) before using Log()."
    );
  }
  return _loggerInstance;
}

export async function Log(
  stack: Stack,
  level: Level,
  pkg: Package,
  message: string
): Promise<LogResponse | null> {
  return getLogger().Log(stack, level, pkg, message);
}

export { Logger };
export default Logger;
