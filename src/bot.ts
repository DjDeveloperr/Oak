import {
  ChannelType,
  Client,
  ContainerBuilder,
  Events,
  GatewayIntentBits,
  MessageType,
  MessageFlags,
  SeparatorBuilder,
  TextDisplayBuilder,
  ThreadAutoArchiveDuration,
  type ApplicationCommandOptionChoiceData,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type Message,
  type MessageReplyOptions,
  type StringSelectMenuInteraction,
  type TextChannel,
  type ThreadChannel,
} from "discord.js";
import { mkdir, open, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  OakCodexClient,
  type OakCodexEvent,
  type OakCodexModelOption,
  type OakUserInput,
} from "./codexClient.js";
import {
  requestSupervisorRestart,
  supervisorControlsRestart,
} from "./processControl.js";
import {
  buildCodexSwitchMessage,
  loadCodexSwitchMenuState,
  parseCodexSwitchCustomId,
  syncActiveCodexProfile,
  switchCodexProfile,
} from "./codexSwitch.js";
import {
  buildOakTurnSandboxPolicy,
  isOakAdminUserId,
  oakBootstrapConfig,
  oakConfig,
} from "./config.js";
import {
  OakAccessConfigStore,
  type OakResolvedWorkspaceRoute,
  type OakWorkspaceConfig,
} from "./accessConfig.js";
import {
  OAK_CONFIG_COMMAND_NAME,
  OAK_RESUME_COMMAND_NAME,
  getOakApplicationCommandData,
} from "./applicationCommands.js";
import {
  SessionStore,
  type OakTrackedAgentRecord,
  type SessionRecord,
} from "./sessionStore.js";
import {
  buildOakFastModePreferences,
  buildOakThreadPreferences,
  buildThreadPreferenceMessage,
  normalizeOakServiceTier,
  type OakModelOption,
  parseThreadPreferenceCustomId,
  type OakThreadPreferences,
} from "./threadPreferences.js";
import { getOakRateLimitSummary } from "./rateLimitChecker.js";

const DISCORD_MESSAGE_LIMIT = 2000;
const DISCORD_INLINE_COMMAND_LIMIT = 500;
const DISCORD_CODE_BLOCK_LIMIT = 1900;
const OAK_MODEL_OPTIONS_CACHE_TTL_MS = 5 * 60 * 1000;

interface SessionContext {
  record: SessionRecord;
  thread: ThreadChannel;
  client: OakCodexClient;
  ready: boolean;
  needsClientRefresh: boolean;
  streamedOutputKeys: Set<string>;
  lastCommentaryTurnId: string | null;
  lastCommentaryText: string;
  typingTimer: NodeJS.Timeout | null;
  rolloutPoller: NodeJS.Timeout | null;
  reconnectTimer: NodeJS.Timeout | null;
  reconnectInFlight: Promise<void> | null;
  reconnectAttempt: number;
  restartResumeTimer: NodeJS.Timeout | null;
  restartResumeInFlight: Promise<void> | null;
  restartResumeAttempt: number;
  rolloutReadOffset: number;
  rolloutLineRemainder: string;
  lastReportedErrorText: string | null;
  lastReportedErrorAt: number;
}

const sessionStore = new SessionStore(oakConfig.sessionsPath);
const oakAccessConfigStore = new OakAccessConfigStore(
  oakConfig.configPath,
  oakBootstrapConfig,
);
const sessions = new Map<string, SessionContext>();
const OAK_RESTART_CONTINUE_TEXT = "continue";
let oakModelOptionsCache: {
  expiresAt: number;
  data: OakModelOption[];
} | null = null;

function log(message: string, context?: Record<string, unknown>): void {
  if (context) {
    console.log(`[oak] ${message}`, context);
    return;
  }
  console.log(`[oak] ${message}`);
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sanitizeFileName(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]+/g, "_");
  return sanitized.slice(0, 120) || "attachment";
}

function getWorkspaceRootsBySpecificity(): string[] {
  return oakAccessConfigStore
    .listWorkspaceRoots()
    .sort((left, right) => right.length - left.length);
}

function isPathInsideRoot(root: string, candidatePath: string): boolean {
  const relativePath = path.relative(root, candidatePath).trim();
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}

function getWorkspaceRootForPath(value: string): string | null {
  const resolvedPath = path.resolve(value);
  return (
    getWorkspaceRootsBySpecificity().find((root) =>
      isPathInsideRoot(root, resolvedPath),
    ) ?? null
  );
}

function formatSmallBlock(title: string, body: string): string {
  const lines = [`### ${title}`, ...body.split(/\r?\n/)];
  return lines.map((line) => `-# ${line}`).join("\n");
}

function formatCompactBlock(body: string): string {
  return body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `-# ${line}`)
    .join("\n");
}

function formatInlineCode(value: string): string {
  const compact = normalizeWhitespace(value);
  if (!compact) {
    return "";
  }
  return `\`${compact.replaceAll("`", "\\`")}\``;
}

function formatCodeBlock(language: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  return `\`\`\`${language}\n${trimmed.replaceAll("```", "\\`\\`\\`")}\n\`\`\``;
}

function normalizeDiscordFileReferencePath(value: string): string {
  const withoutAnchor = value.replace(/#.*$/, "");
  const workspaceRoot = getWorkspaceRootForPath(withoutAnchor);
  if (!workspaceRoot) {
    return withoutAnchor;
  }

  const relativePath = path.relative(workspaceRoot, withoutAnchor).trim();
  if (
    !relativePath ||
    relativePath.startsWith("..") ||
    path.isAbsolute(relativePath)
  ) {
    return withoutAnchor;
  }

  return relativePath.replaceAll("\\", "/");
}

function rewriteDiscordFileReferences(text: string): string {
  const rewritten = text.replaceAll(
    /\[[^\]]+\]\((\/[^)#\s]+)(#L\d+(?:C\d+)?)?\)/g,
    (match, absolutePath: string, anchor?: string) => {
      const relativePath = normalizeDiscordFileReferencePath(absolutePath);
      if (relativePath === absolutePath) {
        return match;
      }

      return `\`${relativePath}${anchor ?? ""}\``;
    },
  );

  return rewritten.replaceAll(
    /`([^`#]+)#L\d+(?:C\d+)?`\s+through\s+`([^`#]+)#(L\d+(?:C\d+)?)`/g,
    (match, leftPath: string, rightPath: string, rightAnchor: string) => {
      if (leftPath !== rightPath) {
        return match;
      }
      return `\`${rightPath}#${rightAnchor}\``;
    },
  );
}

function unwrapShellWrappedCommand(command: string): string {
  const match = command
    .trim()
    .match(/^(?:\/bin\/)?(?:bash|sh|zsh)\s+-lc\s+([\s\S]+)$/);
  if (!match) {
    return command;
  }

  const wrapped = match[1]?.trim() ?? "";
  if (
    (wrapped.startsWith("'") && wrapped.endsWith("'")) ||
    (wrapped.startsWith('"') && wrapped.endsWith('"'))
  ) {
    const quote = wrapped[0];
    const inner = wrapped.slice(1, -1);
    if (quote === "'") {
      return inner.replaceAll(`'"'"'`, "'");
    }
    return inner.replaceAll('\\"', '"').replaceAll("\\\\", "\\");
  }

  return wrapped;
}

function decodeShellQuotedArgument(value: string): string {
  if (
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith('"') && value.endsWith('"'))
  ) {
    const quote = value[0];
    const inner = value.slice(1, -1);
    if (quote === "'") {
      return inner.replaceAll(`'"'"'`, "'");
    }
    return inner.replace(/\\(["\\$`])/g, "$1");
  }

  return value;
}

function extractScriptEvalCode(
  command: string,
  interpreter: "node" | "python" | "python3",
): string | null {
  const match = command
    .trim()
    .match(
      new RegExp(
        `^${escapeRegExp(interpreter)}(?:\\s+--input-type=\\S+)?\\s+-(?:e|c)\\s+([\\s\\S]+)$`,
      ),
    );
  if (!match) {
    return null;
  }

  const code = decodeShellQuotedArgument(match[1]!.trim()).trim();
  return code || null;
}

function extractScriptHeredocCode(
  command: string,
  interpreter: "node" | "python" | "python3",
): string | null {
  const match = command
    .trim()
    .match(
      new RegExp(
        `^${escapeRegExp(interpreter)}\\b[\\s\\S]*?<<(?:(['"])([A-Za-z_][A-Za-z0-9_]*)\\1|([A-Za-z_][A-Za-z0-9_]*))(?:\\s+|\\r?\\n)([\\s\\S]*)$`,
      ),
    );
  if (!match) {
    return null;
  }

  const delimiter = match[2] ?? match[3] ?? "";
  let code = match[4]?.trim() ?? "";
  if (!code) {
    return null;
  }

  const escapedDelimiter = escapeRegExp(delimiter);
  code = code
    .replace(new RegExp(`(?:\\r?\\n)${escapedDelimiter}\\s*$`), "")
    .replace(new RegExp(`\\s+${escapedDelimiter}\\s*$`), "")
    .trim();

  return code || null;
}

function extractScriptCode(
  command: string,
): { language: "javascript" | "python"; code: string } | null {
  const javascriptCode =
    extractScriptEvalCode(command, "node") ??
    extractScriptHeredocCode(command, "node");
  if (javascriptCode) {
    return {
      language: "javascript",
      code: javascriptCode,
    };
  }

  for (const interpreter of ["python", "python3"] as const) {
    const pythonCode =
      extractScriptEvalCode(command, interpreter) ??
      extractScriptHeredocCode(command, interpreter);
    if (pythonCode) {
      return {
        language: "python",
        code: pythonCode,
      };
    }
  }

  return null;
}

type DisplayedCommand =
  | { kind: "inline"; text: string }
  | { kind: "script"; language: "javascript" | "python"; code: string };

function normalizeDisplayedCommand(command: string): DisplayedCommand | null {
  const unwrapped = unwrapShellWrappedCommand(command).trim();
  if (!unwrapped) {
    return null;
  }

  const commandName = unwrapped.match(/^\S+/)?.[0]?.toLowerCase() ?? "";
  if (
    commandName === "rg" ||
    commandName === "sed" ||
    commandName === "nl" ||
    commandName === "pwd"
  ) {
    return null;
  }

  const script = extractScriptCode(unwrapped);
  if (script) {
    return {
      kind: "script",
      language: script.language,
      code: truncateDisplayedCommand(
        script.code,
        DISCORD_CODE_BLOCK_LIMIT - 16,
      ),
    };
  }

  return {
    kind: "inline",
    text: normalizeWhitespace(unwrapped),
  };
}

function truncateDisplayedCommand(
  command: string,
  maxLength = DISCORD_INLINE_COMMAND_LIMIT,
): string {
  if (command.length <= maxLength) {
    return command;
  }

  return `${command.slice(0, maxLength - 4).trimEnd()} ...`;
}

function buildStreamedOutputKey(
  parts: Array<string | null | undefined>,
): string {
  return parts
    .map((part) => normalizeWhitespace(part ?? ""))
    .filter(Boolean)
    .join("|");
}

function resetCommentaryState(
  session: SessionContext,
  turnId: string | null = null,
): void {
  session.lastCommentaryTurnId = turnId;
  session.lastCommentaryText = "";
}

function extractCommentaryDelta(
  previousText: string,
  nextText: string,
): string | null {
  if (!nextText.trim()) {
    return null;
  }

  if (!previousText) {
    return nextText.trim();
  }

  if (nextText === previousText) {
    return null;
  }

  if (nextText.startsWith(previousText)) {
    const delta = nextText.slice(previousText.length).trim();
    return delta || null;
  }

  if (previousText.startsWith(nextText)) {
    return null;
  }

  return nextText.trim();
}

function extractReasoningTextFromRollout(
  payload: Record<string, unknown>,
): string | null {
  if (!Array.isArray(payload.summary)) {
    return null;
  }

  const text = payload.summary
    .flatMap((entry) => {
      if (
        typeof entry === "object" &&
        entry !== null &&
        (entry as { type?: unknown }).type === "summary_text" &&
        typeof (entry as { text?: unknown }).text === "string"
      ) {
        return [(entry as { text: string }).text.trim()];
      }
      return [];
    })
    .filter(Boolean)
    .join("\n")
    .trim();

  return text || null;
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function extractExecCommandsFromRolloutPayload(
  payload: Record<string, unknown>,
): string[] {
  if (payload.type !== "function_call" || typeof payload.name !== "string") {
    return [];
  }

  const argumentsObject = parseJsonObject(payload.arguments);
  if (!argumentsObject) {
    return [];
  }

  if (payload.name === "exec_command") {
    return typeof argumentsObject.cmd === "string" ? [argumentsObject.cmd] : [];
  }

  if (payload.name !== "multi_tool_use.parallel") {
    return [];
  }

  const toolUses = Array.isArray(argumentsObject.tool_uses)
    ? argumentsObject.tool_uses
    : [];

  return toolUses
    .flatMap((toolUse) => {
      if (typeof toolUse !== "object" || toolUse === null) {
        return [];
      }

      const recipientName =
        typeof (toolUse as { recipient_name?: unknown }).recipient_name ===
        "string"
          ? (toolUse as { recipient_name: string }).recipient_name
          : null;
      const parameters =
        typeof (toolUse as { parameters?: unknown }).parameters === "object" &&
        (toolUse as { parameters?: unknown }).parameters !== null
          ? (toolUse as { parameters: Record<string, unknown> }).parameters
          : null;

      if (
        recipientName !== "functions.exec_command" ||
        !parameters ||
        typeof parameters.cmd !== "string"
      ) {
        return [];
      }

      return [parameters.cmd];
    })
    .filter((command) => normalizeWhitespace(command).length > 0);
}

function splitDiscordText(
  text: string,
  maxLength = DISCORD_MESSAGE_LIMIT,
): string[] {
  const normalized = text.replace(/\r/g, "").trim();
  if (!normalized) {
    return [];
  }
  if (normalized.length <= maxLength) {
    return [normalized];
  }

  const chunks: string[] = [];
  let remaining = normalized;

  while (remaining.length > maxLength) {
    const candidate = remaining.slice(0, maxLength);
    const breakIndex =
      candidate.lastIndexOf("\n\n") > 0
        ? candidate.lastIndexOf("\n\n")
        : candidate.lastIndexOf("\n") > 0
          ? candidate.lastIndexOf("\n")
          : candidate.lastIndexOf(" ") > 0
            ? candidate.lastIndexOf(" ")
            : maxLength;

    chunks.push(remaining.slice(0, breakIndex).trim());
    remaining = remaining.slice(breakIndex).trim();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks.filter(Boolean);
}

function splitDiscordCodeText(
  text: string,
  maxLength = DISCORD_CODE_BLOCK_LIMIT,
): string[] {
  const normalized = text.replace(/\r/g, "").trim();
  if (!normalized) {
    return [];
  }
  if (normalized.length <= maxLength) {
    return [normalized];
  }

  const chunks: string[] = [];
  let current = "";

  const pushCurrent = (): void => {
    if (!current) {
      return;
    }
    chunks.push(current);
    current = "";
  };

  for (const line of normalized.split("\n")) {
    if (line.length > maxLength) {
      pushCurrent();
      for (let index = 0; index < line.length; index += maxLength) {
        chunks.push(line.slice(index, index + maxLength));
      }
      continue;
    }

    if (!current) {
      current = line;
      continue;
    }

    const next = `${current}\n${line}`;
    if (next.length <= maxLength) {
      current = next;
      continue;
    }

    pushCurrent();
    current = line;
  }

  pushCurrent();
  return chunks.filter(Boolean);
}

function truncateDiscordContent(
  text: string,
  maxLength = DISCORD_MESSAGE_LIMIT,
): string {
  const normalized = text.replace(/\r/g, "").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function withSafeDiscordContent<T extends { content?: string | null }>(
  payload: T,
): T {
  if (typeof payload.content !== "string") {
    return payload;
  }

  return {
    ...payload,
    content: truncateDiscordContent(payload.content),
  } as T;
}

async function replyWithSafeText(
  interaction:
    | ButtonInteraction
    | ChatInputCommandInteraction
    | StringSelectMenuInteraction,
  text: string,
): Promise<void> {
  const chunks = splitDiscordText(text);
  if (chunks.length === 0) {
    await interaction.reply({
      content: "\u200b",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.reply(
    withSafeDiscordContent({
      content: chunks[0],
      flags: MessageFlags.Ephemeral as const,
    }),
  );

  for (const chunk of chunks.slice(1)) {
    await interaction.followUp(
      withSafeDiscordContent({
        content: chunk,
        flags: MessageFlags.Ephemeral as const,
      }),
    );
  }
}

function getChannelParentId(
  channel:
    | Message["channel"]
    | ButtonInteraction["channel"]
    | StringSelectMenuInteraction["channel"]
    | ChatInputCommandInteraction["channel"]
    | null
    | undefined,
): string | null {
  if (!channel || !("parentId" in channel)) {
    return null;
  }

  return typeof channel.parentId === "string" ? channel.parentId : null;
}

function resolveOakWorkspaceForLocation(options: {
  guildId: string | null | undefined;
  channelId: string | null | undefined;
  parentChannelId?: string | null | undefined;
}): OakResolvedWorkspaceRoute | null {
  return oakAccessConfigStore.resolveWorkspaceForLocation(options);
}

function getAllowedWorkspaceForMessage(
  message: Message,
): OakResolvedWorkspaceRoute | null {
  if (
    message.author.bot ||
    !message.inGuild() ||
    !isProcessableMessageType(message)
  ) {
    return null;
  }

  const scope = resolveOakWorkspaceForLocation({
    guildId: message.guildId,
    channelId: message.channelId,
    parentChannelId: getChannelParentId(message.channel),
  });
  if (!scope) {
    return null;
  }

  if (
    !oakAccessConfigStore.isUserAllowedForWorkspace(
      scope.workspace.key,
      message.author.id,
      oakConfig.ownerUserId,
    )
  ) {
    return null;
  }

  return scope;
}

function isProcessableMessageType(message: Message): boolean {
  return (
    message.type === MessageType.Default ||
    message.type === MessageType.Reply ||
    message.type === MessageType.ThreadStarterMessage
  );
}

function isForumStarterMessage(message: Message): boolean {
  return (
    message.channel.isThread() &&
    message.channel.parent?.type === ChannelType.GuildForum &&
    message.id === message.channel.id
  );
}

function isSupportedTextChannel(message: Message): message is Message<true> & {
  channel: TextChannel;
} {
  return message.channel.type === ChannelType.GuildText;
}

function shouldStartInThread(message: Message, botUserId: string): boolean {
  if (!message.channel.isThread()) {
    return false;
  }
  if (isForumStarterMessage(message)) {
    return true;
  }
  return message.mentions.users.has(botUserId);
}

function stripLeadingBotMention(
  rawContent: string,
  cleanContent: string,
  botUserId: string,
  botMentionNames: readonly string[],
): string {
  const trimmedRaw = rawContent.trimStart();
  if (
    !trimmedRaw.startsWith(`<@${botUserId}>`) &&
    !trimmedRaw.startsWith(`<@!${botUserId}>`)
  ) {
    return normalizeWhitespace(cleanContent);
  }

  const trimmedClean = cleanContent.trimStart();
  const normalizedCandidates = [
    ...new Set(
      botMentionNames
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => `@${value}`),
    ),
  ].sort((left, right) => right.length - left.length);

  for (const candidate of normalizedCandidates) {
    if (!trimmedClean.startsWith(candidate)) {
      continue;
    }

    return normalizeWhitespace(
      trimmedClean.slice(candidate.length).replace(/^[\s:,-]*/i, ""),
    );
  }

  return normalizeWhitespace(trimmedClean.replace(/^@\s*/i, ""));
}

function getBotMentionNames(message: Message): string[] {
  return [
    message.guild?.members.me?.displayName ?? "",
    message.client.user?.displayName ?? "",
    message.client.user?.globalName ?? "",
    message.client.user?.username ?? "",
  ].filter(Boolean);
}

function buildTextThreadName(message: Message, botUserId: string): string {
  const excerpt = stripLeadingBotMention(
    message.content,
    message.cleanContent,
    botUserId,
    getBotMentionNames(message),
  );
  if (excerpt) {
    return excerpt.slice(0, 90);
  }
  return `prof-oak-${message.author.username}-${message.id.slice(-6)}`;
}

async function sendSmallText(
  target: ThreadChannel,
  title: string,
  text: string,
): Promise<void> {
  const normalizedText = rewriteDiscordFileReferences(text);
  for (const chunk of splitDiscordText(
    formatSmallBlock(title, normalizedText),
    1900,
  )) {
    await target.send(chunk);
  }
}

async function sendCompactText(
  target: ThreadChannel,
  text: string,
): Promise<void> {
  const normalizedText = rewriteDiscordFileReferences(text);
  for (const chunk of splitDiscordText(
    formatCompactBlock(normalizedText),
    1900,
  )) {
    await target.send(chunk);
  }
}

async function sendCompactCommand(
  target: ThreadChannel,
  command: string,
): Promise<void> {
  const normalized = normalizeDisplayedCommand(command);
  if (!normalized) {
    return;
  }

  if (normalized.kind === "script") {
    const language = normalized.language === "javascript" ? "js" : "python";
    for (const chunk of splitDiscordCodeText(normalized.code)) {
      const formatted = formatCodeBlock(language, chunk);
      if (formatted) {
        await target.send(formatted);
      }
    }
    return;
  }

  const formatted = formatInlineCode(truncateDisplayedCommand(normalized.text));
  if (formatted) {
    await target.send(`-# ${formatted}`);
  }
}

async function sendFinalAnswer(
  session: SessionContext,
  text: string,
): Promise<void> {
  const normalizedText = rewriteDiscordFileReferences(text);
  const mentionPrefix = session.record.lastInteractorUserId
    ? `<@${session.record.lastInteractorUserId}>\n`
    : "";
  const chunks = splitDiscordText(
    normalizedText,
    DISCORD_MESSAGE_LIMIT - mentionPrefix.length,
  );

  if (chunks.length === 0) {
    if (mentionPrefix) {
      await session.thread.send(mentionPrefix.trim());
    }
    return;
  }

  await session.thread.send(`${mentionPrefix}${chunks[0]}`);
  for (const chunk of chunks.slice(1)) {
    await session.thread.send(chunk);
  }
}

function stripBotMentions(content: string, botUserId: string): string {
  return normalizeWhitespace(
    content
      .replaceAll(`<@${botUserId}>`, "")
      .replaceAll(`<@!${botUserId}>`, ""),
  );
}

function sessionHasActiveStreaming(session: SessionContext): boolean {
  return session.record.streamingActive;
}

function sessionHasPendingRestartContinue(
  session: SessionContext | SessionRecord,
): boolean {
  return "record" in session
    ? session.record.pendingRestartContinue
    : session.pendingRestartContinue;
}

function sessionHasTrackedActiveAgents(
  session: SessionContext | SessionRecord,
): boolean {
  return (
    ("record" in session ? session.record.activeAgents : session.activeAgents)
      .length > 0
  );
}

function sessionHasActiveWork(
  session: SessionContext | SessionRecord,
): boolean {
  return (
    ("record" in session
      ? session.record.streamingActive
      : session.streamingActive) || sessionHasTrackedActiveAgents(session)
  );
}

function sessionNeedsContinueAfterStartup(
  session: SessionContext | SessionRecord,
): boolean {
  const record = "record" in session ? session.record : session;
  if (record.pendingRestartContinue) {
    return true;
  }

  if (!sessionHasActiveWork(record)) {
    return false;
  }

  return record.lastCodexOutputKind !== "final_answer";
}

function buildSyntheticTextInput(text: string): OakUserInput[] {
  return [
    {
      type: "text",
      text,
      text_elements: [],
    },
  ];
}

function upsertTrackedAgent(
  agents: readonly OakTrackedAgentRecord[],
  nextAgent: OakTrackedAgentRecord,
): OakTrackedAgentRecord[] {
  const others = agents.filter(
    (agent) => agent.agentThreadId !== nextAgent.agentThreadId,
  );
  return [...others, nextAgent].sort((left, right) =>
    left.spawnedAt.localeCompare(right.spawnedAt),
  );
}

function getMentionCommandText(
  message: Message,
  botUserId: string,
): string | null {
  if (!message.mentions.users.has(botUserId)) {
    return null;
  }

  return stripBotMentions(message.content, botUserId).toLowerCase();
}

function isInterruptCommandText(value: string): boolean {
  const normalized = normalizeWhitespace(value).toLowerCase();
  return normalized === "stop" || normalized === "cancel";
}

function getInterruptCommandText(
  message: Message,
  botUserId: string,
): string | null {
  const mentionCommand = getMentionCommandText(message, botUserId);
  if (mentionCommand && isInterruptCommandText(mentionCommand)) {
    return mentionCommand;
  }

  if (message.channel.isThread() && isInterruptCommandText(message.content)) {
    return normalizeWhitespace(message.content).toLowerCase();
  }

  return null;
}

function isTransientCodexConnectionError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("codex_ws_closed") ||
    normalized.includes("codex_ws_error") ||
    normalized.includes("codex_not_connected") ||
    normalized.includes("codex_ws_connect_failed") ||
    normalized.includes("codex websocket") ||
    normalized.includes("websocket error")
  );
}

function shouldOfferCodexSwitch(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("usage limit") ||
    normalized.includes("rate limit") ||
    normalized.includes("too many requests") ||
    normalized.includes("quota") ||
    normalized.includes("429") ||
    normalized.includes("authentication") ||
    normalized.includes("unauthorized") ||
    normalized.includes("invalid api key")
  );
}

function shouldSuppressRepeatedSessionError(
  session: SessionContext,
  message: string,
): boolean {
  const normalized = normalizeWhitespace(message);
  if (!normalized) {
    return false;
  }

  const now = Date.now();
  if (
    session.lastReportedErrorText === normalized &&
    now - session.lastReportedErrorAt < 5000
  ) {
    return true;
  }

  session.lastReportedErrorText = normalized;
  session.lastReportedErrorAt = now;
  return false;
}

async function buildCodexSwitchPanelPayload(options: {
  userId: string;
  statusText?: string | null;
  selectedProfile?: string | null;
  refresh?: boolean;
}): Promise<ReturnType<typeof buildCodexSwitchMessage>> {
  const state = await loadCodexSwitchMenuState({
    refresh: options.refresh,
  });

  return buildCodexSwitchMessage({
    userId: options.userId,
    state,
    statusText: options.statusText,
    selectedProfile: options.selectedProfile,
  });
}

async function offerCodexSwitchAfterError(
  session: SessionContext,
  message: string,
): Promise<void> {
  if (
    !shouldOfferCodexSwitch(message) ||
    !session.record.lastInteractorUserId
  ) {
    return;
  }

  await session.thread.send(
    withSafeDiscordContent(
      await buildCodexSwitchPanelPayload({
        userId: session.record.lastInteractorUserId,
        refresh: true,
        statusText:
          "Codex reported an account or limit error. Pick a profile to switch.",
      }),
    ),
  );
}

async function reportSessionError(
  session: SessionContext,
  message: string,
): Promise<void> {
  if (shouldSuppressRepeatedSessionError(session, message)) {
    return;
  }

  await sendSmallText(session.thread, "Error", message);
  await offerCodexSwitchAfterError(session, message);
}

async function persistSession(session: SessionContext): Promise<void> {
  await sessionStore.set(session.record);
}

async function markSessionStreamingState(
  session: SessionContext,
  updates: Partial<
    Pick<
      SessionRecord,
      "activeTurnId" | "streamingActive" | "rolloutReadOffset"
    >
  >,
): Promise<void> {
  session.record = {
    ...session.record,
    ...updates,
    updatedAt: new Date().toISOString(),
  };
  await persistSession(session);
}

async function setSessionTrackedAgent(
  session: SessionContext,
  agent: OakTrackedAgentRecord,
): Promise<void> {
  session.record = {
    ...session.record,
    activeAgents: upsertTrackedAgent(session.record.activeAgents, {
      ...agent,
      updatedAt: new Date().toISOString(),
    }),
    updatedAt: new Date().toISOString(),
  };
  await persistSession(session);
}

async function removeSessionTrackedAgents(
  session: SessionContext,
  agentThreadIds: readonly string[],
): Promise<void> {
  if (agentThreadIds.length === 0) {
    return;
  }

  const nextAgents = session.record.activeAgents.filter(
    (agent) => !agentThreadIds.includes(agent.agentThreadId),
  );
  if (nextAgents.length === session.record.activeAgents.length) {
    return;
  }

  session.record = {
    ...session.record,
    activeAgents: nextAgents,
    updatedAt: new Date().toISOString(),
  };
  await persistSession(session);
}

async function clearSessionTrackedAgents(
  session: SessionContext,
): Promise<void> {
  if (session.record.activeAgents.length === 0) {
    return;
  }

  session.record = {
    ...session.record,
    activeAgents: [],
    updatedAt: new Date().toISOString(),
  };
  await persistSession(session);
}

async function setSessionPendingRestartContinue(
  session: SessionContext,
  pending: boolean,
): Promise<void> {
  session.record = {
    ...session.record,
    pendingRestartContinue: pending,
    pendingRestartContinueAt: pending ? new Date().toISOString() : null,
    activeTurnId: pending ? null : session.record.activeTurnId,
    streamingActive: pending ? false : session.record.streamingActive,
    updatedAt: new Date().toISOString(),
  };
  await persistSession(session);
}

async function setSessionCodexOutputKind(
  session: SessionContext,
  kind:
    | "reasoning"
    | "command_execution"
    | "commentary"
    | "final_answer",
): Promise<void> {
  if (session.record.lastCodexOutputKind === kind) {
    return;
  }

  session.record = {
    ...session.record,
    lastCodexOutputKind: kind,
    updatedAt: new Date().toISOString(),
  };
  await persistSession(session);
}

async function getFileSize(filePath: string | null): Promise<number> {
  if (!filePath) {
    return 0;
  }

  try {
    const metadata = await stat(filePath);
    return metadata.size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }
    throw error;
  }
}

async function readAppendedText(
  filePath: string,
  startOffset: number,
): Promise<{ text: string; endOffset: number }> {
  const metadata = await stat(filePath);
  if (metadata.size <= startOffset) {
    return {
      text: "",
      endOffset: metadata.size,
    };
  }

  const fileHandle = await open(filePath, "r");

  try {
    const length = metadata.size - startOffset;
    const buffer = Buffer.alloc(length);
    await fileHandle.read(buffer, 0, length, startOffset);
    return {
      text: buffer.toString("utf8"),
      endOffset: metadata.size,
    };
  } finally {
    await fileHandle.close();
  }
}

async function downloadToFile(url: string, filePath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(filePath, buffer);
}

async function loadReferencedMessage(
  message: Message,
): Promise<Message | null> {
  if (!message.reference?.messageId) {
    return null;
  }

  try {
    return await message.fetchReference();
  } catch {
    return null;
  }
}

async function buildUserInputs(message: Message): Promise<OakUserInput[]> {
  const messageDir = path.join(
    oakConfig.attachmentsDir,
    message.channelId,
    message.id,
  );
  await mkdir(messageDir, { recursive: true });

  const savedFileAttachmentLines: string[] = [];
  const imageInputs: OakUserInput[] = [];
  const seenImageUrls = new Set<string>();

  for (const attachment of message.attachments.values()) {
    const fileName = sanitizeFileName(attachment.name ?? attachment.id);
    const filePath = path.join(messageDir, fileName);
    await downloadToFile(attachment.url, filePath);

    if (attachment.contentType?.startsWith("image/")) {
      imageInputs.push({
        type: "localImage",
        path: filePath,
      });
      seenImageUrls.add(attachment.url);
      continue;
    }

    const relativePath = path.relative(oakConfig.repoRoot, filePath);
    savedFileAttachmentLines.push(
      `- ${attachment.name ?? attachment.id}: ${relativePath}`,
    );
  }

  const remoteImageUrls = message.embeds
    .flatMap((embed) => [
      embed.image?.url ?? null,
      embed.thumbnail?.url ?? null,
    ])
    .filter((url): url is string => typeof url === "string")
    .filter((url) => !seenImageUrls.has(url));

  for (const imageUrl of remoteImageUrls) {
    imageInputs.push({
      type: "image",
      url: imageUrl,
    });
  }

  const sections: string[] = [];
  const referencedMessage = await loadReferencedMessage(message);
  if (referencedMessage) {
    sections.push("Replied-to message:");
    sections.push(referencedMessage.cleanContent.trim() || "(no text)");
    sections.push("");
    sections.push("User message:");
  }

  const botUserId = message.client.user?.id ?? null;
  const normalizedMessageText = botUserId
    ? stripLeadingBotMention(
        message.content,
        message.cleanContent,
        botUserId,
        getBotMentionNames(message),
      )
    : normalizeWhitespace(message.cleanContent);

  sections.push(normalizedMessageText.trim() || "(no text)");

  if (savedFileAttachmentLines.length > 0) {
    sections.push("");
    sections.push("Attachments saved for Oak:");
    sections.push(...savedFileAttachmentLines);
  }

  return [
    {
      type: "text",
      text: sections.join("\n"),
      text_elements: [],
    },
    ...imageInputs,
  ];
}

function createCodexClient(workspaceRoot = oakConfig.repoRoot): OakCodexClient {
  return createCodexClientForPreferences(
    buildOakThreadPreferences(oakConfig.model, oakConfig.reasoningEffort),
    oakConfig.serviceTier,
    () => {
      // Replaced per-session after construction.
    },
    workspaceRoot,
  );
}

function createCodexClientForPreferences(
  preferences: OakThreadPreferences,
  serviceTier: string | null,
  onEvent: (event: OakCodexEvent) => void,
  workspaceRoot: string,
): OakCodexClient {
  return new OakCodexClient({
    wsUrl: oakConfig.codexWsUrl,
    cwd: workspaceRoot,
    approvalPolicy: oakConfig.approvalPolicy,
    threadSandbox: oakConfig.threadSandbox,
    turnSandboxPolicy: buildOakTurnSandboxPolicy(),
    model: preferences.model,
    reasoningEffort: preferences.reasoningEffort,
    reasoningSummary: oakConfig.reasoningSummary,
    serviceTier,
    turnTimeoutMs: oakConfig.turnTimeoutMs,
    onEvent,
  });
}

function setTyping(session: SessionContext, active: boolean): void {
  if (active) {
    if (session.typingTimer) {
      return;
    }

    void session.thread.sendTyping().catch(() => {});
    session.typingTimer = setInterval(() => {
      void session.thread.sendTyping().catch(() => {});
    }, oakConfig.typingIntervalMs);
    return;
  }

  if (session.typingTimer) {
    clearInterval(session.typingTimer);
    session.typingTimer = null;
  }
}

function cancelSessionReconnect(session: SessionContext): void {
  if (session.reconnectTimer) {
    clearTimeout(session.reconnectTimer);
    session.reconnectTimer = null;
  }
  session.reconnectAttempt = 0;
}

function cancelSessionRestartResume(session: SessionContext): void {
  if (session.restartResumeTimer) {
    clearTimeout(session.restartResumeTimer);
    session.restartResumeTimer = null;
  }
  session.restartResumeAttempt = 0;
}

async function reconnectSession(session: SessionContext): Promise<void> {
  if (session.reconnectInFlight || !sessionHasActiveStreaming(session)) {
    return;
  }

  const attempt = async (): Promise<void> => {
    try {
      session.reconnectAttempt += 1;
      session.ready = false;
      await session.client.close(true);
      attachSessionEventBridge(session);
      await ensureSessionReady(session);
      if (!sessionHasActiveStreaming(session)) {
        session.reconnectAttempt = 0;
        return;
      }

      session.rolloutReadOffset = session.record.rolloutReadOffset;
      session.rolloutLineRemainder = "";
      setTyping(session, true);
      startRolloutPolling(session);
      await pollRolloutFile(session);
      session.reconnectAttempt = 0;
    } finally {
      session.reconnectInFlight = null;
    }
  };

  session.reconnectInFlight = attempt();
  await session.reconnectInFlight;
}

function scheduleSessionReconnect(session: SessionContext): void {
  if (
    session.reconnectTimer ||
    session.reconnectInFlight ||
    !sessionHasActiveStreaming(session)
  ) {
    return;
  }

  const delayMs = Math.min(1000 * 2 ** session.reconnectAttempt, 15000);
  session.reconnectTimer = setTimeout(() => {
    session.reconnectTimer = null;
    void reconnectSession(session).catch((error) => {
      console.error("[oak] Session reconnect failed:", {
        threadId: session.thread.id,
        error,
      });
      scheduleSessionReconnect(session);
    });
  }, delayMs);
}

async function resumeSessionAfterCodexRestart(
  session: SessionContext,
): Promise<void> {
  if (
    session.restartResumeInFlight ||
    !sessionHasPendingRestartContinue(session)
  ) {
    return;
  }

  const attempt = async (): Promise<void> => {
    try {
      session.restartResumeAttempt += 1;
      session.ready = false;
      cancelSessionReconnect(session);
      setTyping(session, false);
      resetCommentaryState(session);
      if (session.rolloutPoller) {
        clearInterval(session.rolloutPoller);
        session.rolloutPoller = null;
      }
      await session.client.close(true);
      attachSessionEventBridge(session);
      await ensureSessionReady(session);

      if (sessionHasActiveStreaming(session)) {
        session.rolloutReadOffset = session.record.rolloutReadOffset;
        session.rolloutLineRemainder = "";
        setTyping(session, true);
        startRolloutPolling(session);
        await pollRolloutFile(session);
        await setSessionPendingRestartContinue(session, false);
        session.restartResumeAttempt = 0;
        return;
      }

      await sendCompactText(
        session.thread,
        "Codex restarted. Resuming the interrupted task with `continue`.",
      );
      await startSessionTurn(
        session,
        buildSyntheticTextInput(OAK_RESTART_CONTINUE_TEXT),
      );
      session.restartResumeAttempt = 0;
    } finally {
      session.restartResumeInFlight = null;
    }
  };

  session.restartResumeInFlight = attempt();
  await session.restartResumeInFlight;
}

function scheduleSessionRestartResume(session: SessionContext): void {
  if (
    session.restartResumeTimer ||
    session.restartResumeInFlight ||
    !sessionHasPendingRestartContinue(session)
  ) {
    return;
  }

  const delayMs = Math.min(1000 * 2 ** session.restartResumeAttempt, 15000);
  session.restartResumeTimer = setTimeout(() => {
    session.restartResumeTimer = null;
    void resumeSessionAfterCodexRestart(session).catch((error) => {
      console.error("[oak] Session restart-resume failed:", {
        threadId: session.thread.id,
        error,
      });
      scheduleSessionRestartResume(session);
    });
  }, delayMs);
}

async function handleSessionEvent(
  session: SessionContext,
  event: OakCodexEvent,
): Promise<void> {
  if ("threadId" in event && !isCodexEventForSession(session, event.threadId)) {
    log("Dropping mismatched Codex event for session", {
      discordThreadId: session.thread.id,
      expectedCodexThreadId:
        session.record.codexThreadId || session.client.currentThreadId || null,
      eventThreadId: event.threadId,
      eventType: event.type,
    });
    return;
  }

  switch (event.type) {
    case "turn_started":
      session.streamedOutputKeys.clear();
      resetCommentaryState(session, event.turnId);
      cancelSessionRestartResume(session);
      await markSessionStreamingState(session, {
        activeTurnId: event.turnId,
        streamingActive: true,
      });
      if (sessionHasPendingRestartContinue(session)) {
        await clearSessionTrackedAgents(session);
        await setSessionPendingRestartContinue(session, false);
      }
      return;
    case "thread_status_changed":
      if (event.status === "idle") {
        setTyping(session, false);
        resetCommentaryState(session);
        cancelSessionReconnect(session);
        cancelSessionRestartResume(session);
        if (sessionHasActiveStreaming(session)) {
          await markSessionStreamingState(session, {
            activeTurnId: null,
            streamingActive: false,
          });
        }
      }
      return;
    case "reasoning":
      await setSessionCodexOutputKind(session, "reasoning");
      {
        const eventKey = buildStreamedOutputKey([
          event.type,
          event.turnId,
          event.text,
        ]);
        if (eventKey && session.streamedOutputKeys.has(eventKey)) {
          return;
        }
        if (eventKey) {
          session.streamedOutputKeys.add(eventKey);
        }
      }
      await sendCompactText(session.thread, event.text);
      return;
    case "command_execution":
      await setSessionCodexOutputKind(session, "command_execution");
      {
        const eventKey = buildStreamedOutputKey([
          event.type,
          event.turnId,
          event.command,
        ]);
        if (eventKey && session.streamedOutputKeys.has(eventKey)) {
          return;
        }
        if (eventKey) {
          session.streamedOutputKeys.add(eventKey);
        }
      }
      await sendCompactCommand(session.thread, event.command);
      return;
    case "assistant_message":
      if (event.phase === "commentary") {
        await setSessionCodexOutputKind(session, "commentary");
        if (session.lastCommentaryTurnId !== event.turnId) {
          resetCommentaryState(session, event.turnId);
        }

        const delta = extractCommentaryDelta(
          session.lastCommentaryText,
          event.text,
        );
        session.lastCommentaryTurnId = event.turnId;
        session.lastCommentaryText = event.text;
        if (!delta) {
          return;
        }

        await sendCompactText(session.thread, delta);
        return;
      }

      {
        const eventKey = buildStreamedOutputKey([
          event.type,
          event.turnId,
          event.phase,
          event.text,
        ]);
        if (eventKey && session.streamedOutputKeys.has(eventKey)) {
          return;
        }
        if (eventKey) {
          session.streamedOutputKeys.add(eventKey);
        }
      }

      resetCommentaryState(session);
      session.record = {
        ...session.record,
        lastAssistantResponse: event.text,
        lastCodexOutputKind: "final_answer",
        updatedAt: new Date().toISOString(),
      };
      await persistSession(session);
      await sendFinalAnswer(session, event.text);
      return;
    case "turn_aborted":
      session.streamedOutputKeys.clear();
      setTyping(session, false);
      resetCommentaryState(session);
      cancelSessionReconnect(session);
      cancelSessionRestartResume(session);
      await markSessionStreamingState(session, {
        activeTurnId: null,
        streamingActive: false,
      });
      if (!sessionHasPendingRestartContinue(session)) {
        await clearSessionTrackedAgents(session);
      }
      return;
    case "turn_completed":
      session.streamedOutputKeys.clear();
      setTyping(session, false);
      resetCommentaryState(session);
      cancelSessionReconnect(session);
      cancelSessionRestartResume(session);
      await markSessionStreamingState(session, {
        activeTurnId: null,
        streamingActive: false,
      });
      await clearSessionTrackedAgents(session);
      if (sessionHasPendingRestartContinue(session)) {
        await setSessionPendingRestartContinue(session, false);
      }
      return;
    case "error":
      setTyping(session, false);
      resetCommentaryState(session);
      if (isTransientCodexConnectionError(event.message)) {
        session.ready = false;
        if (sessionHasPendingRestartContinue(session)) {
          scheduleSessionRestartResume(session);
        } else if (sessionHasActiveStreaming(session)) {
          scheduleSessionReconnect(session);
        }
        return;
      }
      await reportSessionError(session, event.message);
      return;
    case "closed":
      setTyping(session, false);
      resetCommentaryState(session);
      session.ready = false;
      if (sessionHasPendingRestartContinue(session)) {
        scheduleSessionRestartResume(session);
      } else if (sessionHasActiveStreaming(session)) {
        scheduleSessionReconnect(session);
      }
      return;
    default:
      return;
  }
}

function isCodexEventForSession(
  session: SessionContext,
  eventThreadId: string | null | undefined,
): boolean {
  const normalizedEventThreadId = eventThreadId?.trim() ?? "";
  if (!normalizedEventThreadId) {
    return true;
  }

  const knownThreadIds = [
    session.record.codexThreadId,
    session.client.currentThreadId,
  ]
    .map((value) => value?.trim() ?? "")
    .filter(Boolean);

  if (knownThreadIds.length === 0) {
    return true;
  }

  return knownThreadIds.includes(normalizedEventThreadId);
}

async function pollRolloutFile(session: SessionContext): Promise<void> {
  const rolloutPath = session.record.codexRolloutPath;
  if (!rolloutPath) {
    return;
  }

  let appended;
  try {
    appended = await readAppendedText(rolloutPath, session.rolloutReadOffset);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }

  session.rolloutReadOffset = appended.endOffset;
  if (session.record.rolloutReadOffset !== appended.endOffset) {
    await markSessionStreamingState(session, {
      rolloutReadOffset: appended.endOffset,
    });
  }
  if (!appended.text) {
    return;
  }

  const combined = `${session.rolloutLineRemainder}${appended.text}`;
  const lines = combined.split("\n");
  session.rolloutLineRemainder = lines.pop() ?? "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as { type?: unknown }).type !== "string"
    ) {
      continue;
    }

    const entry = parsed as {
      type: string;
      timestamp?: string;
      payload?: Record<string, unknown>;
    };
    const payload = entry.payload;
    if (!payload) {
      continue;
    }

    if (
      entry.type === "event_msg" &&
      payload.type === "agent_message" &&
      typeof payload.message === "string"
    ) {
      const phase =
        payload.phase === "commentary" || payload.phase === "final_answer"
          ? payload.phase
          : "unknown";
      if (phase !== "commentary") {
        continue;
      }
      await handleSessionEvent(session, {
        type: "assistant_message",
        threadId: session.record.codexThreadId,
        turnId: session.client.currentTurnId ?? "unknown",
        text: payload.message,
        phase,
      });
      continue;
    }

    if (
      entry.type === "event_msg" &&
      payload.type === "collab_agent_spawn_end"
    ) {
      const agentThreadId =
        typeof payload.new_thread_id === "string"
          ? payload.new_thread_id.trim()
          : "";
      if (agentThreadId) {
        const spawnedAt =
          typeof entry.timestamp === "string" && entry.timestamp.trim()
            ? entry.timestamp
            : new Date().toISOString();
        await setSessionTrackedAgent(session, {
          agentThreadId,
          nickname:
            typeof payload.new_agent_nickname === "string" &&
            payload.new_agent_nickname.trim()
              ? payload.new_agent_nickname.trim()
              : null,
          role:
            typeof payload.new_agent_role === "string" &&
            payload.new_agent_role.trim()
              ? payload.new_agent_role.trim()
              : null,
          prompt:
            typeof payload.prompt === "string" && payload.prompt.trim()
              ? payload.prompt.trim()
              : null,
          status:
            typeof payload.status === "string" && payload.status.trim()
              ? payload.status.trim()
              : "pending_init",
          spawnedAt,
          updatedAt: spawnedAt,
        });
      }
      continue;
    }

    if (entry.type === "event_msg" && payload.type === "collab_waiting_end") {
      const agentStatuses = Array.isArray(payload.agent_statuses)
        ? payload.agent_statuses
        : [];
      const completedAgentThreadIds = agentStatuses
        .flatMap((entryValue) => {
          if (typeof entryValue !== "object" || entryValue === null) {
            return [];
          }

          const threadId =
            typeof (entryValue as { thread_id?: unknown }).thread_id ===
            "string"
              ? (entryValue as { thread_id: string }).thread_id.trim()
              : "";
          return threadId ? [threadId] : [];
        })
        .filter(Boolean);
      await removeSessionTrackedAgents(session, completedAgentThreadIds);
      continue;
    }

    if (entry.type === "response_item" && payload.type === "reasoning") {
      const reasoningText = extractReasoningTextFromRollout(payload);
      if (reasoningText) {
        await handleSessionEvent(session, {
          type: "reasoning",
          threadId: session.record.codexThreadId,
          turnId: session.client.currentTurnId ?? "unknown",
          text: reasoningText,
        });
      }
      continue;
    }

    if (entry.type === "response_item") {
      const commands = extractExecCommandsFromRolloutPayload(payload);
      for (const command of commands) {
        await handleSessionEvent(session, {
          type: "command_execution",
          threadId: session.record.codexThreadId,
          turnId:
            session.client.currentTurnId ??
            session.record.activeTurnId ??
            "unknown",
          command,
        });
      }
      if (commands.length > 0) {
        continue;
      }
    }

    if (entry.type === "event_msg" && payload.type === "turn_aborted") {
      const reason =
        typeof payload.reason === "string" && payload.reason.trim()
          ? payload.reason
          : "interrupted";
      const turnId =
        typeof payload.turn_id === "string" && payload.turn_id.trim()
          ? payload.turn_id
          : session.client.currentTurnId;
      session.client.markTurnAborted(reason, turnId);
      continue;
    }

    if (entry.type === "event_msg" && payload.type === "task_complete") {
      session.client.markTurnCompleted(session.record.activeTurnId);
    }
  }
}

async function syncThreadMetadata(session: SessionContext): Promise<void> {
  const metadata = await session.client.readThreadMetadata();
  session.record = {
    ...session.record,
    codexThreadId: metadata.threadId,
    codexRolloutPath: metadata.rolloutPath,
    activeTurnId:
      metadata.status === "idle"
        ? null
        : (metadata.activeTurnId ?? session.record.activeTurnId),
    streamingActive:
      metadata.status === "idle"
        ? false
        : session.record.streamingActive ||
          metadata.activeTurnId !== null ||
          metadata.status === "running",
    updatedAt: new Date().toISOString(),
  };
  await persistSession(session);
}

async function ensureRolloutCursor(session: SessionContext): Promise<void> {
  const fileSize = await getFileSize(session.record.codexRolloutPath);
  session.rolloutReadOffset = fileSize;
  session.rolloutLineRemainder = "";
  if (session.record.rolloutReadOffset !== fileSize) {
    await markSessionStreamingState(session, {
      rolloutReadOffset: fileSize,
    });
  }
}

function startRolloutPolling(session: SessionContext): void {
  if (session.rolloutPoller || !session.record.codexRolloutPath) {
    return;
  }

  session.rolloutPoller = setInterval(() => {
    void pollRolloutFile(session).catch((error) => {
      console.error("[oak] Rollout poll failed:", error);
    });

    if (!session.client.isWorking && !sessionHasActiveStreaming(session)) {
      if (session.rolloutPoller) {
        clearInterval(session.rolloutPoller);
        session.rolloutPoller = null;
      }
    }
  }, 500);
}

function getSessionWorkspace(session: SessionContext): OakWorkspaceConfig {
  const scope = resolveOakWorkspaceForLocation({
    guildId: session.thread.guildId ?? session.record.guildId,
    channelId: session.thread.id,
    parentChannelId:
      session.thread.parentId ?? session.record.discordParentChannelId,
  });
  if (!scope) {
    const guildId = session.thread.guildId ?? session.record.guildId;
    throw new Error(
      guildId
        ? `Oak is not configured for guild \`${guildId}\` in this channel.`
        : "Oak sessions require a guild.",
    );
  }

  return scope.workspace;
}

function attachSessionEventBridge(session: SessionContext): void {
  const client = createCodexClientForPreferences(
    getSessionPreferences(session),
    session.record.serviceTier,
    (event) => {
      void handleSessionEvent(session, event).catch((error) => {
        console.error("[oak] Session event handler failed:", {
          threadId: session.thread.id,
          eventType: event.type,
          error,
        });
      });
    },
    getSessionWorkspace(session).root,
  );

  session.client = client;
}

async function ensureSessionReady(session: SessionContext): Promise<void> {
  if (
    session.ready &&
    session.client.currentThreadId === session.record.codexThreadId
  ) {
    return;
  }

  await session.client.ensureConnected();

  if (session.record.codexThreadId) {
    await session.client.resumeThread(session.record.codexThreadId);
  } else {
    const codexThreadId = await session.client.startThread(session.thread.name);
    session.record = {
      ...session.record,
      codexThreadId,
      updatedAt: new Date().toISOString(),
    };
    await persistSession(session);
  }

  await syncThreadMetadata(session);
  if (session.record.streamingActive) {
    session.client.adoptResumedTurn(session.record.activeTurnId);
  }

  session.ready = true;
}

function buildSessionContext(
  thread: ThreadChannel,
  record: SessionRecord,
): SessionContext {
  const session: SessionContext = {
    record,
    thread,
    client: createCodexClient(),
    ready: false,
    needsClientRefresh: false,
    streamedOutputKeys: new Set<string>(),
    lastCommentaryTurnId: null,
    lastCommentaryText: "",
    typingTimer: null,
    rolloutPoller: null,
    reconnectTimer: null,
    reconnectInFlight: null,
    reconnectAttempt: 0,
    restartResumeTimer: null,
    restartResumeInFlight: null,
    restartResumeAttempt: 0,
    rolloutReadOffset: record.rolloutReadOffset,
    rolloutLineRemainder: "",
    lastReportedErrorText: null,
    lastReportedErrorAt: 0,
  };

  attachSessionEventBridge(session);
  return session;
}

async function getOrCreateSession(
  thread: ThreadChannel,
): Promise<SessionContext | null> {
  const existing = sessions.get(thread.id);
  if (existing) {
    existing.thread = thread;
    return existing;
  }

  const record = sessionStore.get(thread.id);
  if (!record) {
    return null;
  }

  if (
    !resolveOakWorkspaceForLocation({
      guildId: thread.guildId ?? record.guildId,
      channelId: thread.id,
      parentChannelId: thread.parentId ?? record.discordParentChannelId,
    })
  ) {
    log("Skipping Oak session outside configured Oak scope", {
      threadId: thread.id,
      guildId: thread.guildId ?? record.guildId,
    });
    return null;
  }

  const session: SessionContext = {
    record,
    thread,
    client: createCodexClient(),
    ready: false,
    needsClientRefresh: false,
    streamedOutputKeys: new Set<string>(),
    lastCommentaryTurnId: null,
    lastCommentaryText: "",
    typingTimer: null,
    rolloutPoller: null,
    reconnectTimer: null,
    reconnectInFlight: null,
    reconnectAttempt: 0,
    restartResumeTimer: null,
    restartResumeInFlight: null,
    restartResumeAttempt: 0,
    rolloutReadOffset: record.rolloutReadOffset,
    rolloutLineRemainder: "",
    lastReportedErrorText: null,
    lastReportedErrorAt: 0,
  };

  attachSessionEventBridge(session);
  sessions.set(thread.id, session);
  return session;
}

function getSessionPreferences(session: SessionContext): OakThreadPreferences {
  return buildOakThreadPreferences(
    session.record.model,
    session.record.reasoningEffort,
  );
}

function formatOakReasoningLabel(value: string): string {
  if (value === "xhigh") {
    return "XHigh";
  }
  return value ? `${value.slice(0, 1).toUpperCase()}${value.slice(1)}` : value;
}

function mapCodexModelOptionsToThreadPreferences(
  models: readonly OakCodexModelOption[],
): OakModelOption[] {
  return models
    .filter((model) => !model.hidden)
    .map((model) => ({
      value: model.value,
      label: model.label,
      description: model.description,
      defaultReasoningEffort: model.defaultReasoningEffort,
      supportedReasoningEfforts: model.supportedReasoningEfforts.map(
        (effort) => ({
          value: effort.reasoningEffort,
          label: formatOakReasoningLabel(effort.reasoningEffort),
          description: effort.description,
        }),
      ),
      isDefault: model.isDefault,
    }));
}

async function getOakModelOptions(
  session: SessionContext,
): Promise<OakModelOption[] | null> {
  if (
    oakModelOptionsCache &&
    oakModelOptionsCache.expiresAt > Date.now() &&
    oakModelOptionsCache.data.length > 0
  ) {
    return oakModelOptionsCache.data;
  }

  try {
    const models = await session.client.listModels();
    const modelOptions = mapCodexModelOptionsToThreadPreferences(models);
    if (modelOptions.length === 0) {
      return oakModelOptionsCache?.data ?? null;
    }

    oakModelOptionsCache = {
      data: modelOptions,
      expiresAt: Date.now() + OAK_MODEL_OPTIONS_CACHE_TTL_MS,
    };
    return modelOptions;
  } catch (error) {
    log("Failed to load Codex model catalog", {
      error: error instanceof Error ? error.message : String(error),
    });
    return oakModelOptionsCache?.data ?? null;
  }
}

async function buildThreadPreferencePanelPayload(
  session: SessionContext,
  userId: string,
  statusText?: string | null,
): Promise<ReturnType<typeof buildThreadPreferenceMessage>> {
  const modelOptions = await getOakModelOptions(session);
  const preferences = buildOakThreadPreferences(
    session.record.model,
    session.record.reasoningEffort,
    modelOptions,
  );

  return buildThreadPreferenceMessage({
    threadId: session.thread.id,
    userId,
    preferences,
    serviceTier: session.record.serviceTier,
    fastModeEnabled: session.record.fastModeEnabled,
    statusText,
    modelOptions,
  });
}

async function refreshSessionClient(session: SessionContext): Promise<void> {
  if (session.client.isWorking || sessionHasActiveStreaming(session)) {
    session.needsClientRefresh = true;
    return;
  }

  cancelSessionReconnect(session);
  cancelSessionRestartResume(session);
  setTyping(session, false);
  resetCommentaryState(session);
  if (session.rolloutPoller) {
    clearInterval(session.rolloutPoller);
    session.rolloutPoller = null;
  }
  await session.client.close(true);
  session.ready = false;
  session.needsClientRefresh = false;
  attachSessionEventBridge(session);
}

async function createFreshSession(
  thread: ThreadChannel,
): Promise<SessionContext> {
  const existing = sessions.get(thread.id);
  if (existing) {
    return existing;
  }

  if (
    !resolveOakWorkspaceForLocation({
      guildId: thread.guildId,
      channelId: thread.id,
      parentChannelId: thread.parentId,
    })
  ) {
    throw new Error(
      thread.guildId
        ? `Oak is not configured for guild \`${thread.guildId}\` in this channel.`
        : "Oak sessions require a guild.",
    );
  }

  const session: SessionContext = {
    ...buildSessionContext(thread, {
      discordThreadId: thread.id,
      discordThreadName: thread.name,
      guildId: thread.guildId,
      discordParentChannelId: thread.parentId,
      lastInteractorUserId: null,
      serviceTier: oakConfig.serviceTier,
      fastModeEnabled: false,
      baseModel: null,
      baseReasoningEffort: null,
      ...buildOakThreadPreferences(oakConfig.model, oakConfig.reasoningEffort),
      codexThreadId: "",
      codexRolloutPath: null,
      activeTurnId: null,
      streamingActive: false,
      activeAgents: [],
      pendingRestartContinue: false,
      pendingRestartContinueAt: null,
      rolloutReadOffset: 0,
      lastAssistantResponse: null,
      lastCodexOutputKind: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  };
  sessions.set(thread.id, session);
  return session;
}

async function createResumedSession(
  thread: ThreadChannel,
  sourceRecord: SessionRecord,
): Promise<SessionContext> {
  const existing = sessions.get(thread.id);
  if (existing) {
    return existing;
  }

  const now = new Date().toISOString();
  const session = buildSessionContext(thread, {
    ...sourceRecord,
    discordThreadId: thread.id,
    discordThreadName: thread.name,
    guildId: thread.guildId,
    discordParentChannelId: thread.parentId,
    updatedAt: now,
    createdAt: now,
  });

  sessions.set(thread.id, session);
  await persistSession(session);
  return session;
}

async function applyResumedRecordToSession(
  session: SessionContext,
  sourceRecord: SessionRecord,
  lastInteractorUserId: string,
): Promise<void> {
  const now = new Date().toISOString();
  session.record = {
    ...sourceRecord,
    discordThreadId: session.thread.id,
    discordThreadName: session.thread.name,
    guildId: session.thread.guildId,
    discordParentChannelId: session.thread.parentId,
    lastInteractorUserId,
    updatedAt: now,
  };
  session.ready = false;
  session.needsClientRefresh = false;
  session.streamedOutputKeys.clear();
  resetCommentaryState(session);
  session.rolloutReadOffset = session.record.rolloutReadOffset;
  session.rolloutLineRemainder = "";
  await session.client.close(true);
  attachSessionEventBridge(session);
  await persistSession(session);
}

async function startSessionTurn(
  session: SessionContext,
  input: OakUserInput[],
): Promise<void> {
  session.streamedOutputKeys.clear();
  resetCommentaryState(session);
  await ensureRolloutCursor(session);
  await markSessionStreamingState(session, {
    activeTurnId: null,
    streamingActive: true,
    rolloutReadOffset: session.rolloutReadOffset,
  });
  setTyping(session, true);
  startRolloutPolling(session);
  void session.client.startTurn(input).catch(async (error) => {
    setTyping(session, false);
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (
      sessionHasPendingRestartContinue(session) &&
      isTransientCodexConnectionError(errorMessage)
    ) {
      scheduleSessionRestartResume(session);
      return;
    }
    if (
      sessionHasActiveStreaming(session) &&
      isTransientCodexConnectionError(errorMessage)
    ) {
      scheduleSessionReconnect(session);
      return;
    }
    await markSessionStreamingState(session, {
      activeTurnId: null,
      streamingActive: false,
    });
    if (sessionHasPendingRestartContinue(session)) {
      await setSessionPendingRestartContinue(session, false);
    }
    await reportSessionError(session, errorMessage);
  });
}

async function dispatchTurnFromMessage(
  session: SessionContext,
  message: Message,
): Promise<void> {
  if (
    session.needsClientRefresh &&
    !session.client.isWorking &&
    !sessionHasActiveStreaming(session)
  ) {
    await refreshSessionClient(session);
  }

  await ensureSessionReady(session);
  session.record = {
    ...session.record,
    discordThreadName: session.thread.name,
    discordParentChannelId: session.thread.parentId,
    lastInteractorUserId: message.author.id,
    updatedAt: new Date().toISOString(),
  };
  await persistSession(session);

  const input = await buildUserInputs(message);

  if (session.client.isWorking) {
    await session.client.steerTurn(input);
    await message.react("👍").catch(() => {});
    return;
  }

  await startSessionTurn(session, input);
}

async function startThreadForTextMessage(
  message: Message,
  botUserId: string,
): Promise<ThreadChannel> {
  const textChannel = message.channel as TextChannel;
  const thread = await message.startThread({
    name: buildTextThreadName(message, botUserId),
    autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
    reason: "Oak Codex session",
  });

  log("Created Discord thread for text-channel session", {
    sourceChannelId: textChannel.id,
    threadId: thread.id,
    messageId: message.id,
  });

  return thread;
}

function buildResumeThreadName(sourceRecord: SessionRecord): string {
  const normalized = normalizeWhitespace(sourceRecord.discordThreadName);
  if (normalized) {
    return normalized.slice(0, 90);
  }
  return `resume-${sourceRecord.codexThreadId.slice(0, 24)}`;
}

async function startThreadForResumeCommand(
  interaction: ChatInputCommandInteraction,
  sourceRecord: SessionRecord,
): Promise<ThreadChannel> {
  if (interaction.channel?.type !== ChannelType.GuildText) {
    throw new Error("`/codex-resume` can only start a new thread from a text channel.");
  }

  return interaction.channel.threads.create({
    name: buildResumeThreadName(sourceRecord),
    autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
    reason: `Oak resume for ${sourceRecord.codexThreadId}`,
  });
}

async function getLastResponseFromDiscordThread(
  thread: ThreadChannel,
): Promise<string | null> {
  const messages = await thread.messages.fetch({ limit: 100 });
  const ordered = [...messages.values()].sort(
    (left, right) => left.createdTimestamp - right.createdTimestamp,
  );

  const responseParts: string[] = [];
  let foundBotMessage = false;
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const message = ordered[index];
    const content = message.content.trim();
    if (!content) {
      continue;
    }

    if (message.author.bot) {
      responseParts.unshift(content);
      foundBotMessage = true;
      continue;
    }

    if (foundBotMessage) {
      break;
    }
  }

  const combined = responseParts.join("\n").trim();
  return combined || null;
}

async function resolveLastResponseForRecord(
  discordClient: Client,
  record: SessionRecord,
): Promise<string | null> {
  if (record.lastAssistantResponse?.trim()) {
    return record.lastAssistantResponse;
  }

  try {
    const channel = await discordClient.channels.fetch(record.discordThreadId);
    if (!channel?.isThread()) {
      return null;
    }
    return await getLastResponseFromDiscordThread(channel);
  } catch {
    return null;
  }
}

async function sendRestoredResponse(
  thread: ThreadChannel,
  text: string,
): Promise<void> {
  const normalizedText = rewriteDiscordFileReferences(text);
  const chunks = splitDiscordText(normalizedText, DISCORD_MESSAGE_LIMIT);
  if (chunks.length === 0) {
    return;
  }

  for (const chunk of chunks) {
    await thread.send(chunk);
  }
}

async function restartCodex(): Promise<void> {
  const sessionsToResume = [...sessions.values()].filter((session) =>
    sessionHasActiveWork(session),
  );

  for (const session of sessionsToResume) {
    await setSessionPendingRestartContinue(session, true);
  }

  if (!supervisorControlsRestart()) {
    throw new Error(
      "Codex restart requires Oak to be started through the supervisor.",
    );
  }

  await requestSupervisorRestart("codex");

  for (const session of sessions.values()) {
    session.ready = false;
    session.needsClientRefresh = false;
    cancelSessionReconnect(session);
    if (sessionHasPendingRestartContinue(session)) {
      scheduleSessionRestartResume(session);
    } else {
      cancelSessionRestartResume(session);
    }
    setTyping(session, false);
    if (session.rolloutPoller) {
      clearInterval(session.rolloutPoller);
      session.rolloutPoller = null;
    }
    await session.client.close(true);
  }
}

async function recoverInterruptedSessionsOnStartup(
  discordClient: Client,
): Promise<void> {
  const candidateRecords = sessionStore
    .list()
    .filter((record) => record.codexThreadId && sessionNeedsContinueAfterStartup(record));

  for (const record of candidateRecords) {
    try {
      const channel = await discordClient.channels.fetch(
        record.discordThreadId,
      );
      if (!channel?.isThread()) {
        log("Skipping Oak startup recovery for non-thread channel", {
          discordThreadId: record.discordThreadId,
        });
        continue;
      }

      const session = await getOrCreateSession(channel);
      if (!session) {
        continue;
      }

      if (!sessionHasPendingRestartContinue(session)) {
        await setSessionPendingRestartContinue(session, true);
      }
      scheduleSessionRestartResume(session);
    } catch (error) {
      console.error("[oak] Failed to recover interrupted session:", {
        discordThreadId: record.discordThreadId,
        error,
      });
    }
  }
}

async function handleRestartCommand(
  message: Message,
  botUserId: string,
): Promise<boolean> {
  const normalized = getMentionCommandText(message, botUserId);
  if (!normalized) {
    return false;
  }

  if (normalized !== "restart bot" && normalized !== "restart codex") {
    return false;
  }

  if (!isOakAdminUserId(message.author.id)) {
    await message.reply("Only the Oak owner can restart services.");
    return true;
  }

  if (normalized === "restart bot") {
    await message.reply("Restarting Oak.");
    if (supervisorControlsRestart()) {
      await requestSupervisorRestart("bot");
    } else {
      setTimeout(() => {
        process.exit(0);
      }, 250).unref();
    }
    return true;
  }

  if (normalized === "restart codex") {
    await message.reply("Restarting Codex app-server.");
    await restartCodex();
    return true;
  }

  return false;
}

function isCodexSwitchCommandMessage(
  message: Message,
  botUserId: string,
): boolean {
  return getMentionCommandText(message, botUserId) === "codex switch";
}

function isModelCommandMessage(message: Message, botUserId: string): boolean {
  return getMentionCommandText(message, botUserId) === "model";
}

async function sendThreadPreferencePanel(
  session: SessionContext,
  userId: string,
  statusText?: string | null,
): Promise<void> {
  await session.thread.send(
    withSafeDiscordContent(
      await buildThreadPreferencePanelPayload(session, userId, statusText),
    ),
  );
}

async function handleModelCommand(
  message: Message,
  botUserId: string,
): Promise<boolean> {
  if (!isModelCommandMessage(message, botUserId)) {
    return false;
  }

  if (isSupportedTextChannel(message)) {
    const thread = await startThreadForTextMessage(message, botUserId);
    const session = await createFreshSession(thread);
    await sendThreadPreferencePanel(
      session,
      message.author.id,
      "Thread created. Pick the model, reasoning level, or fast mode for future turns.",
    );
    return true;
  }

  if (!message.channel.isThread()) {
    return true;
  }

  const session =
    (await getOrCreateSession(message.channel)) ??
    (shouldStartInThread(message, botUserId)
      ? await createFreshSession(message.channel)
      : null);

  if (!session) {
    return true;
  }

  await sendThreadPreferencePanel(
    session,
    message.author.id,
    "Pick the model, reasoning level, or fast mode for future turns.",
  );
  return true;
}

async function handleCodexSwitchCommand(
  message: Message,
  botUserId: string,
): Promise<boolean> {
  if (!isCodexSwitchCommandMessage(message, botUserId)) {
    return false;
  }

  if (!isOakAdminUserId(message.author.id)) {
    await message.reply("Only the Oak owner can switch Codex profiles.");
    return true;
  }

  await message.reply(
    withSafeDiscordContent(
      await buildCodexSwitchPanelPayload({
        userId: message.author.id,
        refresh: true,
      }),
    ),
  );
  return true;
}

function isRateLimitsCommandMessage(
  message: Message,
  botUserId: string,
): boolean {
  const normalized = getMentionCommandText(message, botUserId);
  return normalized === "ratelimits" || normalized === "rate limits";
}

function formatRelativeTimestamp(value: number | null): string {
  if (!Number.isFinite(value) || !value || value <= 0) {
    return "n/a";
  }

  const unixSeconds =
    value >= 1e12 ? Math.floor(value / 1000) : Math.floor(value);
  return `<t:${unixSeconds}:R>`;
}

function formatUsedPercent(value: number | null): string {
  return Number.isFinite(value) ? `${value!.toFixed(1)}%` : "n/a";
}

function buildOakRateLimitContainer(
  summary: Awaited<ReturnType<typeof getOakRateLimitSummary>>,
): MessageReplyOptions {
  const container = new ContainerBuilder().setAccentColor(0x4b8bff);

  if (summary.profiles.length === 0) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "## Codex Rate Limits\nNo Codex profiles were found in `~/.codex-profiles`.",
      ),
    );
    return {
      flags: MessageFlags.IsComponentsV2,
      components: [container.toJSON()],
    };
  }

  const headerLines = ["## Codex Rate Limits"];
  if (summary.bestProfileName) {
    headerLines.push(`Best account: \`${summary.bestProfileName}\``);
  }

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(headerLines.join("\n")),
  );

  for (const [index, profile] of summary.profiles.entries()) {
    container.addSeparatorComponents(new SeparatorBuilder({ divider: true }));

    if (!profile.ok) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `**${profile.profileName}**\nError: ${profile.error ?? "Unknown error"}`,
        ),
      );
      continue;
    }

    const parts = [
      `Daily ${formatUsedPercent(profile.primaryUsedPercent)} ends ${formatRelativeTimestamp(profile.primaryResetsAt)}`,
      `Weekly ${formatUsedPercent(profile.secondaryUsedPercent)} ends ${formatRelativeTimestamp(profile.secondaryResetsAt)}`,
    ];
    if (profile.creditsLine) {
      parts.push(profile.creditsLine);
    }

    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**${index + 1}. ${profile.profileName}**\n${parts.join(" • ")}`,
      ),
    );
  }

  return {
    flags: MessageFlags.IsComponentsV2,
    components: [container.toJSON()],
  };
}

async function handleRateLimitsCommand(
  message: Message,
  botUserId: string,
): Promise<boolean> {
  if (!isRateLimitsCommandMessage(message, botUserId)) {
    return false;
  }

  const summary = await getOakRateLimitSummary({
    cwd: oakConfig.repoRoot,
  });
  await message.reply(buildOakRateLimitContainer(summary));
  return true;
}

async function handleInterruptCommand(
  message: Message,
  botUserId: string,
): Promise<boolean> {
  if (!getInterruptCommandText(message, botUserId)) {
    return false;
  }

  if (!message.channel.isThread()) {
    await message.reply("Stop only works inside an Oak thread.");
    return true;
  }

  const session = await getOrCreateSession(message.channel);
  if (!session) {
    await message.reply("Interrupted.");
    return true;
  }

  if (session.client.isWorking || sessionHasActiveStreaming(session)) {
    try {
      await ensureSessionReady(session);
      await session.client.interruptTurn();
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      if (
        errorMessage.includes("codex_turn_id_unavailable") ||
        errorMessage.includes("codex_turn_not_running") ||
        errorMessage.includes("expected active turn id") ||
        errorMessage.includes("active turn id mismatch")
      ) {
        await message.reply("Oak was no longer running.");
        return true;
      }
      throw error;
    }
  }

  await message.reply("Interrupted.");
  return true;
}

async function handleCodexSwitchInteraction(
  interaction: StringSelectMenuInteraction,
): Promise<boolean> {
  const parsed = parseCodexSwitchCustomId(interaction.customId);
  if (!parsed) {
    return false;
  }

  const scope = resolveOakWorkspaceForLocation({
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    parentChannelId: getChannelParentId(interaction.channel),
  });
  if (!scope) {
    await replyWithSafeText(
      interaction,
      "Oak is not configured for this channel.",
    );
    return true;
  }

  if (!isOakAdminUserId(interaction.user.id)) {
    await replyWithSafeText(
      interaction,
      "Only the Oak owner can switch Codex profiles.",
    );
    return true;
  }

  if (parsed.userId !== interaction.user.id) {
    await replyWithSafeText(
      interaction,
      "This Codex switch menu belongs to another user.",
    );
    return true;
  }

  const selectedProfile = interaction.values[0] ?? "";

  let statusText: string;
  try {
    const result = await switchCodexProfile(selectedProfile);
    const statusLines: string[] = [];
    if (result.previousProfilePath) {
      statusLines.push(
        `Saved the outgoing live auth for \`${result.previousProfile}\` to \`${result.previousProfilePath}\`.`,
      );
    } else if (!result.previousProfile) {
      statusLines.push(
        "No active Codex profile was detected before this switch, so there was no previous profile auth to save.",
      );
    } else if (!result.previousProfileHadLiveAuth) {
      statusLines.push(
        `Active Codex profile was \`${result.previousProfile}\`, but \`~/.codex/auth.json\` was missing so there was no live auth to save back first.`,
      );
    }
    statusLines.push(`Switched Codex profile to \`${selectedProfile}\`.`);
    statusLines.push(
      `\`${result.sourcePath}\` -> \`${result.destinationPath}\``,
    );
    statusText = statusLines.join("\n");
  } catch (error) {
    statusText = error instanceof Error ? error.message : String(error);
  }
  const state = await loadCodexSwitchMenuState();

  await interaction.update(
    withSafeDiscordContent(
      buildCodexSwitchMessage({
        userId: interaction.user.id,
        state,
        statusText,
        selectedProfile,
      }),
    ),
  );
  return true;
}

async function handleThreadPreferenceInteraction(
  interaction: StringSelectMenuInteraction,
): Promise<boolean> {
  const parsed = parseThreadPreferenceCustomId(interaction.customId);
  if (!parsed || parsed.kind === "fast_mode") {
    return false;
  }

  if (!interaction.channel?.isThread()) {
    await replyWithSafeText(
      interaction,
      "This menu only works inside a thread.",
    );
    return true;
  }

  const scope = resolveOakWorkspaceForLocation({
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    parentChannelId: getChannelParentId(interaction.channel),
  });
  if (!scope) {
    await replyWithSafeText(
      interaction,
      "Oak is not configured for this channel.",
    );
    return true;
  }

  if (
    !oakAccessConfigStore.isUserAllowedForWorkspace(
      scope.workspace.key,
      interaction.user.id,
      oakConfig.ownerUserId,
    )
  ) {
    await replyWithSafeText(
      interaction,
      "You are not allowed to use Oak controls.",
    );
    return true;
  }

  let session = await getOrCreateSession(interaction.channel);
  if (!session) {
    session = await createFreshSession(interaction.channel);
  }

  const modelOptions = await getOakModelOptions(session);
  const selectedValue = interaction.values[0] ?? "";
  const fastModeWasEnabled = session.record.fastModeEnabled;
  const nextPreferences =
    parsed.kind === "model"
      ? buildOakThreadPreferences(
          selectedValue,
          session.record.reasoningEffort,
          modelOptions,
        )
      : parsed.kind === "reasoning"
        ? buildOakThreadPreferences(
            session.record.model,
            selectedValue,
            modelOptions,
          )
        : buildOakThreadPreferences(
            session.record.model,
            session.record.reasoningEffort,
            modelOptions,
          );

  const nextServiceTier =
    parsed.kind === "service_tier"
      ? normalizeOakServiceTier(
          selectedValue === "default" ? null : selectedValue,
        )
      : session.record.serviceTier;

  session.record = {
    ...session.record,
    ...nextPreferences,
    serviceTier: nextServiceTier,
    fastModeEnabled:
      parsed.kind === "service_tier" ? session.record.fastModeEnabled : false,
    baseModel: parsed.kind === "service_tier" ? session.record.baseModel : null,
    baseReasoningEffort:
      parsed.kind === "service_tier"
        ? session.record.baseReasoningEffort
        : null,
    updatedAt: new Date().toISOString(),
  };
  await sessionStore.set(session.record);
  session.needsClientRefresh = true;

  let statusText =
    parsed.kind === "model"
      ? "Model saved."
      : parsed.kind === "reasoning"
        ? "Reasoning saved."
        : "Service tier saved.";
  if (parsed.kind !== "service_tier" && fastModeWasEnabled) {
    statusText += " Fast mode was turned off for this custom setting.";
  }
  if (session.client.isWorking || sessionHasActiveStreaming(session)) {
    statusText += " It will apply after the current turn finishes.";
  } else {
    await refreshSessionClient(session);
    statusText += " It will apply on the next turn.";
  }

  await interaction.update(
    withSafeDiscordContent(
      await buildThreadPreferencePanelPayload(
        session,
        interaction.user.id,
        statusText,
      ),
    ),
  );
  return true;
}

async function handleThreadFastModeInteraction(
  interaction: ButtonInteraction,
): Promise<boolean> {
  const parsed = parseThreadPreferenceCustomId(interaction.customId);
  if (!parsed || parsed.kind !== "fast_mode") {
    return false;
  }

  if (!interaction.channel?.isThread()) {
    await replyWithSafeText(
      interaction,
      "This button only works inside a thread.",
    );
    return true;
  }

  const scope = resolveOakWorkspaceForLocation({
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    parentChannelId: getChannelParentId(interaction.channel),
  });
  if (!scope) {
    await replyWithSafeText(
      interaction,
      "Oak is not configured for this channel.",
    );
    return true;
  }

  if (
    !oakAccessConfigStore.isUserAllowedForWorkspace(
      scope.workspace.key,
      interaction.user.id,
      oakConfig.ownerUserId,
    )
  ) {
    await replyWithSafeText(
      interaction,
      "You are not allowed to use Oak controls.",
    );
    return true;
  }

  let session = await getOrCreateSession(interaction.channel);
  if (!session) {
    session = await createFreshSession(interaction.channel);
  }

  const modelOptions = await getOakModelOptions(session);
  const turningFastModeOn = !session.record.fastModeEnabled;
  const nextPreferences = turningFastModeOn
    ? buildOakFastModePreferences(modelOptions)
    : buildOakThreadPreferences(
        session.record.baseModel ?? oakConfig.model,
        session.record.baseReasoningEffort ?? oakConfig.reasoningEffort,
        modelOptions,
      );

  session.record = {
    ...session.record,
    ...nextPreferences,
    fastModeEnabled: turningFastModeOn,
    baseModel: turningFastModeOn ? session.record.model : null,
    baseReasoningEffort: turningFastModeOn
      ? session.record.reasoningEffort
      : null,
    updatedAt: new Date().toISOString(),
  };
  await sessionStore.set(session.record);
  session.needsClientRefresh = true;

  let statusText = turningFastModeOn
    ? `Fast mode enabled. Oak will use \`${nextPreferences.model}\` with \`${nextPreferences.reasoningEffort}\` reasoning.`
    : "Fast mode disabled. Oak restored the previous thread settings.";
  if (session.client.isWorking || sessionHasActiveStreaming(session)) {
    statusText += " It will apply after the current turn finishes.";
  } else {
    await refreshSessionClient(session);
    statusText += " It will apply on the next turn.";
  }

  await interaction.update(
    withSafeDiscordContent(
      await buildThreadPreferencePanelPayload(
        session,
        interaction.user.id,
        statusText,
      ),
    ),
  );
  return true;
}

function formatWorkspaceUserList(userIds: readonly string[]): string {
  if (userIds.length === 0) {
    return "_none_";
  }

  return userIds.map((userId) => `<@${userId}>`).join(", ");
}

function formatWorkspaceSummary(workspace: OakWorkspaceConfig): string {
  const routeCount = oakAccessConfigStore.listRoutes().filter((route) => {
    return route.workspaceKey === workspace.key;
  }).length;

  return [
    `Workspace \`${workspace.key}\``,
    `Root: \`${workspace.root}\``,
    `Allowed users: ${formatWorkspaceUserList(workspace.allowedUserIds)}`,
    `Routes: ${routeCount}`,
  ].join("\n");
}

function formatRouteLabel(channelId: string | null): string {
  return channelId ? `<#${channelId}>` : "`guild default`";
}

function toAutocompleteChoices(
  values: readonly string[],
): ApplicationCommandOptionChoiceData<string>[] {
  return values
    .filter((value) => value.length > 0 && value.length <= 100)
    .slice(0, 25)
    .map((value) => ({
      name: value,
      value,
    }));
}

function getSessionRecordUpdatedAtMs(record: SessionRecord): number {
  const timestamp = Date.parse(record.updatedAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function resolveWorkspaceForSessionRecord(
  record: SessionRecord,
): OakResolvedWorkspaceRoute | null {
  return resolveOakWorkspaceForLocation({
    guildId: record.guildId,
    channelId: record.discordThreadId,
    parentChannelId: record.discordParentChannelId,
  });
}

function listResumableSessionRecords(
  workspaceKey: string,
  query: string,
): SessionRecord[] {
  const normalizedQuery = query.trim().toLowerCase();
  const latestByCodexThreadId = new Map<string, SessionRecord>();

  for (const record of sessionStore.list()) {
    if (!record.codexThreadId.trim()) {
      continue;
    }

    const scope = resolveWorkspaceForSessionRecord(record);
    if (!scope || scope.workspace.key !== workspaceKey) {
      continue;
    }

    if (normalizedQuery) {
      const haystacks = [
        record.discordThreadName,
        record.codexThreadId,
        record.discordThreadId,
      ].map((value) => value.trim().toLowerCase());
      if (!haystacks.some((value) => value.includes(normalizedQuery))) {
        continue;
      }
    }

    const existing = latestByCodexThreadId.get(record.codexThreadId);
    if (
      !existing ||
      getSessionRecordUpdatedAtMs(record) > getSessionRecordUpdatedAtMs(existing)
    ) {
      latestByCodexThreadId.set(record.codexThreadId, record);
    }
  }

  return [...latestByCodexThreadId.values()].sort(
    (left, right) =>
      getSessionRecordUpdatedAtMs(right) - getSessionRecordUpdatedAtMs(left),
  );
}

function buildResumeChoiceName(record: SessionRecord): string {
  const threadName = normalizeWhitespace(record.discordThreadName) || "Untitled";
  const date =
    record.updatedAt.length >= 10
      ? record.updatedAt.slice(0, 10)
      : "unknown-date";
  const label = `${threadName.slice(0, 45)} | ${record.codexThreadId.slice(0, 24)} | ${date}`;
  return label.length <= 100 ? label : label.slice(0, 100);
}

function buildResumeThreadChoices(
  workspaceKey: string,
  query: string,
): ApplicationCommandOptionChoiceData<string>[] {
  return listResumableSessionRecords(workspaceKey, query)
    .slice(0, 10)
    .map((record) => ({
      name: buildResumeChoiceName(record),
      value: record.codexThreadId,
    }));
}

function findResumableSessionRecord(
  workspaceKey: string,
  codexThreadId: string,
): SessionRecord | null {
  const normalizedThreadId = codexThreadId.trim();
  if (!normalizedThreadId) {
    return null;
  }

  return (
    listResumableSessionRecords(workspaceKey, normalizedThreadId).find(
      (record) => record.codexThreadId === normalizedThreadId,
    ) ?? null
  );
}

function buildWorkspaceKeyChoices(
  focusedValue: string,
): ApplicationCommandOptionChoiceData<string>[] {
  const normalizedQuery = focusedValue.trim().toLowerCase();
  const matchingKeys = oakAccessConfigStore
    .listWorkspaces()
    .map((workspace) => workspace.key)
    .filter((key) =>
      normalizedQuery.length === 0
        ? true
        : key.toLowerCase().includes(normalizedQuery),
    )
    .sort((left, right) => left.localeCompare(right));

  const suggestions = new Set<string>(matchingKeys);
  const normalizedFocusedValue = focusedValue.trim().toLowerCase();
  if (
    focusedValue.trim().length > 0 &&
    normalizedFocusedValue.length <= 100 &&
    !suggestions.has(normalizedFocusedValue)
  ) {
    suggestions.add(normalizedFocusedValue);
  }

  return toAutocompleteChoices([...suggestions]);
}

function normalizePathAutocompleteDisplay(
  basePath: string,
  entryName: string,
): string {
  if (basePath === "") {
    return entryName;
  }
  if (basePath === path.sep) {
    return path.posix.join(path.sep, entryName);
  }
  return `${basePath.replace(/[\\/]+$/u, "")}/${entryName}`;
}

async function buildWorkspaceRootChoices(
  focusedValue: string,
): Promise<ApplicationCommandOptionChoiceData<string>[]> {
  const rawValue = focusedValue.trim();
  const endsWithSeparator = /[\\/]$/u.test(rawValue);
  const normalizedInput = rawValue.replaceAll("\\", "/");
  const searchBase =
    normalizedInput.length === 0
      ? "."
      : endsWithSeparator
        ? normalizedInput
        : path.posix.dirname(normalizedInput);
  const fragment =
    normalizedInput.length === 0 || endsWithSeparator
      ? ""
      : path.posix.basename(normalizedInput);
  const resolvedBase = path.resolve(searchBase);
  const displayBase =
    normalizedInput.length === 0
      ? ""
      : endsWithSeparator
        ? normalizedInput.replace(/\/+$/u, "")
        : normalizedInput
            .slice(0, normalizedInput.length - fragment.length)
            .replace(/\/+$/u, "");
  const fragmentLower = fragment.toLowerCase();

  try {
    const entries = await readdir(resolvedBase, { withFileTypes: true });
    const suggestions = await Promise.all(
      entries
        .filter((entry) =>
          fragmentLower.length === 0
            ? true
            : entry.name.toLowerCase().startsWith(fragmentLower),
        )
        .sort((left, right) => left.name.localeCompare(right.name))
        .slice(0, 50)
        .map(async (entry) => {
          const absolutePath = path.join(resolvedBase, entry.name);
          const stats = entry.isSymbolicLink() ? await stat(absolutePath) : null;
          const isDirectory = entry.isDirectory() || stats?.isDirectory() === true;
          if (!isDirectory) {
            return null;
          }

          const suggestion = normalizePathAutocompleteDisplay(
            displayBase,
            entry.name,
          );
          return suggestion.length <= 99 ? `${suggestion}/` : null;
        }),
    );

    return toAutocompleteChoices(
      suggestions.filter((value): value is string => value !== null),
    );
  } catch {
    return [];
  }
}

function isGuildBasedNonThreadChannel(
  interaction: ChatInputCommandInteraction,
  channelId: string | null,
): boolean {
  if (!channelId) {
    return true;
  }

  const channel = interaction.guild?.channels.cache.get(channelId) ?? null;
  if (!channel) {
    return false;
  }

  return channel.isTextBased() && !channel.isThread();
}

async function registerOakCommandsForGuild(guild: Guild): Promise<void> {
  await guild.commands.set(getOakApplicationCommandData());
}

async function syncOakApplicationCommands(client: Client): Promise<void> {
  for (const guild of client.guilds.cache.values()) {
    await registerOakCommandsForGuild(guild);
  }
}

async function handleOakConfigAutocomplete(
  interaction: AutocompleteInteraction,
): Promise<boolean> {
  if (interaction.commandName !== OAK_CONFIG_COMMAND_NAME) {
    return false;
  }

  if (!isOakAdminUserId(interaction.user.id)) {
    await interaction.respond([]);
    return true;
  }

  const group = interaction.options.getSubcommandGroup(false);
  const subcommand = interaction.options.getSubcommand(false);
  const focused = interaction.options.getFocused(true);

  if (!group || !subcommand) {
    await interaction.respond([]);
    return true;
  }

  if (
    focused.name === "root" &&
    group === "workspace" &&
    subcommand === "set"
  ) {
    await interaction.respond(
      await buildWorkspaceRootChoices(String(focused.value ?? "")),
    );
    return true;
  }

  if (focused.name === "workspace" || focused.name === "key") {
    await interaction.respond(
      buildWorkspaceKeyChoices(String(focused.value ?? "")),
    );
    return true;
  }

  await interaction.respond([]);
  return true;
}

async function handleCodexResumeAutocomplete(
  interaction: AutocompleteInteraction,
): Promise<boolean> {
  if (interaction.commandName !== OAK_RESUME_COMMAND_NAME) {
    return false;
  }

  const scope = resolveOakWorkspaceForLocation({
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    parentChannelId: getChannelParentId(interaction.channel),
  });
  if (
    !scope ||
    !oakAccessConfigStore.isUserAllowedForWorkspace(
      scope.workspace.key,
      interaction.user.id,
      oakConfig.ownerUserId,
    )
  ) {
    await interaction.respond([]);
    return true;
  }

  const focused = interaction.options.getFocused(true);
  if (focused.name !== "thread_id") {
    await interaction.respond([]);
    return true;
  }

  await interaction.respond(
    buildResumeThreadChoices(scope.workspace.key, String(focused.value ?? "")),
  );
  return true;
}

async function handleCodexResumeCommand(
  interaction: ChatInputCommandInteraction,
): Promise<boolean> {
  if (interaction.commandName !== OAK_RESUME_COMMAND_NAME) {
    return false;
  }

  const scope = resolveOakWorkspaceForLocation({
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    parentChannelId: getChannelParentId(interaction.channel),
  });
  if (!scope) {
    await replyWithSafeText(
      interaction,
      "Oak is not configured for this channel.",
    );
    return true;
  }

  if (
    !oakAccessConfigStore.isUserAllowedForWorkspace(
      scope.workspace.key,
      interaction.user.id,
      oakConfig.ownerUserId,
    )
  ) {
    await replyWithSafeText(
      interaction,
      "You are not allowed to use Oak controls.",
    );
    return true;
  }

  if (
    interaction.channel?.type !== ChannelType.GuildText &&
    !interaction.channel?.isThread()
  ) {
    await replyWithSafeText(
      interaction,
      "`/codex-resume` only works in a text channel or thread.",
    );
    return true;
  }

  const codexThreadId = interaction.options.getString("thread_id", true).trim();
  const sourceRecord = findResumableSessionRecord(
    scope.workspace.key,
    codexThreadId,
  );
  if (!sourceRecord) {
    await replyWithSafeText(
      interaction,
      "That Codex thread was not found in this workspace.",
    );
    return true;
  }

  const targetThread = interaction.channel?.isThread()
    ? interaction.channel
    : await startThreadForResumeCommand(interaction, sourceRecord);
  const existingSession = await getOrCreateSession(targetThread);
  const existingRecord = sessionStore.get(targetThread.id);
  let session: SessionContext;

  if (
    existingSession &&
    existingSession.record.codexThreadId &&
    existingSession.record.codexThreadId !== sourceRecord.codexThreadId
  ) {
    await replyWithSafeText(
      interaction,
      `This Discord thread is already linked to Codex thread \`${existingSession.record.codexThreadId}\`.`,
    );
    return true;
  }

  if (
    !existingSession &&
    existingRecord?.codexThreadId &&
    existingRecord.codexThreadId !== sourceRecord.codexThreadId
  ) {
    await replyWithSafeText(
      interaction,
      "This Discord thread is already linked to another Codex thread.",
    );
    return true;
  }

  if (existingSession) {
    if (!existingSession.record.codexThreadId) {
      await applyResumedRecordToSession(
        existingSession,
        sourceRecord,
        interaction.user.id,
      );
    }
    session = existingSession;
  } else {
    session = await createResumedSession(targetThread, {
      ...sourceRecord,
      lastInteractorUserId: interaction.user.id,
    });
  }

  await ensureSessionReady(session);
  const lastResponse = await resolveLastResponseForRecord(
    interaction.client,
    sourceRecord,
  );

  await replyWithSafeText(
    interaction,
    interaction.channel?.isThread()
      ? `Resumed Codex thread \`${sourceRecord.codexThreadId}\` in <#${targetThread.id}>.`
      : `Started <#${targetThread.id}> and resumed Codex thread \`${sourceRecord.codexThreadId}\`.`,
  );

  if (lastResponse) {
    await sendRestoredResponse(targetThread, lastResponse);
  } else {
    await targetThread.send(
      "No previous Oak response was available to replay for this thread.",
    );
  }

  return true;
}

async function handleOakConfigCommand(
  interaction: ChatInputCommandInteraction,
): Promise<boolean> {
  if (interaction.commandName !== OAK_CONFIG_COMMAND_NAME) {
    return false;
  }

  if (!isOakAdminUserId(interaction.user.id)) {
    await replyWithSafeText(
      interaction,
      "Only the Oak owner can change workspace configuration.",
    );
    return true;
  }

  const group = interaction.options.getSubcommandGroup(true);
  const subcommand = interaction.options.getSubcommand(true);

  if (group === "workspace" && subcommand === "set") {
    const workspace = await oakAccessConfigStore.upsertWorkspace({
      key: interaction.options.getString("key", true),
      root: interaction.options.getString("root", true),
    });

    await replyWithSafeText(
      interaction,
      `${formatWorkspaceSummary(workspace)}\nStatus: saved.`,
    );
    return true;
  }

  if (group === "workspace" && subcommand === "remove") {
    const key = interaction.options.getString("key", true);
    await oakAccessConfigStore.removeWorkspace(key);
    await replyWithSafeText(interaction, `Removed workspace \`${key}\`.`);
    return true;
  }

  if (group === "workspace" && subcommand === "list") {
    const workspaces = oakAccessConfigStore.listWorkspaces();
    await replyWithSafeText(
      interaction,
      workspaces.length === 0
        ? "No Oak workspaces are configured."
        : workspaces.map(formatWorkspaceSummary).join("\n\n"),
    );
    return true;
  }

  if (group === "route" && subcommand === "set") {
    if (!interaction.guildId) {
      throw new Error("Oak route changes must be run inside a guild.");
    }

    const channel = interaction.options.getChannel("channel");
    const channelId = channel?.id ?? null;
    if (channel && "isThread" in channel && channel.isThread()) {
      throw new Error("Route channels must be parent channels, not threads.");
    }
    if (!isGuildBasedNonThreadChannel(interaction, channelId)) {
      throw new Error("The selected channel is not available in this guild.");
    }

    const route = await oakAccessConfigStore.upsertRoute({
      guildId: interaction.guildId,
      channelId,
      workspaceKey: interaction.options.getString("workspace", true),
    });

    await replyWithSafeText(
      interaction,
      [
        `Saved route for guild \`${route.guildId}\`.`,
        `Target: ${formatRouteLabel(route.channelId)}`,
        `Workspace: \`${route.workspaceKey}\``,
      ].join("\n"),
    );
    return true;
  }

  if (group === "route" && subcommand === "clear") {
    if (!interaction.guildId) {
      throw new Error("Oak route changes must be run inside a guild.");
    }

    const channel = interaction.options.getChannel("channel");
    if (channel && "isThread" in channel && channel.isThread()) {
      throw new Error("Route channels must be parent channels, not threads.");
    }

    await oakAccessConfigStore.clearRoute({
      guildId: interaction.guildId,
      channelId: channel?.id ?? null,
    });

    await replyWithSafeText(
      interaction,
      `Cleared route for ${formatRouteLabel(channel?.id ?? null)}.`,
    );
    return true;
  }

  if (group === "route" && subcommand === "list") {
    if (!interaction.guildId) {
      throw new Error("Oak route changes must be run inside a guild.");
    }

    const routes = oakAccessConfigStore.listRoutes(interaction.guildId);
    await replyWithSafeText(
      interaction,
      routes.length === 0
        ? "No Oak routes are configured for this guild."
        : routes
            .map((route) => {
              return `${formatRouteLabel(route.channelId)} -> \`${route.workspaceKey}\``;
            })
            .join("\n"),
    );
    return true;
  }

  if (group === "access" && subcommand === "grant") {
    const workspace = await oakAccessConfigStore.grantWorkspaceAccess(
      interaction.options.getString("workspace", true),
      interaction.options.getUser("user", true).id,
    );

    await replyWithSafeText(
      interaction,
      `${formatWorkspaceSummary(workspace)}\nStatus: access granted.`,
    );
    return true;
  }

  if (group === "access" && subcommand === "revoke") {
    const workspace = await oakAccessConfigStore.revokeWorkspaceAccess(
      interaction.options.getString("workspace", true),
      interaction.options.getUser("user", true).id,
    );

    await replyWithSafeText(
      interaction,
      `${formatWorkspaceSummary(workspace)}\nStatus: access revoked.`,
    );
    return true;
  }

  if (group === "access" && subcommand === "list") {
    const workspace = oakAccessConfigStore.getWorkspace(
      interaction.options.getString("workspace", true),
    );
    if (!workspace) {
      throw new Error("That workspace does not exist.");
    }

    await replyWithSafeText(interaction, formatWorkspaceSummary(workspace));
    return true;
  }

  return true;
}

async function handleMessage(
  message: Message,
  botUserId: string,
): Promise<void> {
  if (!getAllowedWorkspaceForMessage(message)) {
    return;
  }

  if (
    message.channel.isThread() &&
    message.content.trimStart().startsWith("//")
  ) {
    return;
  }

  if (await handleRestartCommand(message, botUserId)) {
    return;
  }

  if (await handleCodexSwitchCommand(message, botUserId)) {
    return;
  }

  if (await handleRateLimitsCommand(message, botUserId)) {
    return;
  }

  if (await handleModelCommand(message, botUserId)) {
    return;
  }

  if (await handleInterruptCommand(message, botUserId)) {
    return;
  }

  if (isSupportedTextChannel(message)) {
    if (!message.mentions.users.has(botUserId)) {
      return;
    }

    const thread = await startThreadForTextMessage(message, botUserId);
    const session = await createFreshSession(thread);
    await dispatchTurnFromMessage(session, message);
    return;
  }

  if (!message.channel.isThread()) {
    return;
  }

  const existingSession = await getOrCreateSession(message.channel);
  if (existingSession) {
    await dispatchTurnFromMessage(existingSession, message);
    return;
  }

  if (!shouldStartInThread(message, botUserId)) {
    return;
  }

  const session = await createFreshSession(message.channel);
  await dispatchTurnFromMessage(session, message);
}

async function runDryCheck(): Promise<void> {
  if (!oakConfig.codexWsUrl) {
    throw new Error("OAK_CODEX_WS_URL is not configured.");
  }

  await mkdir(oakConfig.runtimeDir, { recursive: true });

  const client = new OakCodexClient({
    wsUrl: oakConfig.codexWsUrl,
    cwd: oakConfig.repoRoot,
    approvalPolicy: oakConfig.approvalPolicy,
    threadSandbox: oakConfig.threadSandbox,
    turnSandboxPolicy: buildOakTurnSandboxPolicy(),
    model: oakConfig.model,
    reasoningEffort: oakConfig.reasoningEffort,
    reasoningSummary: oakConfig.reasoningSummary,
    serviceTier: oakConfig.serviceTier,
    turnTimeoutMs: oakConfig.turnTimeoutMs,
    onEvent: () => {},
  });

  await client.ensureConnected();
  await client.close(true);
  log("Dry run succeeded", { codexWsUrl: oakConfig.codexWsUrl });
}

export async function main(): Promise<void> {
  await mkdir(oakConfig.runtimeDir, { recursive: true });
  await oakAccessConfigStore.load();
  await sessionStore.load();

  if (oakConfig.dryRun) {
    await runDryCheck();
    return;
  }

  if (!oakConfig.discordToken) {
    throw new Error("OAK_DISCORD_TOKEN is required.");
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.once(Events.ClientReady, (readyClient) => {
    log("Discord client ready", {
      user: readyClient.user.tag,
      codexWsUrl: oakConfig.codexWsUrl,
    });
    if (!oakConfig.ownerUserId) {
      log("Oak owner ID is not configured; admin commands are disabled.");
    }

    void syncOakApplicationCommands(readyClient).catch((error) => {
      console.error("[oak] Command sync failed:", error);
    });

    void syncActiveCodexProfile().catch((error) => {
      console.error("[oak] Active Codex profile sync failed:", error);
    });

    void recoverInterruptedSessionsOnStartup(readyClient).catch((error) => {
      console.error("[oak] Interrupted session recovery failed:", error);
    });
  });

  client.on(Events.GuildCreate, (guild) => {
    void registerOakCommandsForGuild(guild).catch((error) => {
      console.error("[oak] Guild command sync failed:", {
        guildId: guild.id,
        error,
      });
    });
  });

  client.on(Events.MessageCreate, (message) => {
    void handleMessage(message, client.user?.id ?? "").catch((error) => {
      console.error("[oak] Message handler failed:", error);
      if (message.channel.isThread()) {
        void sendSmallText(
          message.channel,
          "Error",
          error instanceof Error ? error.message : String(error),
        ).catch(() => {});
      }
    });
  });

  client.on(Events.InteractionCreate, (interaction) => {
    if (interaction.isAutocomplete()) {
      void (async () => {
        if (await handleOakConfigAutocomplete(interaction)) {
          return;
        }

        await handleCodexResumeAutocomplete(interaction);
      })().catch((error) => {
        console.error("[oak] Autocomplete handler failed:", error);
        void interaction.respond([]).catch(() => {});
      });
      return;
    }

    if (interaction.isChatInputCommand()) {
      void (async () => {
        if (await handleOakConfigCommand(interaction)) {
          return;
        }

        await handleCodexResumeCommand(interaction);
      })().catch((error) => {
        console.error("[oak] Command handler failed:", error);
        if (!interaction.replied && !interaction.deferred) {
          void replyWithSafeText(
            interaction,
            error instanceof Error ? error.message : String(error),
          ).catch(() => {});
        }
      });
      return;
    }

    if (interaction.isButton()) {
      void handleThreadFastModeInteraction(interaction).catch((error) => {
        console.error("[oak] Button interaction handler failed:", error);
        if (
          interaction.isRepliable() &&
          !interaction.replied &&
          !interaction.deferred
        ) {
          void replyWithSafeText(
            interaction,
            error instanceof Error ? error.message : String(error),
          ).catch(() => {});
        }
      });
      return;
    }

    if (!interaction.isStringSelectMenu()) {
      return;
    }

    void (async () => {
      if (await handleCodexSwitchInteraction(interaction)) {
        return;
      }

      await handleThreadPreferenceInteraction(interaction);
    })().catch((error) => {
      console.error("[oak] Interaction handler failed:", error);
      if (
        interaction.isRepliable() &&
        !interaction.replied &&
        !interaction.deferred
      ) {
        void replyWithSafeText(
          interaction,
          error instanceof Error ? error.message : String(error),
        ).catch(() => {});
      }
    });
  });

  await client.login(oakConfig.discordToken);
}

main().catch((error) => {
  console.error("[oak] Fatal error:", error);
  process.exitCode = 1;
});
