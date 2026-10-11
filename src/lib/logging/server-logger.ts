import "server-only";
import { getServerEnv } from "../config/env";
import { createLogger, type Logger } from "./logger";

let cached: Logger | undefined;

/** App-wide logger. Registers the API key and secret so they are scrubbed from any output. */
export function getLogger(): Logger {
  if (cached) return cached;
  const env = getServerEnv();
  cached = createLogger({
    level: env.LOG_LEVEL,
    secrets: [env.BINANCE_WEB3_API_KEY, env.BINANCE_WEB3_API_SECRET, env.GAPPILOT_DEBUG_ROUTES_TOKEN, env.OPENAI_API_KEY],
    bindings: { service: "gappilot" },
  });
  return cached;
}
