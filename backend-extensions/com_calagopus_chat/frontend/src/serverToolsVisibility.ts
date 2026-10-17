import { type ServerToolPages, serverToolPagesSchema } from './lib/schemas.ts';

export type ServerToolPageKey = keyof ServerToolPages;

interface MinecraftEggCandidate {
  egg?: {
    name?: string;
    description?: string | null;
    features?: string[];
  };
}

const SETTINGS_CACHE_KEY = 'com.calagopus.all-in-one.server-tool-pages.v1';
const SERVER_CACHE_PREFIX = `${SETTINGS_CACHE_KEY}.server.v2.`;

function getEggDetails(server: MinecraftEggCandidate | null | undefined): string {
  if (!server?.egg) return '';

  return [server.egg.name, ...(server.egg.features ?? [])].join(' ').replace(/[_-]+/g, ' ');
}

interface CachedServerVisibility {
  capabilities: ServerToolCapabilities;
  pages: ServerToolPages;
}

export interface ServerToolCapabilities {
  modpacks: boolean;
  mods: boolean;
  plugins: boolean;
  players: boolean;
  serverProperties: boolean;
}

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): boolean {
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    // The server route still guards each tool when storage is unavailable.
    return false;
  }
}

export function getServerIdentifierFromPath(pathname = window.location.pathname): string | null {
  const match = pathname.match(/^\/server\/([^/]+)/);
  if (!match) return null;

  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

export function isMinecraftEgg(server: MinecraftEggCandidate | null | undefined): boolean {
  const eggDetails = getEggDetails(server);
  return /\b(?:minecraft|paper(?:mc)?|spigot|purpur|bukkit|fabric|forge|neo[\s-]?forge|quilt|folia|velocity|bungee(?:cord)?|waterfall|sponge|magma|mohist|arclight|catserver)\b/i.test(
    eggDetails,
  );
}

export function getServerToolCapabilities(server: MinecraftEggCandidate | null | undefined): ServerToolCapabilities {
  const details = getEggDetails(server);
  const minecraft = isMinecraftEgg(server);
  const java = minecraft && !/\b(?:bedrock|pocketmine|nukkit)\b/i.test(details);
  const proxy = /\b(?:velocity|bungee(?:cord)?|waterfall)\b/i.test(details);
  const modded = /\b(?:fabric|forge|neo[\s-]?forge|quilt|magma|mohist|arclight|catserver)\b/i.test(details);
  const pluginServer =
    /\b(?:paper(?:mc)?|spigot|purpur|bukkit|folia|sponge|magma|mohist|arclight|catserver|velocity|bungee(?:cord)?|waterfall)\b/i.test(
      details,
    );
  const genericJavaServer = java && !proxy && !modded && !pluginServer;

  return {
    modpacks: java && !proxy && (modded || genericJavaServer),
    mods: java && !proxy && (modded || genericJavaServer),
    plugins: java && (pluginServer || genericJavaServer),
    players: java && !proxy,
    serverProperties: java && !proxy,
  };
}

export function supportsServerToolPage(
  server: MinecraftEggCandidate | null | undefined,
  page: ServerToolPageKey,
): boolean {
  return getServerToolCapabilities(server)[page];
}

export function getCachedServerToolPages(): ServerToolPages | null {
  const raw = readStorage(SETTINGS_CACHE_KEY);
  if (!raw) return null;

  try {
    return serverToolPagesSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function setCachedServerToolPages(pages: ServerToolPages): void {
  writeStorage(SETTINGS_CACHE_KEY, JSON.stringify(pages));
}

function serverVisibilityKey(serverIdentifier: string): string {
  return `${SERVER_CACHE_PREFIX}${encodeURIComponent(serverIdentifier)}`;
}

function readServerVisibility(serverIdentifier: string): CachedServerVisibility | null {
  const raw = readStorage(serverVisibilityKey(serverIdentifier));
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as { capabilities?: unknown; pages?: unknown };
    if (typeof parsed.capabilities !== 'object' || parsed.capabilities === null) return null;
    return {
      capabilities: parsed.capabilities as ServerToolCapabilities,
      pages: serverToolPagesSchema.parse(parsed.pages),
    };
  } catch {
    return null;
  }
}

export function cacheServerVisibility(
  serverIdentifier: string,
  server: MinecraftEggCandidate,
  pages: ServerToolPages,
): boolean {
  const capabilities = getServerToolCapabilities(server);
  const previous = readServerVisibility(serverIdentifier);
  const changed =
    !previous ||
    JSON.stringify(previous.capabilities) !== JSON.stringify(capabilities) ||
    JSON.stringify(previous.pages) !== JSON.stringify(pages);

  const settingsStored = writeStorage(SETTINGS_CACHE_KEY, JSON.stringify(pages));
  const serverStored = writeStorage(serverVisibilityKey(serverIdentifier), JSON.stringify({ capabilities, pages }));
  return changed && settingsStored && serverStored;
}

export function isServerToolPageVisible(page: ServerToolPageKey): boolean {
  const serverIdentifier = getServerIdentifierFromPath();
  if (!serverIdentifier) return false;

  const serverVisibility = readServerVisibility(serverIdentifier);
  if (!serverVisibility) return false;

  const pageSettings = getCachedServerToolPages() ?? serverVisibility.pages;
  return pageSettings[page];
}
