import { faRotate, faUserSlash } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  Alert,
  Badge,
  Button,
  Card,
  Code,
  Group,
  Loader,
  Modal,
  Stack,
  Table,
  Tabs,
  Text,
  TextInput,
} from '@mantine/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getHttpStatus, httpErrorToHuman } from '@/api/axios.ts';
import getFileContent from '@/api/server/files/getFileContent.ts';
import { SocketEvent, SocketRequest } from '@/plugins/websocket/useWebsocketEvent.ts';
import type { Websocket } from '@/plugins/websocket/Websocket.ts';
import { useToast } from '@/providers/ToastProvider.tsx';
import { useExtTranslations } from './translations.ts';

type PlayerAction = 'kick' | 'ban' | 'pardon' | 'whitelist-add' | 'whitelist-remove';

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

interface InventoryItem {
  slot?: number;
  id?: string;
  count?: number;
  raw: string;
}

interface Props {
  canReadConsole: boolean;
  canSendCommands: boolean;
  canReadFiles: boolean;
  serverUuid: string;
  serverRunning: boolean;
  socketConnected: boolean;
  socketInstance: Websocket | null;
}

const PLAYER_NAME_PATTERN = /^[A-Za-z0-9_]{3,16}$/;
const ANSI_SGR_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;:?]*m`, 'g');

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

async function readConfiguredMaxPlayers(serverUuid: string): Promise<number | null> {
  try {
    const file = await getFileContent(serverUuid, '/server.properties');
    const text = await file.text();
    const match = text.match(/^\s*max-players\s*=\s*(\d+)\s*$/m);
    return match ? Number(match[1]) : null;
  } catch (error) {
    if (getHttpStatus(error) === 404) return null;
    throw error;
  }
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
  }
}

export default function PlayerManagerPage({
  canReadConsole,
  canSendCommands,
  canReadFiles,
  serverUuid,
  serverRunning,
  socketConnected,
  socketInstance,
}: Props) {
  const { t } = useExtTranslations();
  const { addToast } = useToast();
  const [players, setPlayers] = useState<string[]>([]);
  const [playersLoaded, setPlayersLoaded] = useState(false);
  const [maxPlayers, setMaxPlayers] = useState<number | null>(null);
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
  const responsePending = useRef(false);
  const tpsPending = useRef(false);
  const pingTarget = useRef<string | null>(null);
  const inventoryTarget = useRef<string | null>(null);
  const refreshTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tpsTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inventoryTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const actionLabels: Record<PlayerAction, string> = {
    kick: t('tools.playerActions.kick', {}),
    ban: t('tools.playerActions.ban', {}),
    pardon: t('tools.playerActions.pardon', {}),
    'whitelist-add': t('tools.playerActions.whitelist-add', {}),
    'whitelist-remove': t('tools.playerActions.whitelist-remove', {}),
  };

  const loadPlayerLists = useCallback(async () => {
    if (!canReadFiles) return;

    setLoadingLists(true);
    try {
      const [banned, whitelisted, ops, configuredMaxPlayers] = await Promise.all([
        readPlayerJsonFile(serverUuid, '/banned-players.json'),
        readPlayerJsonFile(serverUuid, '/whitelist.json'),
        readPlayerJsonFile(serverUuid, '/ops.json'),
        readConfiguredMaxPlayers(serverUuid),
      ]);
      setBannedPlayers(banned);
      setWhitelistedPlayers(whitelisted);
      setOperators(ops);
      if (configuredMaxPlayers !== null) setMaxPlayers(configuredMaxPlayers);
    } catch (error) {
      addToast(httpErrorToHuman(error), 'error');
    } finally {
      setLoadingLists(false);
    }
  }, [addToast, canReadFiles, serverUuid]);

  useEffect(() => {
    void loadPlayerLists();
  }, [loadPlayerLists]);

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
      responsePending.current = false;
      tpsPending.current = false;
      pingTarget.current = null;
      inventoryTarget.current = null;
    },
    [],
  );

  const requestAction = (action: PlayerAction, value: string) => {
    const normalized = value.trim();
    if (!PLAYER_NAME_PATTERN.test(normalized)) {
      addToast(t('tools.invalidPlayerName', {}), 'error');
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

  const confirmAction = () => {
    if (!pendingAction || !socketInstance || !canSendCommands || !serverRunning || !socketConnected) return;

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

  return (
    <Stack gap='md'>
      <div>
        <Text size='sm' c='dimmed'>
          {t('tools.playersDescription', {})}
        </Text>
      </div>

      {!canReadConsole && <Alert color='yellow'>{t('tools.playerReadPermissionRequired', {})}</Alert>}
      {!canSendCommands && <Alert color='yellow'>{t('tools.playerCommandPermissionRequired', {})}</Alert>}
      {!canReadFiles && <Alert color='yellow'>{t('tools.playerListsUnavailable', {})}</Alert>}
      {!serverRunning && <Alert color='yellow'>{t('tools.playerServerMustRun', {})}</Alert>}
      {serverRunning && !socketConnected && <Alert color='yellow'>{t('tools.websocketRequired', {})}</Alert>}

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
              detail={(record) => (record.level === undefined ? '' : t('tools.operatorLevel', { level: record.level }))}
            />
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
        onClose={() => setPendingAction(null)}
        title={t('tools.confirmPlayerAction', {})}
        centered
      >
        {pendingAction && (
          <Stack gap='md'>
            <Text>
              {t('tools.confirmPlayerActionDescription', {
                action: actionLabels[pendingAction.action],
                username: pendingAction.username,
              })}
            </Text>
            <Group justify='flex-end'>
              <Button variant='default' onClick={() => setPendingAction(null)}>
                {t('tools.cancel', {})}
              </Button>
              <Button color='red' onClick={confirmAction}>
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
  detail,
}: {
  records: PlayerRecord[];
  emptyLabel: string;
  loading: boolean;
  canManage?: boolean;
  actionLabel?: string;
  onAction?: (username: string) => void;
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
            {actionLabel && <Table.Th>{t('tools.actions', {})}</Table.Th>}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {records.map((record) => (
            <Table.Tr key={`${record.uuid ?? record.name}-${record.name}`}>
              <Table.Td>{record.name}</Table.Td>
              <Table.Td>{detail?.(record) ?? ''}</Table.Td>
              {actionLabel && onAction && (
                <Table.Td>
                  <Button size='xs' variant='light' disabled={!canManage} onClick={() => onAction(record.name)}>
                    {actionLabel}
                  </Button>
                </Table.Td>
              )}
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}
