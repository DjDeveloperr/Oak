import { fork, spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { oakConfig } from "./config.js";
import { isSupervisorRestartMessage } from "./processControl.js";

type OakChildName = "bot" | "codex";

interface OakChildSpec {
  name: OakChildName;
  child: ChildProcess | null;
  restartPending: boolean;
}

const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);
const botEntryPath = path.join(currentDir, "bot.js");
const childSpecs = new Map<OakChildName, OakChildSpec>([
  ["bot", { name: "bot", child: null, restartPending: false }],
  ["codex", { name: "codex", child: null, restartPending: false }],
]);

let shuttingDown = false;
let pendingExitCode: number | null = null;

function log(message: string, context?: Record<string, unknown>): void {
  if (context) {
    console.log(`[oak-supervisor] ${message}`, context);
    return;
  }
  console.log(`[oak-supervisor] ${message}`);
}

function finalizeExit(code = 0, delayMs = 1000): void {
  if (pendingExitCode == null) {
    pendingExitCode = code;
  }

  setTimeout(() => {
    process.exit(pendingExitCode ?? code);
  }, delayMs).unref();
}

function getSpec(name: OakChildName): OakChildSpec {
  const spec = childSpecs.get(name);
  if (!spec) {
    throw new Error(`Unknown child process: ${name}`);
  }
  return spec;
}

function spawnBot(): ChildProcess {
  const child = fork(botEntryPath, [], {
    cwd: oakConfig.repoRoot,
    env: {
      ...process.env,
      OAK_CODEX_WS_URL: oakConfig.codexWsUrl,
    },
    stdio: ["inherit", "inherit", "inherit", "ipc"],
  });

  child.on("message", (message) => {
    if (!isSupervisorRestartMessage(message)) {
      return;
    }

    log("Received restart request", {
      target: message.target,
      requestedBy: "bot",
    });
    restartChild(message.target);
  });

  return child;
}

function spawnCodex(): ChildProcess {
  return spawn(
    oakConfig.codexBin,
    ["app-server", "--listen", oakConfig.codexWsUrl],
    {
      cwd: oakConfig.repoRoot,
      env: process.env,
      stdio: "inherit",
    },
  );
}

function attachChild(name: OakChildName, child: ChildProcess): void {
  const spec = getSpec(name);
  spec.child = child;

  log("Spawned child", {
    name,
    pid: child.pid ?? null,
  });

  child.once("error", (error) => {
    console.error(`[oak-supervisor] ${name} process error:`, error);
  });

  child.once("exit", (code, signal) => {
    if (oakConfig.dryRun && name === "bot" && !spec.restartPending) {
      const exitCode = code ?? 0;
      log("Dry run bot exited; shutting down supervisor", {
        code: exitCode,
        signal: signal ?? null,
      });
      spec.child = null;
      shuttingDown = true;
      stopChild("codex");
      finalizeExit(exitCode);
      return;
    }

    const shouldRestart = !shuttingDown || spec.restartPending;
    log("Child exited", {
      name,
      code,
      signal: signal ?? null,
      restartPending: spec.restartPending,
      shuttingDown,
    });

    spec.child = null;

    if (!shouldRestart) {
      return;
    }

    spec.restartPending = false;
    setTimeout(() => {
      if (shuttingDown) {
        return;
      }
      startChild(name);
    }, 1000).unref();
  });
}

function startChild(name: OakChildName): void {
  const spec = getSpec(name);
  if (spec.child) {
    return;
  }

  const child = name === "bot" ? spawnBot() : spawnCodex();
  attachChild(name, child);
}

function restartChild(name: OakChildName): void {
  const spec = getSpec(name);
  spec.restartPending = true;

  if (!spec.child || spec.child.exitCode !== null || spec.child.killed) {
    spec.child = null;
    spec.restartPending = false;
    startChild(name);
    return;
  }

  spec.child.kill("SIGTERM");
}

function stopChild(name: OakChildName): void {
  const spec = getSpec(name);
  spec.restartPending = false;

  if (!spec.child || spec.child.exitCode !== null || spec.child.killed) {
    spec.child = null;
    return;
  }

  spec.child.kill("SIGTERM");
}

function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  log("Shutting down", { signal });
  stopChild("bot");
  stopChild("codex");

  setTimeout(() => {
    process.exit(pendingExitCode ?? 0);
  }, 5000).unref();
}

process.on("SIGINT", () => {
  shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  shutdown("SIGTERM");
});

process.on("exit", () => {
  shuttingDown = true;
  stopChild("bot");
  stopChild("codex");
});

startChild("codex");
startChild("bot");
