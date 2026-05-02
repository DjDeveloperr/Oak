import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

export interface OakSuperagentRecord {
  workspaceKey: string;
  discordThreadId: string;
  discordParentChannelId: string | null;
  guildId: string | null;
  codexThreadId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OakSuperagentSubscriptionRecord {
  id: string;
  workspaceKey: string;
  superagentDiscordThreadId: string;
  targetDiscordThreadId: string | null;
  targetCodexThreadId: string | null;
  createdAt: string;
  deliveredAt: string | null;
}

interface SuperagentFile {
  superagents: OakSuperagentRecord[];
  subscriptions: OakSuperagentSubscriptionRecord[];
}

async function writeJsonFileAtomically(
  filePath: string,
  contents: string,
): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tempPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );

  const fileHandle = await open(tempPath, "w");
  try {
    await fileHandle.writeFile(contents, "utf8");
    await fileHandle.sync();
  } finally {
    await fileHandle.close();
  }

  try {
    await rename(tempPath, filePath);
    const dirHandle = await open(dir, "r");
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }
}

function normalizeId(value: string): string {
  return value.trim();
}

function buildSubscriptionId(options: {
  workspaceKey: string;
  superagentDiscordThreadId: string;
  targetDiscordThreadId: string | null;
  targetCodexThreadId: string | null;
}): string {
  return [
    options.workspaceKey,
    options.superagentDiscordThreadId,
    options.targetDiscordThreadId ?? "",
    options.targetCodexThreadId ?? "",
  ].join(":");
}

export class OakSuperagentStore {
  private readonly superagents = new Map<string, OakSuperagentRecord>();
  private readonly subscriptions = new Map<
    string,
    OakSuperagentSubscriptionRecord
  >();
  private writeQueue = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });

    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<SuperagentFile>;
      for (const record of parsed.superagents ?? []) {
        if (!record.workspaceKey?.trim() || !record.discordThreadId?.trim()) {
          continue;
        }
        this.superagents.set(record.workspaceKey, {
          workspaceKey: record.workspaceKey,
          discordThreadId: record.discordThreadId,
          discordParentChannelId: record.discordParentChannelId ?? null,
          guildId: record.guildId ?? null,
          codexThreadId: record.codexThreadId ?? null,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        });
      }

      for (const record of parsed.subscriptions ?? []) {
        if (!record.id?.trim() || !record.superagentDiscordThreadId?.trim()) {
          continue;
        }
        this.subscriptions.set(record.id, {
          id: record.id,
          workspaceKey: record.workspaceKey,
          superagentDiscordThreadId: record.superagentDiscordThreadId,
          targetDiscordThreadId: record.targetDiscordThreadId ?? null,
          targetCodexThreadId: record.targetCodexThreadId ?? null,
          createdAt: record.createdAt,
          deliveredAt: record.deliveredAt ?? null,
        });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  getSuperagent(workspaceKey: string): OakSuperagentRecord | null {
    return this.superagents.get(workspaceKey) ?? null;
  }

  listSuperagents(): OakSuperagentRecord[] {
    return [...this.superagents.values()].sort((left, right) =>
      left.workspaceKey.localeCompare(right.workspaceKey),
    );
  }

  async setSuperagent(record: OakSuperagentRecord): Promise<void> {
    this.superagents.set(record.workspaceKey, record);
    await this.flush();
  }

  listSubscriptionsForTarget(options: {
    discordThreadId?: string | null;
    codexThreadId?: string | null;
  }): OakSuperagentSubscriptionRecord[] {
    const discordThreadId = options.discordThreadId?.trim() || null;
    const codexThreadId = options.codexThreadId?.trim() || null;
    return [...this.subscriptions.values()].filter((subscription) => {
      if (subscription.deliveredAt) {
        return false;
      }
      return (
        (discordThreadId &&
          subscription.targetDiscordThreadId === discordThreadId) ||
        (codexThreadId && subscription.targetCodexThreadId === codexThreadId)
      );
    });
  }

  async subscribe(options: {
    workspaceKey: string;
    superagentDiscordThreadId: string;
    targetDiscordThreadId?: string | null;
    targetCodexThreadId?: string | null;
  }): Promise<OakSuperagentSubscriptionRecord> {
    const targetDiscordThreadId = normalizeId(
      options.targetDiscordThreadId ?? "",
    );
    const targetCodexThreadId = normalizeId(options.targetCodexThreadId ?? "");
    if (!targetDiscordThreadId && !targetCodexThreadId) {
      throw new Error("A subscription target thread id is required.");
    }

    const now = new Date().toISOString();
    const id = buildSubscriptionId({
      workspaceKey: options.workspaceKey,
      superagentDiscordThreadId: options.superagentDiscordThreadId,
      targetDiscordThreadId: targetDiscordThreadId || null,
      targetCodexThreadId: targetCodexThreadId || null,
    });
    const record: OakSuperagentSubscriptionRecord = {
      id,
      workspaceKey: options.workspaceKey,
      superagentDiscordThreadId: options.superagentDiscordThreadId,
      targetDiscordThreadId: targetDiscordThreadId || null,
      targetCodexThreadId: targetCodexThreadId || null,
      createdAt: this.subscriptions.get(id)?.createdAt ?? now,
      deliveredAt: null,
    };
    this.subscriptions.set(id, record);
    await this.flush();
    return record;
  }

  async markSubscriptionDelivered(id: string): Promise<void> {
    const existing = this.subscriptions.get(id);
    if (!existing || existing.deliveredAt) {
      return;
    }
    this.subscriptions.set(id, {
      ...existing,
      deliveredAt: new Date().toISOString(),
    });
    await this.flush();
  }

  private async flush(): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      const payload: SuperagentFile = {
        superagents: this.listSuperagents(),
        subscriptions: [...this.subscriptions.values()].sort((left, right) =>
          left.id.localeCompare(right.id),
        ),
      };

      await writeJsonFileAtomically(
        this.filePath,
        `${JSON.stringify(payload, null, 2)}\n`,
      );
    });

    await this.writeQueue;
  }
}
