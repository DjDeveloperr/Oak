import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type MessageActionRowComponentBuilder,
} from "discord.js";

export const DEFAULT_OAK_MODEL = "gpt-5.5";
export const DEFAULT_OAK_REASONING_EFFORT = "high";
export const OAK_FAST_MODE_MODEL = "gpt-5.4-mini";
export const OAK_FAST_MODE_REASONING_EFFORT = "low";

const THREAD_MODEL_MENU_PREFIX = "oak_thread_model";
const THREAD_REASONING_MENU_PREFIX = "oak_thread_reasoning";
const THREAD_SERVICE_TIER_MENU_PREFIX = "oak_thread_service_tier";
const THREAD_FAST_MODE_BUTTON_PREFIX = "oak_thread_fast_mode";

const SERVICE_TIER_OPTIONS = [
  {
    value: "default",
    label: "Default",
    description: "Use the server or account default service tier.",
  },
  {
    value: "fast",
    label: "Fast",
    description: "Prefer the fast service tier.",
  },
  {
    value: "flex",
    label: "Flex",
    description: "Prefer the flex service tier.",
  },
] as const;

export interface OakReasoningOption {
  value: string;
  label: string;
  description: string;
}

export interface OakModelOption {
  value: string;
  label: string;
  description: string;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: readonly OakReasoningOption[];
  isDefault?: boolean;
}

const STATIC_REASONING_OPTIONS: readonly OakReasoningOption[] = [
  {
    value: "low",
    label: "Low",
    description: "Fastest response with lighter reasoning.",
  },
  {
    value: "medium",
    label: "Medium",
    description: "Balanced speed and reasoning depth.",
  },
  {
    value: "high",
    label: "High",
    description: "Deeper reasoning for harder tasks.",
  },
  {
    value: "xhigh",
    label: "XHigh",
    description: "Maximum reasoning depth.",
  },
] as const;

const STATIC_MODEL_OPTIONS: readonly OakModelOption[] = [
  {
    value: "gpt-5.5",
    label: "GPT-5.5",
    description: "Frontier model for complex coding and long-running work.",
    defaultReasoningEffort: "high",
    supportedReasoningEfforts: STATIC_REASONING_OPTIONS,
    isDefault: true,
  },
  {
    value: "gpt-5.4",
    label: "GPT-5.4",
    description: "Latest frontier agentic coding model.",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: STATIC_REASONING_OPTIONS,
  },
  {
    value: "gpt-5.4-mini",
    label: "GPT-5.4-Mini",
    description: "Smaller frontier agentic coding model.",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: STATIC_REASONING_OPTIONS,
  },
  {
    value: "gpt-5.3-codex",
    label: "GPT-5.3 Codex",
    description: "Frontier Codex-optimized agentic coding model.",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: STATIC_REASONING_OPTIONS,
  },
  {
    value: "gpt-5.3-codex-spark",
    label: "GPT-5.3-Codex-Spark",
    description: "Ultra-fast coding model.",
    defaultReasoningEffort: "high",
    supportedReasoningEfforts: STATIC_REASONING_OPTIONS,
  },
  {
    value: "gpt-5.2",
    label: "GPT-5.2",
    description: "Optimized for professional work and long-running agents.",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: STATIC_REASONING_OPTIONS,
  },
] as const;

const STATIC_MODEL_OPTION_SET: ReadonlySet<string> = new Set(
  STATIC_MODEL_OPTIONS.map((option) => option.value),
);

export interface OakThreadPreferences {
  model: string;
  reasoningEffort: string;
}

interface ThreadPreferenceMenuTarget {
  threadId: string;
  userId: string;
}

function getOakModelOptions(
  modelOptions?: readonly OakModelOption[] | null,
): readonly OakModelOption[] {
  return modelOptions && modelOptions.length > 0
    ? modelOptions
    : STATIC_MODEL_OPTIONS;
}

function getDefaultOakModelOption(
  modelOptions?: readonly OakModelOption[] | null,
): OakModelOption {
  const options = getOakModelOptions(modelOptions);
  return (
    options.find((option) => option.isDefault) ??
    options.find((option) => option.value === DEFAULT_OAK_MODEL) ??
    options[0] ??
    STATIC_MODEL_OPTIONS[0]
  );
}

function getOakModelOptionByValue(
  value: string | null | undefined,
  modelOptions?: readonly OakModelOption[] | null,
): OakModelOption | null {
  if (!value) {
    return null;
  }

  return (
    getOakModelOptions(modelOptions).find((option) => option.value === value) ??
    null
  );
}

export function normalizeOakModel(
  value: string | null | undefined,
  modelOptions?: readonly OakModelOption[] | null,
): string {
  if (
    value &&
    (modelOptions
      ? getOakModelOptionByValue(value, modelOptions)
      : STATIC_MODEL_OPTION_SET.has(value))
  ) {
    return value;
  }

  return getDefaultOakModelOption(modelOptions).value;
}

export function getOakReasoningOptionsForModel(
  model: string | null | undefined,
  modelOptions?: readonly OakModelOption[] | null,
): readonly OakReasoningOption[] {
  const normalizedModel = normalizeOakModel(model, modelOptions);
  const matchedModel =
    getOakModelOptionByValue(normalizedModel, modelOptions) ??
    getDefaultOakModelOption(modelOptions);

  return matchedModel.supportedReasoningEfforts.length > 0
    ? matchedModel.supportedReasoningEfforts
    : STATIC_REASONING_OPTIONS;
}

export function normalizeOakReasoningEffort(
  value: string | null | undefined,
  model: string | null | undefined,
  modelOptions?: readonly OakModelOption[] | null,
): string {
  const reasoningOptions = getOakReasoningOptionsForModel(model, modelOptions);
  if (value && reasoningOptions.some((option) => option.value === value)) {
    return value;
  }

  const normalizedModel = normalizeOakModel(model, modelOptions);
  const matchedModel =
    getOakModelOptionByValue(normalizedModel, modelOptions) ??
    getDefaultOakModelOption(modelOptions);

  if (
    matchedModel.defaultReasoningEffort &&
    reasoningOptions.some(
      (option) => option.value === matchedModel.defaultReasoningEffort,
    )
  ) {
    return matchedModel.defaultReasoningEffort;
  }

  return reasoningOptions[0]?.value ?? DEFAULT_OAK_REASONING_EFFORT;
}

export function buildOakThreadPreferences(
  model: string | null | undefined,
  reasoningEffort: string | null | undefined,
  modelOptions?: readonly OakModelOption[] | null,
): OakThreadPreferences {
  const normalizedModel = normalizeOakModel(model, modelOptions);
  return {
    model: normalizedModel,
    reasoningEffort: normalizeOakReasoningEffort(
      reasoningEffort,
      normalizedModel,
      modelOptions,
    ),
  };
}

export function buildOakFastModePreferences(
  modelOptions?: readonly OakModelOption[] | null,
): OakThreadPreferences {
  return buildOakThreadPreferences(
    OAK_FAST_MODE_MODEL,
    OAK_FAST_MODE_REASONING_EFFORT,
    modelOptions,
  );
}

export function normalizeOakServiceTier(
  value: string | null | undefined,
): "fast" | "flex" | null {
  if (value === "fast" || value === "flex") {
    return value;
  }
  return null;
}

export function buildThreadPreferenceCustomId(
  kind: "model" | "reasoning" | "service_tier" | "fast_mode",
  target: ThreadPreferenceMenuTarget,
): string {
  const prefix =
    kind === "model"
      ? THREAD_MODEL_MENU_PREFIX
      : kind === "reasoning"
        ? THREAD_REASONING_MENU_PREFIX
        : kind === "service_tier"
          ? THREAD_SERVICE_TIER_MENU_PREFIX
          : THREAD_FAST_MODE_BUTTON_PREFIX;
  return `${prefix}:${target.threadId}:${target.userId}`;
}

export function parseThreadPreferenceCustomId(customId: string):
  | ({
      kind: "model" | "reasoning" | "service_tier" | "fast_mode";
    } & ThreadPreferenceMenuTarget)
  | null {
  const [prefix, threadId, userId] = customId.split(":");
  if (!threadId || !userId) {
    return null;
  }

  if (prefix === THREAD_MODEL_MENU_PREFIX) {
    return { kind: "model", threadId, userId };
  }

  if (prefix === THREAD_REASONING_MENU_PREFIX) {
    return { kind: "reasoning", threadId, userId };
  }

  if (prefix === THREAD_SERVICE_TIER_MENU_PREFIX) {
    return { kind: "service_tier", threadId, userId };
  }

  if (prefix === THREAD_FAST_MODE_BUTTON_PREFIX) {
    return { kind: "fast_mode", threadId, userId };
  }

  return null;
}

export function buildThreadPreferenceMessage(options: {
  threadId: string;
  userId: string;
  preferences: OakThreadPreferences;
  serviceTier: string | null;
  fastModeEnabled: boolean;
  statusText?: string | null;
  modelOptions?: readonly OakModelOption[] | null;
}): {
  content: string;
  components: Array<ActionRowBuilder<MessageActionRowComponentBuilder>>;
} {
  const modelOptions = getOakModelOptions(options.modelOptions);
  const preferences = buildOakThreadPreferences(
    options.preferences.model,
    options.preferences.reasoningEffort,
    modelOptions,
  );
  const reasoningOptions = getOakReasoningOptionsForModel(
    preferences.model,
    modelOptions,
  );
  const fastModePreferences = buildOakFastModePreferences(modelOptions);
  const normalizedServiceTier = normalizeOakServiceTier(options.serviceTier);

  const modelMenu = new StringSelectMenuBuilder()
    .setCustomId(
      buildThreadPreferenceCustomId("model", {
        threadId: options.threadId,
        userId: options.userId,
      }),
    )
    .setPlaceholder(`Model: ${preferences.model}`)
    .addOptions(
      modelOptions.map((option) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(option.label)
          .setValue(option.value)
          .setDescription(option.description)
          .setDefault(option.value === preferences.model),
      ),
    );

  const reasoningMenu = new StringSelectMenuBuilder()
    .setCustomId(
      buildThreadPreferenceCustomId("reasoning", {
        threadId: options.threadId,
        userId: options.userId,
      }),
    )
    .setPlaceholder(`Reasoning: ${preferences.reasoningEffort}`)
    .addOptions(
      reasoningOptions.map((option) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(option.label)
          .setValue(option.value)
          .setDescription(option.description)
          .setDefault(option.value === preferences.reasoningEffort),
      ),
    );

  const fastModeButton = new ButtonBuilder()
    .setCustomId(
      buildThreadPreferenceCustomId("fast_mode", {
        threadId: options.threadId,
        userId: options.userId,
      }),
    )
    .setLabel(
      options.fastModeEnabled ? "Turn Fast Mode Off" : "Turn Fast Mode On",
    )
    .setStyle(
      options.fastModeEnabled ? ButtonStyle.Secondary : ButtonStyle.Success,
    );

  const serviceTierMenu = new StringSelectMenuBuilder()
    .setCustomId(
      buildThreadPreferenceCustomId("service_tier", {
        threadId: options.threadId,
        userId: options.userId,
      }),
    )
    .setPlaceholder(`Service Tier: ${normalizedServiceTier ?? "default"}`)
    .addOptions(
      SERVICE_TIER_OPTIONS.map((option) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(option.label)
          .setValue(option.value)
          .setDescription(option.description)
          .setDefault(option.value === (normalizedServiceTier ?? "default")),
      ),
    );

  const lines = [
    "Model settings for this thread.",
    `Current model: \`${preferences.model}\``,
    `Current reasoning: \`${preferences.reasoningEffort}\``,
    `Current service tier: \`${normalizedServiceTier ?? "default"}\``,
    `Fast mode: \`${options.fastModeEnabled ? "on" : "off"}\``,
    `Fast mode uses \`${fastModePreferences.model}\` with \`${fastModePreferences.reasoningEffort}\` reasoning.`,
    "Changes apply to the next turn. If Oak is already working, the new settings are queued.",
  ];

  if (options.statusText) {
    lines.push("");
    lines.push(options.statusText);
  }

  return {
    content: lines.join("\n"),
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(modelMenu),
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        reasoningMenu,
      ),
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        serviceTierMenu,
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(fastModeButton),
    ],
  };
}
