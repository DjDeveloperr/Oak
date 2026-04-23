import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

interface OakRateLimitWindow {
  usedPercent?: number | null;
  resetsAt?: number | null;
}

interface OakRateLimitCredits {
  unlimited?: boolean;
  hasCredits?: boolean;
  balance?: string | number | null;
}

interface OakProfileRateLimits {
  primary?: OakRateLimitWindow | null;
  secondary?: OakRateLimitWindow | null;
  credits?: OakRateLimitCredits | null;
}

interface OakRateLimitCheckResult {
  ok: boolean;
  home: string;
  rateLimits?: OakProfileRateLimits | null;
  error?: string;
}

export interface OakRateLimitSummaryEntry {
  profileName: string;
  ok: boolean;
  primaryUsedPercent: number | null;
  primaryResetsAt: number | null;
  secondaryUsedPercent: number | null;
  secondaryResetsAt: number | null;
  creditsLine: string | null;
  error: string | null;
}

export interface OakRateLimitSummary {
  profiles: OakRateLimitSummaryEntry[];
  bestProfileName: string | null;
}

interface OakPendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface OakRateLimitCheckerOptions {
  codexBin?: string;
  cwd?: string;
  timeoutMs?: number;
  excludeProfileNames?: string[];
}

function formatEpoch(msOrSec: number | null | undefined): string {
  if (!Number.isFinite(msOrSec) || !msOrSec || msOrSec <= 0) {
    return "n/a";
  }

  const normalized = msOrSec < 1e12 ? msOrSec * 1000 : msOrSec;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }).format(new Date(normalized));
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function compactText(value: string, maxLen = 180): string {
  const compact = stripAnsi(value).replace(/\s+/g, " ").trim();
  if (compact.length <= maxLen) {
    return compact;
  }
  return `${compact.slice(0, maxLen - 3)}...`;
}

function usageBar(usedPercent: number | null | undefined, width = 12): string {
  if (!Number.isFinite(usedPercent)) {
    return `[${".".repeat(width)}] n/a`;
  }

  const clamped = Math.max(0, Math.min(100, Number(usedPercent)));
  const filled = Math.round((clamped / 100) * width);
  return `[${"#".repeat(filled)}${".".repeat(width - filled)}] ${clamped.toFixed(1)}%`;
}

function formatWindowInline(
  windowValue: OakRateLimitWindow | null | undefined,
): string {
  if (!windowValue || typeof windowValue !== "object") {
    return "n/a";
  }

  return [
    usageBar(windowValue.usedPercent),
    `reset=${windowValue.resetsAt == null ? "n/a" : formatEpoch(windowValue.resetsAt)}`,
  ].join(" | ");
}

function hasUsefulCreditsInfo(
  credits: OakRateLimitCredits | null | undefined,
): boolean {
  if (!credits || typeof credits !== "object") {
    return false;
  }

  if (credits.unlimited || credits.hasCredits) {
    return true;
  }

  if (credits.balance == null) {
    return false;
  }

  const text = String(credits.balance).trim();
  if (!text) {
    return false;
  }

  const numeric = Number(text);
  if (Number.isFinite(numeric)) {
    return numeric > 0;
  }

  return true;
}

function formatCreditsLine(
  credits: OakRateLimitCredits | null | undefined,
): string | null {
  if (!hasUsefulCreditsInfo(credits)) {
    return null;
  }

  const parts: string[] = [];
  if (credits?.unlimited) {
    parts.push("unlimited=true");
  }
  if (credits?.hasCredits) {
    parts.push("hasCredits=true");
  }
  if (credits?.balance != null) {
    const text = String(credits.balance).trim();
    if (text) {
      const numeric = Number(text);
      if (!Number.isFinite(numeric) || numeric > 0) {
        parts.push(`balance=${text}`);
      }
    }
  }

  return parts.length > 0 ? parts.join(" ") : null;
}

function normalizeUsedPercent(value: number | null | undefined): number | null {
  return Number.isFinite(value) ? Number(value) : null;
}

function getPickScore(result: OakRateLimitCheckResult): number {
  if (!result.ok) {
    return Number.POSITIVE_INFINITY;
  }

  const primary = normalizeUsedPercent(result.rateLimits?.primary?.usedPercent);
  const secondary = normalizeUsedPercent(
    result.rateLimits?.secondary?.usedPercent,
  );

  if (primary == null && secondary == null) {
    return Number.POSITIVE_INFINITY;
  }
  if (primary == null) {
    return secondary ?? Number.POSITIVE_INFINITY;
  }
  if (secondary == null) {
    return primary;
  }

  return (primary + secondary) / 2;
}

function pickBestResult(
  results: OakRateLimitCheckResult[],
  excludeProfileNames?: Iterable<string>,
): OakRateLimitCheckResult | null {
  const excludedProfiles = new Set(
    [...(excludeProfileNames ?? [])]
      .map((name) => name.trim())
      .filter((name) => name.length > 0),
  );
  const ranked = results
    .map((result) => ({
      result,
      profileName: path.basename(result.home) || result.home,
      primary: normalizeUsedPercent(result.rateLimits?.primary?.usedPercent),
      secondary: normalizeUsedPercent(
        result.rateLimits?.secondary?.usedPercent,
      ),
      score: getPickScore(result),
    }))
    .filter((entry) => !excludedProfiles.has(entry.profileName))
    .filter((entry) => Number.isFinite(entry.score));

  if (ranked.length === 0) {
    return null;
  }

  ranked.sort((left, right) => {
    if (left.score !== right.score) {
      return left.score - right.score;
    }

    const leftPrimary =
      left.primary == null ? Number.POSITIVE_INFINITY : left.primary;
    const rightPrimary =
      right.primary == null ? Number.POSITIVE_INFINITY : right.primary;
    if (leftPrimary !== rightPrimary) {
      return leftPrimary - rightPrimary;
    }

    const leftSecondary =
      left.secondary == null ? Number.POSITIVE_INFINITY : left.secondary;
    const rightSecondary =
      right.secondary == null ? Number.POSITIVE_INFINITY : right.secondary;
    if (leftSecondary !== rightSecondary) {
      return leftSecondary - rightSecondary;
    }

    return left.profileName.localeCompare(right.profileName);
  });

  return ranked[0]?.result ?? null;
}

function discoverProfileHomes(): string[] {
  const profilesRoot = path.join(os.homedir(), ".codex-profiles");
  if (!fs.existsSync(profilesRoot)) {
    return [];
  }

  try {
    return fs
      .readdirSync(profilesRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== ".git")
      .map((entry) => path.join(profilesRoot, entry.name))
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

function createJsonRpcClient(child: ReturnType<typeof spawn>) {
  const pending = new Map<number, OakPendingRequest>();
  let nextId = 1;

  const stdout = readline.createInterface({ input: child.stdout! });
  stdout.on("line", (line) => {
    if (!line.trim()) {
      return;
    }

    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    if (
      typeof message !== "object" ||
      message === null ||
      !("id" in message) ||
      typeof (message as { id?: unknown }).id !== "number"
    ) {
      return;
    }

    const id = (message as { id: number }).id;
    const entry = pending.get(id);
    if (!entry) {
      return;
    }

    pending.delete(id);
    if (
      "error" in message &&
      (message as { error?: unknown }).error !== undefined
    ) {
      const errorValue = (message as { error?: { message?: unknown } }).error;
      const errorText =
        typeof errorValue?.message === "string"
          ? errorValue.message
          : JSON.stringify(errorValue);
      entry.reject(new Error(errorText));
      return;
    }

    entry.resolve((message as { result?: unknown }).result);
  });

  return {
    sendRaw(payload: object): void {
      if (!child.stdin?.writable) {
        throw new Error("codex app-server stdin is not writable");
      }
      child.stdin.write(`${JSON.stringify(payload)}\n`);
    },
    sendRequest(method: string, params: object): Promise<unknown> {
      const id = nextId;
      nextId += 1;
      this.sendRaw({ id, method, params });
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
    },
    sendNotification(method: string, params: object): void {
      this.sendRaw({ method, params });
    },
    rejectAll(error: Error): void {
      for (const pendingEntry of pending.values()) {
        pendingEntry.reject(error);
      }
      pending.clear();
    },
  };
}

async function runForHome(
  home: string,
  options: Required<OakRateLimitCheckerOptions>,
): Promise<OakRateLimitCheckResult> {
  const child = spawn(options.codexBin, ["app-server"], {
    cwd: options.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      CODEX_HOME: home,
    },
  });

  const rpc = createJsonRpcClient(child);
  const stderrLines: string[] = [];
  let requestedStop = false;
  let exitError: string | null = null;

  const timer = setTimeout(() => {
    rpc.rejectAll(new Error(`Timed out after ${options.timeoutMs}ms`));
    requestedStop = true;
    child.kill();
  }, options.timeoutMs);

  child.stderr?.on("data", (chunk) => {
    const clean = stripAnsi(String(chunk ?? ""));
    for (const line of clean.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) {
        stderrLines.push(trimmed);
      }
    }
  });

  child.on("error", (error) => {
    exitError = `Failed to spawn codex app-server: ${String(error)}`;
  });

  child.on("exit", (code, signal) => {
    if (!requestedStop && code !== 0 && signal !== "SIGTERM") {
      exitError = `codex app-server exited (code=${code}, signal=${signal || "none"})`;
    }
  });

  try {
    await rpc.sendRequest("initialize", {
      clientInfo: {
        name: "oak-codex-discord-bot",
        title: "Oak Rate Limit Checker",
        version: "0.1.0",
      },
    });
    rpc.sendNotification("initialized", {});

    const response = (await rpc.sendRequest("account/rateLimits/read", {})) as {
      rateLimits?: OakProfileRateLimits;
    } | null;

    return {
      ok: true,
      home,
      rateLimits: response?.rateLimits ?? null,
    };
  } catch (error) {
    const requestError = compactText(
      error instanceof Error ? error.message : String(error),
    );
    const stderrSummary =
      stderrLines.length > 0
        ? compactText(stderrLines[stderrLines.length - 1] ?? "")
        : "";
    const detail = stderrSummary ? ` | stderr: ${stderrSummary}` : "";
    return {
      ok: false,
      home,
      error: `${exitError ? `${compactText(exitError)} | ` : ""}${requestError}${detail}`,
    };
  } finally {
    clearTimeout(timer);
    if (!child.killed) {
      requestedStop = true;
      child.kill();
    }
  }
}

export async function getOakRateLimitSummary(
  options?: OakRateLimitCheckerOptions,
): Promise<OakRateLimitSummary> {
  const homes = discoverProfileHomes();
  if (homes.length === 0) {
    return {
      profiles: [],
      bestProfileName: null,
    };
  }

  const resolvedOptions: Required<OakRateLimitCheckerOptions> = {
    codexBin: options?.codexBin?.trim() || process.env.CODEX_BIN || "codex",
    cwd: options?.cwd?.trim() || process.cwd(),
    timeoutMs:
      typeof options?.timeoutMs === "number" && options.timeoutMs > 0
        ? options.timeoutMs
        : 15000,
    excludeProfileNames: options?.excludeProfileNames ?? [],
  };

  const results = await Promise.all(
    homes.map((home) => runForHome(home, resolvedOptions)),
  );

  const best = pickBestResult(results, options?.excludeProfileNames);
  return {
    profiles: results.map((result) => ({
      profileName: path.basename(result.home) || result.home,
      ok: result.ok,
      primaryUsedPercent: normalizeUsedPercent(
        result.rateLimits?.primary?.usedPercent,
      ),
      primaryResetsAt: result.rateLimits?.primary?.resetsAt ?? null,
      secondaryUsedPercent: normalizeUsedPercent(
        result.rateLimits?.secondary?.usedPercent,
      ),
      secondaryResetsAt: result.rateLimits?.secondary?.resetsAt ?? null,
      creditsLine: formatCreditsLine(result.rateLimits?.credits ?? null),
      error: result.ok ? null : (result.error ?? "Unknown error"),
    })),
    bestProfileName: best ? path.basename(best.home) || best.home : null,
  };
}

export async function buildOakRateLimitReport(
  options?: OakRateLimitCheckerOptions,
): Promise<string> {
  const summary = await getOakRateLimitSummary(options);
  if (summary.profiles.length === 0) {
    return "No Codex profiles were found in `~/.codex-profiles`.";
  }

  const lines = [
    `Codex rate limits across ${summary.profiles.length} profile${summary.profiles.length === 1 ? "" : "s"}.`,
  ];
  if (summary.bestProfileName) {
    lines.push(`Best profile: \`${summary.bestProfileName}\``);
  }

  for (const [index, profile] of summary.profiles.entries()) {
    lines.push("");
    lines.push(`${index + 1}. \`${profile.profileName}\``);
    if (!profile.ok) {
      lines.push(`   Error: ${profile.error ?? "Unknown error"}`);
      continue;
    }
    lines.push(
      `   Daily: ${formatWindowInline({
        usedPercent: profile.primaryUsedPercent,
        resetsAt: profile.primaryResetsAt,
      })}`,
    );
    lines.push(
      `   Weekly: ${formatWindowInline({
        usedPercent: profile.secondaryUsedPercent,
        resetsAt: profile.secondaryResetsAt,
      })}`,
    );
    if (profile.creditsLine) {
      lines.push(`   Credits: ${profile.creditsLine}`);
    }
  }

  return lines.join("\n");
}
