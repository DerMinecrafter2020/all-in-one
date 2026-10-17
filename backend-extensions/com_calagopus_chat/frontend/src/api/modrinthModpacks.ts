import { z } from 'zod';
import { getHttpStatus } from '@/api/axios.ts';
import createDirectory from '@/api/server/files/createDirectory.ts';
import deleteFiles from '@/api/server/files/deleteFiles.ts';
import getFileContent from '@/api/server/files/getFileContent.ts';
import loadDirectory from '@/api/server/files/loadDirectory.ts';
import saveFileContent from '@/api/server/files/saveFileContent.ts';
import statFiles from '@/api/server/files/statFiles.ts';

const REGISTRY_DIRECTORY = '/.all-in-one/modpacks';
const MAX_MANAGED_FILES = 10_000;

const MANAGED_MODPACK_ROOT_FILES = new Set([
  'banned-ips.json',
  'banned-players.json',
  'eula.txt',
  'launch.sh',
  'ops.json',
  'run.bat',
  'run.sh',
  'server.jar',
  'server.properties',
  'start.bat',
  'start.sh',
  'start_server.sh',
  'usercache.json',
  'user_jvm_args.txt',
  'whitelist.json',
]);

const managedModpackRecordSchema = z.object({
  schemaVersion: z.literal(1),
  projectId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  slug: z.string().min(1).max(128),
  title: z.string().min(1).max(256),
  description: z.string().max(10_000),
  author: z.string().max(128),
  iconUrl: z.string().max(2048).nullable(),
  categories: z.array(z.string().max(100)).max(64),
  versionId: z.string().min(1).max(128),
  versionNumber: z.string().min(1).max(64),
  gameVersions: z.array(z.string().max(32)).max(64),
  loaders: z.array(z.string().max(32)).max(32),
  installedAt: z.string().datetime(),
  updatedAt: z.string().datetime().optional(),
  managedFiles: z.array(z.string().max(1024)).max(MAX_MANAGED_FILES),
});

export type ManagedModrinthModpack = z.infer<typeof managedModpackRecordSchema>;

export function validateManagedModpackPath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 1024 || value.startsWith('/')) {
    throw new Error('The modpack manifest contains an unsafe file path.');
  }

  const segments = value.split('/');
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment.length > 255 ||
        segment === '.' ||
        segment === '..' ||
        segment.includes('\\') ||
        segment.includes('\0') ||
        segment.includes(':') ||
        segment.includes('\r') ||
        segment.includes('\n'),
    )
  ) {
    throw new Error('The modpack manifest contains an unsafe file path.');
  }

  const normalized = segments.join('/');
  if (isReservedModpackPath(normalized)) {
    throw new Error('The modpack refers to a protected server or All-in-One file.');
  }
  return normalized;
}

export function isReservedModpackPath(path: string): boolean {
  const normalized = path.toLowerCase();
  const firstSegment = normalized.split('/')[0];
  return firstSegment === '.all-in-one' || (normalized === firstSegment && MANAGED_MODPACK_ROOT_FILES.has(normalized));
}

function validateProjectId(projectId: string): string {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(projectId)) {
    throw new Error('The Modrinth project ID is invalid.');
  }
  return projectId;
}

function normalizeManagedModpackRecord(value: unknown): ManagedModrinthModpack {
  const record = managedModpackRecordSchema.parse(value);
  const managedFiles = [...new Set(record.managedFiles.map(validateManagedModpackPath))];
  return { ...record, managedFiles };
}

async function getEntry(serverUuid: string, directory: string, name: string) {
  try {
    const entries = await statFiles(serverUuid, directory, [name]);
    return entries.find((entry) => entry.name === name) ?? null;
  } catch (error) {
    if (getHttpStatus(error) === 404) return null;
    throw error;
  }
}

async function ensureRegistryDirectory(serverUuid: string): Promise<void> {
  const segments = REGISTRY_DIRECTORY.split('/').filter(Boolean);
  let current = '/';

  for (const segment of segments) {
    const entry = await getEntry(serverUuid, current, segment);
    if (entry) {
      if (!entry.directory || entry.symlink) {
        throw new Error('The All-in-One modpack registry path is not a safe directory.');
      }
    } else {
      await createDirectory(serverUuid, current, segment);
    }
    current = current === '/' ? `/${segment}` : `${current}/${segment}`;
  }
}

async function hasSafeDirectory(serverUuid: string, directory: string): Promise<boolean> {
  const segments = directory.split('/').filter(Boolean);
  let current = '/';

  for (const segment of segments) {
    const entry = await getEntry(serverUuid, current, segment);
    if (!entry) return false;
    if (!entry.directory || entry.symlink) {
      throw new Error(`The server directory ${current}/${segment} is not a safe directory.`);
    }
    current = current === '/' ? `/${segment}` : `${current}/${segment}`;
  }

  return true;
}

function markerFilename(projectId: string): string {
  return `${validateProjectId(projectId)}.json`;
}

async function readMarker(serverUuid: string, filename: string): Promise<ManagedModrinthModpack | null> {
  const entry = await getEntry(serverUuid, REGISTRY_DIRECTORY, filename);
  if (!entry) return null;
  if (!entry.file || entry.directory || entry.symlink) {
    throw new Error(`The managed modpack record ${filename} is not a regular file.`);
  }

  const file = await getFileContent(serverUuid, `${REGISTRY_DIRECTORY}/${filename}`);
  let value: unknown;
  try {
    value = JSON.parse(await file.text());
  } catch {
    throw new Error(`The managed modpack record ${filename} contains invalid JSON.`);
  }
  const record = normalizeManagedModpackRecord(value);
  if (markerFilename(record.projectId) !== filename) {
    throw new Error(`The managed modpack record ${filename} has a mismatched project ID.`);
  }
  return record;
}

export async function getManagedModrinthModpack(
  serverUuid: string,
  projectId: string,
): Promise<ManagedModrinthModpack | null> {
  if (!(await hasSafeDirectory(serverUuid, REGISTRY_DIRECTORY))) return null;
  return readMarker(serverUuid, markerFilename(projectId));
}

export async function listManagedModrinthModpacks(serverUuid: string): Promise<ManagedModrinthModpack[]> {
  const records: ManagedModrinthModpack[] = [];
  let total = Number.POSITIVE_INFINITY;
  if (!(await hasSafeDirectory(serverUuid, REGISTRY_DIRECTORY))) return records;

  try {
    for (let page = 1; records.length < total && page <= 100; page += 1) {
      const response = await loadDirectory(serverUuid, REGISTRY_DIRECTORY, page, 'name_asc');
      total = response.entries.total;
      for (const entry of response.entries.data) {
        if (!entry.file || entry.directory || entry.symlink || !/^[A-Za-z0-9_-]{1,100}\.json$/.test(entry.name)) {
          continue;
        }

        const record = await readMarker(serverUuid, entry.name);
        if (record) records.push(record);
      }
      if (response.entries.data.length === 0) break;
    }
  } catch (error) {
    if (getHttpStatus(error) === 404) return [];
    throw error;
  }

  return records.sort((left, right) => left.title.localeCompare(right.title));
}

export async function saveManagedModrinthModpack(
  serverUuid: string,
  value: ManagedModrinthModpack,
  replaceExisting = false,
): Promise<void> {
  const record = normalizeManagedModpackRecord(value);
  const filename = markerFilename(record.projectId);
  await ensureRegistryDirectory(serverUuid);

  const existing = await getEntry(serverUuid, REGISTRY_DIRECTORY, filename);
  if (existing && !replaceExisting) {
    throw new Error(`A managed record for ${record.title} already exists. Use the installed modpack's update action.`);
  }
  if (existing && (!existing.file || existing.directory || existing.symlink)) {
    throw new Error(`The managed modpack record ${filename} is not a regular file.`);
  }

  await saveFileContent(serverUuid, `${REGISTRY_DIRECTORY}/${filename}`, `${JSON.stringify(record, null, 2)}\n`);
}

export async function deleteManagedModrinthModpackFiles(serverUuid: string, paths: string[]): Promise<number> {
  const normalizedPaths = [...new Set(paths.map(validateManagedModpackPath))];
  const grouped = new Map<string, Set<string>>();

  for (const path of normalizedPaths) {
    const segments = path.split('/');
    const name = segments.pop();
    if (!name) continue;
    const directory = segments.length ? `/${segments.join('/')}` : '/';
    const names = grouped.get(directory) ?? new Set<string>();
    names.add(name);
    grouped.set(directory, names);
  }

  let deleted = 0;
  for (const [directory, names] of grouped) {
    if (!(await hasSafeDirectory(serverUuid, directory))) continue;
    let entries;
    try {
      entries = await statFiles(serverUuid, directory, [...names]);
    } catch (error) {
      if (getHttpStatus(error) === 404) continue;
      throw error;
    }

    const entriesByName = new Map(entries.map((entry) => [entry.name, entry]));
    const present: string[] = [];
    for (const name of names) {
      const entry = entriesByName.get(name);
      if (!entry) continue;
      if (!entry.file || entry.directory || entry.symlink) {
        throw new Error(
          `The managed modpack path ${directory}/${name} is no longer a regular file; it was left untouched.`,
        );
      }
      present.push(name);
    }

    if (present.length > 0) {
      await deleteFiles(serverUuid, directory, present);
      deleted += present.length;
    }
  }

  return deleted;
}

export async function deleteManagedModrinthModpackRecord(serverUuid: string, projectId: string): Promise<void> {
  const filename = markerFilename(projectId);
  if (!(await hasSafeDirectory(serverUuid, REGISTRY_DIRECTORY))) return;
  const entry = await getEntry(serverUuid, REGISTRY_DIRECTORY, filename);
  if (!entry) return;
  if (!entry.file || entry.directory || entry.symlink) {
    throw new Error(`The managed modpack record ${filename} is not a regular file.`);
  }
  await deleteFiles(serverUuid, REGISTRY_DIRECTORY, [filename]);
}
