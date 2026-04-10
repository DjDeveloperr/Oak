import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface OakWorkspaceConfig {
  key: string;
  root: string;
  allowedUserIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface OakWorkspaceRoute {
  guildId: string;
  channelId: string | null;
  workspaceKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface OakAccessConfigSnapshot {
  version: 1;
  workspaces: Array<{
    key: string;
    root: string;
    allowedUserIds: string[];
  }>;
  routes: Array<{
    guildId: string;
    channelId: string | null;
    workspaceKey: string;
  }>;
}

interface OakAccessConfigFile {
  version: 1;
  workspaces: OakWorkspaceConfig[];
  routes: OakWorkspaceRoute[];
}

export interface OakResolvedWorkspaceRoute {
  workspace: OakWorkspaceConfig;
  route: OakWorkspaceRoute;
  matchedChannelId: string | null;
}

function normalizeWorkspaceKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeUserIds(userIds: readonly string[]): string[] {
  return [
    ...new Set(userIds.map((value) => value.trim()).filter(Boolean)),
  ].sort((left, right) => left.localeCompare(right));
}

function buildRouteMapKey(guildId: string, channelId: string | null): string {
  return `${guildId}:${channelId ?? "*"}`;
}

function assertWorkspaceKey(key: string): string {
  const normalized = normalizeWorkspaceKey(key);
  if (!normalized) {
    throw new Error(
      "Workspace key must contain letters, numbers, dashes, or underscores.",
    );
  }
  return normalized;
}

function assertGuildId(guildId: string): string {
  const normalized = guildId.trim();
  if (!normalized) {
    throw new Error("Guild ID is required.");
  }
  return normalized;
}

function assertWorkspaceRoot(root: string): string {
  const resolved = path.resolve(root.trim());
  if (!existsSync(resolved)) {
    throw new Error(`Workspace root does not exist: \`${resolved}\`.`);
  }
  return resolved;
}

function normalizeSnapshot(
  snapshot: OakAccessConfigSnapshot,
): OakAccessConfigFile {
  const now = new Date().toISOString();
  const workspaceKeys = new Set<string>();
  const workspaces = snapshot.workspaces
    .map((workspace) => {
      const key = assertWorkspaceKey(workspace.key);
      if (workspaceKeys.has(key)) {
        throw new Error(
          `Duplicate workspace key in Oak config bootstrap: \`${key}\`.`,
        );
      }
      workspaceKeys.add(key);

      return {
        key,
        root: assertWorkspaceRoot(workspace.root),
        allowedUserIds: normalizeUserIds(workspace.allowedUserIds),
        createdAt: now,
        updatedAt: now,
      };
    })
    .sort((left, right) => left.key.localeCompare(right.key));

  const routeKeys = new Set<string>();
  const routes = snapshot.routes
    .map((route) => {
      const guildId = assertGuildId(route.guildId);
      const workspaceKey = assertWorkspaceKey(route.workspaceKey);
      if (!workspaceKeys.has(workspaceKey)) {
        throw new Error(
          `Route for guild \`${guildId}\` references unknown workspace \`${workspaceKey}\`.`,
        );
      }

      const channelId = route.channelId?.trim() || null;
      const routeKey = buildRouteMapKey(guildId, channelId);
      if (routeKeys.has(routeKey)) {
        throw new Error(`Duplicate Oak route in bootstrap: \`${routeKey}\`.`);
      }
      routeKeys.add(routeKey);

      return {
        guildId,
        channelId,
        workspaceKey,
        createdAt: now,
        updatedAt: now,
      };
    })
    .sort((left, right) =>
      buildRouteMapKey(left.guildId, left.channelId).localeCompare(
        buildRouteMapKey(right.guildId, right.channelId),
      ),
    );

  return {
    version: 1,
    workspaces,
    routes,
  };
}

export class OakAccessConfigStore {
  private readonly workspaces = new Map<string, OakWorkspaceConfig>();
  private readonly routes = new Map<string, OakWorkspaceRoute>();
  private writeQueue = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly bootstrap: OakAccessConfigSnapshot,
  ) {}

  async load(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });

    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<OakAccessConfigFile>;
      this.hydrate({
        version: 1,
        workspaces: parsed.workspaces ?? [],
        routes: parsed.routes ?? [],
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }

      this.hydrate(normalizeSnapshot(this.bootstrap));
      await this.flush();
    }
  }

  listWorkspaces(): OakWorkspaceConfig[] {
    return [...this.workspaces.values()].sort((left, right) =>
      left.key.localeCompare(right.key),
    );
  }

  listWorkspaceRoots(): string[] {
    return [
      ...new Set(this.listWorkspaces().map((workspace) => workspace.root)),
    ];
  }

  getWorkspace(key: string): OakWorkspaceConfig | null {
    return this.workspaces.get(assertWorkspaceKey(key)) ?? null;
  }

  listRoutes(guildId?: string | null): OakWorkspaceRoute[] {
    return [...this.routes.values()]
      .filter((route) => !guildId || route.guildId === guildId)
      .sort((left, right) =>
        buildRouteMapKey(left.guildId, left.channelId).localeCompare(
          buildRouteMapKey(right.guildId, right.channelId),
        ),
      );
  }

  resolveWorkspaceForLocation(options: {
    guildId: string | null | undefined;
    channelId: string | null | undefined;
    parentChannelId?: string | null | undefined;
  }): OakResolvedWorkspaceRoute | null {
    if (!options.guildId) {
      return null;
    }

    const candidateChannelIds = [
      options.channelId?.trim() || null,
      options.parentChannelId?.trim() || null,
    ].filter((value, index, values): value is string => {
      return Boolean(value) && values.indexOf(value) === index;
    });

    for (const channelId of candidateChannelIds) {
      const route = this.routes.get(
        buildRouteMapKey(options.guildId, channelId),
      );
      if (!route) {
        continue;
      }

      const workspace = this.workspaces.get(route.workspaceKey);
      if (!workspace) {
        continue;
      }

      return {
        workspace,
        route,
        matchedChannelId: channelId,
      };
    }

    const defaultRoute =
      this.routes.get(buildRouteMapKey(options.guildId, null)) ?? null;
    if (!defaultRoute) {
      return null;
    }

    const workspace = this.workspaces.get(defaultRoute.workspaceKey);
    if (!workspace) {
      return null;
    }

    return {
      workspace,
      route: defaultRoute,
      matchedChannelId: null,
    };
  }

  isUserAllowedForWorkspace(
    workspaceKey: string | null | undefined,
    userId: string | null | undefined,
    ownerUserId: string | null | undefined,
  ): boolean {
    if (!userId) {
      return false;
    }
    if (ownerUserId && userId === ownerUserId) {
      return true;
    }
    if (!workspaceKey) {
      return false;
    }

    const workspace = this.workspaces.get(assertWorkspaceKey(workspaceKey));
    return workspace?.allowedUserIds.includes(userId) ?? false;
  }

  async upsertWorkspace(options: {
    key: string;
    root: string;
  }): Promise<OakWorkspaceConfig> {
    const key = assertWorkspaceKey(options.key);
    const root = assertWorkspaceRoot(options.root);
    const existing = this.workspaces.get(key);
    const now = new Date().toISOString();

    const nextWorkspace: OakWorkspaceConfig = existing
      ? {
          ...existing,
          root,
          updatedAt: now,
        }
      : {
          key,
          root,
          allowedUserIds: [],
          createdAt: now,
          updatedAt: now,
        };

    this.workspaces.set(key, nextWorkspace);
    await this.flush();
    return nextWorkspace;
  }

  async removeWorkspace(key: string): Promise<void> {
    const normalizedKey = assertWorkspaceKey(key);
    if (!this.workspaces.has(normalizedKey)) {
      throw new Error(`Workspace \`${normalizedKey}\` does not exist.`);
    }

    const routeUsingWorkspace = [...this.routes.values()].find(
      (route) => route.workspaceKey === normalizedKey,
    );
    if (routeUsingWorkspace) {
      throw new Error(
        `Workspace \`${normalizedKey}\` is still assigned to guild \`${routeUsingWorkspace.guildId}\`${routeUsingWorkspace.channelId ? ` channel \`${routeUsingWorkspace.channelId}\`` : ""}.`,
      );
    }

    this.workspaces.delete(normalizedKey);
    await this.flush();
  }

  async grantWorkspaceAccess(
    workspaceKey: string,
    userId: string,
  ): Promise<OakWorkspaceConfig> {
    const workspace = this.requireWorkspace(workspaceKey);
    const nextWorkspace: OakWorkspaceConfig = {
      ...workspace,
      allowedUserIds: normalizeUserIds([...workspace.allowedUserIds, userId]),
      updatedAt: new Date().toISOString(),
    };
    this.workspaces.set(nextWorkspace.key, nextWorkspace);
    await this.flush();
    return nextWorkspace;
  }

  async revokeWorkspaceAccess(
    workspaceKey: string,
    userId: string,
  ): Promise<OakWorkspaceConfig> {
    const workspace = this.requireWorkspace(workspaceKey);
    const nextWorkspace: OakWorkspaceConfig = {
      ...workspace,
      allowedUserIds: workspace.allowedUserIds.filter(
        (value) => value !== userId,
      ),
      updatedAt: new Date().toISOString(),
    };
    this.workspaces.set(nextWorkspace.key, nextWorkspace);
    await this.flush();
    return nextWorkspace;
  }

  async upsertRoute(options: {
    guildId: string;
    channelId: string | null;
    workspaceKey: string;
  }): Promise<OakWorkspaceRoute> {
    const guildId = assertGuildId(options.guildId);
    const channelId = options.channelId?.trim() || null;
    const workspaceKey = this.requireWorkspace(options.workspaceKey).key;
    const routeKey = buildRouteMapKey(guildId, channelId);
    const existing = this.routes.get(routeKey);
    const now = new Date().toISOString();

    const nextRoute: OakWorkspaceRoute = existing
      ? {
          ...existing,
          workspaceKey,
          updatedAt: now,
        }
      : {
          guildId,
          channelId,
          workspaceKey,
          createdAt: now,
          updatedAt: now,
        };

    this.routes.set(routeKey, nextRoute);
    await this.flush();
    return nextRoute;
  }

  async clearRoute(options: {
    guildId: string;
    channelId: string | null;
  }): Promise<void> {
    const routeKey = buildRouteMapKey(
      assertGuildId(options.guildId),
      options.channelId?.trim() || null,
    );
    this.routes.delete(routeKey);
    await this.flush();
  }

  private requireWorkspace(key: string): OakWorkspaceConfig {
    const normalizedKey = assertWorkspaceKey(key);
    const workspace = this.workspaces.get(normalizedKey);
    if (!workspace) {
      throw new Error(`Workspace \`${normalizedKey}\` does not exist.`);
    }
    return workspace;
  }

  private hydrate(file: OakAccessConfigFile): void {
    this.workspaces.clear();
    this.routes.clear();

    const normalized = normalizeSnapshot({
      version: 1,
      workspaces: file.workspaces.map((workspace) => ({
        key: workspace.key,
        root: workspace.root,
        allowedUserIds: workspace.allowedUserIds ?? [],
      })),
      routes: file.routes.map((route) => ({
        guildId: route.guildId,
        channelId: route.channelId ?? null,
        workspaceKey: route.workspaceKey,
      })),
    });

    for (const workspace of normalized.workspaces) {
      this.workspaces.set(workspace.key, workspace);
    }

    for (const route of normalized.routes) {
      this.routes.set(buildRouteMapKey(route.guildId, route.channelId), route);
    }
  }

  private async flush(): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      const payload: OakAccessConfigFile = {
        version: 1,
        workspaces: this.listWorkspaces(),
        routes: this.listRoutes(),
      };

      await writeFile(this.filePath, `${JSON.stringify(payload, null, 2)}\n`);
    });

    await this.writeQueue;
  }
}
