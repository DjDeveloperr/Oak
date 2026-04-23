import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotEnv } from "dotenv";
import type { OakAccessConfigSnapshot } from "./accessConfig.js";
import {
  DEFAULT_OAK_MODEL,
  DEFAULT_OAK_REASONING_EFFORT,
} from "./threadPreferences.js";

function findUp(startDir: string, marker: string): string | null {
  let currentDir = startDir;

  while (true) {
    const candidate = path.join(currentDir, marker);
    if (existsSync(candidate)) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}

const currentFileDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = findUp(currentFileDir, "package.json") ?? process.cwd();

for (const envPath of [
  path.join(process.cwd(), ".env"),
  path.join(repoRoot, ".env"),
]) {
  if (existsSync(envPath)) {
    loadDotEnv({ path: envPath, override: false });
  }
}

function parseInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseCsv(value: string | undefined): string[] {
  return [
    ...new Set(
      (value ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
}

function resolveOakRuntimeDir(root: string): string {
  const preferredRuntimeDir = path.join(root, ".runtime");
  const legacyRuntimeDir = path.join(root, "oak", ".runtime");

  if (existsSync(preferredRuntimeDir) || !existsSync(legacyRuntimeDir)) {
    return preferredRuntimeDir;
  }

  return legacyRuntimeDir;
}

function buildOakBootstrapConfig(root: string): OakAccessConfigSnapshot {
  const workspaceRoot = (process.env.OAK_BOOTSTRAP_WORKSPACE_ROOT ?? "").trim();
  const workspaceKey =
    (process.env.OAK_BOOTSTRAP_WORKSPACE_KEY ?? "").trim() || "default";
  const guildId = (process.env.OAK_BOOTSTRAP_GUILD_ID ?? "").trim();
  const channelId = (process.env.OAK_BOOTSTRAP_CHANNEL_ID ?? "").trim() || null;
  const allowedUserIds = parseCsv(process.env.OAK_BOOTSTRAP_ALLOWED_USER_IDS);

  if (!workspaceRoot) {
    return {
      version: 1,
      workspaces: [],
      routes: [],
    };
  }

  return {
    version: 1,
    workspaces: [
      {
        key: workspaceKey,
        root: path.resolve(root, workspaceRoot),
        allowedUserIds,
      },
    ],
    routes: guildId
      ? [
          {
            guildId,
            channelId,
            workspaceKey,
          },
        ]
      : [],
  };
}

export const oakBootstrapConfig: OakAccessConfigSnapshot =
  buildOakBootstrapConfig(repoRoot);

export function buildOakTurnSandboxPolicy() {
  return {
    type: "dangerFullAccess" as const,
  };
}

const runtimeDir = resolveOakRuntimeDir(repoRoot);

export const oakConfig = {
  repoRoot,
  runtimeDir,
  attachmentsDir: path.join(runtimeDir, "attachments"),
  sessionsPath: path.join(runtimeDir, "sessions.json"),
  configPath: path.join(runtimeDir, "config.json"),
  discordToken: (process.env.OAK_DISCORD_TOKEN ?? "").trim(),
  ownerUserId: (process.env.OAK_OWNER_ID ?? "").trim(),
  codexBin: (
    process.env.OAK_CODEX_BIN ??
    process.env.CODEX_BIN ??
    "codex"
  ).trim(),
  codexWsUrl: (process.env.OAK_CODEX_WS_URL ?? "ws://127.0.0.1:4789").trim(),
  approvalPolicy: "never" as const,
  threadSandbox: "danger-full-access" as const,
  turnSandboxPolicy: buildOakTurnSandboxPolicy(),
  model: (process.env.OAK_CODEX_MODEL ?? "").trim() || DEFAULT_OAK_MODEL,
  reasoningEffort:
    (process.env.OAK_CODEX_REASONING_EFFORT ?? "").trim() ||
    DEFAULT_OAK_REASONING_EFFORT,
  reasoningSummary:
    (process.env.OAK_CODEX_REASONING_SUMMARY ?? "concise").trim() || null,
  serviceTier: (process.env.OAK_CODEX_SERVICE_TIER ?? "").trim() || "fast",
  turnTimeoutMs: parseInteger(process.env.OAK_TURN_TIMEOUT_MS, 60 * 60 * 1000),
  typingIntervalMs: parseInteger(process.env.OAK_TYPING_INTERVAL_MS, 8000),
  dryRun: process.env.OAK_DRY_RUN === "1",
};

export function isOakAdminUserId(userId: string | null | undefined): boolean {
  return Boolean(userId) && userId === oakConfig.ownerUserId;
}
