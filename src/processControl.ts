type OakSupervisorRestartTarget = "bot" | "codex";

interface OakSupervisorRestartMessage {
  type: "oak-supervisor-restart";
  target: OakSupervisorRestartTarget;
}

export function supervisorControlsRestart(): boolean {
  return typeof process.send === "function";
}

export function isSupervisorRestartMessage(
  value: unknown,
): value is OakSupervisorRestartMessage {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as {
    type?: unknown;
    target?: unknown;
  };

  return (
    candidate.type === "oak-supervisor-restart" &&
    (candidate.target === "bot" || candidate.target === "codex")
  );
}

export async function requestSupervisorRestart(
  target: OakSupervisorRestartTarget,
): Promise<void> {
  if (typeof process.send !== "function") {
    throw new Error("Oak supervisor IPC is unavailable.");
  }

  const message: OakSupervisorRestartMessage = {
    type: "oak-supervisor-restart",
    target,
  };

  await new Promise<void>((resolve, reject) => {
    process.send?.(message, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
