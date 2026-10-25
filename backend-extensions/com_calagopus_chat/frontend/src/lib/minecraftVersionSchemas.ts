import { z } from 'zod';

export const minecraftVersionTypeSchema = z.object({
  name: z.string().max(255),
  identifier: z.string().min(1).max(64).optional(),
  icon: z.string().max(1024).optional().default(''),
  homepage: z.string().max(1024).optional().default(''),
  description: z.string().max(4096).optional().default(''),
  experimental: z.boolean().optional().default(false),
  deprecated: z.boolean().optional().default(false),
  builds: z.number().int().nonnegative().optional().default(0),
  versions: z.object({
    minecraft: z.number().int().nonnegative().optional().default(0),
    project: z.number().int().nonnegative().optional().default(0),
  }),
  categories: z.array(z.string().max(64)).optional().default([]),
  compatibility: z.array(z.string().max(64)).optional().default([]),
});

export const minecraftVersionTypesResponseSchema = z.object({
  success: z.boolean().optional(),
  types: z.unknown(),
});

export const minecraftVersionBuildSchema = z.object({
  id: z.number().int().positive(),
  type: z.string().max(64),
  projectVersionId: z.string().max(128).nullable().optional(),
  versionId: z.string().max(128).nullable().optional(),
  name: z.string().max(255),
  experimental: z.boolean().optional().default(false),
  created: z.string().nullable().optional(),
});

export const minecraftVersionListItemSchema = z.object({
  type: z.enum(['RELEASE', 'SNAPSHOT']).optional(),
  builds: z.number().int().nonnegative(),
  latest: minecraftVersionBuildSchema,
  version: z.string().min(1).max(128),
});

export const minecraftVersionListResponseSchema = z.object({
  success: z.boolean().optional(),
  builds: z.record(
    z.string(),
    z.object({
      type: z.enum(['RELEASE', 'SNAPSHOT']).optional(),
      builds: z.number().int().nonnegative(),
      latest: minecraftVersionBuildSchema,
    }),
  ),
});

export const minecraftVersionBuildsResponseSchema = z.object({
  success: z.boolean().optional(),
  builds: z.array(minecraftVersionBuildSchema),
});

export const minecraftVersionBuildDetailsSchema = z.object({
  success: z.boolean().optional(),
  build: minecraftVersionBuildSchema.extend({ installation: z.unknown().optional() }),
  latest: minecraftVersionBuildSchema.optional(),
  version: z.object({ java: z.number().int().positive().optional() }).nullable().optional(),
});

export const minecraftVersionLookupResponseSchema = z.object({
  success: z.boolean().optional(),
  build: minecraftVersionBuildSchema.nullable().optional(),
  latest: minecraftVersionBuildSchema.nullable().optional(),
  version: z.object({ java: z.number().int().positive().optional() }).nullable().optional(),
});

export const minecraftVersionTypeOrderSchema = z.object({
  category: z.string().min(1).max(64),
  types: z.array(z.string().min(1).max(64)).max(256),
});

export const minecraftVersionEggOverrideSchema = z.object({
  providerType: z.string().min(1).max(64),
  eggUuid: z.string().uuid(),
});

export const minecraftVersionStatsSchema = z.object({
  totalInstalls: z.number().int().nonnegative(),
  installsByType: z.record(z.string(), z.number().int().nonnegative()),
  installsByVersion: z.record(z.string(), z.number().int().nonnegative()),
});

export const minecraftVersionAdminSettingsSchema = z.object({
  apiBaseUrl: z.string().max(512),
  apiKeyConfigured: z.boolean(),
  iconBaseUrl: z.string().max(512),
  iconFormat: z.enum(['png', 'webp']),
  typeOrder: z.array(minecraftVersionTypeOrderSchema).max(64),
  eggOverrides: z.array(minecraftVersionEggOverrideSchema).max(256),
  collectStats: z.boolean(),
  localStats: minecraftVersionStatsSchema,
});

export const minecraftVersionAdminSettingsResponseSchema = z.object({
  settings: minecraftVersionAdminSettingsSchema,
});

export const updateMinecraftVersionAdminSettingsSchema = z.object({
  apiBaseUrl: z.string().url().max(512),
  apiKey: z.string().max(4096),
  clearApiKey: z.boolean(),
  iconBaseUrl: z.string().url().max(512),
  iconFormat: z.enum(['png', 'webp']),
  typeOrder: z.array(minecraftVersionTypeOrderSchema).max(64),
  eggOverrides: z.array(minecraftVersionEggOverrideSchema).max(256),
  collectStats: z.boolean(),
  resetLocalStats: z.boolean(),
});

export const minecraftVersionClientConfigSchema = z.object({
  iconBaseUrl: z.string().max(512),
  iconFormat: z.enum(['png', 'webp']),
  typeOrder: z.array(minecraftVersionTypeOrderSchema).max(64),
  eggOverrides: z.array(minecraftVersionEggOverrideSchema).max(256),
  collectStats: z.boolean(),
});

export const minecraftVersionGlobalStatsSchema = z.object({
  types: z.object({
    success: z.boolean().optional(),
    types: z.record(z.string(), z.object({ total: z.number().nonnegative(), uniqueIps: z.number().nonnegative() })),
  }),
  versions: z.object({
    success: z.boolean().optional(),
    versions: z.record(z.string(), z.object({ total: z.number().nonnegative(), uniqueIps: z.number().nonnegative() })),
  }),
});

export type MinecraftVersionType = z.infer<typeof minecraftVersionTypeSchema>;
export type MinecraftVersionTypeOrder = z.infer<typeof minecraftVersionTypeOrderSchema>;
export type MinecraftVersionBuild = z.infer<typeof minecraftVersionBuildSchema>;
export type MinecraftVersionListItem = z.infer<typeof minecraftVersionListItemSchema>;
export type MinecraftVersionAdminSettings = z.infer<typeof minecraftVersionAdminSettingsSchema>;
export type UpdateMinecraftVersionAdminSettings = z.infer<typeof updateMinecraftVersionAdminSettingsSchema>;
