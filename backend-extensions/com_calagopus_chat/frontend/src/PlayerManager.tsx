import { faRotate, faUserSlash } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { Alert, Button, Card, Group, Modal, Stack, Table, Text, TextInput } from '@mantine/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { SocketEvent, SocketRequest } from '@/plugins/websocket/useWebsocketEvent.ts';
import type { Websocket } from '@/plugins/websocket/Websocket.ts';
import { useToast } from '@/providers/ToastProvider.tsx';
import { useExtTranslations } from './translations.ts';

type PlayerAction = 'kick' | 'ban' | 'pardon' | 'whitelist-add' | 'whitelist-remove';

interface PendingAction {
  action: PlayerAction;
  username: string;
}

interface Props {
  canReadConsole: boolean;
  canSendCommands: boolean;
  serverRunning: boolean;
  socketConnected: boolean;
  socketInstance: Websocket | null;
}

const PLAYER_NAME_PATTERN = /^[A-Za-z0-9_]{3,16}$/;

function parseOnlinePlayers(line: string): string[] | null {
  const plainText = line.replace(/\u001b\[[0-9;:?]*m/g, '').trim();
  const match = plainText.match(/there are\s+\d+(?:\s+of a max of\s+\d+)?\s+players online(?::\s*(.*))?/i);
  if (!match) return null;

  const names = (match[1] ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => PLAYER_NAME_PATTERN.test(name));
  return names;
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

export default function PlayerManager({
  canReadConsole,
  canSendCommands,
  serverRunning,
  socketConnected,
  socketInstance,
}: Props) {
  const { t } = useExtTranslations();
  const { addToast } = useToast();
  const [players, setPlayers] = useState<string[]>([]);
  const [username, setUsername] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const responsePending = useRef(false);
  const refreshTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const actionLabels: Record<PlayerAction, string> = {
    kick: t('tools.playerActions.kick', {}),
    ban: t('tools.playerActions.ban', {}),
    pardon: t('tools.playerActions.pardon', {}),
    'whitelist-add': t('tools.playerActions.whitelist-add', {}),
    'whitelist-remove': t('tools.playerActions.whitelist-remove', {}),
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
    responsePending.current = true;
    setRefreshing(true);
    socketInstance.send(SocketRequest.SEND_COMMAND, 'list');
    refreshTimeout.current = setTimeout(() => {
      if (responsePending.current) {
        responsePending.current = false;
        setRefreshing(false);
        addToast(t('tools.playerListTimedOut', {}), 'error');
      }
    }, 10000);
  }, [addToast, canReadConsole, canSendCommands, serverRunning, socketConnected, socketInstance, t]);

  const onConsoleOutput = useCallback(
    (line: string) => {
      if (!responsePending.current) return;
      const response = parseOnlinePlayers(line);
      if (!response) return;

      responsePending.current = false;
      if (refreshTimeout.current) clearTimeout(refreshTimeout.current);
      setRefreshing(false);
      setPlayers(response);
    },
    [],
  );

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
      responsePending.current = false;
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

  const validUsername = PLAYER_NAME_PATTERN.test(username.trim());

  return (
    <Stack gap='md'>
      <div>
        <Text fw={700} size='lg'>{t('tools.playersTitle', {})}</Text>
        <Text size='sm' c='dimmed'>{t('tools.playersDescription', {})}</Text>
      </div>

      {!canReadConsole && <Alert color='yellow'>{t('tools.playerReadPermissionRequired', {})}</Alert>}
      {!canSendCommands && <Alert color='yellow'>{t('tools.playerCommandPermissionRequired', {})}</Alert>}
      {!serverRunning && <Alert color='yellow'>{t('tools.playerServerMustRun', {})}</Alert>}
      {serverRunning && !socketConnected && <Alert color='yellow'>{t('tools.websocketRequired', {})}</Alert>}

      <Card withBorder padding='md' radius='md'>
        <Stack gap='sm'>
          <Group justify='space-between'>
            <Text fw={600}>{t('tools.onlinePlayers', {})}</Text>
            <Button
              variant='light'
              leftSection={<FontAwesomeIcon icon={faRotate} />}
              loading={refreshing}
              disabled={!canReadConsole || !canSendCommands || !serverRunning || !socketConnected || !socketInstance}
              onClick={refreshPlayers}
            >
              {t('tools.refreshPlayers', {})}
            </Button>
          </Group>

          {!canReadConsole ? (
            <Text size='sm' c='dimmed'>{t('tools.playerReadPermissionRequired', {})}</Text>
          ) : !canSendCommands ? (
            <Text size='sm' c='dimmed'>{t('tools.playerCommandPermissionRequired', {})}</Text>
          ) : players.length === 0 ? (
            <Text size='sm' c='dimmed'>
              {refreshing ? t('tools.loadingPlayers', {}) : t('tools.noPlayersOnline', {})}
            </Text>
          ) : (
            <Table.ScrollContainer minWidth={520}>
              <Table striped highlightOnHover>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t('tools.playerName', {})}</Table.Th>
                    <Table.Th>{t('tools.actions', {})}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {players.map((player) => (
                    <Table.Tr key={player}>
                      <Table.Td>{player}</Table.Td>
                      <Table.Td>
                        <Group gap='xs'>
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
            <Button
              variant='light'
              disabled={!validUsername || !canSendCommands || !serverRunning || !socketConnected}
              onClick={() => requestAction('ban', username)}
            >
              {t('tools.ban', {})}
            </Button>
            <Button
              variant='light'
              disabled={!validUsername || !canSendCommands || !serverRunning || !socketConnected}
              onClick={() => requestAction('pardon', username)}
            >
              {t('tools.unban', {})}
            </Button>
            <Button
              variant='light'
              disabled={!validUsername || !canSendCommands || !serverRunning || !socketConnected}
              onClick={() => requestAction('whitelist-add', username)}
            >
              {t('tools.whitelistAdd', {})}
            </Button>
            <Button
              variant='light'
              disabled={!validUsername || !canSendCommands || !serverRunning || !socketConnected}
              onClick={() => requestAction('whitelist-remove', username)}
            >
              {t('tools.whitelistRemove', {})}
            </Button>
          </Group>
        </Stack>
      </Card>

      <Text size='xs' c='dimmed'>{t('tools.playerManagerNote', {})}</Text>

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
              <Button variant='default' onClick={() => setPendingAction(null)}>{t('tools.cancel', {})}</Button>
              <Button color='red' onClick={confirmAction}>{t('tools.confirm', {})}</Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </Stack>
  );
}
