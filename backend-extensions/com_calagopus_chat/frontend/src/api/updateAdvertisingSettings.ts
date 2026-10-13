import { axiosInstance } from '@/api/axios.ts';
import { serializeForApi } from '@/lib/serialization/api-transform.ts';
import { advertisingSettingsSchema, type UpdateAdvertisingSettings } from '../lib/schemas.ts';

export default async (settings: UpdateAdvertisingSettings) => {
  await axiosInstance.put(
    '/api/admin/extensions/com.calagopus.chat/advertising',
    serializeForApi(advertisingSettingsSchema, settings),
  );
};
