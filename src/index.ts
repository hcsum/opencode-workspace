import fs from "node:fs";
import path from "node:path";

import { AppOrchestrator } from "./app/orchestrator.js";
import { loadConfig } from "./config.js";
import { ExecutionSlot } from "./execution-slot.js";
import { ExternalSessionObserver } from "./external-session-observer.js";
import { startOpencodeServer } from "./opencode-server.js";
import { createProvider } from "./providers/index.js";
import { PublicEventPublisher } from "./public-activity.js";
import { SerialQueue } from "./queue.js";
import { GmailBridge } from "./gmail.js";
import { DeliveryApi } from "./delivery-api.js";
import { createMailTransport } from "./mail/factory.js";
import { initDatabase } from "./db.js";
import { getRuntimeLogPath, setupFileLogging } from "./logger.js";
import { GmailScheduledResultSink } from "./scheduler/gmail-result-sink.js";
import { launchScheduler, type Scheduler } from "./scheduler/index.js";
import { NoopScheduledResultSink } from "./scheduler/result-sink.js";

const BRIDGE_PROCESS_MARKERS = ["src/index.ts", "dist/index.js"];

setupFileLogging();
console.log(`[app] runtime log file: ${getRuntimeLogPath()}`);

async function main(): Promise<void> {
  const releaseLock = acquireInstanceLock();
  const config = loadConfig();
  const publicActivity = new PublicEventPublisher(
    config.publicActivityDir,
    config.publicActivityMaxEvents,
    {
      commitSha: config.deployCommitSha,
      commitMessage: config.deployCommitMessage,
      runId: config.deployRunId,
      actor: config.deployActor,
      deployedAt: config.deployedAt,
    },
  );
  const executionSlot = new ExecutionSlot();
  initDatabase();
  // Spawn the OpenCode server in-process (with the code-injected provider
  // config) before connecting to it, then bind the bridge's clients to it.
  // Decoupled from the active provider: whenever OPENCODE_BASE_URL is set we
  // run the server so external clients (e.g. the Telegram bot) can connect,
  // even when the bridge itself routes its own work through the claude provider.
  const server = config.providers.opencode
    ? await startOpencodeServer(config.providers.opencode.baseUrl)
    : undefined;
  // Sessions on that server belong to external clients (Telegram bot, TUI).
  // On the opencode provider OpencodeRuntime already watches them; on any other
  // provider it is never constructed, so without this nobody subscribes to the
  // event stream and everything those clients do stays off the status page.
  const externalSessions =
    server && config.providers.opencode && config.provider !== "opencode"
      ? new ExternalSessionObserver(config.providers.opencode, publicActivity)
      : undefined;
  externalSessions?.start();

  const queue = new SerialQueue(publicActivity);
  const provider = createProvider({ config, publicActivity });
  const orchestrator = new AppOrchestrator(provider);
  await orchestrator.healthcheck();
  orchestrator.startBackgroundMonitoring();
  publicActivity.setIdleIfNoActiveRuns();

  const launches: Promise<void>[] = [];
  let scheduler: Scheduler | undefined;
  let bridge: GmailBridge | undefined;
  let deliveryApi: DeliveryApi | undefined;

  if (config.channels.gmail?.inboxEmail) {
    bridge = new GmailBridge(
      config,
      orchestrator,
      queue,
      publicActivity,
      executionSlot,
      createMailTransport(config.channels.gmail),
    );
    launches.push(
      bridge.launch().catch((err) => console.error("[gmail] failed to start", err)),
    );
    deliveryApi = new DeliveryApi(bridge, config.deliveryApiPort);
    launches.push(
      deliveryApi
        .start()
        .catch((err) => console.error("[delivery-api] failed to start", err)),
    );
  }

  launches.push(
    launchScheduler({
      config,
      orchestrator,
      queue,
      resultSink: bridge
        ? new GmailScheduledResultSink(bridge)
        : new NoopScheduledResultSink(),
      publicActivity,
      executionSlot,
    })
      .then((s) => {
        scheduler = s;
      })
      .catch((err) => console.error("[scheduler] failed to start", err)),
  );

  try {
    await Promise.all(launches);
  } catch (error) {
    server?.close();
    releaseLock();
    throw error;
  }

  // Upper bound on how long we let in-flight work drain before exiting anyway.
  // Must stay below docker-compose's stop_grace_period so we exit cleanly
  // rather than being SIGKILLed mid-drain.
  const drainTimeoutMs = Number(process.env.SHUTDOWN_DRAIN_TIMEOUT_MS) || 240_000;
  let shuttingDown = false;

  const gracefulShutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[app] ${signal} received — starting graceful shutdown`);

    // 1) Stop intake: no new emails claimed, no new scheduled fires. Clients
    //    stay alive so in-flight tasks can still reply / deliver results.
    bridge?.beginShutdown();
    scheduler?.beginShutdown();

    // 2) Let the current task finish and deliver. The serial queue stays busy
    //    (via lease.wait) until the OpenCode run completes; the per-component
    //    waiters then cover the reply / result-email continuations.
    const drain = (async () => {
      await queue.whenIdle();
      await scheduler?.waitForInFlight();
      await bridge?.waitForInFlight();
      await queue.whenIdle();
    })();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      drain.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), drainTimeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);

    if (timedOut) {
      console.warn(
        `[app] drain exceeded ${drainTimeoutMs}ms — exiting with work still in flight`,
      );
    } else {
      console.log("[app] in-flight work drained — exiting cleanly");
    }

    // 3) Full teardown. Stop intake/clients first, then the server child last
    //    so in-flight tasks had the server available right up to here.
    try {
      await scheduler?.stop();
      await deliveryApi?.stop();
      await bridge?.stop();
      await externalSessions?.stop();
    } catch (error) {
      console.error("[app] error during teardown", error);
    }
    server?.close();
    releaseLock();
    process.exit(0);
  };

  process.once("exit", () => releaseLock());
  process.once("SIGINT", () => {
    void gracefulShutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void gracefulShutdown("SIGTERM");
  });
}

main().catch((error) => {
  console.error("[app] startup failed", error);
  process.exit(1);
});

function acquireInstanceLock(): () => void {
  if (process.env.BRIDGE_DISABLE_LOCK === "true") {
    return () => {};
  }

  const lockPath = path.join(".data", "bridge.lock");
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  try {
    const fd = fs.openSync(lockPath, "wx");
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid }), "utf8");
    let released = false;

    return () => {
      if (released) return;
      released = true;
      fs.closeSync(fd);
      fs.rmSync(lockPath, { force: true });
    };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "EEXIST") throw error;

    const activePid = readActivePid(lockPath);
    if (activePid && isBridgeProcessAlive(activePid)) {
      throw new Error(
        `[app] bridge already running with pid ${activePid}; refusing second instance`,
      );
    }

    fs.rmSync(lockPath, { force: true });
    return acquireInstanceLock();
  }
}

function readActivePid(lockPath: string): number | undefined {
  try {
    const raw = fs.readFileSync(lockPath, "utf8").trim();
    if (raw.startsWith("{")) {
      const parsed = JSON.parse(raw) as { pid?: unknown };
      return typeof parsed.pid === "number" && Number.isInteger(parsed.pid)
        ? parsed.pid
        : undefined;
    }
    const pid = Number(raw);
    return Number.isInteger(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

function isBridgeProcessAlive(pid: number): boolean {
  if (!isPidAlive(pid)) return false;

  const cmdline = readProcessCommandLine(pid);
  if (!cmdline) return true;
  return BRIDGE_PROCESS_MARKERS.some((marker) => cmdline.includes(marker));
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readProcessCommandLine(pid: number): string | undefined {
  if (process.platform !== "linux") return undefined;

  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
  } catch {
    return undefined;
  }
}
