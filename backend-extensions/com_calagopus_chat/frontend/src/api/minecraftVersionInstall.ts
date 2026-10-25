import copyFiles from '@/api/server/files/copyFiles.ts';
import createDirectory from '@/api/server/files/createDirectory.ts';
import decompressFile from '@/api/server/files/decompressFile.ts';
import deleteFiles from '@/api/server/files/deleteFiles.ts';
import getFileContent from '@/api/server/files/getFileContent.ts';
import loadDirectory from '@/api/server/files/loadDirectory.ts';
import pullFile from '@/api/server/files/pullFile.ts';
import statFiles from '@/api/server/files/statFiles.ts';
import saveFileContent from '@/api/server/files/saveFileContent.ts';
import type { Websocket } from '@/plugins/websocket/Websocket.ts';
import { PanelFileOperationTimeoutError, runPanelFileOperation } from './serverFiles.ts';

const MAX_INSTALL_STEPS = 250;
const MAX_INSTALL_FILES = 5000;
const MAX_INSTALL_DIRECTORY_PAGES = 100;
const MAX_SINGLE_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_INSTALL_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_TOTAL_INSTALL_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_COMPRESSION_RATIO = 200;
const TRUSTED_MINECRAFT_DOWNLOAD_HOSTS = new Set([
  'piston-data.mojang.com',
  'piston-meta.mojang.com',
  'launcher.mojang.com',
  'libraries.minecraft.net',
  'fill-data.papermc.io',
  'api.papermc.io',
  'repo.papermc.io',
  'api.purpurmc.org',
  'versions.mcjars.app',
  'files.mcjars.app',
  'maven.minecraftforge.net',
  'files.minecraftforge.net',
  'maven.neoforged.net',
  'maven.fabricmc.net',
  'meta.fabricmc.net',
  'maven.quiltmc.org',
  'meta.quiltmc.org',
  'repo.spongepowered.org',
  'github.com',
  'raw.githubusercontent.com',
]);
const PROTECTED_SERVER_PATHS = new Set([
  'backups',
  'banned-ips.json',
  'banned-players.json',
  'config',
  'crash-reports',
  'eula.txt',
  'logs',
  'mods',
  'ops.json',
  'plugins',
  'server.properties',
  'usercache.json',
  'whitelist.json',
  'world',
  'world_nether',
  'world_the_end',
  'worlds',
]);

export interface MinecraftInstallProgress {
  stage: 'download' | 'extract' | 'prepare' | 'install' | 'cleanup';
  current: number;
  total: number;
}

export interface MinecraftInstallFile {
  relativePath: string;
  sourcePath: string;
  size: number;
}

export interface PreparedMinecraftVersionInstall {
  stageName: string;
  files: MinecraftInstallFile[];
  removePaths: string[];
  conflicts: string[];
  totalBytes: number;
}

type MinecraftInstallStep =
  | { type: 'download'; url: string; file: string; size?: number }
  | { type: 'unzip'; file: string; location: string }
  | { type: 'remove'; location: string };

export interface MinecraftVersionPlanSummary {
  downloads: string[];
  removals: string[];
  usesArchives: boolean;
}

interface DirectoryEntry {
  name: string;
  file: boolean;
  directory: boolean;
  symlink: boolean;
  size: number;
}

export function validateMinecraftDownloadUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('The Minecraft version provider returned an invalid download URL.');
  }

  const hostname = url.hostname.toLowerCase();
  const trustedHost =
    TRUSTED_MINECRAFT_DOWNLOAD_HOSTS.has(hostname) ||
    hostname.endsWith('.mcjars.app') ||
    hostname.endsWith('.githubusercontent.com');
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || !trustedHost) {
    throw new Error('The version download URL is not on an approved HTTPS host.');
  }

  return url.toString();
}

function isSafeSegment(segment: string): boolean {
  return (
    segment.length > 0 && segment.length <= 255 && segment !== '.' && segment !== '..' && !/[\\:\0\r\n]/.test(segment)
  );
}

function safeRelativePath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 1024 || value.startsWith('/') || value.includes('\\')) {
    throw new Error('The version installer returned an unsafe path.');
  }
  const segments = value.split('/');
  if (segments.some((segment) => !isSafeSegment(segment))) {
    throw new Error('The version installer returned an unsafe path.');
  }
  return segments.join('/');
}

function safeLocation(value: unknown): string {
  if (value === '.' || value === '' || value === undefined) return '';
  return safeRelativePath(value);
}

function isProtectedPath(path: string): boolean {
  const segments = path.split('/').map((segment) => segment.toLowerCase());
  return (
    segments.some((segment) => PROTECTED_SERVER_PATHS.has(segment)) ||
    segments[0].startsWith('calagopus-version-stage-')
  );
}

interface ZipEntrySummary {
  archivePath: string;
  path: string | null;
  directory: boolean;
  compressedSize: number;
  uncompressedSize: number;
  crc32: number;
  localHeaderOffset: number;
  flags: number;
  compressionMethod: number;
}

interface ZipInspectionResult {
  fileCount: number;
  uncompressedSize: number;
  paths: Array<{ path: string; directory: boolean }>;
}

interface StagedPathRegistry {
  kinds: Map<string, 'directory' | 'file'>;
  descendants: Map<string, number>;
}

function readZipName(bytes: Uint8Array, utf8: boolean): string {
  if (!utf8 && bytes.some((byte) => byte >= 0x80)) {
    throw new Error('The installer archive uses an unsupported legacy filename encoding.');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('The installer archive contains an invalid filename encoding.');
  }
}

function validateZipExtraFields(bytes: Uint8Array, start: number, length: number): void {
  const end = start + length;
  if (end > bytes.length) throw new Error('The installer archive contains malformed ZIP metadata.');
  let cursor = start;
  while (cursor < end) {
    if (cursor + 4 > end) throw new Error('The installer archive contains malformed ZIP metadata.');
    const fieldId = bytes[cursor] | (bytes[cursor + 1] << 8);
    const fieldLength = bytes[cursor + 2] | (bytes[cursor + 3] << 8);
    cursor += 4;
    if (cursor + fieldLength > end) throw new Error('The installer archive contains malformed ZIP metadata.');
    // These fields can override names or sizes in ways the staging validator cannot safely honor.
    if (fieldId === 0x0001 || fieldId === 0x7075) {
      throw new Error('The installer archive uses unsupported ZIP64 or alternate filename metadata.');
    }
    cursor += fieldLength;
  }
}

function safeZipEntryPath(value: string, directory: boolean): string | null {
  if (!value || value.startsWith('/') || value.includes('\\') || value.includes('\0')) {
    throw new Error('The installer archive contains an unsafe file path.');
  }

  const segments = value.split('/');
  if (directory && segments.at(-1) === '') segments.pop();
  if (segments[0] === '.') segments.shift();
  if (!segments.length) return null;
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('The installer archive contains an unsafe file path.');
  }

  return safeRelativePath(segments.join('/'));
}

function registerStagedPath(registry: StagedPathRegistry, path: string, directory: boolean): void {
  const normalized = safeRelativePath(path).toLocaleLowerCase('en-US');
  const segments = normalized.split('/');
  for (let index = 1; index < segments.length; index += 1) {
    const parent = segments.slice(0, index).join('/');
    if (registry.kinds.get(parent) === 'file') {
      throw new Error(`The installer has a file/directory path conflict at ${parent}.`);
    }
    if (!registry.kinds.has(parent)) registry.kinds.set(parent, 'directory');
    registry.descendants.set(parent, (registry.descendants.get(parent) ?? 0) + 1);
  }

  const existingKind = registry.kinds.get(normalized);
  if (existingKind) {
    if (directory && existingKind === 'directory') return;
    throw new Error(`Multiple installer steps target the same staged path: ${path}`);
  }
  if (!directory && (registry.descendants.get(normalized) ?? 0) > 0) {
    throw new Error(`The installer has a file/directory path conflict at ${path}.`);
  }
  registry.kinds.set(normalized, directory ? 'directory' : 'file');
}

function inspectZipArchive(bytes: Uint8Array, extractionLocation: string): ZipInspectionResult {
  if (bytes.length < 22) throw new Error('The installer archive is incomplete.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const searchStart = Math.max(0, bytes.length - 22 - 65_535);
  let endRecordOffset = -1;

  for (let offset = bytes.length - 22; offset >= searchStart; offset -= 1) {
    if (view.getUint32(offset, true) !== 0x06054b50) continue;
    const commentLength = view.getUint16(offset + 20, true);
    if (offset + 22 + commentLength === bytes.length) {
      endRecordOffset = offset;
      break;
    }
  }
  if (endRecordOffset < 0) throw new Error('The installer archive has no valid ZIP directory.');

  const diskNumber = view.getUint16(endRecordOffset + 4, true);
  const directoryDiskNumber = view.getUint16(endRecordOffset + 6, true);
  const entriesOnDisk = view.getUint16(endRecordOffset + 8, true);
  const entryCount = view.getUint16(endRecordOffset + 10, true);
  const directorySize = view.getUint32(endRecordOffset + 12, true);
  const directoryOffset = view.getUint32(endRecordOffset + 16, true);
  if (
    diskNumber !== 0 ||
    directoryDiskNumber !== 0 ||
    entriesOnDisk !== entryCount ||
    entryCount === 0xffff ||
    directorySize === 0xffffffff ||
    directoryOffset === 0xffffffff ||
    entryCount > MAX_INSTALL_FILES ||
    directoryOffset + directorySize !== endRecordOffset
  ) {
    throw new Error('The installer archive uses an unsupported multi-disk or ZIP64 layout.');
  }

  const entries: ZipEntrySummary[] = [];
  const normalizedNames = new Set<string>();
  const localRanges: Array<[number, number]> = [];
  let cursor = directoryOffset;
  let totalUncompressedSize = 0;
  let fileCount = 0;

  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > endRecordOffset || view.getUint32(cursor, true) !== 0x02014b50) {
      throw new Error('The installer archive has a malformed ZIP directory.');
    }

    const versionMadeBy = view.getUint16(cursor + 4, true);
    const flags = view.getUint16(cursor + 8, true);
    const compressionMethod = view.getUint16(cursor + 10, true);
    const crc32 = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const filenameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const externalAttributes = view.getUint32(cursor + 38, true);
    const localHeaderOffset = view.getUint32(cursor + 42, true);
    const nextCursor = cursor + 46 + filenameLength + extraLength + commentLength;
    if (
      nextCursor > endRecordOffset ||
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff ||
      (flags & 0x0041) !== 0 ||
      ![0, 8].includes(compressionMethod) ||
      uncompressedSize > MAX_SINGLE_DOWNLOAD_BYTES ||
      (uncompressedSize > 1024 * 1024 && uncompressedSize / Math.max(compressedSize, 1) > MAX_ARCHIVE_COMPRESSION_RATIO)
    ) {
      throw new Error('The installer archive contains an unsupported, encrypted, or oversized entry.');
    }
    validateZipExtraFields(bytes, cursor + 46 + filenameLength, extraLength);

    const filename = readZipName(bytes.subarray(cursor + 46, cursor + 46 + filenameLength), (flags & 0x0800) !== 0);
    const unixHost = versionMadeBy >>> 8 === 3;
    const unixFileType = (externalAttributes >>> 16) & 0xf000;
    const directoryEntry =
      filename.endsWith('/') ||
      (unixHost && unixFileType === 0x4000) ||
      (!unixHost && (externalAttributes & 0x10) !== 0);
    if (directoryEntry && uncompressedSize !== 0) {
      throw new Error('The installer archive contains a non-empty directory entry.');
    }
    const isDirectory = directoryEntry;
    const path = safeZipEntryPath(filename, isDirectory);
    if (!path && !isDirectory) {
      throw new Error('The installer archive contains a non-directory entry for the staging root.');
    }
    const windowsReparsePoint = (externalAttributes & 0x0400) !== 0;
    if ((unixHost && unixFileType === 0xa000) || windowsReparsePoint) {
      throw new Error('The installer archive contains a symbolic link or reparse point.');
    }
    if (unixHost && ![0, 0x4000, 0x8000, 0xa000].includes(unixFileType)) {
      throw new Error('The installer archive contains an unsupported special file.');
    }

    const fullPath = path ? (extractionLocation ? `${extractionLocation}/${path}` : path) : null;
    if (fullPath) {
      if (isProtectedPath(fullPath)) {
        throw new Error(`The installer archive targets protected server data: ${fullPath}`);
      }
      const foldedPath = fullPath.toLocaleLowerCase('en-US');
      if (normalizedNames.has(foldedPath)) {
        throw new Error(`The installer archive repeats a path: ${fullPath}`);
      }
      normalizedNames.add(foldedPath);
      if (!isDirectory) {
        fileCount += 1;
        if (fileCount > MAX_INSTALL_FILES) throw new Error('The installer archive contains too many files.');
        totalUncompressedSize += uncompressedSize;
        if (totalUncompressedSize > MAX_TOTAL_INSTALL_BYTES) {
          throw new Error('The installer archive expands beyond the supported total size.');
        }
      }
    }
    entries.push({
      archivePath: filename,
      path: fullPath,
      directory: isDirectory,
      compressedSize,
      uncompressedSize,
      crc32,
      localHeaderOffset,
      flags,
      compressionMethod,
    });

    cursor = nextCursor;
  }

  if (cursor !== endRecordOffset) throw new Error('The installer archive ZIP directory is inconsistent.');

  const pathKinds = new Map(
    entries.flatMap((entry) => (entry.path ? [[entry.path.toLocaleLowerCase('en-US'), entry.directory] as const] : [])),
  );
  for (const entry of entries) {
    if (entry.path) {
      const segments = entry.path.split('/');
      for (let index = 1; index < segments.length; index += 1) {
        const parent = segments.slice(0, index).join('/').toLocaleLowerCase('en-US');
        if (pathKinds.has(parent) && pathKinds.get(parent) === false) {
          throw new Error('The installer archive contains a file/directory path conflict.');
        }
      }
    }
    const localOffset = entry.localHeaderOffset;
    if (localOffset + 30 > directoryOffset || view.getUint32(localOffset, true) !== 0x04034b50) {
      throw new Error('The installer archive contains an invalid local file header.');
    }
    const localFlags = view.getUint16(localOffset + 6, true);
    const localMethod = view.getUint16(localOffset + 8, true);
    const localCrc32 = view.getUint32(localOffset + 14, true);
    const localCompressedSize = view.getUint32(localOffset + 18, true);
    const localUncompressedSize = view.getUint32(localOffset + 22, true);
    const localFilenameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    if (localOffset + 30 + localFilenameLength + localExtraLength > directoryOffset) {
      throw new Error('The installer archive contains an invalid local file header.');
    }
    validateZipExtraFields(bytes, localOffset + 30 + localFilenameLength, localExtraLength);
    const localNameStart = localOffset + 30;
    const localDataStart = localNameStart + localFilenameLength + localExtraLength;
    const localName = readZipName(
      bytes.subarray(localNameStart, localNameStart + localFilenameLength),
      (localFlags & 0x0800) !== 0,
    );
    const dataEnd = localDataStart + entry.compressedSize;
    let localRangeEnd = dataEnd;
    const usesDataDescriptor = (entry.flags & 0x0008) !== 0;
    let descriptorValuesMatch = true;
    if (usesDataDescriptor) {
      const hasDescriptorSignature = dataEnd + 4 <= directoryOffset && view.getUint32(dataEnd, true) === 0x08074b50;
      const descriptorStart = dataEnd + (hasDescriptorSignature ? 4 : 0);
      if (descriptorStart + 12 > directoryOffset) {
        throw new Error('The installer archive contains an incomplete ZIP data descriptor.');
      }
      descriptorValuesMatch =
        view.getUint32(descriptorStart, true) === entry.crc32 &&
        view.getUint32(descriptorStart + 4, true) === entry.compressedSize &&
        view.getUint32(descriptorStart + 8, true) === entry.uncompressedSize;
      localRangeEnd = descriptorStart + 12;
    }
    if (
      dataEnd > directoryOffset ||
      localName !== entry.archivePath ||
      localFlags !== entry.flags ||
      localMethod !== entry.compressionMethod ||
      localCrc32 === 0xffffffff ||
      localCompressedSize === 0xffffffff ||
      localUncompressedSize === 0xffffffff ||
      (usesDataDescriptor
        ? ![0, entry.crc32].includes(localCrc32) ||
          ![0, entry.compressedSize].includes(localCompressedSize) ||
          ![0, entry.uncompressedSize].includes(localUncompressedSize) ||
          !descriptorValuesMatch
        : localCrc32 !== entry.crc32 ||
          localCompressedSize !== entry.compressedSize ||
          localUncompressedSize !== entry.uncompressedSize)
    ) {
      throw new Error('The installer archive local and central directories do not match.');
    }
    localRanges.push([localOffset, localRangeEnd]);
  }

  localRanges.sort((left, right) => left[0] - right[0]);
  for (let index = 1; index < localRanges.length; index += 1) {
    if (localRanges[index][0] < localRanges[index - 1][1]) {
      throw new Error('The installer archive contains overlapping local file entries.');
    }
  }

  return {
    fileCount,
    uncompressedSize: totalUncompressedSize,
    paths: entries.flatMap((entry) => (entry.path ? [{ path: entry.path, directory: entry.directory }] : [])),
  };
}

function normalizeInstallationPlan(value: unknown): MinecraftInstallStep[] {
  const steps: MinecraftInstallStep[] = [];
  const visit = (current: unknown, depth: number): void => {
    if (depth > 4) throw new Error('The version installer plan is nested too deeply.');
    if (Array.isArray(current)) {
      for (const child of current) visit(child, depth + 1);
      return;
    }
    if (typeof current !== 'object' || current === null) {
      throw new Error('The version provider returned an invalid installation plan.');
    }
    const item = current as Record<string, unknown>;
    if (item.type === 'download') {
      if (typeof item.url !== 'string' || typeof item.file !== 'string') {
        throw new Error('A download step in the version installer plan is invalid.');
      }
      if (
        item.size !== undefined &&
        (typeof item.size !== 'number' ||
          !Number.isSafeInteger(item.size) ||
          item.size < 1 ||
          item.size > MAX_SINGLE_DOWNLOAD_BYTES)
      ) {
        throw new Error('A version installer download exceeds the supported size limit.');
      }
      const file = safeRelativePath(item.file);
      if (isProtectedPath(file)) throw new Error(`The installer targets protected server data: ${file}`);
      steps.push({
        type: 'download',
        url: validateMinecraftDownloadUrl(item.url),
        file,
        size: typeof item.size === 'number' ? item.size : undefined,
      });
      return;
    }
    if (item.type === 'unzip') {
      if (typeof item.file !== 'string' || typeof item.location !== 'string') {
        throw new Error('An archive step in the version installer plan is invalid.');
      }
      const archiveFile = safeRelativePath(item.file);
      if (archiveFile.includes('/')) throw new Error('The version installer archive filename is invalid.');
      steps.push({ type: 'unzip', file: archiveFile, location: safeLocation(item.location) });
      return;
    }
    if (item.type === 'remove') {
      if (typeof item.location !== 'string') throw new Error('A remove step in the version installer plan is invalid.');
      const location = safeLocation(item.location);
      if (!location || isProtectedPath(location)) {
        throw new Error(`The version installer requested an unsafe removal path: ${item.location}`);
      }
      steps.push({ type: 'remove', location });
      return;
    }
    if (Array.isArray(item.value)) {
      visit(item.value, depth + 1);
      return;
    }
    throw new Error('The version provider returned an unsupported installation step.');
  };

  visit(value, 0);
  if (steps.length === 0 || steps.length > MAX_INSTALL_STEPS) {
    throw new Error('The version provider returned an empty or oversized installation plan.');
  }
  return steps;
}

export function previewMinecraftVersionPlan(value: unknown): MinecraftVersionPlanSummary {
  const steps = normalizeInstallationPlan(value);
  return {
    downloads: steps.filter((step) => step.type === 'download').map((step) => step.file),
    removals: steps.flatMap((step) => {
      if (step.type !== 'remove') return [];
      const isTemporaryArchive =
        step.location.toLowerCase().endsWith('.zip') &&
        steps.some((candidate) => candidate.type === 'download' && candidate.file === step.location);
      return isTemporaryArchive ? [] : [step.location];
    }),
    usesArchives: steps.some((step) => step.type === 'unzip'),
  };
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

function randomStageName(): string {
  const token = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `calagopus-version-stage-${token.replace(/[^A-Za-z0-9-]/g, '')}`;
}

function parentAndName(path: string): { parent: string; name: string } {
  const segments = path.split('/');
  const name = segments.pop();
  if (!name) throw new Error('A safe file path is required.');
  return { parent: segments.length ? segments.join('/') : '', name };
}

async function ensureDirectory(
  uuid: string,
  absolutePath: string,
  ensuredDirectories = new Set<string>(['/']),
): Promise<void> {
  if (!absolutePath.startsWith('/') || absolutePath.includes('\\')) {
    throw new Error('The server returned an unsafe directory path.');
  }
  const segments = absolutePath.split('/').filter(Boolean);
  if (segments.some((segment) => !isSafeSegment(segment))) {
    throw new Error('The server returned an unsafe directory path.');
  }
  let current = '/';
  for (const segment of segments) {
    const next = current === '/' ? `/${segment}` : `${current}/${segment}`;
    if (ensuredDirectories.has(next)) {
      current = next;
      continue;
    }
    let existing: DirectoryEntry | null = null;
    try {
      const entries = await statFiles(uuid, current, [segment]);
      existing = (entries.find((entry) => entry.name === segment) as DirectoryEntry | undefined) ?? null;
    } catch (error) {
      if (!hasHttpStatus(error, 404)) throw error;
    }
    if (existing) {
      if (!existing.directory || existing.symlink) throw new Error(`A non-directory entry blocks ${absolutePath}.`);
    } else {
      await createDirectory(uuid, current, segment);
    }
    ensuredDirectories.add(next);
    current = next;
  }
}

async function getEntry(uuid: string, directory: string, name: string): Promise<DirectoryEntry | null> {
  try {
    const entries = await statFiles(uuid, directory, [name]);
    return (entries.find((entry) => entry.name === name) as DirectoryEntry | undefined) ?? null;
  } catch (error) {
    if (hasHttpStatus(error, 404)) return null;
    throw error;
  }
}

async function getEntries(uuid: string, directory: string, names: string[]): Promise<DirectoryEntry[]> {
  const entries: DirectoryEntry[] = [];
  const batchSize = 200;
  for (let index = 0; index < names.length; index += batchSize) {
    try {
      const batch = await statFiles(uuid, directory, names.slice(index, index + batchSize));
      entries.push(...(batch as DirectoryEntry[]));
    } catch (error) {
      if (!hasHttpStatus(error, 404)) throw error;
    }
  }
  return entries;
}

async function assertSafeExistingParents(
  uuid: string,
  absoluteDirectory: string,
  verifiedDirectories = new Set<string>(['/']),
): Promise<void> {
  if (!absoluteDirectory.startsWith('/') || absoluteDirectory.includes('\\')) {
    throw new Error('The server returned an unsafe directory path.');
  }
  const segments = absoluteDirectory.split('/').filter(Boolean);
  if (segments.some((segment) => !isSafeSegment(segment))) {
    throw new Error('The server returned an unsafe directory path.');
  }

  let current = '/';
  for (const segment of segments) {
    const next = current === '/' ? `/${segment}` : `${current}/${segment}`;
    if (verifiedDirectories.has(next)) {
      current = next;
      continue;
    }
    const entry = await getEntry(uuid, current, segment);
    if (!entry) {
      verifiedDirectories.add(next);
      return;
    }
    if (!entry.directory || entry.symlink) {
      throw new Error(`A file or symbolic link blocks the version installer directory ${absoluteDirectory}.`);
    }
    verifiedDirectories.add(next);
    current = next;
  }
}

async function getRelativeEntry(uuid: string, root: string, relativePath: string): Promise<DirectoryEntry | null> {
  const { parent, name } = parentAndName(relativePath);
  const directory = parent ? (root === '/' ? `/${parent}` : `${root}/${parent}`) : root;
  await assertSafeExistingParents(uuid, directory);
  return getEntry(uuid, directory, name);
}

async function removePath(uuid: string, path: string, permanent: boolean): Promise<void> {
  const { parent, name } = parentAndName(path);
  await assertSafeExistingParents(uuid, parent ? `/${parent}` : '/');
  const entry = await getEntry(uuid, parent ? `/${parent}` : '/', name);
  if (!entry) return;
  if (entry.symlink) throw new Error(`Refusing to remove a symbolic link: ${path}`);
  await deleteFiles(uuid, parent ? `/${parent}` : '/', [name], permanent);
}

async function listStageFiles(
  uuid: string,
  stagePath: string,
  relativePrefix = '',
  depth = 0,
): Promise<MinecraftInstallFile[]> {
  if (depth > 32) throw new Error('The staged version contains directories nested too deeply.');
  const result: MinecraftInstallFile[] = [];
  let page = 1;
  const entries: DirectoryEntry[] = [];
  let total = Number.POSITIVE_INFINITY;
  while (entries.length < total) {
    if (page > MAX_INSTALL_DIRECTORY_PAGES) throw new Error('The staged version contains too many directory pages.');
    const response = await loadDirectory(uuid, stagePath, page, 'name_asc');
    total = response.entries.total;
    if (!Number.isSafeInteger(total) || total < 0 || total > MAX_INSTALL_FILES * 4) {
      throw new Error('The staged version contains too many entries.');
    }
    const pageEntries = response.entries.data as DirectoryEntry[];
    if (entries.length + pageEntries.length > MAX_INSTALL_FILES * 4) {
      throw new Error('The staged version contains too many entries.');
    }
    if (pageEntries.length === 0 && entries.length < total) {
      throw new Error('The staged version directory could not be scanned completely.');
    }
    entries.push(...pageEntries);
    if (pageEntries.length === 0) break;
    page += 1;
  }
  if (entries.length < total) throw new Error('The staged version directory could not be scanned completely.');

  for (const entry of entries) {
    if (!isSafeSegment(entry.name)) throw new Error('The staged version contains an unsafe path segment.');
    if (entry.symlink) throw new Error('The staged version contains a symbolic link and cannot be installed safely.');
    const relativePath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
    const sourcePath = `${stagePath}/${entry.name}`;
    if (entry.directory) {
      result.push(...(await listStageFiles(uuid, sourcePath, relativePath, depth + 1)));
    } else if (entry.file) {
      const normalized = safeRelativePath(relativePath);
      if (isProtectedPath(normalized)) {
        throw new Error(`The installer targets protected server data: ${normalized}`);
      }
      if (normalized.toLowerCase().endsWith('.zip')) {
        throw new Error(`A temporary installer archive was not removed from staging: ${normalized}`);
      }
      result.push({ relativePath: normalized, sourcePath, size: entry.size ?? 0 });
      if (result.length > MAX_INSTALL_FILES) throw new Error('The staged version contains too many files.');
    }
  }
  return result;
}

async function cleanupStage(uuid: string, stageName: string): Promise<void> {
  if (!/^calagopus-version-stage-[A-Za-z0-9-]{8,80}$/.test(stageName)) {
    throw new Error('Refusing to clean an unexpected staging path.');
  }
  const entry = await getEntry(uuid, '/', stageName);
  if (!entry) return;
  if (!entry.directory || entry.symlink) throw new Error('Refusing to clean an unexpected staging entry.');
  await deleteFiles(uuid, '/', [stageName], true);
}

export async function prepareMinecraftVersionInstall(
  uuid: string,
  socket: Websocket,
  installation: unknown,
  canArchive: boolean,
  onProgress: (progress: MinecraftInstallProgress) => void,
): Promise<PreparedMinecraftVersionInstall> {
  const steps = normalizeInstallationPlan(installation);
  if (!canArchive && steps.some((step) => step.type === 'unzip')) {
    throw new Error('This build includes an archive. Installing it requires the Panel permission files.archive.');
  }
  const stageName = randomStageName();
  const stagePath = `/${stageName}`;
  let stageCreated = false;
  let cleanupSafe = true;
  try {
    await createDirectory(uuid, '/', stageName);
    stageCreated = true;
    const stagedDirectories = new Set<string>(['/', stagePath]);
    const rootRemovals = new Set<string>();
    const plannedDownloadPaths = new Set<string>();
    const archiveRelativePaths = new Set(
      steps
        .filter((step): step is Extract<MinecraftInstallStep, { type: 'unzip' }> => step.type === 'unzip')
        .map((step) => (step.location ? `${step.location}/${step.file}` : step.file)),
    );
    const stagedPathRegistry: StagedPathRegistry = { kinds: new Map(), descendants: new Map() };
    for (const archivePath of archiveRelativePaths) {
      registerStagedPath(stagedPathRegistry, archivePath, false);
    }
    let totalDownloadSize = 0;
    let totalExpandedArchiveSize = 0;
    let totalArchiveFiles = 0;

    for (const [index, step] of steps.entries()) {
      onProgress({
        stage: step.type === 'download' ? 'download' : step.type === 'unzip' ? 'extract' : 'prepare',
        current: index + 1,
        total: steps.length,
      });
      if (step.type === 'download') {
        if (step.size === undefined) {
          throw new Error(`The provider did not declare a safe size for ${step.file}; this download was refused.`);
        }
        if (plannedDownloadPaths.has(step.file)) throw new Error(`The installer repeats the file path ${step.file}.`);
        plannedDownloadPaths.add(step.file);
        if (!archiveRelativePaths.has(step.file)) registerStagedPath(stagedPathRegistry, step.file, false);
        if (step.size !== undefined) {
          totalDownloadSize += step.size;
          if (totalDownloadSize > MAX_TOTAL_INSTALL_BYTES) {
            throw new Error('The version installer download plan exceeds the supported total size.');
          }
        }
        const path = safeRelativePath(step.file);
        const { parent, name } = parentAndName(path);
        const destinationDirectory = parent ? `${stagePath}/${parent}` : stagePath;
        if (parent) await ensureDirectory(uuid, destinationDirectory, stagedDirectories);
        await runPanelFileOperation(socket, () =>
          pullFile(uuid, {
            root: destinationDirectory,
            url: validateMinecraftDownloadUrl(step.url),
            name,
          }),
        );
        if (step.size !== undefined) {
          const downloaded = await getEntry(uuid, destinationDirectory, name);
          if (!downloaded?.file || downloaded.symlink || downloaded.size !== step.size) {
            throw new Error(`The downloaded installer file ${step.file} did not match its provider size.`);
          }
        }
      } else if (step.type === 'unzip') {
        const location = safeLocation(step.location);
        const archiveRelativePath = location ? `${location}/${step.file}` : step.file;
        if (!plannedDownloadPaths.has(archiveRelativePath)) {
          throw new Error(`The installer attempts to extract an archive it did not download: ${step.file}`);
        }
        const archiveDirectory = location ? `${stagePath}/${location}` : stagePath;
        const archiveEntry = await getEntry(uuid, archiveDirectory, step.file);
        if (!archiveEntry?.file || archiveEntry.symlink || archiveEntry.size > MAX_INSTALL_ARCHIVE_BYTES) {
          throw new Error(`The installer archive ${step.file} is missing or larger than the safe inspection limit.`);
        }
        const archivePath = `${archiveDirectory}/${step.file}`;
        const archiveBlob = await getFileContent(uuid, archivePath);
        if (archiveBlob.size !== archiveEntry.size || archiveBlob.size > MAX_INSTALL_ARCHIVE_BYTES) {
          throw new Error(`The installer archive ${step.file} changed during validation or is too large.`);
        }
        const zipInspection = inspectZipArchive(new Uint8Array(await archiveBlob.arrayBuffer()), location);
        for (const path of zipInspection.paths) {
          registerStagedPath(stagedPathRegistry, path.path, path.directory);
        }
        totalExpandedArchiveSize += zipInspection.uncompressedSize;
        totalArchiveFiles += zipInspection.fileCount;
        if (totalExpandedArchiveSize > MAX_TOTAL_INSTALL_BYTES) {
          throw new Error('The installer archives expand beyond the supported total size.');
        }
        if (totalArchiveFiles > MAX_INSTALL_FILES) {
          throw new Error('The installer archives contain too many files.');
        }
        await runPanelFileOperation(socket, () => decompressFile(uuid, archiveDirectory, step.file));
      } else {
        const location = safeRelativePath(step.location);
        if (isProtectedPath(location)) throw new Error(`The installer requests a protected removal path: ${location}`);
        const temporaryArchive = location.toLowerCase().endsWith('.zip') && plannedDownloadPaths.has(location);
        if (temporaryArchive) {
          const stagedEntry = await getRelativeEntry(uuid, stagePath, location);
          if (!stagedEntry || !stagedEntry.file || stagedEntry.symlink) {
            throw new Error(`The temporary installer archive ${location} could not be found safely.`);
          }
          await removePath(uuid, `${stageName}/${location}`, true);
        } else {
          const allowedLauncherRemoval =
            location === 'libraries' ||
            location.startsWith('libraries/') ||
            (plannedDownloadPaths.has(location) && location.toLowerCase().endsWith('.jar'));
          if (!allowedLauncherRemoval) {
            throw new Error(`The installer requests an unsupported removal path: ${location}`);
          }
          rootRemovals.add(location);
        }
      }
    }

    onProgress({ stage: 'prepare', current: 0, total: 1 });
    const files = await listStageFiles(uuid, stagePath);
    if (!files.length) throw new Error('The version installer did not produce any files.');
    const totalBytes = files.reduce((total, file) => total + file.size, 0);
    if (totalBytes > MAX_TOTAL_INSTALL_BYTES)
      throw new Error('The extracted version is larger than the supported limit.');
    for (const remove of rootRemovals) {
      if (!files.some((file) => file.relativePath === remove || file.relativePath.startsWith(`${remove}/`))) {
        throw new Error(`The installer wants to remove ${remove} but does not provide replacement files.`);
      }
    }

    const conflicts: string[] = [];
    for (const remove of rootRemovals) {
      const entry = await getRelativeEntry(uuid, '/', remove);
      if (entry) {
        if (entry.symlink) throw new Error(`The installer removal path ${remove} is a symbolic link.`);
        conflicts.push(remove);
      }
    }
    const filesByTargetDirectory = new Map<string, MinecraftInstallFile[]>();
    for (const file of files) {
      const { parent } = parentAndName(file.relativePath);
      const directory = parent ? `/${parent}` : '/';
      const group = filesByTargetDirectory.get(directory) ?? [];
      group.push(file);
      filesByTargetDirectory.set(directory, group);
    }
    const verifiedTargetDirectories = new Set<string>(['/']);
    for (const [directory, targetFiles] of filesByTargetDirectory) {
      await assertSafeExistingParents(uuid, directory, verifiedTargetDirectories);
      const entries = await getEntries(
        uuid,
        directory,
        targetFiles.map((file) => parentAndName(file.relativePath).name),
      );
      const entriesByName = new Map(entries.map((entry) => [entry.name, entry]));
      for (const file of targetFiles) {
        const name = parentAndName(file.relativePath).name;
        const entry = entriesByName.get(name);
        if (!entry) continue;
        if (!entry.file || entry.directory || entry.symlink) {
          if (!rootRemovals.some((path) => file.relativePath === path || file.relativePath.startsWith(`${path}/`))) {
            throw new Error(`A non-file or symbolic link blocks the version installer path ${file.relativePath}.`);
          }
        } else if (
          !rootRemovals.some((path) => file.relativePath === path || file.relativePath.startsWith(`${path}/`))
        ) {
          conflicts.push(file.relativePath);
        }
      }
    }

    return {
      stageName,
      files,
      removePaths: [...rootRemovals].sort(),
      conflicts: [...new Set(conflicts)].sort(),
      totalBytes,
    };
  } catch (error) {
    if (error instanceof PanelFileOperationTimeoutError) cleanupSafe = false;
    let cleanupFailed = false;
    if (stageCreated && cleanupSafe) {
      try {
        await cleanupStage(uuid, stageName);
      } catch {
        // Preserve the original error and avoid masking a file-operation failure.
        cleanupFailed = true;
      }
    }
    if (cleanupFailed) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message} Temporary staging folder ${stageName} could not be removed.`);
    }
    throw error;
  }
}

export async function applyMinecraftVersionInstall(
  uuid: string,
  socket: Websocket,
  prepared: PreparedMinecraftVersionInstall,
  replaceLauncherFiles: boolean,
  acceptEula: boolean,
  onProgress: (progress: MinecraftInstallProgress) => void,
): Promise<{ cleanupFailed: boolean }> {
  let cleanupSafe = true;
  let cleanupFailed = false;
  let failure: unknown;
  try {
    if ((prepared.conflicts.length > 0 || prepared.removePaths.length > 0) && !replaceLauncherFiles) {
      throw new Error('Confirm replacement of the listed launcher files before applying this version.');
    }

    const reviewedPaths = new Set(prepared.conflicts);
    const conflictsToTrash = prepared.conflicts.filter(
      (path) => !prepared.removePaths.some((removed) => path === removed || path.startsWith(`${removed}/`)),
    );
    const totalOperations =
      prepared.files.length + prepared.removePaths.length + conflictsToTrash.length + (acceptEula ? 1 : 0);
    for (const path of prepared.removePaths) {
      const entry = await getRelativeEntry(uuid, '/', path);
      if (entry && !reviewedPaths.has(path)) {
        throw new Error(`The launcher path ${path} changed after review. Prepare the installation again.`);
      }
      if (entry?.symlink) throw new Error(`Refusing to replace a symbolic link: ${path}`);
    }
    const preflightFilesByDirectory = new Map<string, MinecraftInstallFile[]>();
    for (const file of prepared.files) {
      const { parent } = parentAndName(file.relativePath);
      const directory = parent ? `/${parent}` : '/';
      const group = preflightFilesByDirectory.get(directory) ?? [];
      group.push(file);
      preflightFilesByDirectory.set(directory, group);
    }
    const verifiedTargetDirectories = new Set<string>(['/']);
    for (const [directory, targetFiles] of preflightFilesByDirectory) {
      await assertSafeExistingParents(uuid, directory, verifiedTargetDirectories);
      const entries = await getEntries(
        uuid,
        directory,
        targetFiles.map((file) => parentAndName(file.relativePath).name),
      );
      const entriesByName = new Map(entries.map((entry) => [entry.name, entry]));
      for (const file of targetFiles) {
        const name = parentAndName(file.relativePath).name;
        const entry = entriesByName.get(name);
        const coveredByRemoval = prepared.removePaths.some(
          (path) => file.relativePath === path || file.relativePath.startsWith(`${path}/`),
        );
        if (entry && !coveredByRemoval && !reviewedPaths.has(file.relativePath)) {
          throw new Error(
            `The launcher file ${file.relativePath} appeared after review. Prepare the installation again.`,
          );
        }
        if (entry?.symlink) throw new Error(`Refusing to replace a symbolic link: ${file.relativePath}`);
      }
    }

    onProgress({ stage: 'install', current: 0, total: totalOperations });
    let removedCount = 0;
    for (const [index, path] of prepared.removePaths.entries()) {
      await removePath(uuid, path, false);
      removedCount = index + 1;
      onProgress({ stage: 'install', current: removedCount, total: totalOperations });
    }

    for (const path of conflictsToTrash) {
      await removePath(uuid, path, false);
      removedCount += 1;
      onProgress({ stage: 'install', current: removedCount, total: totalOperations });
    }

    const filesByDirectory = new Map<string, MinecraftInstallFile[]>();
    for (const file of prepared.files) {
      const { parent } = parentAndName(file.relativePath);
      const directory = parent ? `/${parent}` : '/';
      const group = filesByDirectory.get(directory) ?? [];
      group.push(file);
      filesByDirectory.set(directory, group);
    }
    const ensuredServerDirectories = new Set<string>(['/']);
    for (const directory of filesByDirectory.keys()) {
      await ensureDirectory(uuid, directory, ensuredServerDirectories);
    }

    let copiedCount = 0;
    for (const [directory, group] of filesByDirectory) {
      const resultHolder: { value?: Awaited<ReturnType<typeof copyFiles>> } = {};
      await runPanelFileOperation(socket, async () => {
        const result = await copyFiles({
          uuid,
          root: '/',
          files: group.map((file) => ({ from: file.sourcePath, to: file.relativePath })),
          overwrite: false,
        });
        resultHolder.value = result;
        return result.identifier;
      });
      const result = resultHolder.value;
      if (!result) throw new Error(`The Panel did not return a copy result for ${directory}.`);
      if (result.skipped.length > 0) {
        throw new Error(`Some version files were skipped in ${directory}; no further changes were made.`);
      }
      copiedCount += group.length;
      onProgress({
        stage: 'install',
        current: removedCount + copiedCount,
        total: totalOperations,
      });
    }

    if (acceptEula) {
      await saveFileContent(uuid, '/eula.txt', 'eula=true\n');
      onProgress({ stage: 'install', current: totalOperations, total: totalOperations });
    }
  } catch (error) {
    failure = error;
    if (error instanceof PanelFileOperationTimeoutError) cleanupSafe = false;
  } finally {
    if (cleanupSafe) {
      onProgress({ stage: 'cleanup', current: 0, total: 1 });
      try {
        await cleanupStage(uuid, prepared.stageName);
      } catch {
        cleanupFailed = true;
      }
    }
  }

  if (failure) {
    if (cleanupFailed) {
      const message = failure instanceof Error ? failure.message : String(failure);
      throw new Error(`${message} Temporary staging folder ${prepared.stageName} could not be removed.`);
    }
    throw failure;
  }
  return { cleanupFailed };
}

export async function discardPreparedMinecraftVersionInstall(
  uuid: string,
  prepared: PreparedMinecraftVersionInstall,
): Promise<void> {
  await cleanupStage(uuid, prepared.stageName);
}
