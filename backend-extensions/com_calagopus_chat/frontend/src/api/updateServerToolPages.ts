import { axiosInstance } from '@/api/axios.ts';
import { serializeForApi } from '@/lib/serialization/api-transform.ts';
import { updateServerToolPagesSchema, type UpdateServerToolPages } from '../lib/schemas.ts';

export default async (settings: UpdateServerToolPages) => {
  await axiosInstance.put(
    '/api/admin/extensions/com.calagopus.chat/server-tools',
    serializeForApi(updateServerToolPagesSchema, settings),
  );
};
