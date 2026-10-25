import { axiosInstance } from '@/api/axios.ts';
import { parseFromApi, serializeForApi } from '@/lib/serialization/api-transform.ts';
import {
  minecraftVersionAdminSettingsResponseSchema,
  updateMinecraftVersionAdminSettingsSchema,
  type UpdateMinecraftVersionAdminSettings,
} from '../lib/minecraftVersionSchemas.ts';

export async function getMinecraftVersionAdminSettings() {
  const { data } = await axiosInstance.get('/api/admin/extensions/com.calagopus.chat/minecraft-versions/settings');
  return parseFromApi(minecraftVersionAdminSettingsResponseSchema, data);
}

export async function updateMinecraftVersionAdminSettings(settings: UpdateMinecraftVersionAdminSettings) {
  await axiosInstance.put(
    '/api/admin/extensions/com.calagopus.chat/minecraft-versions/settings',
    serializeForApi(updateMinecraftVersionAdminSettingsSchema, settings),
  );
}
