import { z } from 'zod';
import { axiosInstance } from '@/api/axios.ts';

const modrinthProjectSchema = z.looseObject({
  project_id: z.string(),
  project_type: z.string(),
  all_project_types: z.array(z.string()).optional().default([]),
  slug: z.string(),
  title: z.string(),
  description: z.string(),
  author: z.string(),
  icon_url: z.string().nullable().optional(),
  downloads: z.number().optional().default(0),
  categories: z.array(z.string()).optional().default([]),
  versions: z.array(z.string()).optional().default([]),
  server_side: z.string().optional(),
});

const modrinthSearchResponseSchema = z.object({
  hits: z.array(modrinthProjectSchema),
  offset: z.number(),
  limit: z.number(),
  total_hits: z.number(),
});

const modrinthVersionFileSchema = z.looseObject({
  hashes: z.record(z.string(), z.string()).optional(),
  url: z.string().url(),
  filename: z.string(),
  primary: z.boolean().optional().default(false),
  size: z.number().optional(),
});

const modrinthVersionSchema = z.looseObject({
  id: z.string(),
  project_id: z.string(),
  name: z.string(),
  version_number: z.string(),
  date_published: z.string(),
  downloads: z.number().optional().default(0),
  game_versions: z.array(z.string()).optional().default([]),
  loaders: z.array(z.string()).optional().default([]),
  files: z.array(modrinthVersionFileSchema),
  dependencies: z.array(z.unknown()).optional().default([]),
});

export type ModrinthProject = z.infer<typeof modrinthProjectSchema>;
export type ModrinthVersion = z.infer<typeof modrinthVersionSchema>;
export type ModrinthVersionFile = z.infer<typeof modrinthVersionFileSchema>;
export type ModrinthProjectType = 'mod' | 'modpack' | 'plugin';
export type ModrinthSearchIndex = 'relevance' | 'downloads' | 'follows' | 'updated';

const baseUrl = '/api/client/extensions/com.calagopus.chat/modrinth';

export async function searchModrinthProjects(params: {
  query?: string;
  projectType: ModrinthProjectType;
  gameVersion?: string;
  loader?: string;
  index?: ModrinthSearchIndex;
  limit?: number;
  offset?: number;
}) {
  const { data } = await axiosInstance.get(`${baseUrl}/search`, {
    params: {
      query: params.query?.trim() || undefined,
      project_type: params.projectType,
      game_version: params.gameVersion || undefined,
      loader: params.loader || undefined,
      index: params.index,
      limit: params.limit ?? 48,
      offset: params.offset ?? 0,
    },
  });

  return modrinthSearchResponseSchema.parse(data);
}

export async function getModrinthVersions(projectId: string, filters: { gameVersion?: string; loader?: string } = {}) {
  const { data } = await axiosInstance.get(`${baseUrl}/projects/${encodeURIComponent(projectId)}/versions`, {
    params: {
      game_version: filters.gameVersion || undefined,
      loader: filters.loader || undefined,
    },
  });

  return z.array(modrinthVersionSchema).parse(data);
}
