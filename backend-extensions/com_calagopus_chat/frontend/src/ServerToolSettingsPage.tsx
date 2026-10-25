import { faPuzzlePiece } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { Alert, Button, Group, Loader, MultiSelect, Paper, Stack, Switch, Text } from '@mantine/core';
import { useEffect, useState } from 'react';
import getAllEggs from '@/api/admin/nests/getAllEggs.ts';
import { httpErrorToHuman } from '@/api/axios.ts';
import { useToast } from '@/providers/ToastProvider.tsx';
import getAdminSettings from './api/getAdminSettings.ts';
import updateServerToolPages from './api/updateServerToolPages.ts';
import type { AdminSettings } from './lib/schemas.ts';
import {
  type ServerToolPageKey,
  setCachedServerToolEggSettings,
  setCachedServerToolPages,
} from './serverToolsVisibility.ts';
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
    case 'minecraftVersions':
      return t('tools.sidebar.minecraftVersions', {});
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
    case 'minecraftVersions':
      return t('settings.serverToolPages.minecraftVersions', {});
  }
}

export default function ServerToolSettingsPage({ page }: Props) {
  const { addToast } = useToast();
  const { t } = useExtTranslations();
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [allEggs, setAllEggs] = useState(true);
  const [selectedEggUuids, setSelectedEggUuids] = useState<string[]>([]);
  const [eggOptions, setEggOptions] = useState<
    Array<{ group: string; items: Array<{ label: string; value: string }> }>
  >([]);
  const [loadingEggs, setLoadingEggs] = useState(true);
  const [eggLoadFailed, setEggLoadFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setSettings(null);
    getAdminSettings()
      .then(({ settings: data }) => {
        if (!active) return;
        setSettings(data);
        setEnabled(data.serverToolPages[page]);
        const pageEggSelection = data.serverToolEggSettings[page];
        setAllEggs(pageEggSelection === null);
        setSelectedEggUuids(pageEggSelection ?? []);
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

  useEffect(() => {
    let active = true;
    getAllEggs()
      .then((nests) => {
        if (!active) return;
        setEggOptions(
          nests.map((nest) => ({
            group: nest.nest.name,
            items: nest.eggs.map((egg) => ({ label: egg.name, value: egg.uuid })),
          })),
        );
      })
      .catch(() => {
        if (active) setEggLoadFailed(true);
      })
      .finally(() => {
        if (active) setLoadingEggs(false);
      });

    return () => {
      active = false;
    };
  }, []);

  const save = async () => {
    if (!settings) return;

    const nextPages = { ...settings.serverToolPages, [page]: enabled };
    const nextEggSettings = eggLoadFailed
      ? settings.serverToolEggSettings
      : { ...settings.serverToolEggSettings, [page]: allEggs ? null : selectedEggUuids };
    setSaving(true);
    try {
      await updateServerToolPages({ serverToolPages: nextPages, serverToolEggSettings: nextEggSettings });
      setSettings({ ...settings, serverToolPages: nextPages, serverToolEggSettings: nextEggSettings });
      setCachedServerToolPages(nextPages);
      setCachedServerToolEggSettings(nextEggSettings);
      addToast(t('settings.serverToolPageSaved', {}), 'success');
    } catch (error) {
      addToast(httpErrorToHuman(error), 'error');
    } finally {
      setSaving(false);
    }
  };

  const title = getPageTitle(page, t);
  const selectedEggIds = new Set(eggOptions.flatMap((group) => group.items.map((egg) => egg.value)));
  const unknownEggs = selectedEggUuids
    .filter((eggUuid) => !selectedEggIds.has(eggUuid))
    .map((eggUuid) => ({
      label: t('settings.unknownServerEgg', { uuid: eggUuid }),
      value: eggUuid,
    }));
  const eggSelectData = [
    ...eggOptions,
    ...(unknownEggs.length > 0 ? [{ group: t('settings.unknownServerEggGroup', {}), items: unknownEggs }] : []),
  ];

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

          <Stack gap='xs'>
            <Switch
              label={t('settings.serverToolAllEggsLabel', {})}
              description={t('settings.serverToolAllEggsDescription', {})}
              checked={allEggs}
              disabled={saving || loadingEggs || eggLoadFailed}
              onChange={(event) => setAllEggs(event.currentTarget.checked)}
            />
            {loadingEggs && (
              <Group gap='xs'>
                <Loader size='xs' />
                <Text size='xs' c='dimmed'>
                  {t('settings.loadingEggs', {})}
                </Text>
              </Group>
            )}
            {eggLoadFailed && <Alert color='yellow'>{t('settings.eggListPermissionRequired', {})}</Alert>}
            {!allEggs && !eggLoadFailed && (
              <>
                <MultiSelect
                  label={t('settings.serverToolEggSelectionLabel', {})}
                  description={t('settings.serverToolEggSelectionDescription', {})}
                  data={eggSelectData}
                  value={selectedEggUuids}
                  onChange={setSelectedEggUuids}
                  searchable
                  clearable
                  maxDropdownHeight={320}
                  maxValues={1000}
                  disabled={saving || loadingEggs}
                />
                {selectedEggUuids.length === 0 && (
                  <Alert color='yellow'>{t('settings.serverToolNoEggsSelected', {})}</Alert>
                )}
              </>
            )}
          </Stack>

          <Group justify='flex-end'>
            <Button loading={saving} disabled={saving || loadingEggs} onClick={() => void save()}>
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
