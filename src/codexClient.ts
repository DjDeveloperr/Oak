import { setTimeout as delay } from "node:timers/promises";

export interface OakUserTextInput {
  type: "text";
  text: string;
  text_elements: [];
}

export interface OakUserImageInput {
  type: "image";
  url: string;
}

export interface OakUserLocalImageInput {
  type: "localImage";
  path: string;
}

export type OakUserInput =
  | OakUserTextInput
  | OakUserImageInput
  | OakUserLocalImageInput;

export type OakCodexEvent =
  | { type: "thread_started"; threadId: string }
  | { type: "thread_status_changed"; threadId: string; status: string }
  | { type: "turn_started"; threadId: string; turnId: string }
  | { type: "turn_completed"; threadId: string; turnId: string | null }
  | {
      type: "turn_aborted";
      threadId: string;
      turnId: string | null;
      reason: string;
    }
  | { type: "reasoning"; threadId: string; turnId: string; text: string }
  | {
      type: "command_execution";
      threadId: string;
      turnId: string;
      command: string;
    }
  | {
      type: "assistant_message";
      threadId: string;
      turnId: string;
      text: string;
      phase: "commentary" | "final_answer" | "unknown";
    }
  | { type: "error"; message: string }
  | { type: "closed"; message: string | null };

export interface OakCodexReasoningEffortOption {
  reasoningEffort: string;
  description: string;
}

export interface OakCodexModelOption {
  value: string;
  label: string;
  description: string;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: OakCodexReasoningEffortOption[];
  supportsPersonality: boolean;
  isDefault: boolean;
  hidden: boolean;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

interface TurnWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  promise: Promise<void>;
}

interface OakCodexClientOptions {
  wsUrl: string;
  cwd: string;
  approvalPolicy: "never";
  threadSandbox: "danger-full-access";
  turnSandboxPolicy: {
    type: "dangerFullAccess";
  };
  model: string | null;
  reasoningEffort: string | null;
  reasoningSummary: string | null;
  serviceTier: string | null;
  turnTimeoutMs: number;
  onEvent: (event: OakCodexEvent) => void;
}

export interface OakThreadMetadata {
  threadId: string;
  rolloutPath: string | null;
  name: string | null;
  status: string | null;
  activeTurnId: string | null;
}

const OAK_CODEX_CLIENT_NAME = "oak-codex-discord-bot";
const OAK_CODEX_CLIENT_VERSION = "0.1.0";
const OAK_CODEX_SERVICE_NAME = "oak-discord-bot";
const OAK_CODEX_OPT_OUT_NOTIFICATION_METHODS = [
  "thread/archived",
  "thread/unarchived",
  "thread/closed",
  "skills/changed",
  "thread/name/updated",
  "thread/tokenUsage/updated",
  "hook/started",
  "hook/completed",
  "turn/diff/updated",
  "turn/plan/updated",
  "item/autoApprovalReview/started",
  "item/autoApprovalReview/completed",
  "item/plan/delta",
  "command/exec/outputDelta",
  "item/commandExecution/outputDelta",
  "item/commandExecution/terminalInteraction",
  "item/fileChange/outputDelta",
  "serverRequest/resolved",
  "item/mcpToolCall/progress",
  "mcpServer/oauthLogin/completed",
  "mcpServer/startupStatus/updated",
  "account/updated",
  "account/rateLimits/updated",
  "app/list/updated",
  "fs/changed",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/textDelta",
  "thread/compacted",
  "model/rerouted",
  "deprecationNotice",
  "configWarning",
  "fuzzyFileSearch/sessionUpdated",
  "fuzzyFileSearch/sessionCompleted",
  "thread/realtime/started",
  "thread/realtime/itemAdded",
  "thread/realtime/transcriptUpdated",
  "thread/realtime/outputAudio/delta",
  "thread/realtime/error",
  "thread/realtime/closed",
  "windows/worldWritableWarning",
  "windowsSandbox/setupCompleted",
  "account/login/completed",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function findFirstString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findFirstString(entry);
      if (found) {
        return found;
      }
    }
    return null;
  }
  if (isRecord(value)) {
    for (const nested of Object.values(value)) {
      const found = findFirstString(nested);
      if (found) {
        return found;
      }
    }
  }
  return null;
}

function extractThreadId(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  if (asString(value.threadId)) {
    return asString(value.threadId);
  }
  if (isRecord(value.thread)) {
    return asString(value.thread.id) ?? asString(value.thread.threadId);
  }
  if (isRecord(value.turn)) {
    return extractThreadId(value.turn);
  }
  return null;
}

function extractTurnId(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  if (asString(value.turnId)) {
    return asString(value.turnId);
  }
  if (isRecord(value.turn)) {
    return asString(value.turn.id) ?? asString(value.turn.turnId);
  }
  return null;
}

function extractTurnStatus(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }

  if (asString(value.status)) {
    return asString(value.status);
  }

  if (isRecord(value.turn)) {
    return extractTurnStatus(value.turn);
  }

  return null;
}

function extractTurnErrorMessage(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }

  if (isRecord(value.error)) {
    return asString(value.error.message) ?? findFirstString(value.error);
  }

  if (isRecord(value.turn)) {
    return extractTurnErrorMessage(value.turn);
  }

  return null;
}

function extractModelListPage(value: unknown): {
  data: OakCodexModelOption[];
  nextCursor: string | null;
} {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    return { data: [], nextCursor: null };
  }

  const data = value.data.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }

    const model = asString(entry.model);
    const label = asString(entry.displayName) ?? model;
    const description = asString(entry.description) ?? "";
    const defaultReasoningEffort = asString(entry.defaultReasoningEffort);
    if (!model || !label || !defaultReasoningEffort) {
      return [];
    }

    const supportedReasoningEfforts = Array.isArray(
      entry.supportedReasoningEfforts,
    )
      ? entry.supportedReasoningEfforts.flatMap((option) => {
          if (!isRecord(option)) {
            return [];
          }

          const reasoningEffort = asString(option.reasoningEffort);
          if (!reasoningEffort) {
            return [];
          }

          return [
            {
              reasoningEffort,
              description: asString(option.description) ?? "",
            } satisfies OakCodexReasoningEffortOption,
          ];
        })
      : [];

    return [
      {
        value: model,
        label,
        description,
        defaultReasoningEffort,
        supportedReasoningEfforts,
        supportsPersonality: asBoolean(entry.supportsPersonality) ?? false,
        isDefault: asBoolean(entry.isDefault) ?? false,
        hidden: asBoolean(entry.hidden) ?? false,
      } satisfies OakCodexModelOption,
    ];
  });

  return {
    data,
    nextCursor: asString(value.nextCursor),
  };
}

function extractReasoningSummary(item: Record<string, unknown>): string | null {
  if (!Array.isArray(item.summary)) {
    return null;
  }

  const text = item.summary
    .flatMap((entry) => {
      if (!isRecord(entry) || entry.type !== "summary_text") {
        return [];
      }
      return typeof entry.text === "string" ? [entry.text.trim()] : [];
    })
    .filter(Boolean)
    .join("\n")
    .trim();

  return text || null;
}

function extractAssistantMessage(item: Record<string, unknown>): {
  text: string;
  phase: "commentary" | "final_answer" | "unknown";
} | null {
  if (item.type !== "message" || item.role !== "assistant") {
    return null;
  }
  if (!Array.isArray(item.content)) {
    return null;
  }

  const text = item.content
    .flatMap((entry) => {
      if (!isRecord(entry) || entry.type !== "output_text") {
        return [];
      }
      return typeof entry.text === "string" ? [entry.text] : [];
    })
    .join("")
    .trim();

  if (!text) {
    return null;
  }

  const phase =
    item.phase === "commentary" || item.phase === "final_answer"
      ? item.phase
      : "unknown";

  return { text, phase };
}

function extractThreadStatus(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }

  if (isRecord(value.status)) {
    return asString(value.status.type) ?? asString(value.status.status);
  }

  if (isRecord(value.thread)) {
    return extractThreadStatus(value.thread);
  }

  return null;
}

function isEmptyRolloutThreadReadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("codex_request_error: thread/read:") &&
    message.includes("failed to load rollout") &&
    message.includes("is empty")
  );
}

function isActiveTurnMismatchError(message: string): boolean {
  return (
    message.includes("expected active turn id") ||
    message.includes("active turn id mismatch")
  );
}

function extractMismatchedTurnId(
  message: string,
  attemptedTurnId: string,
): string | null {
  const ids = [...message.matchAll(/`([^`]+)`/g)]
    .map((match) => match[1]?.trim() ?? "")
    .filter(Boolean);

  if (ids.length < 2) {
    return null;
  }

  return ids.find((turnId) => turnId !== attemptedTurnId) ?? null;
}

export class OakCodexClient {
  private ws: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private nextId = 1;
  private initialized = false;
  private pendingRequests = new Map<number, PendingRequest>();
  private currentTurn: TurnWaiter | null = null;
  private threadId: string | null = null;
  private activeTurnId: string | null = null;
  private readonly agentMessages = new Map<
    string,
    {
      threadId: string;
      turnId: string;
      phase: "commentary" | "final_answer" | "unknown";
      text: string;
    }
  >();
  private resumedTurnActive = false;
  private currentTurnFinished = false;
  private silentClose = false;

  constructor(private readonly options: OakCodexClientOptions) {}

  get isWorking(): boolean {
    return this.currentTurn !== null || this.resumedTurnActive;
  }

  get currentTurnId(): string | null {
    return this.activeTurnId;
  }

  get currentThreadId(): string | null {
    return this.threadId;
  }

  adoptResumedTurn(turnId: string | null): void {
    this.resumedTurnActive = true;
    this.currentTurnFinished = false;
    this.activeTurnId = turnId;
  }

  async ensureConnected(): Promise<void> {
    if (
      this.ws &&
      this.ws.readyState === WebSocket.OPEN &&
      this.initialized &&
      !this.connectPromise
    ) {
      return;
    }

    if (this.connectPromise) {
      await this.connectPromise;
      return;
    }

    this.connectPromise = this.connectInternal();

    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  async startThread(name: string): Promise<string> {
    await this.ensureConnected();

    if (this.threadId) {
      return this.threadId;
    }

    const result = await this.request(
      "thread/start",
      {
        approvalPolicy: this.options.approvalPolicy,
        sandbox: this.options.threadSandbox,
        cwd: this.options.cwd,
        model: this.options.model,
        serviceTier: this.options.serviceTier,
        serviceName: OAK_CODEX_SERVICE_NAME,
        experimentalRawEvents: false,
        persistExtendedHistory: true,
      },
      15000,
    );

    const threadId =
      extractThreadId(result) ?? (await this.waitForThreadId(2000));
    if (!threadId) {
      throw new Error(
        "codex_protocol_error: thread/start did not return a thread id",
      );
    }

    this.threadId = threadId;

    if (name.trim()) {
      await this.request(
        "thread/name/set",
        {
          threadId,
          name,
        },
        10000,
      ).catch(() => {
        // Best effort only.
      });
    }

    return threadId;
  }

  async resumeThread(threadId: string): Promise<void> {
    await this.ensureConnected();
    this.threadId = threadId;

    try {
      await this.request(
        "thread/resume",
        {
          threadId,
          cwd: this.options.cwd,
          approvalPolicy: this.options.approvalPolicy,
          sandbox: this.options.threadSandbox,
          model: this.options.model,
          serviceTier: this.options.serviceTier,
          persistExtendedHistory: true,
        },
        15000,
      );
    } catch (error) {
      this.threadId = null;
      this.activeTurnId = null;
      throw error;
    }
  }

  async archiveThread(threadId?: string | null): Promise<void> {
    await this.ensureConnected();
    const targetThreadId = threadId ?? this.threadId;
    if (!targetThreadId) {
      throw new Error("codex_thread_not_started");
    }

    await this.request(
      "thread/archive",
      {
        threadId: targetThreadId,
      },
      15000,
    );
  }

  async readThreadMetadata(): Promise<OakThreadMetadata> {
    if (!this.threadId) {
      throw new Error("codex_thread_not_started");
    }

    let lastError: unknown;
    let result: unknown;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        result = await this.request(
          "thread/read",
          {
            threadId: this.threadId,
          },
          15000,
        );
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (!isEmptyRolloutThreadReadError(error) || attempt === 4) {
          throw error;
        }
        await delay(200 * (attempt + 1));
      }
    }

    if (lastError) {
      throw lastError;
    }

    const thread =
      isRecord(result) && isRecord(result.thread) ? result.thread : null;
    if (!thread) {
      throw new Error(
        "codex_protocol_error: thread/read did not return thread metadata",
      );
    }

    return {
      threadId: asString(thread.id) ?? this.threadId,
      rolloutPath: asString(thread.path),
      name: asString(thread.name),
      status: extractThreadStatus(result) ?? extractThreadStatus(thread),
      activeTurnId: extractTurnId(result) ?? extractTurnId(thread),
    };
  }

  async listModels(): Promise<OakCodexModelOption[]> {
    await this.ensureConnected();

    const models: OakCodexModelOption[] = [];
    let cursor: string | null = null;

    do {
      const result = await this.request(
        "model/list",
        {
          limit: 100,
          ...(cursor ? { cursor } : {}),
        },
        15000,
      );

      const page = extractModelListPage(result);
      models.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor);

    return models;
  }

  async startTurn(input: OakUserInput[]): Promise<void> {
    if (!this.threadId) {
      throw new Error("codex_thread_not_started");
    }
    if (this.currentTurn) {
      throw new Error("codex_turn_already_running");
    }

    this.currentTurnFinished = false;
    this.currentTurn = this.createTurnWaiter();

    try {
      const result = await this.request(
        "turn/start",
        {
          threadId: this.threadId,
          input,
          cwd: this.options.cwd,
          approvalPolicy: this.options.approvalPolicy,
          sandboxPolicy: this.options.turnSandboxPolicy,
          model: this.options.model,
          effort: this.options.reasoningEffort,
          summary: this.options.reasoningSummary,
          serviceTier: this.options.serviceTier,
        },
        15000,
      );

      const turnId = extractTurnId(result) ?? (await this.waitForTurnId(2000));
      if (turnId) {
        this.activeTurnId = turnId;
        this.options.onEvent({
          type: "turn_started",
          threadId: this.threadId ?? "",
          turnId,
        });
      }

      await this.currentTurn.promise;
    } finally {
      if (this.currentTurn) {
        clearTimeout(this.currentTurn.timeout);
        this.currentTurn = null;
      }
      this.resumedTurnActive = false;
      this.currentTurnFinished = false;
      this.activeTurnId = null;
    }
  }

  async steerTurn(input: OakUserInput[]): Promise<void> {
    if (!this.threadId || (!this.currentTurn && !this.resumedTurnActive)) {
      throw new Error("codex_turn_not_running");
    }

    if (this.resumedTurnActive && !this.currentTurn) {
      await this.refreshTurnStateFromThread();
    }

    const turnId = await this.waitForTurnId(5000);
    if (!turnId) {
      throw new Error("codex_turn_id_unavailable");
    }

    try {
      await this.request(
        "turn/steer",
        {
          threadId: this.threadId,
          input,
          expectedTurnId: turnId,
        },
        15000,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isActiveTurnMismatchError(message)) {
        throw error;
      }

      const recoveredTurnId =
        extractMismatchedTurnId(message, turnId) ??
        (await this.refreshTurnStateFromThread());
      if (!recoveredTurnId || recoveredTurnId === turnId) {
        throw error;
      }

      this.activeTurnId = recoveredTurnId;
      await this.request(
        "turn/steer",
        {
          threadId: this.threadId,
          input,
          expectedTurnId: recoveredTurnId,
        },
        15000,
      );
    }
  }

  async interruptTurn(): Promise<string> {
    if (!this.threadId || (!this.currentTurn && !this.resumedTurnActive)) {
      throw new Error("codex_turn_not_running");
    }

    if (this.resumedTurnActive && !this.currentTurn) {
      await this.refreshTurnStateFromThread();
    }

    let turnId = this.activeTurnId ?? (await this.waitForTurnId(2000));
    if (!turnId) {
      turnId = await this.refreshTurnStateFromThread();
    }
    if (!turnId) {
      throw new Error("codex_turn_id_unavailable");
    }

    try {
      await this.request(
        "turn/interrupt",
        {
          threadId: this.threadId,
          turnId,
        },
        15000,
      );
      return turnId;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isActiveTurnMismatchError(message)) {
        throw error;
      }

      const recoveredTurnId =
        extractMismatchedTurnId(message, turnId) ??
        (await this.refreshTurnStateFromThread());
      if (!recoveredTurnId || recoveredTurnId === turnId) {
        throw error;
      }

      this.activeTurnId = recoveredTurnId;
      await this.request(
        "turn/interrupt",
        {
          threadId: this.threadId,
          turnId: recoveredTurnId,
        },
        15000,
      );
      return recoveredTurnId;
    }
  }

  markTurnAborted(reason: string, turnId?: string | null): void {
    this.finishCurrentTurn(
      turnId ?? this.activeTurnId,
      reason || "interrupted",
      true,
    );
  }

  markTurnCompleted(turnId?: string | null): void {
    this.finishCurrentTurn(turnId ?? this.activeTurnId, null, false);
  }

  async close(silent = false): Promise<void> {
    this.silentClose = silent;
    this.failAll(new Error("codex_client_closed"), true);

    if (!this.ws) {
      return;
    }

    const ws = this.ws;
    this.ws = null;
    this.initialized = false;

    if (
      ws.readyState === WebSocket.CLOSING ||
      ws.readyState === WebSocket.CLOSED
    ) {
      return;
    }

    await new Promise<void>((resolve) => {
      const cleanup = (): void => {
        ws.removeEventListener("close", cleanup);
        resolve();
      };

      ws.addEventListener("close", cleanup, { once: true });
      ws.close();

      setTimeout(() => {
        cleanup();
      }, 1000).unref();
    });
  }

  private async connectInternal(): Promise<void> {
    this.initialized = false;
    this.silentClose = false;

    const ws = new WebSocket(this.options.wsUrl);
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      const onOpen = (): void => {
        cleanup();
        resolve();
      };
      const onError = (event: Event): void => {
        cleanup();
        reject(
          new Error(
            `codex_ws_connect_failed: ${(event as ErrorEvent).message || "websocket connection failed"}`,
          ),
        );
      };
      const onClose = (): void => {
        cleanup();
        reject(
          new Error("codex_ws_connect_failed: websocket closed during connect"),
        );
      };
      const cleanup = (): void => {
        ws.removeEventListener("open", onOpen);
        ws.removeEventListener("error", onError);
        ws.removeEventListener("close", onClose);
      };

      ws.addEventListener("open", onOpen, { once: true });
      ws.addEventListener("error", onError, { once: true });
      ws.addEventListener("close", onClose, { once: true });
    });

    ws.addEventListener("message", (event) => {
      this.handleMessage(event).catch((error) => {
        this.failAll(
          error instanceof Error ? error : new Error(String(error)),
          false,
        );
      });
    });

    ws.addEventListener("close", () => {
      const message = this.silentClose
        ? null
        : "Codex websocket connection closed.";
      this.failAll(new Error("codex_ws_closed"), true);
      this.options.onEvent({ type: "closed", message });
    });

    ws.addEventListener("error", (event) => {
      if (this.silentClose) {
        return;
      }
      const rawMessage = (event as ErrorEvent).message?.trim();
      const message = rawMessage
        ? `codex_ws_error: ${rawMessage}`
        : "codex_ws_error: websocket error";
      this.options.onEvent({ type: "error", message });
    });

    await this.request(
      "initialize",
      {
        clientInfo: {
          name: OAK_CODEX_CLIENT_NAME,
          version: OAK_CODEX_CLIENT_VERSION,
        },
        capabilities: {
          experimentalApi: true,
          optOutNotificationMethods: [
            ...OAK_CODEX_OPT_OUT_NOTIFICATION_METHODS,
          ],
        },
      },
      15000,
    );

    this.notify("initialized");
    this.initialized = true;
  }

  private createTurnWaiter(): TurnWaiter {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((innerResolve, innerReject) => {
      resolve = innerResolve;
      reject = innerReject;
    });

    const timeout = setTimeout(() => {
      reject(
        new Error(
          `codex_turn_timeout: exceeded ${this.options.turnTimeoutMs}ms`,
        ),
      );
    }, this.options.turnTimeoutMs);

    return { resolve, reject, timeout, promise };
  }

  private async handleMessage(event: MessageEvent): Promise<void> {
    const line = await this.readMessageData(event.data);
    const message = JSON.parse(line) as unknown;

    if (isRecord(message) && "method" in message && "id" in message) {
      await this.handleServerRequest(message);
      return;
    }

    if (isRecord(message) && "method" in message) {
      this.handleNotification(message);
      return;
    }

    if (isRecord(message) && "id" in message) {
      this.handleResponse(message);
      return;
    }

    throw new Error("codex_protocol_error: unrecognized JSON-RPC message");
  }

  private async readMessageData(data: MessageEvent["data"]): Promise<string> {
    if (typeof data === "string") {
      return data;
    }
    if (data instanceof ArrayBuffer) {
      return Buffer.from(data).toString("utf8");
    }
    if (ArrayBuffer.isView(data)) {
      return Buffer.from(
        data.buffer,
        data.byteOffset,
        data.byteLength,
      ).toString("utf8");
    }
    if (data instanceof Blob) {
      return await data.text();
    }

    throw new Error("codex_protocol_error: unsupported websocket frame type");
  }

  private handleResponse(message: Record<string, unknown>): void {
    const requestId = typeof message.id === "number" ? message.id : null;
    if (requestId == null) {
      return;
    }

    const pending = this.pendingRequests.get(requestId);
    if (!pending) {
      return;
    }

    this.pendingRequests.delete(requestId);
    clearTimeout(pending.timeout);

    if (isRecord(message.error)) {
      pending.reject(
        new Error(
          `codex_request_error: ${pending.method}: ${
            asString(message.error.message) ?? JSON.stringify(message.error)
          }`,
        ),
      );
      return;
    }

    pending.resolve(message.result);
  }

  private handleNotification(message: Record<string, unknown>): void {
    const method = asString(message.method);
    const params = isRecord(message.params) ? message.params : {};

    if (!method) {
      return;
    }

    if (method === "thread/started") {
      const threadId = extractThreadId(params);
      if (threadId) {
        this.threadId = threadId;
        this.options.onEvent({ type: "thread_started", threadId });
      }
      return;
    }

    if (method === "thread/status/changed") {
      const threadId = this.resolveNotificationThreadId(params);
      if (!threadId) {
        return;
      }
      const status =
        isRecord(params.status) && typeof params.status.type === "string"
          ? params.status.type
          : "unknown";

      this.options.onEvent({
        type: "thread_status_changed",
        threadId,
        status,
      });

      if (status === "idle" && (this.currentTurn || this.resumedTurnActive)) {
        this.finishCurrentTurn(this.activeTurnId, null, false);
      }
      return;
    }

    if (method === "turn/started") {
      const threadId = this.resolveNotificationThreadId(params);
      if (!threadId) {
        return;
      }
      const turnId = extractTurnId(params);
      if (turnId) {
        this.activeTurnId = turnId;
        this.options.onEvent({
          type: "turn_started",
          threadId,
          turnId,
        });
      }
      return;
    }

    if (method === "turn/completed") {
      const turnId = extractTurnId(params) ?? this.activeTurnId;
      const status = extractTurnStatus(params) ?? "completed";

      if (status === "interrupted") {
        this.finishCurrentTurn(turnId, "interrupted", true);
        return;
      }

      if (status === "failed") {
        this.finishCurrentTurn(
          turnId,
          extractTurnErrorMessage(params) ?? "Codex turn failed.",
          true,
        );
        return;
      }

      this.finishCurrentTurn(turnId, null, false);
      return;
    }

    if (method === "turn/aborted") {
      this.finishCurrentTurn(
        asString(params.turnId) ?? this.activeTurnId,
        asString(params.reason) ?? "interrupted",
        true,
      );
      return;
    }

    if (method === "item/started") {
      this.handleItemStarted(params);
      return;
    }

    if (method === "item/agentMessage/delta") {
      this.handleAgentMessageDelta(params);
      return;
    }

    if (method === "item/completed") {
      this.handleItemCompleted(params);
      return;
    }

    if (method === "rawResponseItem/completed") {
      this.handleRawResponseItem(params);
      return;
    }

    if (method === "error") {
      const errorMessage = findFirstString(params) ?? "Unknown Codex error.";
      this.options.onEvent({ type: "error", message: errorMessage });
      this.currentTurn?.reject(new Error(errorMessage));
    }
  }

  private handleRawResponseItem(params: Record<string, unknown>): void {
    const threadId = this.resolveNotificationThreadId(params);
    const turnId = asString(params.turnId) ?? this.activeTurnId;
    const item = isRecord(params.item) ? params.item : null;

    if (!item || !turnId || !threadId) {
      return;
    }

    if (item.type === "reasoning") {
      const summary = extractReasoningSummary(item);
      if (summary) {
        this.options.onEvent({
          type: "reasoning",
          threadId,
          turnId,
          text: summary,
        });
      }
      return;
    }

    const assistantMessage = extractAssistantMessage(item);
    if (assistantMessage) {
      this.options.onEvent({
        type: "assistant_message",
        threadId,
        turnId,
        text: assistantMessage.text,
        phase: assistantMessage.phase,
      });
    }
  }

  private handleItemStarted(params: Record<string, unknown>): void {
    const threadId = this.resolveNotificationThreadId(params);
    const turnId = asString(params.turnId) ?? this.activeTurnId;
    const item = isRecord(params.item) ? params.item : null;
    if (!item || !turnId || !threadId) {
      return;
    }

    if (item.type === "agentMessage") {
      const itemId = asString(item.id);
      if (!itemId) {
        return;
      }

      const phase =
        item.phase === "commentary" || item.phase === "final_answer"
          ? item.phase
          : "unknown";
      const text = typeof item.text === "string" ? item.text : "";
      this.agentMessages.set(itemId, {
        threadId,
        turnId,
        phase,
        text,
      });
      return;
    }

    if (item.type === "commandExecution" && typeof item.command === "string") {
      return;
    }
  }

  private handleAgentMessageDelta(params: Record<string, unknown>): void {
    const itemId = asString(params.itemId);
    const delta = typeof params.delta === "string" ? params.delta : null;
    if (!itemId || delta == null) {
      return;
    }

    const existing = this.agentMessages.get(itemId);
    if (!existing) {
      return;
    }

    existing.text += delta;
  }

  private handleItemCompleted(params: Record<string, unknown>): void {
    const threadId = this.resolveNotificationThreadId(params);
    const turnId = asString(params.turnId) ?? this.activeTurnId;
    const item = isRecord(params.item) ? params.item : null;
    if (!item || !turnId || !threadId) {
      return;
    }

    if (item.type === "reasoning") {
      const summary = extractReasoningSummary(item);
      if (summary) {
        this.options.onEvent({
          type: "reasoning",
          threadId,
          turnId,
          text: summary,
        });
      }
      return;
    }

    if (item.type === "agentMessage") {
      const itemId = asString(item.id);
      const stored = itemId ? this.agentMessages.get(itemId) : null;
      const phase =
        item.phase === "commentary" || item.phase === "final_answer"
          ? item.phase
          : (stored?.phase ?? "unknown");
      const text =
        typeof item.text === "string" ? item.text : (stored?.text ?? "");

      if (itemId) {
        this.agentMessages.delete(itemId);
      }

      if (!text.trim()) {
        return;
      }

      this.options.onEvent({
        type: "assistant_message",
        threadId: stored?.threadId ?? threadId,
        turnId: stored?.turnId ?? turnId,
        text,
        phase,
      });
      return;
    }

    if (item.type === "commandExecution" && typeof item.command === "string") {
      this.options.onEvent({
        type: "command_execution",
        threadId,
        turnId,
        command: item.command,
      });
    }
  }

  private async handleServerRequest(
    message: Record<string, unknown>,
  ): Promise<void> {
    const requestId = typeof message.id === "number" ? message.id : null;
    const method = asString(message.method);

    if (requestId == null || !method) {
      return;
    }

    switch (method) {
      case "item/tool/requestUserInput":
        this.respond(requestId, { answers: {} });
        this.currentTurn?.reject(
          new Error(
            "codex_user_input_required: requestUserInput is unsupported",
          ),
        );
        return;
      case "item/permissions/requestApproval":
        this.respond(requestId, { permissions: {}, scope: "turn" });
        this.currentTurn?.reject(
          new Error(
            "codex_permission_request: permission escalation requested",
          ),
        );
        return;
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
      case "applyPatchApproval":
      case "execCommandApproval":
        this.respond(requestId, { decision: "cancel" });
        this.currentTurn?.reject(
          new Error("codex_approval_request: approval was requested"),
        );
        return;
      default:
        this.respondError(requestId, `unsupported server request: ${method}`);
        this.currentTurn?.reject(
          new Error(`codex_server_request_unsupported: ${method}`),
        );
    }
  }

  private async request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error("codex_not_connected");
    }

    const id = this.nextId++;
    const payload = {
      id,
      method,
      params,
    };

    const result = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(
          new Error(`codex_request_timeout: ${method} exceeded ${timeoutMs}ms`),
        );
      }, timeoutMs);

      this.pendingRequests.set(id, {
        method,
        resolve,
        reject,
        timeout,
      });
    });

    ws.send(JSON.stringify(payload));
    return result;
  }

  private finishCurrentTurn(
    turnId: string | null,
    reason: string | null,
    aborted: boolean,
  ): void {
    if (
      (!this.currentTurn && !this.resumedTurnActive) ||
      this.currentTurnFinished
    ) {
      return;
    }

    this.currentTurnFinished = true;
    const threadId = this.threadId ?? "";
    this.agentMessages.clear();
    this.resumedTurnActive = false;
    this.activeTurnId = null;

    if (aborted) {
      this.options.onEvent({
        type: "turn_aborted",
        threadId,
        turnId,
        reason: reason ?? "interrupted",
      });
    } else {
      this.options.onEvent({
        type: "turn_completed",
        threadId,
        turnId,
      });
    }

    this.currentTurn?.resolve();
  }

  private notify(method: string, params?: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    this.ws.send(
      JSON.stringify({
        method,
        ...(params ? { params } : {}),
      }),
    );
  }

  private respond(id: number, result: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    this.ws.send(
      JSON.stringify({
        id,
        result,
      }),
    );
  }

  private respondError(id: number, message: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    this.ws.send(
      JSON.stringify({
        id,
        error: {
          code: -32601,
          message,
        },
      }),
    );
  }

  private async waitForThreadId(timeoutMs: number): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.threadId) {
        return this.threadId;
      }
      await delay(50);
    }
    return this.threadId;
  }

  private async waitForTurnId(timeoutMs: number): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.activeTurnId) {
        return this.activeTurnId;
      }
      await delay(50);
    }
    return this.activeTurnId;
  }

  private async refreshTurnStateFromThread(): Promise<string | null> {
    const metadata = await this.readThreadMetadata();
    if (metadata.status === "idle") {
      this.finishCurrentTurn(
        metadata.activeTurnId ?? this.activeTurnId,
        null,
        false,
      );
      return null;
    }

    if (!this.currentTurn) {
      this.resumedTurnActive = true;
    }

    if (metadata.activeTurnId) {
      this.activeTurnId = metadata.activeTurnId;
    }

    return this.activeTurnId;
  }

  private failAll(error: Error, silent: boolean): void {
    this.initialized = false;
    this.activeTurnId = null;
    this.agentMessages.clear();
    this.resumedTurnActive = false;
    this.threadId = this.threadId;

    for (const [requestId, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pendingRequests.delete(requestId);
    }

    if (this.currentTurn) {
      clearTimeout(this.currentTurn.timeout);
      this.currentTurn.reject(error);
      this.currentTurn = null;
    }

    if (!silent) {
      this.options.onEvent({ type: "error", message: error.message });
    }
  }

  private resolveNotificationThreadId(
    params: Record<string, unknown>,
  ): string | null {
    const threadId = extractThreadId(params) ?? this.threadId;
    if (!threadId) {
      return null;
    }

    if (this.threadId && threadId !== this.threadId) {
      return null;
    }

    return threadId;
  }
}
