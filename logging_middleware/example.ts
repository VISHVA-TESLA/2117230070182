import { initLogger, Log, getLogger } from "./logger";

async function main() {

  initLogger({
    accessToken: process.env.ACCESS_TOKEN ?? "<your-bearer-token-here>",
    consoleOutput: true,
  });

  await Log("backend", "error", "handler", "received string, expected bool");

  await Log("backend", "fatal", "db", "Critical database connection failure.");

  await Log("backend", "warn", "cache", "Cache miss for user profile id=42; falling back to DB");

  await Log("backend", "info", "cron_job", "Daily report generation cron job started");

  await Log("frontend", "info", "page", "Dashboard page mounted, user=authenticated");

  await Log("frontend", "error", "api", "POST /orders failed with 503 Service Unavailable");

  await Log("backend", "warn", "middleware", "Unauthenticated request blocked at /api/admin");

  const logger = getLogger();

  await logger.debug("backend", "service", "UserService.findById called with id=123");
  await logger.info("frontend", "state", "Cart state updated: 3 items, total=$49.99");
}

main().catch(console.error);
