import { axiosInstance } from '@/api/axios.ts';
import createDirectory from '@/api/server/files/createDirectory.ts';
import decompressFile from '@/api/server/files/decompressFile.ts';
import deleteFiles from '@/api/server/files/deleteFiles.ts';
import getFileContent from '@/api/server/files/getFileContent.ts';
import loadDirectory from '@/api/server/files/loadDirectory.ts';
import pullFile from '@/api/server/files/pullFile.ts';
import statFiles from '@/api/server/files/statFiles.ts';
import { SocketEvent } from '@/plugins/websocket/useWebsocketEvent.ts';
import type { Websocket } from '@/plugins/websocket/Websocket.ts';
import type { ModrinthVersionFile } from './modrinth.ts';

const OPERATION_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_MRPACK_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_MRPACK_FILE_COUNT = 1000;
const MAX_MRPACK_TOTAL_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_MRPACK_SINGLE_FILE_BYTES = 2 * 1024 * 1024 * 1024;
const TRUSTED_MODRINTH_FILE_HOSTS = new Set([
  'cdn.modrinth.com',
  'github.com',
  'raw.githubusercontent.com',
  'gitlab.com',
]);

export class PanelFileOperationTimeoutError extends Error {
  constructor() {
    super('The Panel file operation did not report a result in time.');
    this.name = 'PanelFileOperationTimeoutError';
  }
}

function hasHttpStatus(error: unknown, status: number): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'response' in error &&
    typeof error.response === 'object' &&
    error.response !== null &&
    'status' in error.response &&
    error.response.status === status
  );
}

function pathSegments(path: string): string[] {
  if (!path.startsWith('/') || path.includes('\\') || path.includes('\0')) {
    throw new Error('The server returned an unsafe file path.');
  }

  const segments = path.split('/').filter(Boolean);
  if (segments.some((segment) => !isSafePathSegment(segment))) {
    throw new Error('The server returned an unsafe file path.');
  }

  return segments;
}

function isSafePathSegment(segment: string): boolean {
  return (
    segment.length > 0 &&
    segment.length <= 255 &&
    segment !== '.' &&
    segment !== '..' &&
    !segment.includes('/') &&
    !segment.includes('\\') &&
    !segment.includes('\0') &&
    !segment.includes(':') &&
    !segment.includes('\r') &&
    !segment.includes('\n')
  );
}

export function validateModrinthDownloadUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Modrinth returned an invalid download URL.');
  }

  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !TRUSTED_MODRINTH_FILE_HOSTS.has(url.hostname.toLowerCase())
  ) {
    throw new Error('The download URL is not hosted on a trusted HTTPS Modrinth file domain.');
  }

  return url.toString();
}

async function getPathEntry(uuid: string, directory: string, name: string) {
  try {
    const entries = await statFiles(uuid, directory, [name]);
    return entries.find((entry) => entry.name === name) ?? null;
  } catch (error) {
    if (hasHttpStatus(error, 404)) return null;
    throw error;
  }
}

async function ensureServerDirectory(uuid: string, absolutePath: string): Promise<void> {
  const segments = pathSegments(absolutePath);
  let current = '/';

  for (const segment of segments) {
    const existing = await getPathEntry(uuid, current, segment);
    if (existing) {
      if (!existing.directory || existing.symlink) {
        throw new Error(`A non-directory entry blocks ${absolutePath}.`);
      }
    } else {
      await createDirectory(uuid, current, segment);
    }

    current = current === '/' ? `/${segment}` : `${current}/${segment}`;
  }
}

function splitServerPath(absolutePath: string): { directory: string; name: string } {
  const segments = pathSegments(absolutePath);
  const name = segments.pop();
  if (!name) throw new Error('A file path is required.');

  return {
    directory: segments.length ? `/${segments.join('/')}` : '/',
    name,
  };
}

function newStageName(): string {
  const token = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `calagopus-chat-stage-${token.replace(/[^A-Za-z0-9-]/g, '')}`;
}

export async function runPanelFileOperation(
  socket: Websocket,
  start: () => Promise<string | undefined>,
): Promise<void> {
  const finishedBeforeResponse = new Map<string, string | null>();
  let operationId: string | undefined;
  let resolveOperation: (() => void) | undefined;
  let rejectOperation: ((error: Error) => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const onCompleted = (uuid: string) => {
    if (operationId === uuid) resolveOperation?.();
    else finishedBeforeResponse.set(uuid, null);
  };
  const onError = (uuid: string, message?: string) => {
    const errorMessage = message || 'The Panel file operation failed.';
    if (operationId === uuid) rejectOperation?.(new Error(errorMessage));
    else finishedBeforeResponse.set(uuid, errorMessage);
  };
  const onAborted = (uuid: string) => {
    const errorMessage = 'The Panel file operation was aborted.';
    if (operationId === uuid) rejectOperation?.(new Error(errorMessage));
    else finishedBeforeResponse.set(uuid, errorMessage);
  };

  socket.addListener(SocketEvent.OPERATION_COMPLETED, onCompleted);
  socket.addListener(SocketEvent.OPERATION_ERROR, onError);
  socket.addListener(SocketEvent.OPERATION_ABORTED, onAborted);

  try {
    operationId = await start();
    if (!operationId) return;

    const alreadyFinished = finishedBeforeResponse.get(operationId);
    if (finishedBeforeResponse.has(operationId)) {
      if (alreadyFinished) throw new Error(alreadyFinished);
      return;
    }

    await new Promise<void>((resolve, reject) => {
      resolveOperation = resolve;
      rejectOperation = reject;
      timer = setTimeout(() => reject(new PanelFileOperationTimeoutError()), OPERATION_TIMEOUT_MS);
    });
  } finally {
    if (timer) clearTimeout(timer);
    socket.removeListener(SocketEvent.OPERATION_COMPLETED, onCompleted);
    socket.removeListener(SocketEvent.OPERATION_ERROR, onError);
    socket.removeListener(SocketEvent.OPERATION_ABORTED, onAborted);
  }
}

async function copyStagedFiles(
  uuid: string,
  socket: Websocket,
  files: OverrideFile[],
): Promise<number> {
  if (!files.length) return 0;

  const normalizedFiles = files.map((file) => ({
    relativePath: validateRelativePath(file.relativePath),
    sourcePath: pathSegments(file.sourcePath).join('/'),
  }));
  const { data } = await axiosInstance.post(`/api/client/servers/${uuid}/files/copy-many`, {
    root: '/',
    files: normalizedFiles.map((file) => ({ from: file.sourcePath, to: file.relativePath })),
    overwrite: false,
  });

  await runPanelFileOperation(socket, async () => data.identifier);

  const byDirectory = new Map<string, Set<string>>();
  for (const file of normalizedFiles) {
    const { directory, name } = splitServerPath(`/${file.relativePath}`);
    const names = byDirectory.get(directory) ?? new Set<string>();
    names.add(name);
    byDirectory.set(directory, names);
  }

  let missing = 0;
  for (const [directory, names] of byDirectory) {
    try {
      const entries = await statFiles(uuid, directory, [...names]);
      const present = new Set(entries.map((entry) => entry.name));
      missing += [...names].filter((name) => !present.has(name)).length;
    } catch (error) {
      if (hasHttpStatus(error, 404)) missing += names.size;
      else throw error;
    }
  }

  const reportedSkipped = Array.isArray(data.skipped) ? data.skipped.length : 0;
  return Math.min(normalizedFiles.length, reportedSkipped + missing);
}

export async function installModrinthFile(
  uuid: string,
  socket: Websocket,
  folder: '/mods' | '/plugins',
  file: ModrinthVersionFile,
): Promise<{ cleanupFailed: boolean }> {
  if (!file.filename.toLowerCase().endsWith('.jar') || !isSafePathSegment(file.filename)) {
    throw new Error('The selected Modrinth version does not contain a .jar file.');
  }
  validateModrinthDownloadUrl(file.url);

  const stageName = newStageName();
  const stagePath = `/${stageName}`;
  let stageCreated = false;
  let safeToCleanup = true;
  let failure: unknown;
  let cleanupFailed = false;

  try {
    await createDirectory(uuid, '/', stageName);
    stageCreated = true;
    await ensureServerDirectory(uuid, folder);
    if (await getPathEntry(uuid, folder, file.filename)) {
      throw new Error(`The file ${file.filename} already exists; it was not overwritten.`);
    }

    await runPanelFileOperation(socket, () =>
      pullFile(uuid, {
        root: stagePath,
        url: validateModrinthDownloadUrl(file.url),
        name: file.filename,
      }),
    );

    const skipped = await copyStagedFiles(uuid, socket, [
      {
        relativePath: `${folder.slice(1)}/${file.filename}`,
        sourcePath: `${stagePath}/${file.filename}`,
      },
    ]);
    if (skipped > 0) {
      throw new Error(`The file ${file.filename} already exists; it was not overwritten.`);
    }
  } catch (error) {
    failure = error;
    if (error instanceof PanelFileOperationTimeoutError) safeToCleanup = false;
  } finally {
    if (stageCreated && safeToCleanup) {
      try {
        await deleteFiles(uuid, '/', [stageName]);
      } catch {
        cleanupFailed = true;
      }
    }
  }

  if (failure) {
    if (cleanupFailed) {
      const message = failure instanceof Error ? failure.message : String(failure);
      throw new Error(`${message} The temporary staging folder could not be removed.`);
    }
    throw failure;
  }
  return { cleanupFailed };
}

interface ManifestFile {
  path: string;
  downloads: string[];
  fileSize: number;
  env?: { server?: string };
}

interface Manifest {
  formatVersion: number;
  game: string;
  files: ManifestFile[];
  dependencies: Record<string, string>;
}

interface OverrideFile {
  relativePath: string;
  sourcePath: string;
}

interface PlannedInstall {
  kind: 'download' | 'copy';
  path: string;
  url?: string;
  sourcePath?: string;
}

export interface ModpackInstallProgress {
  stage: 'download' | 'extract' | 'prepare' | 'install' | 'cleanup';
  current: number;
  total: number;
}

export interface ModpackInstallResult {
  installed: number;
  skipped: number;
  dependencies: Record<string, string>;
  cleanupFailed: boolean;
}

function validateRelativePath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 1024 || value.startsWith('/')) {
    throw new Error('The modpack manifest contains an unsafe file path.');
  }

  const segments = value.split('/');
  if (segments.some((segment) => !isSafePathSegment(segment))) {
    throw new Error('The modpack manifest contains an unsafe file path.');
  }

  return segments.join('/');
}

function safeDependencyRecord(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};

  return Object.fromEntries(
    Object.entries(value).filter(
      ([key, version]) => key.length <= 64 && typeof version === 'string' && version.length <= 64,
    ),
  ) as Record<string, string>;
}

async function listOverrideFiles(uuid: string, directory: string, maxFiles: number): Promise<OverrideFile[]> {
  const path = splitServerPath(directory);
  const entry = await getPathEntry(uuid, path.directory, path.name);
  if (!entry) return [];
  if (!entry.directory || entry.symlink) throw new Error(`The modpack ${path.name} entry is not a safe directory.`);

  const result: OverrideFile[] = [];
  let visitedEntries = 0;
  const visit = async (currentDirectory: string, relativePrefix: string): Promise<void> => {
    if (relativePrefix.split('/').filter(Boolean).length > 64) {
      throw new Error('The modpack override directory structure is too deep.');
    }

    let page = 1;
    const entries = [] as Awaited<ReturnType<typeof loadDirectory>>['entries']['data'];
    let total = 0;

    do {
      const response = await loadDirectory(uuid, currentDirectory, page, 'name_asc');
      entries.push(...response.entries.data);
      total = response.entries.total;
      page += 1;
    } while (entries.length < total);

    for (const item of entries) {
      visitedEntries += 1;
      if (visitedEntries > maxFiles * 4) throw new Error('The modpack contains too many override entries.');
      if (item.symlink || !isSafePathSegment(item.name)) continue;
      const relativePath = relativePrefix ? `${relativePrefix}/${item.name}` : item.name;
      const sourcePath = currentDirectory === '/' ? `/${item.name}` : `${currentDirectory}/${item.name}`;

      if (item.directory) {
        await visit(sourcePath, relativePath);
      } else if (item.file) {
        result.push({ relativePath: validateRelativePath(relativePath), sourcePath });
        if (result.length > maxFiles) throw new Error('The modpack contains too many override files.');
      }
    }
  };

  await visit(directory, '');
  return result;
}

function shouldSkipOverride(relativePath: string, allowServerMods: boolean): boolean {
  const lower = relativePath.toLowerCase();
  const first = lower.split('/')[0];
  return (
    (!allowServerMods && first === 'mods') ||
    first === 'resourcepacks' ||
    first === 'shaderpacks' ||
    first === 'screenshots' ||
    first === 'saves' ||
    lower === 'options.txt' ||
    lower === 'servers.dat'
  );
}

export async function installModrinthModpack(
  uuid: string,
  socket: Websocket,
  file: ModrinthVersionFile,
  onProgress: (progress: ModpackInstallProgress) => void,
): Promise<ModpackInstallResult> {
  if (!file.filename.toLowerCase().endsWith('.mrpack')) {
    throw new Error('The selected Modrinth version does not contain an .mrpack file.');
  }
  if (file.size && file.size > MAX_MRPACK_SINGLE_FILE_BYTES) {
    throw new Error('This modpack archive is larger than the supported 2 GiB limit.');
  }

  const stageName = newStageName();
  const stagePath = `/${stageName}`;
  let stageCreated = false;
  let safeToCleanup = true;
  let failure: unknown;
  let result: Omit<ModpackInstallResult, 'cleanupFailed'> | undefined;
  let cleanupFailed = false;
  let optionalSkipped = 0;

  try {
    await createDirectory(uuid, '/', stageName);
    stageCreated = true;

    onProgress({ stage: 'download', current: 0, total: 1 });
    await runPanelFileOperation(socket, () =>
      pullFile(uuid, {
        root: stagePath,
        url: validateModrinthDownloadUrl(file.url),
        name: 'modpack.zip',
      }),
    );

    onProgress({ stage: 'extract', current: 0, total: 1 });
    await runPanelFileOperation(socket, () => decompressFile(uuid, stagePath, 'modpack.zip'));

    const manifestEntry = await getPathEntry(uuid, stagePath, 'modrinth.index.json');
    if (!manifestEntry?.file || manifestEntry.symlink) {
      throw new Error('The modpack archive does not contain a valid root modrinth.index.json file.');
    }
    if (manifestEntry.size > MAX_MRPACK_MANIFEST_BYTES) {
      throw new Error('The modpack manifest is larger than the supported limit.');
    }

    const manifestBlob = await getFileContent(uuid, `${stagePath}/modrinth.index.json`);
    let manifest: Manifest;
    try {
      manifest = JSON.parse(await manifestBlob.text()) as Manifest;
    } catch {
      throw new Error('The modpack contains an invalid modrinth.index.json manifest.');
    }

    if (
      manifest.formatVersion !== 1 ||
      manifest.game !== 'minecraft' ||
      !Array.isArray(manifest.files) ||
      manifest.files.length > MAX_MRPACK_FILE_COUNT
    ) {
      throw new Error('This Modrinth modpack format is not supported.');
    }

    const dependencies = safeDependencyRecord(manifest.dependencies);
    const planned = new Map<string, PlannedInstall>();
    let totalDownloadBytes = 0;

    for (const packFile of manifest.files) {
      const serverEnvironment = packFile?.env?.server;
      if (serverEnvironment === 'unsupported') continue;
      if (serverEnvironment === 'optional') {
        optionalSkipped += 1;
        continue;
      }
      if (serverEnvironment !== undefined && serverEnvironment !== 'required') {
        throw new Error('The modpack contains an unsupported server environment value.');
      }

      const targetPath = validateRelativePath(packFile?.path);
      if (!Array.isArray(packFile.downloads) || packFile.downloads.length === 0) {
        throw new Error(`The server modpack file ${targetPath} has no download URL.`);
      }
      if (!Number.isSafeInteger(packFile.fileSize) || packFile.fileSize < 0) {
        throw new Error(`The server modpack file ${targetPath} has an invalid file size.`);
      }

      const url = packFile.downloads.map((candidate) => {
        try {
          return validateModrinthDownloadUrl(candidate);
        } catch {
          return null;
        }
      }).find((candidate): candidate is string => candidate !== null);

      if (!url) throw new Error(`The server modpack file ${targetPath} has no trusted Modrinth CDN URL.`);
      if (packFile.fileSize && packFile.fileSize > MAX_MRPACK_SINGLE_FILE_BYTES) {
        throw new Error(`The server modpack file ${targetPath} is larger than the supported limit.`);
      }
      totalDownloadBytes += packFile.fileSize;
      if (totalDownloadBytes > MAX_MRPACK_TOTAL_BYTES) {
        throw new Error('The total modpack download size is larger than the supported 8 GiB limit.');
      }

      planned.set(targetPath, { kind: 'download', path: targetPath, url });
    }

    const commonOverrides = await listOverrideFiles(uuid, `${stagePath}/overrides`, MAX_MRPACK_FILE_COUNT);
    for (const override of commonOverrides) {
      if (!shouldSkipOverride(override.relativePath, false)) {
        planned.set(override.relativePath, {
          kind: 'copy',
          path: override.relativePath,
          sourcePath: override.sourcePath,
        });
      }
    }

    const serverOverrides = await listOverrideFiles(
      uuid,
      `${stagePath}/server-overrides`,
      MAX_MRPACK_FILE_COUNT,
    );
    for (const override of serverOverrides) {
      if (shouldSkipOverride(override.relativePath, true)) continue;
      planned.set(override.relativePath, {
        kind: 'copy',
        path: override.relativePath,
        sourcePath: override.sourcePath,
      });
    }

    if (planned.size > MAX_MRPACK_FILE_COUNT * 2) {
      throw new Error('The modpack contains too many server files and overrides.');
    }

    const ready: PlannedInstall[] = [];
    let skipped = optionalSkipped;
    onProgress({ stage: 'prepare', current: 0, total: planned.size });

    for (const item of planned.values()) {
      const relativePath = validateRelativePath(item.path);
      const absolutePath = `/${relativePath}`;
      const { directory, name } = splitServerPath(absolutePath);
      await ensureServerDirectory(uuid, directory);
      const existing = await getPathEntry(uuid, directory, name);

      if (existing) {
        skipped += 1;
        continue;
      }

      ready.push({ ...item, path: relativePath });
      onProgress({ stage: 'prepare', current: ready.length + skipped, total: planned.size });
    }

    const downloads = ready.filter((item) => item.kind === 'download');
    const overrides = ready.filter((item) => item.kind === 'copy');
    let installed = 0;

    for (const [index, item] of downloads.entries()) {
      const stagedPath = `${stagePath}/downloads/${item.path}`;
      const { directory, name } = splitServerPath(stagedPath);
      await ensureServerDirectory(uuid, directory);
      onProgress({ stage: 'install', current: index + 1, total: downloads.length + (ready.length ? 1 : 0) });
      await runPanelFileOperation(socket, () =>
        pullFile(uuid, {
          root: directory,
          url: item.url!,
          name,
        }),
      );
    }

    if (ready.length) {
      onProgress({ stage: 'install', current: downloads.length + 1, total: downloads.length + 1 });
      const stagedFiles = [
        ...downloads.map((item) => ({
          relativePath: item.path,
          sourcePath: `${stagePath}/downloads/${item.path}`,
        })),
        ...overrides.map((item) => ({
          relativePath: item.path,
          sourcePath: item.sourcePath!,
        })),
      ];
      const copySkipped = await copyStagedFiles(
        uuid,
        socket,
        stagedFiles,
      );
      skipped += copySkipped;
      installed += Math.max(0, stagedFiles.length - copySkipped);
    }

    result = { installed, skipped, dependencies };
  } catch (error) {
    failure = error;
    if (error instanceof PanelFileOperationTimeoutError) safeToCleanup = false;
  } finally {
    if (stageCreated && safeToCleanup) {
      onProgress({ stage: 'cleanup', current: 0, total: 1 });
      try {
        await deleteFiles(uuid, '/', [stageName]);
      } catch {
        cleanupFailed = true;
      }
    }
  }

  if (failure) {
    if (cleanupFailed) {
      const message = failure instanceof Error ? failure.message : String(failure);
      throw new Error(`${message} The temporary staging folder could not be removed.`);
    }
    throw failure;
  }
  if (!result) throw new Error('The modpack could not be installed.');
  return { ...result, cleanupFailed };
}
