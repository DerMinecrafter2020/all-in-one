import { z } from 'zod';

export const conversationKindSchema = z.enum(['direct', 'group', 'ai']);

export const userSummarySchema = z.object({
  uuid: z.string().uuid(),
  username: z.string(),
});

export const chatServerOptionSchema = z.object({
  uuid: z.string().uuid(),
  uuidShort: z.string(),
  name: z.string(),
  status: z.string().nullable().optional(),
  isSuspended: z.boolean(),
});

export const chatServerResourcesSchema = z.object({
  state: z.string(),
  cpuAbsolute: z.number(),
  cpuLimitAbsolute: z.number(),
  memoryBytes: z.number(),
  memoryLimitBytes: z.number(),
  diskBytes: z.number(),
  uptime: z.number(),
});

export const conversationSchema = z.object({
  uuid: z.string().uuid(),
  kind: conversationKindSchema,
  aiEnabled: z.boolean(),
  title: z.string().nullable(),
  createdAt: z.coerce.date(),
  lastMessage: z.string().nullable(),
  lastMessageAt: z.coerce.date().nullable(),
  lastActionStatus: z.enum(['pending', 'executing', 'confirmed', 'cancelled', 'failed', 'expired']).nullable(),
  unreadCount: z.number(),
  participants: z.array(z.string()),
});

export const conversationRefSchema = z.object({
  uuid: z.string().uuid(),
  kind: conversationKindSchema,
  aiEnabled: z.boolean(),
  title: z.string().nullable(),
});

export const aiServerActionSchema = z.object({
  actionType: z.enum(['start', 'stop', 'restart']),
  serverName: z.string(),
  status: z.enum(['pending', 'executing', 'confirmed', 'cancelled', 'failed', 'expired']),
  expiresAt: z.coerce.date(),
  canConfirm: z.boolean(),
});

export const messageSchema = z.object({
  uuid: z.string().uuid(),
  conversationUuid: z.string().uuid(),
  senderUuid: z.string().uuid().nullable(),
  senderUsername: z.string(),
  isAi: z.boolean(),
  content: z.string(),
  createdAt: z.coerce.date(),
  pendingAction: aiServerActionSchema.nullable(),
});

export const conversationsResponseSchema = z.object({
  conversations: z.array(conversationSchema),
  aiAvailable: z.boolean(),
  floatingWidgetEnabled: z.boolean(),
});

export const usersResponseSchema = z.object({
  users: z.array(userSummarySchema),
});

export const createConversationSchema = z.object({
  kind: conversationKindSchema,
  aiEnabled: z.boolean(),
  title: z.string().optional(),
  participantUuids: z.array(z.string().uuid()),
});

export const createConversationResponseSchema = z.object({
  conversation: conversationRefSchema,
});

export const messagesResponseSchema = z.object({
  messages: z.array(messageSchema),
});

export const sendMessageSchema = z.object({
  content: z.string().min(1).max(4000),
});

export const sendMessageResponseSchema = z.object({
  messageUuid: z.string().uuid(),
  aiMessageUuid: z.string().uuid().nullable(),
});

export const aiServerActionDecisionSchema = z.object({
  confirm: z.boolean(),
});

export const aiServerActionResponseSchema = z.object({
  status: aiServerActionSchema.shape.status,
});

export const aiProviderSchema = z.enum(['openai_compatible', 'openrouter', 'anthropic', 'google_gemini', 'ollama']);

export const serverToolPagesSchema = z.object({
  modpacks: z.boolean(),
  mods: z.boolean(),
  plugins: z.boolean(),
  players: z.boolean(),
  serverProperties: z.boolean(),
});

export const serverToolPagesResponseSchema = z.object({
  settings: serverToolPagesSchema,
});

export const adminSettingsSchema = z.object({
  aiEnabled: z.boolean(),
  aiProvider: aiProviderSchema,
  aiBaseUrl: z.string(),
  aiModel: z.string(),
  aiSystemPrompt: z.string(),
  apiKeyConfigured: z.boolean(),
  serverControlApiKeyConfigured: z.boolean(),
  aiServerInfoEnabled: z.boolean(),
  aiServerPowerEnabled: z.boolean(),
  floatingWidgetEnabled: z.boolean(),
  serverToolPages: serverToolPagesSchema,
});

export const tokenUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  reportedResponses: z.number().int().nonnegative(),
});

export const adminSettingsResponseSchema = z.object({
  settings: adminSettingsSchema,
  tokenUsage: tokenUsageSchema,
});

export const advertisingModeSchema = z.enum(['custom_banner', 'sandboxed_iframe']);
export const advertisingScopeSchema = z.enum(['all', 'dashboard']);
export const advertisingSlotNameSchema = z.enum(['top', 'bottom', 'left', 'right']);

export const advertisingSlotSchema = z.object({
  enabled: z.boolean(),
  mode: advertisingModeSchema,
  width: z.number().int().min(1).max(2000),
  height: z.number().int().min(1).max(2000),
  customAdImageUrl: z.string().max(512),
  customAdTargetUrl: z.string().max(512),
  customAdAltText: z.string().max(120),
  customAdIframeUrl: z.string().max(512),
});

export const advertisingSettingsSchema = z.object({
  scope: advertisingScopeSchema,
  slots: z.object({
    top: advertisingSlotSchema,
    bottom: advertisingSlotSchema,
    left: advertisingSlotSchema,
    right: advertisingSlotSchema,
  }),
});

export const updateAdvertisingSettingsSchema = advertisingSettingsSchema.superRefine((settings, context) => {
  const validateHttpsUrl = (path: (string | number)[], value: string) => {
    let validHttpsUrl = false;
    try {
      const url = new URL(value);
      validHttpsUrl = url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password;
    } catch {
      // The field-specific issue below reports invalid or non-HTTPS URLs.
    }
    if (!validHttpsUrl) {
      context.addIssue({
        code: 'custom',
        path,
        message: 'Enter a valid HTTPS URL.',
      });
    }
  };

  for (const slotName of advertisingSlotNameSchema.options) {
    const slot = settings.slots[slotName];
    if (!slot.enabled) continue;

    if (slot.mode === 'sandboxed_iframe') {
      validateHttpsUrl(['slots', slotName, 'customAdIframeUrl'], slot.customAdIframeUrl);
      continue;
    }

    validateHttpsUrl(['slots', slotName, 'customAdImageUrl'], slot.customAdImageUrl);
    validateHttpsUrl(['slots', slotName, 'customAdTargetUrl'], slot.customAdTargetUrl);

    if (!slot.customAdAltText.trim()) {
      context.addIssue({
        code: 'custom',
        path: ['slots', slotName, 'customAdAltText'],
        message: 'Alternative text is required for the banner image.',
      });
    }
  }
});

export const advertisingSettingsResponseSchema = z.object({
  settings: advertisingSettingsSchema,
});

export const providerModelsRequestSchema = z.object({
  aiProvider: aiProviderSchema,
  aiBaseUrl: z.string().url().max(512),
  aiApiKey: z.string().max(4096),
});

export const providerModelsResponseSchema = z.object({
  models: z.array(z.string()),
});

export const updateAdminSettingsSchema = z.object({
  aiEnabled: z.boolean(),
  aiProvider: aiProviderSchema,
  aiBaseUrl: z.string().url().max(512),
  aiModel: z.string().trim().min(1).max(128),
  aiSystemPrompt: z.string().trim().min(1).max(4000),
  aiApiKey: z.string().max(4096),
  serverControlApiKey: z.string().max(4096),
  aiServerInfoEnabled: z.boolean(),
  aiServerPowerEnabled: z.boolean(),
  floatingWidgetEnabled: z.boolean(),
  serverToolPages: serverToolPagesSchema,
  clearServerControlApiKey: z.boolean(),
  clearApiKey: z.boolean(),
});

export type Conversation = z.infer<typeof conversationSchema>;
export type ConversationKind = z.infer<typeof conversationKindSchema>;
export type ChatServerOption = z.infer<typeof chatServerOptionSchema>;
export type ChatServerResources = z.infer<typeof chatServerResourcesSchema>;
export type AiProvider = z.infer<typeof aiProviderSchema>;
export type TokenUsage = z.infer<typeof tokenUsageSchema>;
export type ServerToolPages = z.infer<typeof serverToolPagesSchema>;
export type AiServerAction = z.infer<typeof aiServerActionSchema>;
export type ChatMessage = z.infer<typeof messageSchema>;
export type ChatUser = z.infer<typeof userSummarySchema>;
export type ProviderModelsRequest = z.infer<typeof providerModelsRequestSchema>;
export type UpdateAdminSettings = z.infer<typeof updateAdminSettingsSchema>;
export type AdvertisingMode = z.infer<typeof advertisingModeSchema>;
export type AdvertisingScope = z.infer<typeof advertisingScopeSchema>;
export type AdvertisingSlotName = z.infer<typeof advertisingSlotNameSchema>;
export type AdvertisingSlotSettings = z.infer<typeof advertisingSlotSchema>;
export type AdvertisingSettings = z.infer<typeof advertisingSettingsSchema>;
export type UpdateAdvertisingSettings = z.infer<typeof updateAdvertisingSettingsSchema>;
