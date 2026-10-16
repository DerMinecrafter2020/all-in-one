import { faPuzzlePiece } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { Alert, Button, Group, Loader, Paper, Stack, Switch, Text } from '@mantine/core';
import { useEffect, useState } from 'react';
import { httpErrorToHuman } from '@/api/axios.ts';
import { useToast } from '@/providers/ToastProvider.tsx';
import getAdminSettings from './api/getAdminSettings.ts';
import updateServerToolPages from './api/updateServerToolPages.ts';
import type { AdminSettings } from './lib/schemas.ts';
import { setCachedServerToolPages, type ServerToolPageKey } from './serverToolsVisibility.ts';
import { useExtTranslations } from './translations.ts';

interface Props {
  page: ServerToolPageKey;
}

function getPageTitle(page: ServerToolPageKey, t: ReturnType<typeof useExtTranslations>['t']): string {
  switch (page) {
    case 'modpacks':
      return t('tools.sidebar.modpacks', {});
    case 'mods':
      return t('tools.sidebar.mods', {});
    case 'plugins':
      return t('tools.sidebar.plugins', {});
    case 'players':
      return t('tools.sidebar.players', {});
    case 'serverProperties':
      return t('tools.sidebar.serverProperties', {});
  }
}

function getSwitchLabel(page: ServerToolPageKey, t: ReturnType<typeof useExtTranslations>['t']): string {
  switch (page) {
    case 'modpacks':
      return t('settings.serverToolPages.modpacks', {});
    case 'mods':
      return t('settings.serverToolPages.mods', {});
    case 'plugins':
      return t('settings.serverToolPages.plugins', {});
    case 'players':
      return t('settings.serverToolPages.players', {});
    case 'serverProperties':
      return t('settings.serverToolPages.serverProperties', {});
  }
}

export default function ServerToolSettingsPage({ page }: Props) {
  const { addToast } = useToast();
  const { t } = useExtTranslations();
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    getAdminSettings()
      .then(({ settings: data }) => {
        if (!active) return;
        setSettings(data);
        setEnabled(data.serverToolPages[page]);
      })
      .catch((error) => {
        if (active) addToast(httpErrorToHuman(error), 'error');
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [addToast, page]);

  const save = async () => {
    if (!settings) return;

    const nextPages = { ...settings.serverToolPages, [page]: enabled };
    setSaving(true);
    try {
      await updateServerToolPages({ serverToolPages: nextPages });
      setSettings({ ...settings, serverToolPages: nextPages });
      setCachedServerToolPages(nextPages);
      addToast(t('settings.serverToolPageSaved', {}), 'success');
    } catch (error) {
      addToast(httpErrorToHuman(error), 'error');
    } finally {
      setSaving(false);
    }
  };

  const title = getPageTitle(page, t);

  if (loading) {
    return (
      <Group justify='center' py='xl'>
        <Loader size='sm' />
        <Text size='sm' c='dimmed'>
          {t('settings.loading', {})}
        </Text>
      </Group>
    );
  }

  if (!settings) {
    return (
      <Alert color='red' title={title}>
        {t('settings.loadFailed', {})}
      </Alert>
    );
  }

  return (
    <Stack gap='md' className='calagopus-chat-settings'>
      <Paper withBorder radius='md' p='lg' className='calagopus-chat-settings-card'>
        <Stack gap='md'>
          <Group gap='sm' align='flex-start'>
            <FontAwesomeIcon icon={faPuzzlePiece} aria-hidden='true' />
            <div>
              <Text fw={700}>{title}</Text>
              <Text size='sm' c='dimmed'>
                {t('settings.serverToolPageDescription', {})}
              </Text>
            </div>
          </Group>

          <Switch
            label={getSwitchLabel(page, t)}
            description={t('settings.serverToolPageEggNote', {})}
            checked={enabled}
            disabled={saving}
            onChange={(event) => setEnabled(event.currentTarget.checked)}
          />

          <Group justify='flex-end'>
            <Button loading={saving} disabled={saving} onClick={() => void save()}>
              {t('settings.saveServerToolPage', {})}
            </Button>
          </Group>
        </Stack>
      </Paper>
    </Stack>
  );
}

export function ModpackInstallerSettingsPage() {
  return <ServerToolSettingsPage page='modpacks' />;
}

export function ModManagerSettingsPage() {
  return <ServerToolSettingsPage page='mods' />;
}

export function PluginManagerSettingsPage() {
  return <ServerToolSettingsPage page='plugins' />;
}

export function PlayerManagerSettingsPage() {
  return <ServerToolSettingsPage page='players' />;
}

export function ServerPropertiesSettingsPage() {
  return <ServerToolSettingsPage page='serverProperties' />;
}
