import "server-only";
import type { ServerEnv } from "../config/env";
import { InMemoryAuditLog } from "./audit";
import { BinanceAgenticWalletProvider } from "./agentic-provider";
import { MockExecutionProvider } from "./mock-provider";
import type { ExecutionProvider } from "./types";

/**
 * Provider for the WEB app. Live Agentic Wallet execution is never available
 * here: it needs the user's signed-in desktop session (OS keychain), so the
 * provider is constructed in "serverless" mode and every preflight refuses.
 */
export function webExecutionProvider(env: ServerEnv): ExecutionProvider {
  if (env.GAPPILOT_EXECUTION_PROVIDER === "binance-agentic-wallet") {
    return new BinanceAgenticWalletProvider({
      run: async () => ({ stdout: "", exitCode: 1 }), // never invoked: serverless preflight refuses first
      versionPrefix: env.GAPPILOT_AGENTIC_CLI_VERSION_PREFIX,
      isServerless: true,
    });
  }
  return new MockExecutionProvider();
}

/**
 * Web demo audit log: in memory, per server instance. Records are also
 * returned to the browser. The local agent worker uses a durable JSONL log.
 */
let webAudit: InMemoryAuditLog | undefined;
export function webAuditLog(): InMemoryAuditLog {
  webAudit ??= new InMemoryAuditLog();
  return webAudit;
}
