#!/usr/bin/env node

const apiBase =
  process.env.OAK_API_URL ??
  `http://${process.env.OAK_API_HOST ?? "127.0.0.1"}:${process.env.OAK_API_PORT ?? "4788"}`;

function usage(): never {
  console.error(
    [
      "Usage:",
      "  oak-api workspaces",
      "  oak-api sessions",
      "  oak-api thread --workspace <key> --prompt <text> [--name <name>] [--channel <id>] [--subscribe] [--subscribe-workspace <key>]",
      "  oak-api message <discordThreadId> <text>",
      "  oak-api superagent <workspace> <text>",
      "  oak-api cron list [--workspace <key>]",
      "  oak-api cron add --workspace <key> --expression <cron> --message <text> [--id <id>]",
      "  oak-api cron remove <id>",
      "  oak-api cron enable <id>",
      "  oak-api cron disable <id>",
      "  oak-api subscribe <workspace> (--discord-thread <id> | --codex-thread <id>)",
      "  oak-api wait <discordThreadId> [--timeout-ms <ms>] [--interval-ms <ms>]",
      "  oak-api context <discordThreadId>",
      "  oak-api compact <discordThreadId>",
      "  oak-api interrupt <discordThreadId>",
      "  oak-api last <discordThreadId>",
      "  oak-api get <path>",
      "  oak-api post <path> [json]",
    ].join("\n"),
  );
  process.exit(2);
}

function readFlag(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index === -1) {
    return null;
  }
  const value = args[index + 1];
  if (!value) {
    usage();
  }
  args.splice(index, 2);
  return value;
}

function readSwitch(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index === -1) {
    return false;
  }
  args.splice(index, 1);
  return true;
}

function parsePositiveInteger(value: string | null, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function requestText(
  path: string,
  options: RequestInit = {},
): Promise<string> {
  const response = await fetch(new URL(path, apiBase), {
    ...options,
    headers: {
      "content-type": "application/json",
      ...options.headers,
    },
  });
  const text = await response.text();
  if (!response.ok) {
    console.error(text.trim() || `${response.status} ${response.statusText}`);
    process.exit(1);
  }
  return text;
}

async function request(path: string, options: RequestInit = {}): Promise<void> {
  const text = await requestText(path, options);
  process.stdout.write(text);
}

async function requestJson(
  path: string,
  options: RequestInit = {},
): Promise<unknown> {
  const text = await requestText(path, options);
  return text.trim() ? (JSON.parse(text) as unknown) : null;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args.shift();
  if (!command) {
    usage();
  }

  if (command === "workspaces") {
    await request("/workspaces");
    return;
  }

  if (command === "sessions") {
    await request("/sessions");
    return;
  }

  if (command === "thread") {
    const workspace = readFlag(args, "--workspace");
    const prompt = readFlag(args, "--prompt");
    const name = readFlag(args, "--name");
    const channelId = readFlag(args, "--channel");
    const subscribe = readSwitch(args, "--subscribe");
    const subscribeWorkspace = readFlag(args, "--subscribe-workspace");
    if (!workspace || !prompt || args.length > 0) {
      usage();
    }
    await request("/threads", {
      method: "POST",
      body: JSON.stringify({
        workspace,
        prompt,
        name,
        channelId,
        subscribe,
        subscribeWorkspace,
      }),
    });
    return;
  }

  if (command === "message") {
    const [threadId, ...textParts] = args;
    if (!threadId || textParts.length === 0) {
      usage();
    }
    await request(`/sessions/${threadId}/message`, {
      method: "POST",
      body: JSON.stringify({ message: textParts.join(" ") }),
    });
    return;
  }

  if (command === "superagent") {
    const [workspace, ...textParts] = args;
    if (!workspace || textParts.length === 0) {
      usage();
    }
    await request(`/superagents/${workspace}/message`, {
      method: "POST",
      body: JSON.stringify({ message: textParts.join(" ") }),
    });
    return;
  }

  if (command === "cron") {
    const subcommand = args.shift();
    if (subcommand === "list") {
      const workspace = readFlag(args, "--workspace");
      if (args.length > 0) {
        usage();
      }
      await request(
        workspace
          ? `/cron-jobs?workspace=${encodeURIComponent(workspace)}`
          : "/cron-jobs",
      );
      return;
    }

    if (subcommand === "add") {
      const workspace = readFlag(args, "--workspace");
      const expression = readFlag(args, "--expression");
      const message = readFlag(args, "--message");
      const id = readFlag(args, "--id");
      if (!workspace || !expression || !message || args.length > 0) {
        usage();
      }
      await request(`/superagents/${encodeURIComponent(workspace)}/cron-jobs`, {
        method: "POST",
        body: JSON.stringify({ id, expression, message }),
      });
      return;
    }

    if (subcommand === "remove") {
      const [id] = args;
      if (!id || args.length !== 1) {
        usage();
      }
      await request("/cron-jobs/remove", {
        method: "POST",
        body: JSON.stringify({ id }),
      });
      return;
    }

    if (subcommand === "enable" || subcommand === "disable") {
      const [id] = args;
      if (!id || args.length !== 1) {
        usage();
      }
      await request("/cron-jobs/enabled", {
        method: "POST",
        body: JSON.stringify({ id, enabled: subcommand === "enable" }),
      });
      return;
    }

    usage();
  }

  if (command === "subscribe") {
    const workspace = args.shift();
    const discordThreadId = readFlag(args, "--discord-thread");
    const codexThreadId = readFlag(args, "--codex-thread");
    if (!workspace || args.length > 0 || (!discordThreadId && !codexThreadId)) {
      usage();
    }
    await request("/subscriptions", {
      method: "POST",
      body: JSON.stringify({ workspace, discordThreadId, codexThreadId }),
    });
    return;
  }

  if (command === "context" || command === "last") {
    const [threadId] = args;
    if (!threadId || args.length !== 1) {
      usage();
    }
    await request(
      command === "context"
        ? `/sessions/${threadId}/context`
        : `/sessions/${threadId}/last-message`,
    );
    return;
  }

  if (command === "wait") {
    const [threadId] = args;
    const timeoutMs = parsePositiveInteger(
      readFlag(args, "--timeout-ms"),
      60 * 60 * 1000,
    );
    const intervalMs = parsePositiveInteger(
      readFlag(args, "--interval-ms"),
      2000,
    );
    if (!threadId || args.length !== 1) {
      usage();
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const payload = await requestJson(`/sessions/${threadId}`);
      const session = isRecord(payload) ? payload.session : null;
      if (isRecord(session)) {
        const activeTurnId =
          typeof session.activeTurnId === "string" ? session.activeTurnId : "";
        const streamingActive = session.streamingActive === true;
        if (!activeTurnId && !streamingActive) {
          const last = await requestJson(`/sessions/${threadId}/last-message`);
          process.stdout.write(
            `${JSON.stringify({ session, last }, null, 2)}\n`,
          );
          return;
        }
      }
      await sleep(intervalMs);
    }

    console.error(`Timed out waiting for ${threadId}.`);
    process.exit(1);
  }

  if (command === "compact" || command === "interrupt") {
    const [threadId] = args;
    if (!threadId || args.length !== 1) {
      usage();
    }
    await request(`/sessions/${threadId}/${command}`, { method: "POST" });
    return;
  }

  if (command === "get") {
    const [path] = args;
    if (!path || args.length !== 1) {
      usage();
    }
    await request(path);
    return;
  }

  if (command === "post") {
    const [path, json = "{}"] = args;
    if (!path || args.length > 2) {
      usage();
    }
    await request(path, { method: "POST", body: json });
    return;
  }

  usage();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
