import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from "discord.js";

const execFileAsync = promisify(execFile);

const CODEX_SWITCH_MENU_PREFIX = "oak_codex_switch";
const CODEX_SWITCH_MENU_LIMIT = 25;
const CODEX_PROFILES_DIR = path.join(homedir(), ".codex-profiles");
const CODEX_ACTIVE_PROFILE_PATH = path.join(
  CODEX_PROFILES_DIR,
  ".active-profile",
);
const CODEX_CURRENT_PROFILE_PATH = path.join(homedir(), ".codex_current");
const CODEX_AUTH_DIR = path.join(homedir(), ".codex");
const CODEX_AUTH_PATH = path.join(CODEX_AUTH_DIR, "auth.json");
let gitOperationQueue = Promise.resolve();

export interface CodexSwitchMenuState {
  activeProfile: string | null;
  profiles: string[];
  refreshWarning: string | null;
  truncatedCount: number;
}

interface CodexAuthIdentity {
  accountId: string | null;
  contentHash: string;
}

function asErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  return String(error);
}

function toTildePath(value: string): string {
  const home = homedir();
  if (value === home) {
    return "~";
  }
  if (value.startsWith(`${home}${path.sep}`)) {
    return `~${value.slice(home.length)}`;
  }
  return value;
}

async function runGitRefreshStep(args: string[]): Promise<void> {
  await runSerializedGitCommand(args);
}

export async function refreshCodexProfiles(): Promise<void> {
  await runGitRefreshStep(["pull", "--ff-only"]);
}

async function readProfileMarker(markerPath: string): Promise<string | null> {
  try {
    const profile = (await readFile(markerPath, "utf8")).trim();
    return profile || null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return null;
    }

    throw new Error(
      `Failed to read ${toTildePath(markerPath)}: ${asErrorMessage(error)}`,
    );
  }
}

async function readTrackedActiveCodexProfile(): Promise<string | null> {
  const [repoProfile, currentProfile] = await Promise.all([
    readProfileMarker(CODEX_ACTIVE_PROFILE_PATH),
    readProfileMarker(CODEX_CURRENT_PROFILE_PATH),
  ]);

  return repoProfile ?? currentProfile;
}

async function writeProfileMarker(
  markerPath: string,
  profile: string,
): Promise<void> {
  await mkdir(path.dirname(markerPath), { recursive: true });

  try {
    await writeFile(markerPath, `${profile}\n`, "utf8");
  } catch (error) {
    throw new Error(
      `Failed to write ${toTildePath(markerPath)}: ${asErrorMessage(error)}`,
    );
  }
}

function toRepoRelativePath(filePath: string): string {
  const repoRelativePath = path.relative(CODEX_PROFILES_DIR, filePath);
  if (
    !repoRelativePath ||
    repoRelativePath.startsWith("..") ||
    path.isAbsolute(repoRelativePath)
  ) {
    throw new Error(
      `Changed file is outside ${toTildePath(CODEX_PROFILES_DIR)}: ${toTildePath(filePath)}`,
    );
  }
  return repoRelativePath;
}

async function hasGitChangesForPaths(paths: string[]): Promise<boolean> {
  try {
    const { stdout } = await runSerializedGitCommand([
      "status",
      "--short",
      "--untracked-files=all",
      "--",
      ...paths,
    ]);
    return stdout.trim().length > 0;
  } catch (error) {
    throw new Error(
      `git status failed in ${toTildePath(CODEX_PROFILES_DIR)}: ${asErrorMessage(error)}`,
    );
  }
}

async function pushCodexProfileChanges(changedPaths: string[]): Promise<void> {
  const repoPaths = [...new Set(changedPaths.map(toRepoRelativePath))];
  if (repoPaths.length === 0) {
    return;
  }

  if (!(await hasGitChangesForPaths(repoPaths))) {
    return;
  }

  try {
    await runSerializedGitCommand(["add", "--", ...repoPaths]);
    await runSerializedGitCommand(["commit", "-m", "update", "--", ...repoPaths]);
    await runSerializedGitCommand(["push"]);
  } catch (error) {
    throw new Error(
      `Failed to push Codex profile updates from ${toTildePath(CODEX_PROFILES_DIR)}: ${asErrorMessage(error)}`,
    );
  }
}

async function runSerializedGitCommand(
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  const run = async (): Promise<{ stdout: string; stderr: string }> => {
    try {
      const { stdout, stderr } = await execFileAsync("git", args, {
        cwd: CODEX_PROFILES_DIR,
      });
      return {
        stdout: stdout ?? "",
        stderr: stderr ?? "",
      };
    } catch (error) {
      const details =
        error && typeof error === "object"
          ? [
              "stdout" in error && typeof error.stdout === "string"
                ? error.stdout.trim()
                : "",
              "stderr" in error && typeof error.stderr === "string"
                ? error.stderr.trim()
                : "",
            ]
              .filter(Boolean)
              .join("\n")
          : "";

      const suffix = details ? `\n${details}` : "";
      throw new Error(
        `git ${args.join(" ")} failed in ${toTildePath(CODEX_PROFILES_DIR)}: ${asErrorMessage(error)}${suffix}`,
      );
    }
  };

  const pending = gitOperationQueue.then(run, run);
  gitOperationQueue = pending.then(
    () => undefined,
    () => undefined,
  );
  return pending;
}

async function persistTrackedActiveCodexProfile(profile: string): Promise<void> {
  await refreshCodexProfiles();
  await writeProfileMarker(CODEX_ACTIVE_PROFILE_PATH, profile);
  await pushCodexProfileChanges([CODEX_ACTIVE_PROFILE_PATH]);
  await writeProfileMarker(CODEX_CURRENT_PROFILE_PATH, profile);
}

function extractCodexAccountId(rawAuth: string): string | null {
  try {
    const parsed = JSON.parse(rawAuth) as {
      tokens?: { account_id?: unknown };
    };
    const accountId = parsed.tokens?.account_id;
    if (typeof accountId !== "string") {
      return null;
    }

    const trimmed = accountId.trim();
    return trimmed || null;
  } catch {
    return null;
  }
}

async function readCodexAuthIdentity(
  authPath: string,
): Promise<CodexAuthIdentity | null> {
  try {
    const rawAuth = await readFile(authPath, "utf8");
    return {
      accountId: extractCodexAccountId(rawAuth),
      contentHash: createHash("sha256").update(rawAuth).digest("hex"),
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return null;
    }

    throw new Error(
      `Failed to read ${toTildePath(authPath)}: ${asErrorMessage(error)}`,
    );
  }
}

async function listAllCodexProfiles(): Promise<string[]> {
  let entries: Dirent<string>[];
  try {
    entries = await readdir(CODEX_PROFILES_DIR, {
      encoding: "utf8",
      withFileTypes: true,
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return [];
    }

    throw new Error(
      `Failed to read ${toTildePath(CODEX_PROFILES_DIR)}: ${asErrorMessage(error)}`,
    );
  }

  return entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        entry.name !== ".git" &&
        entry.name !== ".DS_Store",
    )
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

async function resolveActiveCodexProfile(
  profiles?: string[],
): Promise<string | null> {
  const [trackedProfile, availableProfiles, liveAuth] = await Promise.all([
    readTrackedActiveCodexProfile(),
    profiles ? Promise.resolve(profiles) : listAllCodexProfiles(),
    readCodexAuthIdentity(CODEX_AUTH_PATH),
  ]);

  if (!liveAuth) {
    return trackedProfile;
  }

  const exactMatches: string[] = [];
  const accountMatches: string[] = [];

  for (const profile of availableProfiles) {
    const profileAuth = await readCodexAuthIdentity(
      path.join(CODEX_PROFILES_DIR, profile, "auth.json"),
    );
    if (!profileAuth) {
      continue;
    }

    if (profileAuth.contentHash === liveAuth.contentHash) {
      exactMatches.push(profile);
      continue;
    }

    if (
      liveAuth.accountId &&
      profileAuth.accountId &&
      profileAuth.accountId === liveAuth.accountId
    ) {
      accountMatches.push(profile);
    }
  }

  const chooseMatch = (matches: string[]): string | null => {
    if (matches.length === 0) {
      return null;
    }
    if (trackedProfile && matches.includes(trackedProfile)) {
      return trackedProfile;
    }
    return matches.length === 1 ? (matches[0] ?? null) : null;
  };

  const resolvedProfile =
    chooseMatch(exactMatches) ?? chooseMatch(accountMatches) ?? trackedProfile;

  if (resolvedProfile && resolvedProfile !== trackedProfile) {
    await persistTrackedActiveCodexProfile(resolvedProfile);
  }

  return resolvedProfile;
}

export async function syncActiveCodexProfile(): Promise<string | null> {
  const profiles = await listAllCodexProfiles();
  return resolveActiveCodexProfile(profiles);
}

export async function listCodexProfiles(): Promise<CodexSwitchMenuState> {
  const profiles = await listAllCodexProfiles();
  const activeProfile = await resolveActiveCodexProfile(profiles);

  return {
    activeProfile,
    profiles: profiles.slice(0, CODEX_SWITCH_MENU_LIMIT),
    refreshWarning: null,
    truncatedCount: Math.max(0, profiles.length - CODEX_SWITCH_MENU_LIMIT),
  };
}

export async function loadCodexSwitchMenuState(options?: {
  refresh?: boolean;
}): Promise<CodexSwitchMenuState> {
  let refreshWarning: string | null = null;

  if (options?.refresh) {
    try {
      await refreshCodexProfiles();
    } catch (error) {
      refreshWarning = asErrorMessage(error);
    }
  }

  const state = await listCodexProfiles();
  return {
    ...state,
    refreshWarning,
  };
}

export async function switchCodexProfile(account: string): Promise<{
  previousProfile: string | null;
  previousProfilePath: string | null;
  previousProfileHadLiveAuth: boolean;
  sourcePath: string;
  destinationPath: string;
}> {
  const sourcePath = path.join(CODEX_PROFILES_DIR, account, "auth.json");
  const previousProfile = await resolveActiveCodexProfile();
  const changedPaths = new Set<string>();

  await refreshCodexProfiles();
  await mkdir(CODEX_AUTH_DIR, { recursive: true });

  let previousProfilePath: string | null = null;
  let previousProfileHadLiveAuth = false;
  if (previousProfile) {
    const previousPath = path.join(
      CODEX_PROFILES_DIR,
      previousProfile,
      "auth.json",
    );

    await mkdir(path.dirname(previousPath), { recursive: true });

    try {
      await copyFile(CODEX_AUTH_PATH, previousPath);
      previousProfileHadLiveAuth = true;
      previousProfilePath = toTildePath(previousPath);
      changedPaths.add(previousPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        previousProfileHadLiveAuth = false;
      } else {
        throw new Error(
          `Failed to copy ${toTildePath(CODEX_AUTH_PATH)} to ${toTildePath(previousPath)}: ${asErrorMessage(error)}`,
        );
      }
    }
  }

  try {
    await copyFile(sourcePath, CODEX_AUTH_PATH);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(
        `Profile auth file not found: ${toTildePath(sourcePath)}`,
      );
    }

    throw new Error(
      `Failed to copy ${toTildePath(sourcePath)} to ${toTildePath(CODEX_AUTH_PATH)}: ${asErrorMessage(error)}`,
    );
  }

  try {
    await writeProfileMarker(CODEX_ACTIVE_PROFILE_PATH, account);
    changedPaths.add(CODEX_ACTIVE_PROFILE_PATH);
    await pushCodexProfileChanges([...changedPaths]);
    await writeProfileMarker(CODEX_CURRENT_PROFILE_PATH, account);
  } catch (error) {
    throw new Error(
      `Switched auth into ${toTildePath(CODEX_AUTH_PATH)}, but failed to update the tracked active profile: ${asErrorMessage(error)}`,
    );
  }

  return {
    previousProfile,
    previousProfilePath,
    previousProfileHadLiveAuth,
    sourcePath: toTildePath(sourcePath),
    destinationPath: toTildePath(CODEX_AUTH_PATH),
  };
}

export function buildCodexSwitchCustomId(userId: string): string {
  return `${CODEX_SWITCH_MENU_PREFIX}:${userId}`;
}

export function parseCodexSwitchCustomId(
  customId: string,
): { userId: string } | null {
  const [prefix, userId] = customId.split(":");
  if (prefix !== CODEX_SWITCH_MENU_PREFIX || !userId) {
    return null;
  }

  return { userId };
}

export function buildCodexSwitchMessage(options: {
  userId: string;
  state: CodexSwitchMenuState;
  statusText?: string | null;
  selectedProfile?: string | null;
}): {
  content: string;
  components: Array<ActionRowBuilder<StringSelectMenuBuilder>>;
} {
  const lines = [
    "Codex profile switcher.",
    "This saves the active profile's live `auth.json`, then copies the selected profile into `~/.codex/auth.json`.",
    "Restart Codex manually when safe after switching.",
  ];
  const highlightedProfile =
    options.selectedProfile ??
    (options.state.activeProfile &&
    options.state.profiles.includes(options.state.activeProfile)
      ? options.state.activeProfile
      : null);

  lines.push(
    options.state.activeProfile
      ? `Active profile: \`${options.state.activeProfile}\``
      : "Active profile: `none`",
  );

  if (options.state.refreshWarning) {
    lines.push("");
    lines.push(`Profile refresh warning: ${options.state.refreshWarning}`);
  }

  if (options.state.truncatedCount > 0) {
    lines.push(
      `Showing the first ${options.state.profiles.length} profiles. ${options.state.truncatedCount} more are not shown.`,
    );
  }

  if (options.statusText) {
    lines.push("");
    lines.push(options.statusText);
  }

  if (options.state.profiles.length === 0) {
    lines.push("");
    lines.push("No Codex profiles were found in `~/.codex-profiles`.");
    return {
      content: lines.join("\n"),
      components: [],
    };
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId(buildCodexSwitchCustomId(options.userId))
    .setPlaceholder(
      highlightedProfile
        ? `Codex profile: ${highlightedProfile}`
        : "Choose a Codex profile",
    )
    .addOptions(
      options.state.profiles.map((profile) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(profile)
          .setValue(profile)
          .setDescription(`Copy ${profile}/auth.json into ~/.codex`)
          .setDefault(profile === highlightedProfile),
      ),
    );

  return {
    content: lines.join("\n"),
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
    ],
  };
}
