import { axiosInstance } from '@/api/axios.ts';
import { parseFromApi } from '@/lib/serialization/api-transform.ts';
import {
  minecraftVersionBuildDetailsSchema,
  minecraftVersionBuildsResponseSchema,
  minecraftVersionClientConfigSchema,
  minecraftVersionGlobalStatsSchema,
  minecraftVersionListResponseSchema,
  minecraftVersionLookupResponseSchema,
  minecraftVersionTypeSchema,
  minecraftVersionTypesResponseSchema,
  type MinecraftVersionType,
} from '../lib/minecraftVersionSchemas.ts';

const UNSAFE_PROVIDER_RECORD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function safeProviderRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('MCJars returned an invalid keyed response.');
  }
  const result = Object.create(null) as Record<string, unknown>;
  for (const [key, item] of Object.entries(value)) {
    if (
      !key ||
      key.length > 256 ||
      UNSAFE_PROVIDER_RECORD_KEYS.has(key.toLowerCase()) ||
      [...key].some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f)
    ) {
      throw new Error('MCJars returned an unsafe keyed response.');
    }
    result[key] = item;
  }
  return result;
}

function normalizeMinecraftVersionTypes(response: { success?: boolean; types: unknown }) {
  if (
    response.success === false ||
    typeof response.types !== 'object' ||
    response.types === null ||
    Array.isArray(response.types)
  ) {
    throw new Error('MCJars returned an invalid server type catalog.');
  }
  const types = Object.create(null) as Record<string, Record<string, MinecraftVersionType>>;
  const addType = (category: string, identifier: string, rawType: unknown) => {
    const normalizedIdentifier = identifier.trim().toUpperCase();
    if (
      !category ||
      category.length > 64 ||
      [...category].some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f) ||
      UNSAFE_PROVIDER_RECORD_KEYS.has(category.toLowerCase()) ||
      !/^[A-Z0-9_]{1,64}$/.test(normalizedIdentifier) ||
      UNSAFE_PROVIDER_RECORD_KEYS.has(normalizedIdentifier.toLowerCase())
    ) {
      return;
    }
    if (typeof rawType !== 'object' || rawType === null || Array.isArray(rawType)) return;
    const parsed = minecraftVersionTypeSchema.safeParse({
      ...(rawType as Record<string, unknown>),
      identifier: normalizedIdentifier,
    });
    if (!parsed.success) return;
    const normalizedCategory = category.trim() || 'other';
    (types[normalizedCategory] ??= Object.create(null) as Record<string, MinecraftVersionType>)[normalizedIdentifier] =
      parsed.data;
  };

  for (const [category, value] of Object.entries(response.types as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    if ('name' in value) {
      addType('organization', category, value);
      continue;
    }
    const entries = Object.entries(value as Record<string, unknown>);
    for (const [identifier, item] of entries) addType(category, identifier, item);
  }

  return { ...response, types };
}

export async function getMinecraftVersionTypes(serverUuid: string) {
  const { data } = await axiosInstance.get(
    `/api/client/extensions/com.calagopus.chat/minecraft-versions/servers/${serverUuid}/types`,
  );
  return normalizeMinecraftVersionTypes(minecraftVersionTypesResponseSchema.parse(data));
}

export async function getAdminMinecraftVersionTypes() {
  const { data } = await axiosInstance.get('/api/admin/extensions/com.calagopus.chat/minecraft-versions/types');
  return normalizeMinecraftVersionTypes(minecraftVersionTypesResponseSchema.parse(data));
}

export async function getMinecraftVersionClientConfig(serverUuid: string) {
  const { data } = await axiosInstance.get(
    `/api/client/extensions/com.calagopus.chat/minecraft-versions/servers/${serverUuid}/config`,
  );
  return parseFromApi(minecraftVersionClientConfigSchema, data);
}

export async function getMinecraftVersionList(serverUuid: string, type: string) {
  const { data } = await axiosInstance.get(
    `/api/client/extensions/com.calagopus.chat/minecraft-versions/servers/${serverUuid}/types/${encodeURIComponent(type)}`,
  );
  return minecraftVersionListResponseSchema.parse({
    ...data,
    builds: safeProviderRecord(data.builds),
  });
}

export async function getMinecraftVersionBuilds(serverUuid: string, type: string, version: string) {
  const { data } = await axiosInstance.get(
    `/api/client/extensions/com.calagopus.chat/minecraft-versions/servers/${serverUuid}/types/${encodeURIComponent(type)}/${encodeURIComponent(version)}`,
  );
  return parseFromApi(minecraftVersionBuildsResponseSchema, data);
}

export async function getMinecraftVersionBuildDetails(serverUuid: string, buildId: number) {
  const { data } = await axiosInstance.post(
    `/api/client/extensions/com.calagopus.chat/minecraft-versions/servers/${serverUuid}/build`,
    { id: buildId },
  );
  return parseFromApi(minecraftVersionBuildDetailsSchema, data);
}

export async function lookupMinecraftVersionFingerprint(serverUuid: string, sha256: string) {
  const { data } = await axiosInstance.post(
    `/api/client/extensions/com.calagopus.chat/minecraft-versions/servers/${serverUuid}/lookup`,
    { sha256 },
  );
  return parseFromApi(minecraftVersionLookupResponseSchema, data);
}

export async function recordMinecraftVersionInstall(serverUuid: string, providerType: string, version: string) {
  await axiosInstance.post(
    `/api/client/extensions/com.calagopus.chat/minecraft-versions/servers/${serverUuid}/stats/install`,
    { providerType, version },
  );
}

export async function getMinecraftVersionGlobalStats() {
  const { data } = await axiosInstance.get('/api/admin/extensions/com.calagopus.chat/minecraft-versions/global-stats');
  if (
    typeof data !== 'object' ||
    data === null ||
    typeof data.types !== 'object' ||
    data.types === null ||
    typeof data.versions !== 'object' ||
    data.versions === null ||
    data.types.success === false ||
    data.versions.success === false
  ) {
    throw new Error('MCJars returned invalid global statistics.');
  }
  return minecraftVersionGlobalStatsSchema.parse({
    types: {
      ...data.types,
      types: safeProviderRecord(data.types.types),
    },
    versions: {
      ...data.versions,
      versions: safeProviderRecord(data.versions.versions),
    },
  });
}
