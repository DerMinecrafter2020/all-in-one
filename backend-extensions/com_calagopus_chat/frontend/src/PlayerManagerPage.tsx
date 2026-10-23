import { faCopy, faPenToSquare, faRotate, faUserSlash } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  Alert,
  Avatar,
  Badge,
  Button,
  Card,
  Code,
  Group,
  Loader,
  Modal,
  NumberInput,
  SimpleGrid,
  Stack,
  Table,
  Tabs,
  Text,
  TextInput,
} from '@mantine/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getHttpStatus, httpErrorToHuman } from '@/api/axios.ts';
import deleteFiles from '@/api/server/files/deleteFiles.ts';
import getFileContent from '@/api/server/files/getFileContent.ts';
import saveFileContent from '@/api/server/files/saveFileContent.ts';
import statFiles from '@/api/server/files/statFiles.ts';
import { SocketEvent, SocketRequest } from '@/plugins/websocket/useWebsocketEvent.ts';
import type { Websocket } from '@/plugins/websocket/Websocket.ts';
import { useToast } from '@/providers/ToastProvider.tsx';
import { useExtTranslations } from './translations.ts';

type PlayerAction =
  | 'kick'
  | 'ban'
  | 'pardon'
  | 'whitelist-add'
  | 'whitelist-remove'
  | 'op'
  | 'deop'
  | 'ban-ip'
  | 'pardon-ip'
  | 'clear-inventory'
  | 'kill'
  | 'wipe-data';

interface PendingAction {
  action: PlayerAction;
  username: string;
}

interface PlayerRecord {
  name: string;
  uuid?: string;
  reason?: string;
  expires?: string;
  level?: number;
}

interface BannedIpRecord {
  ip: string;
  reason?: string;
  expires?: string;
}

type LiveStatField = 'position' | 'gameMode' | 'xpLevel' | 'xpTotal' | 'lastDeath';

interface PlayerStats {
  position: string | null;
  gameMode: string | null;
  playtime: string | null;
  kills: string | null;
  deaths: string | null;
  xpLevel: string | null;
  xpTotal: string | null;
  lastDeath: string | null;
}

interface InventoryItem {
  slot?: number;
  id?: string;
  count?: number;
  raw: string;
}

interface Props {
  canReadConsole: boolean;
  canReadConsoleOutput: boolean;
  canSendCommands: boolean;
  canReadFiles: boolean;
  canStatFiles: boolean;
  canDeleteFiles: boolean;
  canWriteFiles: boolean;
  serverUuid: string;
  serverRunning: boolean;
  serverStopped: boolean;
  serverBusy: boolean;
  socketConnected: boolean;
  socketInstance: Websocket | null;
}

const PLAYER_NAME_PATTERN = /^[A-Za-z0-9_]{3,16}$/;
const ANSI_SGR_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;:?]*m`, 'g');
const EMPTY_PLAYER_STATS: PlayerStats = {
  position: null,
  gameMode: null,
  playtime: null,
  kills: null,
  deaths: null,
  xpLevel: null,
  xpTotal: null,
  lastDeath: null,
};

function stripAnsi(line: string): string {
  return line.replace(ANSI_SGR_PATTERN, '').trim();
}

function parseOnlinePlayers(line: string): { players: string[]; maxPlayers: number | null } | null {
  const plainText = stripAnsi(line);
  const match = plainText.match(/there are\s+\d+(?:\s+of a max of\s+(\d+))?\s+players online(?::\s*(.*))?/i);
  if (!match) return null;

  return {
    players: (match[2] ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter((name) => PLAYER_NAME_PATTERN.test(name)),
    maxPlayers: match[1] ? Number(match[1]) : null,
  };
}

function parseTps(line: string): number[] | null {
  const plainText = stripAnsi(line);
  if (!/\btps\b/i.test(plainText)) return null;
  const colon = plainText.lastIndexOf(':');
  if (colon < 0) return null;

  const values = plainText.slice(colon + 1).match(/\d+(?:\.\d+)?/g);
  if (!values?.length) return null;
  return values.slice(0, 3).map(Number);
}

function isValidIp(value: string): boolean {
  const ipv4 = value.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) return ipv4.slice(1).every((part) => Number(part) <= 255);
  if (value.length > 45 || !value.includes(':') || !/^[0-9a-f:.]+$/i.test(value)) return false;
  try {
    const parsed = new URL(`http://[${value}]/`);
    return parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']');
  } catch {
    return false;
  }
}

function isValidPlayerUuid(value: string): boolean {
  return /^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(value);
}

function parseBannedIpRecords(json: string): BannedIpRecord[] {
  const value: unknown = JSON.parse(json);
  if (!Array.isArray(value)) return [];

  return value.flatMap((item): BannedIpRecord[] => {
    if (typeof item !== 'object' || item === null) return [];
    const record = item as Record<string, unknown>;
    const ip = typeof record.ip === 'string' ? record.ip : typeof record.IP === 'string' ? record.IP : '';
    if (!isValidIp(ip)) return [];
    return [
      {
        ip,
        reason: typeof record.reason === 'string' ? record.reason : undefined,
        expires: typeof record.expires === 'string' ? record.expires : undefined,
      },
    ];
  });
}

async function readBannedIpFile(serverUuid: string): Promise<BannedIpRecord[]> {
  try {
    const blob = await getFileContent(serverUuid, '/banned-ips.json');
    return parseBannedIpRecords(await blob.text());
  } catch (error) {
    if (getHttpStatus(error) === 404) return [];
    throw error;
  }
}

function parseNonWhitelistedAttempt(line: string): string | null {
  const plainText = stripAnsi(line);
  if (!/not\s+(?:white[\s-]?listed|on\s+(?:the\s+)?whitelist)/i.test(plainText)) return null;

  const candidates = [
    plainText.match(/\bname\s*=\s*["']?([A-Za-z0-9_]{3,16})\b/i)?.[1],
    plainText.match(/\bdisconnecting\s+([A-Za-z0-9_]{3,16})\s*(?=[(:])/i)?.[1],
    plainText.match(
      /\b([A-Za-z0-9_]{3,16})\s+(?:is|was)\s+not\s+(?:white[\s-]?listed|on\s+(?:the\s+)?whitelist)/i,
    )?.[1],
  ];

  return candidates.find((candidate) => candidate && PLAYER_NAME_PATTERN.test(candidate)) ?? null;
}

function parsePlayerRecords(json: string): PlayerRecord[] {
  const value: unknown = JSON.parse(json);
  if (!Array.isArray(value)) return [];

  return value.flatMap((item): PlayerRecord[] => {
    if (typeof item !== 'object' || item === null) return [];
    const record = item as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name : typeof record.Name === 'string' ? record.Name : '';
    if (!PLAYER_NAME_PATTERN.test(name)) return [];

    return [
      {
        name,
        uuid: typeof record.uuid === 'string' ? record.uuid : undefined,
        reason: typeof record.reason === 'string' ? record.reason : undefined,
        expires: typeof record.expires === 'string' ? record.expires : undefined,
        level: typeof record.level === 'number' ? record.level : undefined,
      },
    ];
  });
}

async function readPlayerJsonFile(serverUuid: string, path: string): Promise<PlayerRecord[]> {
  try {
    const blob = await getFileContent(serverUuid, path);
    return parsePlayerRecords(await blob.text());
  } catch (error) {
    if (getHttpStatus(error) === 404) return [];
    throw error;
  }
}

async function readConfiguredServerProperties(
  serverUuid: string,
): Promise<{ maxPlayers: number | null; worldName: string | null }> {
  try {
    const file = await getFileContent(serverUuid, '/server.properties');
    const text = await file.text();
    const maxPlayersMatch = text.match(/^\s*max-players\s*=\s*(\d+)\s*$/m);
    const worldNameMatch = text.match(/^\s*level-name\s*=\s*([^\r\n#]+)\s*$/m);
    return {
      maxPlayers: maxPlayersMatch ? Number(maxPlayersMatch[1]) : null,
      worldName: worldNameMatch?.[1]?.trim() || null,
    };
  } catch (error) {
    if (getHttpStatus(error) === 404) return { maxPlayers: null, worldName: null };
    throw error;
  }
}

async function saveMaxPlayersProperty(serverUuid: string, value: number): Promise<void> {
  const file = await getFileContent(serverUuid, '/server.properties');
  const original = await file.text();
  const lineEnding = original.match(/\r\n|\n/)?.[0] ?? '\n';
  const trailingNewline = /(?:\r\n|\n)$/.test(original);
  const lines = original ? original.split(/\r\n|\n/) : [];
  if (trailingNewline) lines.pop();

  let found = false;
  const updated = lines.map((line) => {
    const match = line.match(/^(\s*max-players\s*=\s*)(.*)$/i);
    if (!match) return line;

    found = true;
    const suffix = match[2].match(/\s+#.*$/)?.[0] ?? match[2].match(/\s+$/)?.[0] ?? '';
    return `${match[1]}${value}${suffix}`;
  });
  if (!found) updated.push(`max-players=${value}`);

  const nextContent = updated.join(lineEnding) + (trailingNewline ? lineEnding : '');
  await saveFileContent(serverUuid, '/server.properties', nextContent);
}

function formatPlaytimeTicks(ticks: number): string {
  const totalSeconds = Math.floor(ticks / 20);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

function parseStatsFile(json: string): Partial<Pick<PlayerStats, 'playtime' | 'kills' | 'deaths'>> {
  const root: unknown = JSON.parse(json);
  if (typeof root !== 'object' || root === null || !('stats' in root)) return {};
  const stats = (root as { stats?: unknown }).stats;
  if (typeof stats !== 'object' || stats === null) return {};
  const custom = (stats as Record<string, unknown>)['minecraft:custom'];
  if (typeof custom !== 'object' || custom === null) return {};
  const values = custom as Record<string, unknown>;
  const playtime = values['minecraft:play_time'] ?? values['minecraft:play_one_minute'];
  const playerKills = values['minecraft:player_kills'];
  const mobKills = values['minecraft:mob_kills'];
  const deaths = values['minecraft:deaths'];

  return {
    playtime: typeof playtime === 'number' ? formatPlaytimeTicks(playtime) : null,
    kills:
      typeof playerKills === 'number' || typeof mobKills === 'number'
        ? String((typeof playerKills === 'number' ? playerKills : 0) + (typeof mobKills === 'number' ? mobKills : 0))
        : null,
    deaths: typeof deaths === 'number' ? String(deaths) : null,
  };
}

async function readPlayerStatsFile(
  serverUuid: string,
  worldName: string,
  uuid: string,
): Promise<Partial<Pick<PlayerStats, 'playtime' | 'kills' | 'deaths'>>> {
  const uuids = [...new Set([uuid, uuid.replace(/-/g, '')])];
  for (const playerUuid of uuids) {
    try {
      const blob = await getFileContent(serverUuid, `/${worldName}/stats/${playerUuid}.json`);
      return parseStatsFile(await blob.text());
    } catch (error) {
      if (getHttpStatus(error) !== 404) throw error;
    }
  }

  return {};
}

function formatLiveStat(field: LiveStatField, value: string): string {
  if (field === 'position') {
    const coordinates = value.match(/-?\d+(?:\.\d+)?/g);
    return coordinates?.length
      ? coordinates
          .slice(0, 3)
          .map((part) => Number(part))
          .join(', ')
      : value;
  }
  if (field === 'gameMode') {
    const modes: Record<string, string> = {
      '0': 'Survival',
      '1': 'Creative',
      '2': 'Adventure',
      '3': 'Spectator',
    };
    const mode = value.match(/\d+/)?.[0];
    return mode ? (modes[mode] ?? mode) : value;
  }
  return value.replace(/[dDfF]$/, '').trim();
}

function parseInventoryItems(value: string): InventoryItem[] {
  const start = value.indexOf('[');
  if (start < 0) return [];

  const compounds: string[] = [];
  let depth = 0;
  let compoundStart = -1;
  let inString = false;
  let escaped = false;

  for (let index = start + 1; index < value.length; index += 1) {
    const character = value[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '{') {
      if (depth === 0) compoundStart = index;
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0 && compoundStart >= 0) {
        compounds.push(value.slice(compoundStart, index + 1));
        compoundStart = -1;
      }
    } else if (character === ']' && depth === 0) {
      break;
    }
  }

  return compounds.map((raw) => {
    const id = raw.match(/(?:^|[,{\s])(?:id|Id)\s*:\s*"?([^,"}\s]+)"?/i)?.[1];
    const count = raw.match(/(?:^|[,{\s])(?:count|Count)\s*:\s*(\d+)/i)?.[1];
    const slot = raw.match(/(?:^|[,{\s])slot\s*:\s*(-?\d+)/i)?.[1];
    return {
      id,
      count: count ? Number(count) : undefined,
      slot: slot ? Number(slot) : undefined,
      raw,
    };
  });
}

function buildCommand(action: PlayerAction, username: string): string {
  switch (action) {
    case 'kick':
      return `kick ${username}`;
    case 'ban':
      return `ban ${username}`;
    case 'pardon':
      return `pardon ${username}`;
    case 'whitelist-add':
      return `whitelist add ${username}`;
    case 'whitelist-remove':
      return `whitelist remove ${username}`;
    case 'op':
      return `op ${username}`;
    case 'deop':
      return `deop ${username}`;
    case 'ban-ip':
      return `ban-ip ${username}`;
    case 'pardon-ip':
      return `pardon-ip ${username}`;
    case 'clear-inventory':
      return `clear ${username}`;
    case 'kill':
      return `kill ${username}`;
    case 'wipe-data':
      return '';
  }
}

export default function PlayerManagerPage({
  canReadConsole,
  canReadConsoleOutput,
  canSendCommands,
  canReadFiles,
  canStatFiles,
  canDeleteFiles,
  canWriteFiles,
  serverUuid,
  serverRunning,
  serverStopped,
  serverBusy,
  socketConnected,
  socketInstance,
}: Props) {
  const { t } = useExtTranslations();
  const { addToast } = useToast();
  const [players, setPlayers] = useState<string[]>([]);
  const [playersLoaded, setPlayersLoaded] = useState(false);
  const [nonWhitelistedAttempts, setNonWhitelistedAttempts] = useState<string[]>([]);
  const [maxPlayers, setMaxPlayers] = useState<number | null>(null);
  const [worldName, setWorldName] = useState('world');
  const [bannedIps, setBannedIps] = useState<BannedIpRecord[]>([]);
  const [cachedPlayers, setCachedPlayers] = useState<PlayerRecord[]>([]);
  const [selectedPlayer, setSelectedPlayer] = useState<string | null>(null);
  const [detailsTab, setDetailsTab] = useState<string | null>('actions');
  const [maxPlayersModalOpen, setMaxPlayersModalOpen] = useState(false);
  const [maxPlayersDraft, setMaxPlayersDraft] = useState<number | string>(20);
  const [savingMaxPlayers, setSavingMaxPlayers] = useState(false);
  const [wipingPlayer, setWipingPlayer] = useState(false);
  const [tps, setTps] = useState<number[] | null>(null);
  const [tpsLoading, setTpsLoading] = useState(false);
  const [tpsUnavailable, setTpsUnavailable] = useState(false);
  const [bannedPlayers, setBannedPlayers] = useState<PlayerRecord[]>([]);
  const [whitelistedPlayers, setWhitelistedPlayers] = useState<PlayerRecord[]>([]);
  const [operators, setOperators] = useState<PlayerRecord[]>([]);
  const [loadingLists, setLoadingLists] = useState(false);
  const [username, setUsername] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [pingResults, setPingResults] = useState<Record<string, string>>({});
  const [pingLoading, setPingLoading] = useState<string | null>(null);
  const [inventoryPlayer, setInventoryPlayer] = useState<string | null>(null);
  const [inventoryItems, setInventoryItems] = useState<InventoryItem[]>([]);
  const [inventoryRaw, setInventoryRaw] = useState('');
  const [inventoryLoading, setInventoryLoading] = useState(false);
  const [playerStats, setPlayerStats] = useState<PlayerStats>(EMPTY_PLAYER_STATS);
  const [statsLoading, setStatsLoading] = useState(false);
  const responsePending = useRef(false);
  const tpsPending = useRef(false);
  const pingTarget = useRef<string | null>(null);
  const inventoryTarget = useRef<string | null>(null);
  const statsTarget = useRef<string | null>(null);
  const statsQueue = useRef<LiveStatField[]>([]);
  const refreshTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tpsTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inventoryTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statsTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const actionLabels: Record<PlayerAction, string> = {
    kick: t('tools.playerActions.kick', {}),
    ban: t('tools.playerActions.ban', {}),
    pardon: t('tools.playerActions.pardon', {}),
    'whitelist-add': t('tools.playerActions.whitelist-add', {}),
    'whitelist-remove': t('tools.playerActions.whitelist-remove', {}),
    op: t('tools.playerActions.op', {}),
    deop: t('tools.playerActions.deop', {}),
    'ban-ip': t('tools.playerActions.ban-ip', {}),
    'pardon-ip': t('tools.playerActions.pardon-ip', {}),
    'clear-inventory': t('tools.playerActions.clear-inventory', {}),
    kill: t('tools.playerActions.kill', {}),
    'wipe-data': t('tools.playerActions.wipe-data', {}),
  };

  const playerRecords = [...cachedPlayers, ...operators, ...whitelistedPlayers, ...bannedPlayers];
  const playerRecordsByName = new Map<string, PlayerRecord>();
  for (const record of playerRecords) {
    if (!playerRecordsByName.has(record.name.toLowerCase())) {
      playerRecordsByName.set(record.name.toLowerCase(), record);
    }
  }
  const getPlayerRecord = (name: string) => playerRecordsByName.get(name.toLowerCase());
  const selectedPlayerRecord = selectedPlayer ? getPlayerRecord(selectedPlayer) : undefined;
  const selectedPlayerUuid = selectedPlayerRecord?.uuid;
  const selectedPlayerIsOnline = selectedPlayer
    ? players.some((name) => name.toLowerCase() === selectedPlayer.toLowerCase())
    : false;
  const selectedPlayerIsOperator = selectedPlayer
    ? operators.some((record) => record.name.toLowerCase() === selectedPlayer.toLowerCase())
    : false;
  const selectedPlayerIsWhitelisted = selectedPlayer
    ? whitelistedPlayers.some((record) => record.name.toLowerCase() === selectedPlayer.toLowerCase())
    : false;
  const selectedPlayerIsBanned = selectedPlayer
    ? bannedPlayers.some((record) => record.name.toLowerCase() === selectedPlayer.toLowerCase())
    : false;
  const onlineNames = new Set(players.map((name) => name.toLowerCase()));
  const offlinePlayers = [...playerRecordsByName.values()]
    .filter((record) => !onlineNames.has(record.name.toLowerCase()))
    .sort((left, right) => left.name.localeCompare(right.name));

  const openPlayerDetails = (name: string) => {
    if (statsTimeout.current) clearTimeout(statsTimeout.current);
    statsTarget.current = null;
    statsQueue.current = [];
    setSelectedPlayer(name);
    setDetailsTab('actions');
    setPlayerStats(EMPTY_PLAYER_STATS);
  };

  const closePlayerDetails = () => {
    if (statsTimeout.current) clearTimeout(statsTimeout.current);
    statsTarget.current = null;
    statsQueue.current = [];
    setStatsLoading(false);
    setSelectedPlayer(null);
  };

  const loadPlayerLists = useCallback(async () => {
    if (!canReadFiles) return;

    setLoadingLists(true);
    try {
      const [banned, whitelisted, ops, bannedIpRecords, cached, properties] = await Promise.all([
        readPlayerJsonFile(serverUuid, '/banned-players.json'),
        readPlayerJsonFile(serverUuid, '/whitelist.json'),
        readPlayerJsonFile(serverUuid, '/ops.json'),
        readBannedIpFile(serverUuid),
        readPlayerJsonFile(serverUuid, '/usercache.json'),
        readConfiguredServerProperties(serverUuid),
      ]);
      setBannedPlayers(banned);
      setWhitelistedPlayers(whitelisted);
      setOperators(ops);
      setBannedIps(bannedIpRecords);
      setCachedPlayers(cached);
      if (properties.maxPlayers !== null) setMaxPlayers(properties.maxPlayers);
      if (properties.worldName === null) setWorldName('world');
      else if (/^[A-Za-z0-9._ -]{1,100}$/.test(properties.worldName) && !['.', '..'].includes(properties.worldName)) {
        setWorldName(properties.worldName);
      } else setWorldName('');
    } catch (error) {
      addToast(httpErrorToHuman(error), 'error');
    } finally {
      setLoadingLists(false);
    }
  }, [addToast, canReadFiles, serverUuid]);

  useEffect(() => {
    void loadPlayerLists();
  }, [loadPlayerLists]);

  const loadPlayerStats = async (playerName: string) => {
    setDetailsTab('stats');
    setPlayerStats(EMPTY_PLAYER_STATS);
    setStatsLoading(true);
    const record = getPlayerRecord(playerName);

    if (canReadFiles && record?.uuid && isValidPlayerUuid(record.uuid)) {
      try {
        const fileStats = await readPlayerStatsFile(serverUuid, worldName, record.uuid);
        setPlayerStats((current) => ({ ...current, ...fileStats }));
      } catch (error) {
        addToast(httpErrorToHuman(error), 'error');
      }
    }

    const isOnline = players.some((name) => name.toLowerCase() === playerName.toLowerCase());
    if (!isOnline || !canReadConsole || !canSendCommands || !socketConnected || !socketInstance) {
      setStatsLoading(false);
      return;
    }

    if (statsTimeout.current) clearTimeout(statsTimeout.current);
    const fields: LiveStatField[] = ['position', 'gameMode', 'xpLevel', 'xpTotal', 'lastDeath'];
    const propertyPaths: Record<LiveStatField, string> = {
      position: 'Pos',
      gameMode: 'playerGameType',
      xpLevel: 'XpLevel',
      xpTotal: 'XpTotal',
      lastDeath: 'LastDeathLocation',
    };
    statsTarget.current = playerName;
    statsQueue.current = fields;
    fields.forEach((field) => {
      socketInstance.send(SocketRequest.SEND_COMMAND, `data get entity ${playerName} ${propertyPaths[field]}`);
    });
    statsTimeout.current = setTimeout(() => {
      statsTarget.current = null;
      statsQueue.current = [];
      setStatsLoading(false);
    }, 10000);
  };

  const refreshPlayers = useCallback(() => {
    if (!canReadConsole) {
      addToast(t('tools.playerReadPermissionRequired', {}), 'error');
      return;
    }
    if (!canSendCommands) {
      addToast(t('tools.playerCommandPermissionRequired', {}), 'error');
      return;
    }
    if (!serverRunning || !socketConnected || !socketInstance) {
      addToast(t('tools.playerServerUnavailable', {}), 'error');
      return;
    }

    if (refreshTimeout.current) clearTimeout(refreshTimeout.current);
    if (tpsTimeout.current) clearTimeout(tpsTimeout.current);
    responsePending.current = true;
    tpsPending.current = true;
    setRefreshing(true);
    setTpsLoading(true);
    setTpsUnavailable(false);
    socketInstance.send(SocketRequest.SEND_COMMAND, 'list');
    socketInstance.send(SocketRequest.SEND_COMMAND, 'tps');
    refreshTimeout.current = setTimeout(() => {
      if (responsePending.current) {
        responsePending.current = false;
        setRefreshing(false);
        addToast(t('tools.playerListTimedOut', {}), 'error');
      }
    }, 10000);
    tpsTimeout.current = setTimeout(() => {
      if (tpsPending.current) {
        tpsPending.current = false;
        setTpsLoading(false);
        setTpsUnavailable(true);
      }
    }, 8000);
  }, [addToast, canReadConsole, canSendCommands, serverRunning, socketConnected, socketInstance, t]);

  const onConsoleOutput = useCallback((line: string) => {
    const plainText = stripAnsi(line);
    const rejectedPlayer = parseNonWhitelistedAttempt(plainText);
    if (rejectedPlayer) {
      setNonWhitelistedAttempts((current) =>
        [rejectedPlayer, ...current.filter((name) => name.toLowerCase() !== rejectedPlayer.toLowerCase())].slice(0, 20),
      );
    }

    const onlineResponse = parseOnlinePlayers(plainText);
    if (onlineResponse && responsePending.current) {
      responsePending.current = false;
      if (refreshTimeout.current) clearTimeout(refreshTimeout.current);
      setRefreshing(false);
      setPlayers(onlineResponse.players);
      setPlayersLoaded(true);
      if (onlineResponse.maxPlayers !== null) setMaxPlayers(onlineResponse.maxPlayers);
    }

    const tpsValues = parseTps(plainText);
    if (tpsValues && tpsPending.current) {
      tpsPending.current = false;
      if (tpsTimeout.current) clearTimeout(tpsTimeout.current);
      setTps(tpsValues);
      setTpsUnavailable(false);
      setTpsLoading(false);
    }

    const statsTargetName = statsTarget.current;
    if (statsTargetName && plainText.toLowerCase().includes(statsTargetName.toLowerCase())) {
      const marker = plainText.match(/has the following entity data:\s*(.*)$/i);
      const failed = /unable to get entity data|no entity was found|unknown or incomplete command/i.test(plainText);
      if (marker || failed) {
        const field = statsQueue.current.shift();
        if (field && marker) {
          setPlayerStats((current) => ({ ...current, [field]: formatLiveStat(field, marker[1]) }));
        }
        if (statsQueue.current.length === 0) {
          statsTarget.current = null;
          if (statsTimeout.current) clearTimeout(statsTimeout.current);
          setStatsLoading(false);
        }
      }
    }

    const inventoryTargetName = inventoryTarget.current;
    if (inventoryTargetName && plainText.toLowerCase().includes(inventoryTargetName.toLowerCase())) {
      const marker = plainText.match(/has the following entity data:\s*(.*)$/i);
      if (marker) {
        inventoryTarget.current = null;
        if (inventoryTimeout.current) clearTimeout(inventoryTimeout.current);
        setInventoryRaw(marker[1]);
        setInventoryItems(parseInventoryItems(marker[1]));
        setInventoryLoading(false);
      } else if (/unable to get entity data|no entity was found|unknown or incomplete command/i.test(plainText)) {
        inventoryTarget.current = null;
        if (inventoryTimeout.current) clearTimeout(inventoryTimeout.current);
        setInventoryRaw(plainText);
        setInventoryItems([]);
        setInventoryLoading(false);
      }
    }

    const pingTargetName = pingTarget.current;
    if (pingTargetName && plainText.toLowerCase().includes(pingTargetName.toLowerCase())) {
      const ping =
        plainText.match(/(?:ping[^0-9]{0,24}|(?:'s|’s)\s*ping[^0-9]{0,24})(\d+(?:\.\d+)?)\s*ms\b/i) ??
        plainText.match(/\b(\d+(?:\.\d+)?)\s*ms\b/i);
      if (ping) {
        pingTarget.current = null;
        if (pingTimeout.current) clearTimeout(pingTimeout.current);
        setPingResults((current) => ({ ...current, [pingTargetName]: `${ping[1]} ms` }));
        setPingLoading(null);
      }
    }
  }, []);

  useEffect(() => {
    if (!socketInstance) return;
    socketInstance.addListener(SocketEvent.CONSOLE_OUTPUT, onConsoleOutput);
    return () => {
      socketInstance.removeListener(SocketEvent.CONSOLE_OUTPUT, onConsoleOutput);
    };
  }, [onConsoleOutput, socketInstance]);

  useEffect(
    () => () => {
      if (refreshTimeout.current) clearTimeout(refreshTimeout.current);
      if (tpsTimeout.current) clearTimeout(tpsTimeout.current);
      if (pingTimeout.current) clearTimeout(pingTimeout.current);
      if (inventoryTimeout.current) clearTimeout(inventoryTimeout.current);
      if (statsTimeout.current) clearTimeout(statsTimeout.current);
      responsePending.current = false;
      tpsPending.current = false;
      pingTarget.current = null;
      inventoryTarget.current = null;
      statsTarget.current = null;
      statsQueue.current = [];
    },
    [],
  );

  const requestAction = (action: PlayerAction, value: string) => {
    const normalized = value.trim();
    const validTarget = action === 'pardon-ip' ? isValidIp(normalized) : PLAYER_NAME_PATTERN.test(normalized);
    if (!validTarget) {
      addToast(t('tools.invalidPlayerName', {}), 'error');
      return;
    }

    if (action === 'wipe-data') {
      if (!canReadFiles || !canStatFiles || !canDeleteFiles) {
        addToast(t('tools.playerWipePermissionRequired', {}), 'error');
        return;
      }
      if (!serverStopped || serverBusy) {
        addToast(t('tools.playerWipeServerMustBeStopped', {}), 'error');
        return;
      }
      if (!getPlayerRecord(normalized)?.uuid) {
        addToast(t('tools.playerUuidUnavailable', {}), 'error');
        return;
      }
      setPendingAction({ action, username: normalized });
      return;
    }

    if (!canSendCommands) {
      addToast(t('tools.playerCommandPermissionRequired', {}), 'error');
      return;
    }
    if (!serverRunning || !socketConnected || !socketInstance) {
      addToast(t('tools.playerServerUnavailable', {}), 'error');
      return;
    }
    setPendingAction({ action, username: normalized });
  };

  const saveMaxPlayers = async () => {
    const value = Number(maxPlayersDraft);
    if (!canReadFiles || !canWriteFiles) {
      addToast(t('tools.serverPropertiesPermissionRequired', {}), 'error');
      return;
    }
    if (!Number.isInteger(value) || value < 1 || value > 10000) {
      addToast(t('tools.invalidMaxPlayers', {}), 'error');
      return;
    }
    if (serverBusy) {
      addToast(t('tools.serverBusy', {}), 'error');
      return;
    }

    setSavingMaxPlayers(true);
    try {
      await saveMaxPlayersProperty(serverUuid, value);
      setMaxPlayers(value);
      setMaxPlayersModalOpen(false);
      addToast(t('tools.maxPlayersSaved', { count: value }), 'success');
    } catch (error) {
      addToast(httpErrorToHuman(error), 'error');
    } finally {
      setSavingMaxPlayers(false);
    }
  };

  const wipePlayerData = async (playerName: string) => {
    const playerUuid = getPlayerRecord(playerName)?.uuid;
    if (!canReadFiles || !canStatFiles || !canDeleteFiles) throw new Error(t('tools.playerWipePermissionRequired', {}));
    if (!serverStopped || serverBusy) throw new Error(t('tools.playerWipeServerMustBeStopped', {}));
    if (!worldName) throw new Error(t('tools.playerWipeUnsupportedWorldPath', {}));
    if (!playerUuid) throw new Error(t('tools.playerUuidUnavailable', {}));
    if (!isValidPlayerUuid(playerUuid)) throw new Error(t('tools.playerUuidUnavailable', {}));

    const uuidNames = [...new Set([playerUuid, playerUuid.replace(/-/g, '')])];
    const directories = [
      { path: `/${worldName}/playerdata`, extension: '.dat' },
      { path: `/${worldName}/playerdata`, extension: '.dat_old' },
      { path: `/${worldName}/advancements`, extension: '.json' },
      { path: `/${worldName}/stats`, extension: '.json' },
    ];
    let deleted = 0;

    for (const directory of directories) {
      try {
        const entries = await statFiles(
          serverUuid,
          directory.path,
          uuidNames.map((uuid) => `${uuid}${directory.extension}`),
        );
        const allowedNames = new Set(uuidNames.map((uuid) => `${uuid}${directory.extension}`));
        const files = entries
          .filter((entry) => entry.file && !entry.symlink && allowedNames.has(entry.name))
          .map((entry) => entry.name);
        if (files.length > 0) {
          await deleteFiles(serverUuid, directory.path, files, true);
          deleted += files.length;
        }
      } catch (error) {
        if (getHttpStatus(error) !== 404) throw error;
      }
    }

    if (deleted === 0) throw new Error(t('tools.playerDataNotFound', { username: playerName }));
  };

  const confirmAction = async () => {
    if (!pendingAction) return;

    if (pendingAction.action === 'wipe-data') {
      if (!serverStopped || serverBusy || !canReadFiles || !canStatFiles || !canDeleteFiles) return;
      setWipingPlayer(true);
      try {
        await wipePlayerData(pendingAction.username);
        addToast(t('tools.playerDataWiped', { username: pendingAction.username }), 'success');
        setPendingAction(null);
        await loadPlayerLists();
      } catch (error) {
        addToast(error instanceof Error ? error.message : httpErrorToHuman(error), 'error');
      } finally {
        setWipingPlayer(false);
      }
      return;
    }

    if (!socketInstance || !canSendCommands || !serverRunning || !socketConnected) return;

    socketInstance.send(SocketRequest.SEND_COMMAND, buildCommand(pendingAction.action, pendingAction.username));
    addToast(
      t('tools.playerActionSent', {
        action: actionLabels[pendingAction.action],
        username: pendingAction.username,
      }),
      'success',
    );
    setPendingAction(null);
  };

  const requestPing = (player: string) => {
    if (!canReadConsole || !canSendCommands || !socketConnected || !socketInstance || !serverRunning) return;
    if (pingTimeout.current) clearTimeout(pingTimeout.current);
    pingTarget.current = player;
    setPingLoading(player);
    setPingResults((current) => ({ ...current, [player]: '' }));
    socketInstance.send(SocketRequest.SEND_COMMAND, `ping ${player}`);
    pingTimeout.current = setTimeout(() => {
      if (pingTarget.current === player) {
        pingTarget.current = null;
        setPingLoading(null);
        setPingResults((current) => ({ ...current, [player]: t('tools.pingUnavailable', {}) }));
      }
    }, 5000);
  };

  const requestInventory = (player: string) => {
    if (!canReadConsole || !canSendCommands || !socketConnected || !socketInstance || !serverRunning) return;
    if (inventoryTimeout.current) clearTimeout(inventoryTimeout.current);
    inventoryTarget.current = player;
    setInventoryPlayer(player);
    setInventoryItems([]);
    setInventoryRaw('');
    setInventoryLoading(true);
    socketInstance.send(SocketRequest.SEND_COMMAND, `data get entity ${player} Inventory`);
    inventoryTimeout.current = setTimeout(() => {
      if (inventoryTarget.current === player) {
        inventoryTarget.current = null;
        setInventoryLoading(false);
        setInventoryRaw(t('tools.inventoryUnavailable', {}));
      }
    }, 10000);
  };

  const validUsername = PLAYER_NAME_PATTERN.test(username.trim());
  const unlistedAttempts = nonWhitelistedAttempts.filter(
    (name) => !whitelistedPlayers.some((record) => record.name.toLowerCase() === name.toLowerCase()),
  );

  return (
    <Stack gap='md'>
      <div>
        <Text size='sm' c='dimmed'>
          {t('tools.playersDescription', {})}
        </Text>
      </div>

      {!canReadConsole && <Alert color='yellow'>{t('tools.playerReadPermissionRequired', {})}</Alert>}
      {!canReadConsoleOutput && <Alert color='yellow'>{t('tools.playerAttemptsPermissionRequired', {})}</Alert>}
      {!canSendCommands && <Alert color='yellow'>{t('tools.playerCommandPermissionRequired', {})}</Alert>}
      {!canReadFiles && <Alert color='yellow'>{t('tools.playerListsUnavailable', {})}</Alert>}
      {!serverRunning && <Alert color='yellow'>{t('tools.playerServerOffline', {})}</Alert>}
      {serverRunning && !socketConnected && <Alert color='yellow'>{t('tools.websocketRequired', {})}</Alert>}

      <Card withBorder padding='md' radius='md'>
        <Stack gap='sm'>
          <div>
            <Text fw={600}>{t('tools.nonWhitelistedAttempts', {})}</Text>
            <Text size='xs' c='dimmed'>
              {t('tools.nonWhitelistedAttemptsDescription', {})}
            </Text>
          </div>
          {!canReadConsoleOutput ? (
            <Text size='sm' c='dimmed'>
              {t('tools.playerAttemptsPermissionRequired', {})}
            </Text>
          ) : unlistedAttempts.length === 0 ? (
            <Text size='sm' c='dimmed'>
              {t('tools.noNonWhitelistedAttempts', {})}
            </Text>
          ) : (
            <Group gap='xs' wrap='wrap'>
              {unlistedAttempts.map((player) => (
                <Button
                  key={player}
                  size='xs'
                  color='red'
                  variant='light'
                  disabled={!canSendCommands || !serverRunning || !socketConnected}
                  onClick={() => requestAction('ban', player)}
                >
                  {t('tools.banAttemptingPlayer', { username: player })}
                </Button>
              ))}
            </Group>
          )}
        </Stack>
      </Card>

      <Card withBorder padding='md' radius='md'>
        <Stack gap='sm'>
          <Group justify='space-between'>
            <div>
              <Text fw={600}>{t('tools.onlinePlayers', {})}</Text>
              {playersLoaded && maxPlayers !== null && (
                <Text size='xs' c='dimmed'>
                  {t('tools.onlinePlayerCapacity', { online: players.length, max: maxPlayers })}
                </Text>
              )}
            </div>
            <Group gap='xs'>
              {canReadFiles && canWriteFiles && (
                <Button
                  size='xs'
                  variant='subtle'
                  leftSection={<FontAwesomeIcon icon={faPenToSquare} />}
                  disabled={serverBusy}
                  onClick={() => {
                    setMaxPlayersDraft(maxPlayers ?? 20);
                    setMaxPlayersModalOpen(true);
                  }}
                >
                  {t('tools.editMaxPlayers', {})}
                </Button>
              )}
              <Button
                variant='light'
                leftSection={<FontAwesomeIcon icon={faRotate} />}
                loading={refreshing || tpsLoading}
                disabled={!canReadConsole || !canSendCommands || !serverRunning || !socketConnected || !socketInstance}
                onClick={refreshPlayers}
              >
                {t('tools.refreshServerStats', {})}
              </Button>
            </Group>
          </Group>
          {canReadFiles && (
            <Group justify='flex-end'>
              <Button size='xs' variant='subtle' loading={loadingLists} onClick={() => void loadPlayerLists()}>
                {t('tools.readPlayerLists', {})}
              </Button>
            </Group>
          )}
          <Group gap='sm'>
            <Badge variant='light'>
              {tpsLoading
                ? t('tools.loadingTps', {})
                : tpsUnavailable
                  ? t('tools.tpsUnavailable', {})
                  : t('tools.tpsValue', { values: tps?.join(' · ') ?? '—' })}
            </Badge>
            {maxPlayers !== null && <Badge variant='outline'>{t('tools.maxPlayers', { count: maxPlayers })}</Badge>}
          </Group>

          {!canReadConsole || !canSendCommands ? (
            <Text size='sm' c='dimmed'>
              {t('tools.playerReadPermissionRequired', {})}
            </Text>
          ) : players.length === 0 ? (
            <Text size='sm' c='dimmed'>
              {refreshing
                ? t('tools.loadingPlayers', {})
                : playersLoaded
                  ? t('tools.noPlayersOnline', {})
                  : t('tools.playerListNotLoaded', {})}
            </Text>
          ) : (
            <Table.ScrollContainer minWidth={760}>
              <Table striped highlightOnHover>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t('tools.playerName', {})}</Table.Th>
                    <Table.Th>{t('tools.ping', {})}</Table.Th>
                    <Table.Th>{t('tools.actions', {})}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {players.map((player) => (
                    <Table.Tr key={player}>
                      <Table.Td>{player}</Table.Td>
                      <Table.Td>
                        {pingLoading === player ? t('tools.loadingPing', {}) : (pingResults[player] ?? '—')}
                      </Table.Td>
                      <Table.Td>
                        <Group gap='xs' wrap='wrap'>
                          <Button size='xs' variant='default' onClick={() => openPlayerDetails(player)}>
                            {t('tools.details', {})}
                          </Button>
                          <Button
                            size='xs'
                            variant='subtle'
                            disabled={
                              !canReadConsole ||
                              !canSendCommands ||
                              !serverRunning ||
                              !socketConnected ||
                              !socketInstance
                            }
                            onClick={() => requestPing(player)}
                          >
                            {t('tools.ping', {})}
                          </Button>
                          <Button
                            size='xs'
                            variant='subtle'
                            disabled={
                              !canReadConsole ||
                              !canSendCommands ||
                              !serverRunning ||
                              !socketConnected ||
                              !socketInstance
                            }
                            onClick={() => requestInventory(player)}
                          >
                            {t('tools.inventory', {})}
                          </Button>
                          <Button
                            size='xs'
                            color='orange'
                            variant='light'
                            leftSection={<FontAwesomeIcon icon={faUserSlash} />}
                            disabled={!canSendCommands || !serverRunning || !socketConnected}
                            onClick={() => requestAction('kick', player)}
                          >
                            {t('tools.kick', {})}
                          </Button>
                          <Button
                            size='xs'
                            color='red'
                            variant='light'
                            disabled={!canSendCommands || !serverRunning || !socketConnected}
                            onClick={() => requestAction('ban', player)}
                          >
                            {t('tools.ban', {})}
                          </Button>
                        </Group>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          )}
        </Stack>
      </Card>

      <Tabs defaultValue='banned' keepMounted={false}>
        <Tabs.List grow>
          <Tabs.Tab value='banned'>
            {t('tools.bannedPlayers', {})} ({bannedPlayers.length})
          </Tabs.Tab>
          <Tabs.Tab value='whitelist'>
            {t('tools.whitelistedPlayers', {})} ({whitelistedPlayers.length})
          </Tabs.Tab>
          <Tabs.Tab value='ops'>
            {t('tools.operators', {})} ({operators.length})
          </Tabs.Tab>
          <Tabs.Tab value='bannedIps'>
            {t('tools.bannedIps', {})} ({bannedIps.length})
          </Tabs.Tab>
          <Tabs.Tab value='offline'>
            {t('tools.offlinePlayers', {})} ({offlinePlayers.length})
          </Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value='banned' pt='md'>
          {canReadFiles ? (
            <PlayerListCard
              records={bannedPlayers}
              emptyLabel={t('tools.noBannedPlayers', {})}
              loading={loadingLists}
              canManage={canSendCommands && serverRunning && socketConnected}
              actionLabel={t('tools.unban', {})}
              onAction={(player) => requestAction('pardon', player)}
              onDetails={(record) => openPlayerDetails(record.name)}
              detail={(record) => [record.reason, record.expires].filter(Boolean).join(' · ')}
            />
          ) : (
            <Alert color='yellow'>{t('tools.playerListsUnavailable', {})}</Alert>
          )}
        </Tabs.Panel>
        <Tabs.Panel value='whitelist' pt='md'>
          {canReadFiles ? (
            <PlayerListCard
              records={whitelistedPlayers}
              emptyLabel={t('tools.noWhitelistedPlayers', {})}
              loading={loadingLists}
              canManage={canSendCommands && serverRunning && socketConnected}
              actionLabel={t('tools.whitelistRemove', {})}
              onAction={(player) => requestAction('whitelist-remove', player)}
              onDetails={(record) => openPlayerDetails(record.name)}
            />
          ) : (
            <Alert color='yellow'>{t('tools.playerListsUnavailable', {})}</Alert>
          )}
        </Tabs.Panel>
        <Tabs.Panel value='ops' pt='md'>
          {canReadFiles ? (
            <PlayerListCard
              records={operators}
              emptyLabel={t('tools.noOperators', {})}
              loading={loadingLists}
              onDetails={(record) => openPlayerDetails(record.name)}
              detail={(record) => (record.level === undefined ? '' : t('tools.operatorLevel', { level: record.level }))}
            />
          ) : (
            <Alert color='yellow'>{t('tools.playerListsUnavailable', {})}</Alert>
          )}
        </Tabs.Panel>
        <Tabs.Panel value='bannedIps' pt='md'>
          {canReadFiles ? (
            loadingLists ? (
              <Group justify='center' py='md'>
                <Loader size='sm' />
              </Group>
            ) : bannedIps.length === 0 ? (
              <Text size='sm' c='dimmed'>
                {t('tools.noBannedIps', {})}
              </Text>
            ) : (
              <SimpleGrid cols={{ base: 1, md: 2 }} spacing='sm'>
                {bannedIps.map((entry) => (
                  <Card key={entry.ip} withBorder padding='md' radius='md'>
                    <Group justify='space-between' align='center'>
                      <div>
                        <Code>{entry.ip}</Code>
                        {(entry.reason || entry.expires) && (
                          <Text size='xs' c='dimmed' mt={4}>
                            {[entry.reason, entry.expires].filter(Boolean).join(' · ')}
                          </Text>
                        )}
                      </div>
                      <Button
                        size='xs'
                        variant='light'
                        disabled={!canSendCommands || !serverRunning || !socketConnected}
                        onClick={() => requestAction('pardon-ip', entry.ip)}
                      >
                        {t('tools.unbanIp', {})}
                      </Button>
                    </Group>
                  </Card>
                ))}
              </SimpleGrid>
            )
          ) : (
            <Alert color='yellow'>{t('tools.playerListsUnavailable', {})}</Alert>
          )}
        </Tabs.Panel>
        <Tabs.Panel value='offline' pt='md'>
          {canReadFiles ? (
            <>
              <Alert color='blue' mb='sm'>
                {t('tools.offlinePlayersDescription', {})}
              </Alert>
              <PlayerListCard
                records={offlinePlayers}
                emptyLabel={t('tools.noOfflinePlayers', {})}
                loading={loadingLists}
                onDetails={(record) => openPlayerDetails(record.name)}
                detail={(record) => (record.uuid ? record.uuid : '')}
              />
            </>
          ) : (
            <Alert color='yellow'>{t('tools.playerListsUnavailable', {})}</Alert>
          )}
        </Tabs.Panel>
      </Tabs>

      <Card withBorder padding='md' radius='md'>
        <Stack gap='sm'>
          <Text fw={600}>{t('tools.manageByName', {})}</Text>
          <TextInput
            label={t('tools.playerName', {})}
            placeholder={t('tools.playerNamePlaceholder', {})}
            value={username}
            onChange={(event) => setUsername(event.currentTarget.value)}
            maxLength={16}
          />
          <Group gap='xs' wrap='wrap'>
            {(['ban', 'pardon', 'whitelist-add', 'whitelist-remove'] as PlayerAction[]).map((action) => (
              <Button
                key={action}
                variant='light'
                disabled={!validUsername || !canSendCommands || !serverRunning || !socketConnected}
                onClick={() => requestAction(action, username)}
              >
                {actionLabels[action]}
              </Button>
            ))}
          </Group>
        </Stack>
      </Card>

      <Text size='xs' c='dimmed'>
        {t('tools.playerManagerNote', {})}
      </Text>

      <Modal
        opened={selectedPlayer !== null}
        onClose={closePlayerDetails}
        title={t('tools.playerDetailsTitle', { username: selectedPlayer ?? '' })}
        size='lg'
        centered
      >
        {selectedPlayer && (
          <Stack gap='md'>
            <Group align='center' wrap='nowrap'>
              <Avatar alt={selectedPlayer} size={72} radius='md' color='blue'>
                {selectedPlayer.slice(0, 2).toUpperCase()}
              </Avatar>
              <Stack gap={4} className='min-w-0 flex-1'>
                <Group gap='xs'>
                  <Text fw={700} size='lg'>
                    {selectedPlayer}
                  </Text>
                  {selectedPlayerUuid && (
                    <Button
                      size='compact-xs'
                      variant='subtle'
                      leftSection={<FontAwesomeIcon icon={faCopy} />}
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(selectedPlayerUuid);
                          addToast(t('tools.playerUuidCopied', {}), 'success');
                        } catch {
                          addToast(t('tools.playerUuidCopyFailed', {}), 'error');
                        }
                      }}
                    >
                      {t('tools.copyUuid', {})}
                    </Button>
                  )}
                </Group>
                <Group gap='xs' wrap='wrap'>
                  <Badge color={selectedPlayerIsOnline ? 'green' : 'gray'}>
                    {selectedPlayerIsOnline ? t('tools.onlineStatus', {}) : t('tools.offlineStatus', {})}
                  </Badge>
                  {selectedPlayerIsOperator && <Badge color='orange'>{t('tools.operatorStatus', {})}</Badge>}
                  {selectedPlayerIsWhitelisted && <Badge color='teal'>{t('tools.whitelistedStatus', {})}</Badge>}
                  {selectedPlayerIsBanned && <Badge color='red'>{t('tools.bannedStatus', {})}</Badge>}
                </Group>
                {selectedPlayerUuid && <Code>{selectedPlayerUuid}</Code>}
              </Stack>
            </Group>

            <Tabs
              value={detailsTab}
              onChange={(value) => {
                if (!value) return;
                setDetailsTab(value);
                if (value === 'stats') void loadPlayerStats(selectedPlayer);
              }}
              keepMounted={false}
            >
              <Tabs.List grow>
                <Tabs.Tab value='actions'>{t('tools.playerActionsTab', {})}</Tabs.Tab>
                <Tabs.Tab value='stats'>{t('tools.playerStatsTab', {})}</Tabs.Tab>
              </Tabs.List>
              <Tabs.Panel value='actions' pt='md'>
                <Stack gap='md'>
                  <SimpleGrid cols={{ base: 1, sm: 2 }} spacing='xs'>
                    <Button
                      variant='light'
                      disabled={!canSendCommands || !serverRunning || !socketConnected}
                      onClick={() => requestAction(selectedPlayerIsOperator ? 'deop' : 'op', selectedPlayer)}
                    >
                      {selectedPlayerIsOperator ? t('tools.playerActions.deop', {}) : t('tools.playerActions.op', {})}
                    </Button>
                    <Button
                      variant='light'
                      disabled={!canSendCommands || !serverRunning || !socketConnected}
                      onClick={() =>
                        requestAction(
                          selectedPlayerIsWhitelisted ? 'whitelist-remove' : 'whitelist-add',
                          selectedPlayer,
                        )
                      }
                    >
                      {selectedPlayerIsWhitelisted ? t('tools.whitelistRemove', {}) : t('tools.whitelistAdd', {})}
                    </Button>
                    <Button
                      color='red'
                      variant='light'
                      disabled={!canSendCommands || !serverRunning || !socketConnected}
                      onClick={() => requestAction(selectedPlayerIsBanned ? 'pardon' : 'ban', selectedPlayer)}
                    >
                      {selectedPlayerIsBanned ? t('tools.unban', {}) : t('tools.ban', {})}
                    </Button>
                    <Button
                      color='red'
                      variant='light'
                      disabled={!selectedPlayerIsOnline || !canSendCommands || !serverRunning || !socketConnected}
                      onClick={() => requestAction('ban-ip', selectedPlayer)}
                    >
                      {t('tools.banPlayerIp', {})}
                    </Button>
                    <Button
                      variant='default'
                      disabled={
                        !selectedPlayerIsOnline ||
                        !canReadConsole ||
                        !canSendCommands ||
                        !serverRunning ||
                        !socketConnected
                      }
                      onClick={() => requestInventory(selectedPlayer)}
                    >
                      {t('tools.inventory', {})}
                    </Button>
                    <Button
                      color='orange'
                      variant='light'
                      disabled={!selectedPlayerIsOnline || !canSendCommands || !serverRunning || !socketConnected}
                      onClick={() => requestAction('kick', selectedPlayer)}
                    >
                      {t('tools.kick', {})}
                    </Button>
                    <Button
                      color='orange'
                      variant='light'
                      disabled={!selectedPlayerIsOnline || !canSendCommands || !serverRunning || !socketConnected}
                      onClick={() => requestAction('clear-inventory', selectedPlayer)}
                    >
                      {t('tools.clearInventory', {})}
                    </Button>
                    <Button
                      color='red'
                      variant='light'
                      disabled={!selectedPlayerIsOnline || !canSendCommands || !serverRunning || !socketConnected}
                      onClick={() => requestAction('kill', selectedPlayer)}
                    >
                      {t('tools.killPlayer', {})}
                    </Button>
                    <Button
                      color='red'
                      variant='light'
                      disabled={
                        !selectedPlayerUuid ||
                        !canReadFiles ||
                        !canStatFiles ||
                        !canDeleteFiles ||
                        !serverStopped ||
                        serverBusy
                      }
                      onClick={() => requestAction('wipe-data', selectedPlayer)}
                    >
                      {t('tools.wipePlayerData', {})}
                    </Button>
                  </SimpleGrid>
                  {!serverStopped || serverBusy ? (
                    <Text size='xs' c='dimmed'>
                      {t('tools.playerWipeServerMustBeStopped', {})}
                    </Text>
                  ) : !canReadFiles || !canStatFiles || !canDeleteFiles ? (
                    <Text size='xs' c='dimmed'>
                      {t('tools.playerWipePermissionRequired', {})}
                    </Text>
                  ) : !selectedPlayerUuid ? (
                    <Text size='xs' c='dimmed'>
                      {t('tools.playerUuidUnavailable', {})}
                    </Text>
                  ) : null}
                </Stack>
              </Tabs.Panel>
              <Tabs.Panel value='stats' pt='md'>
                <Stack gap='sm'>
                  {!canReadFiles && <Alert color='yellow'>{t('tools.playerStatsFilePermissionRequired', {})}</Alert>}
                  {!canReadConsole && selectedPlayerIsOnline && (
                    <Alert color='yellow'>{t('tools.playerStatsConsolePermissionRequired', {})}</Alert>
                  )}
                  {statsLoading ? (
                    <Group>
                      <Loader size='sm' />
                      <Text size='sm' c='dimmed'>
                        {t('tools.playerStatsLoading', {})}
                      </Text>
                    </Group>
                  ) : (
                    <SimpleGrid cols={{ base: 1, sm: 2 }} spacing='xs'>
                      <PlayerStat label={t('tools.playerPosition', {})} value={playerStats.position} />
                      <PlayerStat label={t('tools.playerGamemode', {})} value={playerStats.gameMode} />
                      <PlayerStat label={t('tools.playerPlaytime', {})} value={playerStats.playtime} />
                      <PlayerStat label={t('tools.playerKills', {})} value={playerStats.kills} />
                      <PlayerStat label={t('tools.playerDeaths', {})} value={playerStats.deaths} />
                      <PlayerStat
                        label={t('tools.playerXp', {})}
                        value={
                          playerStats.xpLevel || playerStats.xpTotal
                            ? t('tools.playerXpValue', {
                                level: playerStats.xpLevel ?? '—',
                                total: playerStats.xpTotal ?? '—',
                              })
                            : null
                        }
                      />
                      <PlayerStat label={t('tools.playerLastDeath', {})} value={playerStats.lastDeath} />
                    </SimpleGrid>
                  )}
                  {!statsLoading && Object.values(playerStats).every((value) => value === null) && (
                    <Text size='sm' c='dimmed'>
                      {t('tools.playerStatsUnavailable', {})}
                    </Text>
                  )}
                  <Group justify='flex-end'>
                    <Button
                      variant='light'
                      disabled={(!canReadFiles && !canReadConsole) || !selectedPlayer}
                      onClick={() => selectedPlayer && void loadPlayerStats(selectedPlayer)}
                    >
                      {t('tools.refreshPlayerStats', {})}
                    </Button>
                  </Group>
                </Stack>
              </Tabs.Panel>
            </Tabs>
          </Stack>
        )}
      </Modal>

      <Modal
        opened={maxPlayersModalOpen}
        onClose={() => {
          if (!savingMaxPlayers) setMaxPlayersModalOpen(false);
        }}
        title={t('tools.maxPlayersTitle', {})}
        centered
      >
        <Stack gap='md'>
          <NumberInput
            label={t('tools.maxPlayersInputLabel', {})}
            min={1}
            max={10000}
            allowDecimal={false}
            value={maxPlayersDraft}
            onChange={setMaxPlayersDraft}
            disabled={savingMaxPlayers || serverBusy}
          />
          <Alert color='yellow'>{t('tools.maxPlayersRestartNotice', {})}</Alert>
          <Group justify='flex-end'>
            <Button variant='default' disabled={savingMaxPlayers} onClick={() => setMaxPlayersModalOpen(false)}>
              {t('tools.cancel', {})}
            </Button>
            <Button loading={savingMaxPlayers} disabled={serverBusy} onClick={() => void saveMaxPlayers()}>
              {t('tools.saveMaxPlayers', {})}
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Modal
        opened={inventoryPlayer !== null}
        onClose={() => {
          setInventoryPlayer(null);
          inventoryTarget.current = null;
          if (inventoryTimeout.current) clearTimeout(inventoryTimeout.current);
          setInventoryLoading(false);
        }}
        title={t('tools.inventoryTitle', { username: inventoryPlayer ?? '' })}
        size='lg'
      >
        <Stack gap='sm'>
          {inventoryLoading ? (
            <Group>
              <Loader size='sm' />
              <Text size='sm' c='dimmed'>
                {t('tools.inventoryLoading', {})}
              </Text>
            </Group>
          ) : inventoryItems.length > 0 ? (
            inventoryItems.map((item, index) => (
              <Text key={`${item.slot ?? index}-${index}`} size='sm'>
                {item.slot === undefined ? '' : `Slot ${item.slot}: `}
                {item.id ?? item.raw}
                {item.count === undefined ? '' : ` × ${item.count}`}
              </Text>
            ))
          ) : inventoryRaw === '[]' || inventoryRaw === '' ? (
            <Text size='sm' c='dimmed'>
              {t('tools.inventoryNoItems', {})}
            </Text>
          ) : (
            <>
              <Text size='sm' c='dimmed'>
                {t('tools.inventoryRaw', {})}
              </Text>
              <Code block>{inventoryRaw}</Code>
            </>
          )}
        </Stack>
      </Modal>

      <Modal
        opened={pendingAction !== null}
        onClose={() => {
          if (!wipingPlayer) setPendingAction(null);
        }}
        title={t('tools.confirmPlayerAction', {})}
        centered
        closeOnClickOutside={!wipingPlayer}
        closeOnEscape={!wipingPlayer}
      >
        {pendingAction && (
          <Stack gap='md'>
            <Text>
              {pendingAction.action === 'wipe-data'
                ? t('tools.playerWipeConfirmDescription', { username: pendingAction.username })
                : t('tools.confirmPlayerActionDescription', {
                    action: actionLabels[pendingAction.action],
                    username: pendingAction.username,
                  })}
            </Text>
            {pendingAction.action === 'wipe-data' && (
              <Alert color='red'>{t('tools.playerWipeServerMustBeStopped', {})}</Alert>
            )}
            <Group justify='flex-end'>
              <Button variant='default' disabled={wipingPlayer} onClick={() => setPendingAction(null)}>
                {t('tools.cancel', {})}
              </Button>
              <Button
                color='red'
                loading={wipingPlayer}
                disabled={
                  pendingAction.action === 'wipe-data' &&
                  (!serverStopped || serverBusy || !canReadFiles || !canStatFiles || !canDeleteFiles)
                }
                onClick={() => void confirmAction()}
              >
                {t('tools.confirm', {})}
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </Stack>
  );
}

function PlayerListCard({
  records,
  emptyLabel,
  loading,
  canManage,
  actionLabel,
  onAction,
  onDetails,
  detail,
}: {
  records: PlayerRecord[];
  emptyLabel: string;
  loading: boolean;
  canManage?: boolean;
  actionLabel?: string;
  onAction?: (username: string) => void;
  onDetails?: (record: PlayerRecord) => void;
  detail?: (record: PlayerRecord) => string;
}) {
  const { t } = useExtTranslations();

  if (loading)
    return (
      <Group justify='center' py='md'>
        <Loader size='sm' />
      </Group>
    );
  if (records.length === 0)
    return (
      <Text size='sm' c='dimmed'>
        {emptyLabel}
      </Text>
    );

  return (
    <Table.ScrollContainer minWidth={520}>
      <Table striped highlightOnHover>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t('tools.playerName', {})}</Table.Th>
            <Table.Th>{t('tools.playerDetails', {})}</Table.Th>
            {(actionLabel || onDetails) && <Table.Th>{t('tools.actions', {})}</Table.Th>}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {records.map((record) => (
            <Table.Tr key={`${record.uuid ?? record.name}-${record.name}`}>
              <Table.Td>{record.name}</Table.Td>
              <Table.Td>{detail?.(record) ?? ''}</Table.Td>
              {(onDetails || (actionLabel && onAction)) && (
                <Table.Td>
                  <Group gap='xs'>
                    {onDetails && (
                      <Button size='xs' variant='default' onClick={() => onDetails(record)}>
                        {t('tools.details', {})}
                      </Button>
                    )}
                    {actionLabel && onAction && (
                      <Button size='xs' variant='light' disabled={!canManage} onClick={() => onAction(record.name)}>
                        {actionLabel}
                      </Button>
                    )}
                  </Group>
                </Table.Td>
              )}
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

function PlayerStat({ label, value }: { label: string; value: string | null }) {
  return (
    <Card withBorder padding='sm' radius='sm'>
      <Text size='xs' c='dimmed'>
        {label}
      </Text>
      <Text fw={600} mt={4}>
        {value ?? '—'}
      </Text>
    </Card>
  );
}
