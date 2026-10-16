import { faFloppyDisk, faRotateRight } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { Alert, Button, Group, Loader, Modal, Stack, Text, Textarea } from '@mantine/core';
import { useEffect, useState } from 'react';
import { httpErrorToHuman } from '@/api/axios.ts';
import getFileContent from '@/api/server/files/getFileContent.ts';
import saveFileContent from '@/api/server/files/saveFileContent.ts';
import { SocketRequest } from '@/plugins/websocket/useWebsocketEvent.ts';
import type { Websocket } from '@/plugins/websocket/Websocket.ts';
import { useToast } from '@/providers/ToastProvider.tsx';
import { useExtTranslations } from './translations.ts';

interface Props {
  serverUuid: string;
  serverState: 'offline' | 'starting' | 'stopping' | 'running';
  serverBusy: boolean;
  canRead: boolean;
  canWrite: boolean;
  canRestart: boolean;
  canStart: boolean;
  socketConnected: boolean;
  socketInstance: Websocket | null;
}

export default function ServerPropertiesEditor({
  serverUuid,
  serverState,
  serverBusy,
  canRead,
  canWrite,
  canRestart,
  canStart,
  socketConnected,
  socketInstance,
}: Props) {
  const { t } = useExtTranslations();
  const { addToast } = useToast();
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [restartPromptOpen, setRestartPromptOpen] = useState(false);

  useEffect(() => {
    let active = true;
    if (!canRead) {
      setLoading(false);
      return () => {
        active = false;
      };
    }

    setLoading(true);
    setLoadError(false);
    getFileContent(serverUuid, '/server.properties')
      .then((file) => file.text())
      .then((text) => {
        if (active) setContent(text);
      })
      .catch((error) => {
        if (active) {
          setLoadError(true);
          addToast(httpErrorToHuman(error), 'error');
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [addToast, canRead, serverUuid]);

  const save = async () => {
    if (!canWrite || !canRead || loadError || serverBusy) return;

    setSaving(true);
    try {
      await saveFileContent(serverUuid, '/server.properties', content);
      addToast(t('tools.serverPropertiesSaved', {}), 'success');
      setRestartPromptOpen(true);
    } catch (error) {
      addToast(httpErrorToHuman(error), 'error');
    } finally {
      setSaving(false);
    }
  };

  const startPowerAction = () => {
    if (!socketConnected || !socketInstance) return;
    const action = serverState === 'running' ? 'restart' : 'start';
    socketInstance.send(SocketRequest.SET_STATE, action);
    setRestartPromptOpen(false);
    addToast(
      action === 'restart' ? t('tools.serverPropertiesRestartSent', {}) : t('tools.serverPropertiesStartSent', {}),
      'success',
    );
  };

  const canPowerAction = serverState === 'running' ? canRestart : serverState === 'offline' && canStart;
  const powerTransitioning = serverState === 'starting' || serverState === 'stopping';

  if (loading) {
    return (
      <Group justify='center' py='xl'>
        <Loader size='sm' />
        <Text size='sm' c='dimmed'>
          {t('tools.serverPropertiesLoading', {})}
        </Text>
      </Group>
    );
  }

  return (
    <Stack gap='md'>
      <div>
        <Text size='sm' c='dimmed'>
          {t('tools.serverPropertiesDescription', {})}
        </Text>
      </div>

      {(!canRead || !canWrite) && <Alert color='yellow'>{t('tools.serverPropertiesPermissionRequired', {})}</Alert>}
      {loadError && <Alert color='red'>{t('tools.serverPropertiesLoadFailed', {})}</Alert>}
      {serverBusy && <Alert color='yellow'>{t('tools.serverBusy', {})}</Alert>}

      <Textarea
        aria-label='server.properties'
        value={content}
        onChange={(event) => setContent(event.currentTarget.value)}
        minRows={18}
        autosize
        disabled={!canRead || !canWrite || loadError || serverBusy || saving}
        styles={{ input: { fontFamily: 'monospace' } }}
      />

      <Group justify='flex-end'>
        <Button
          leftSection={<FontAwesomeIcon icon={faFloppyDisk} />}
          loading={saving}
          disabled={!canRead || !canWrite || loadError || serverBusy}
          onClick={() => void save()}
        >
          {t('tools.serverPropertiesSave', {})}
        </Button>
      </Group>

      <Modal
        opened={restartPromptOpen}
        onClose={() => setRestartPromptOpen(false)}
        title={t('tools.serverPropertiesRestartTitle', {})}
        centered
      >
        <Stack gap='md'>
          <Text>{t('tools.serverPropertiesRestartPrompt', {})}</Text>
          {!canPowerAction && !powerTransitioning && !serverBusy && (
            <Alert color='yellow'>{t('tools.serverPropertiesRestartPermissionRequired', {})}</Alert>
          )}
          {(serverBusy || powerTransitioning) && <Alert color='yellow'>{t('tools.serverBusy', {})}</Alert>}
          <Group justify='flex-end'>
            <Button variant='default' onClick={() => setRestartPromptOpen(false)}>
              {t('tools.serverPropertiesRestartLater', {})}
            </Button>
            {canPowerAction && (
              <Button
                leftSection={<FontAwesomeIcon icon={faRotateRight} />}
                disabled={!socketConnected || !socketInstance || serverBusy}
                onClick={startPowerAction}
              >
                {serverState === 'running'
                  ? t('tools.serverPropertiesRestartNow', {})
                  : t('tools.serverPropertiesStartNow', {})}
              </Button>
            )}
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
