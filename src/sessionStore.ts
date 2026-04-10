import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildOakThreadPreferences,
  type OakThreadPreferences,
} from "./threadPreferences.js";

export interface OakTrackedAgentRecord {
  agentThreadId: string;
  nickname: string | null;
  role: string | null;
  prompt: string | null;
  status: string | null;
  spawnedAt: string;
  updatedAt: string;
}

export interface SessionRecord extends OakThreadPreferences {
  discordThreadId: string;
  discordThreadName: string;
  guildId: string | null;
  discordParentChannelId: string | null;
  lastInteractorUserId: string | null;
  serviceTier: string | null;
  fastModeEnabled: boolean;
  baseModel: string | null;
  baseReasoningEffort: string | null;
  codexThreadId: string;
  codexRolloutPath: string | null;
  activeTurnId: string | null;
  streamingActive: boolean;
  activeAgents: OakTrackedAgentRecord[];
  pendingRestartContinue: boolean;
  pendingRestartContinueAt: string | null;
  rolloutReadOffset: number;
  createdAt: string;
  updatedAt: string;
}

interface SessionFile {
  sessions: SessionRecord[];
}

function normalizeTrackedAgent(
  value: OakTrackedAgentRecord | null | undefined,
): OakTrackedAgentRecord | null {
  if (!value || !value.agentThreadId?.trim()) {
    return null;
  }

  const fallbackTimestamp = new Date(0).toISOString();
  return {
    agentThreadId: value.agentThreadId.trim(),
    nickname:
      typeof value.nickname === "string" && value.nickname.trim()
        ? value.nickname.trim()
        : null,
    role:
      typeof value.role === "string" && value.role.trim()
        ? value.role.trim()
        : null,
    prompt:
      typeof value.prompt === "string" && value.prompt.trim()
        ? value.prompt.trim()
        : null,
    status:
      typeof value.status === "string" && value.status.trim()
        ? value.status.trim()
        : null,
    spawnedAt:
      typeof value.spawnedAt === "string" && value.spawnedAt.trim()
        ? value.spawnedAt
        : fallbackTimestamp,
    updatedAt:
      typeof value.updatedAt === "string" && value.updatedAt.trim()
        ? value.updatedAt
        : typeof value.spawnedAt === "string" && value.spawnedAt.trim()
          ? value.spawnedAt
          : fallbackTimestamp,
  };
}

export class SessionStore {
  private readonly records = new Map<string, SessionRecord>();
  private writeQueue = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });

    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as SessionFile;
      for (const record of parsed.sessions ?? []) {
        this.records.set(record.discordThreadId, {
          discordThreadId: record.discordThreadId,
          discordThreadName: record.discordThreadName,
          guildId: record.guildId ?? null,
          discordParentChannelId: record.discordParentChannelId ?? null,
          lastInteractorUserId: record.lastInteractorUserId ?? null,
          serviceTier:
            typeof record.serviceTier === "string" && record.serviceTier.trim()
              ? record.serviceTier
              : null,
          fastModeEnabled: record.fastModeEnabled ?? false,
          baseModel: record.baseModel ?? null,
          baseReasoningEffort: record.baseReasoningEffort ?? null,
          ...buildOakThreadPreferences(record.model, record.reasoningEffort),
          codexThreadId: record.codexThreadId,
          codexRolloutPath: record.codexRolloutPath ?? null,
          activeTurnId: record.activeTurnId ?? null,
          streamingActive: record.streamingActive ?? false,
          activeAgents: Array.isArray(record.activeAgents)
            ? record.activeAgents
                .map((agent) => normalizeTrackedAgent(agent))
                .filter(
                  (agent): agent is OakTrackedAgentRecord => agent !== null,
                )
            : [],
          pendingRestartContinue: record.pendingRestartContinue ?? false,
          pendingRestartContinueAt: record.pendingRestartContinueAt ?? null,
          rolloutReadOffset:
            typeof record.rolloutReadOffset === "number" &&
            Number.isFinite(record.rolloutReadOffset) &&
            record.rolloutReadOffset >= 0
              ? record.rolloutReadOffset
              : 0,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  get(discordThreadId: string): SessionRecord | null {
    return this.records.get(discordThreadId) ?? null;
  }

  list(): SessionRecord[] {
    return [...this.records.values()];
  }

  async set(record: SessionRecord): Promise<void> {
    this.records.set(record.discordThreadId, record);
    await this.flush();
  }

  private async flush(): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      const payload: SessionFile = {
        sessions: [...this.records.values()].sort((left, right) =>
          left.discordThreadId.localeCompare(right.discordThreadId),
        ),
      };

      await writeFile(this.filePath, `${JSON.stringify(payload, null, 2)}\n`);
    });

    await this.writeQueue;
  }
}
