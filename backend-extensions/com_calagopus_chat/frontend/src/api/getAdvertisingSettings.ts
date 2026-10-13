import { axiosInstance } from '@/api/axios.ts';
import { parseFromApi } from '@/lib/serialization/api-transform.ts';
import { advertisingSettingsResponseSchema } from '../lib/schemas.ts';

export default async () => {
  const { data } = await axiosInstance.get('/api/admin/extensions/com.calagopus.chat/advertising');
  return parseFromApi(advertisingSettingsResponseSchema, data);
};
