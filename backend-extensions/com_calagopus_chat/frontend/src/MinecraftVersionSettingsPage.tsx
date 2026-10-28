import { faChartColumn, faCube, faRotate } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Group,
  Loader,
  Modal,
  MultiSelect,
  Paper,
  PasswordInput,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Table,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { useCallback, useEffect, useMemo, useState } from 'react';
import getAllEggs from '@/api/admin/nests/getAllEggs.ts';
import { httpErrorToHuman } from '@/api/axios.ts';
import { useAdminCan } from '@/plugins/usePermissions.ts';
import { useToast } from '@/providers/ToastProvider.tsx';
import getAdminSettings from './api/getAdminSettings.ts';
import {
  getMinecraftVersionAdminSettings,
  updateMinecraftVersionAdminSettings,
} from './api/minecraftVersionAdminSettings.ts';
import { getAdminMinecraftVersionTypes, getMinecraftVersionGlobalStats } from './api/minecraftVersions.ts';
import updateServerToolPages from './api/updateServerToolPages.ts';
import { useExtTranslations } from './translations.ts';
import type {
  MinecraftVersionAdminSettings,
  MinecraftVersionTypeOrder,
  UpdateMinecraftVersionAdminSettings,
} from './lib/minecraftVersionSchemas.ts';
import type { ServerToolEggSettings, ServerToolPages } from './lib/schemas.ts';
import {
  isMinecraftEgg,
  setCachedServerToolEggSettings,
  setCachedServerToolPages,
  supportsServerToolPage,
} from './serverToolsVisibility.ts';

interface EggGroup {
  group: string;
  items: Array<{ label: string; value: string }>;
}

const EMPTY_PAGES: ServerToolPages = {
  modpacks: true,
  mods: true,
  plugins: true,
  players: true,
  serverProperties: true,
  minecraftVersions: true,
};

const EMPTY_EGG_SETTINGS: ServerToolEggSettings = {
  modpacks: null,
  mods: null,
  plugins: null,
  players: null,
  serverProperties: null,
  minecraftVersions: null,
};

function defaultTypeOrder(types: Record<string, Record<string, { identifier?: string }>>): MinecraftVersionTypeOrder[] {
  return Object.entries(types).map(([category, entries]) => ({
    category,
    types: Object.keys(entries),
  }));
}

export default function MinecraftVersionSettingsPage() {
  const { addToast } = useToast();
  const { t: translate } = useExtTranslations();
  const t = useCallback(
    (key: string, values: Record<string, string | number> = {}) =>
      translate(
        (key.startsWith('versionChanger.') ? `tools.${key}` : key) as Parameters<typeof translate>[0],
        values as Parameters<typeof translate>[1],
      ),
    [translate],
  );
  const canReadEggs = useAdminCan('nests.read');
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [settings, setSettings] = useState<UpdateMinecraftVersionAdminSettings | null>(null);
  const [localStats, setLocalStats] = useState<MinecraftVersionAdminSettings['localStats']>({
    totalInstalls: 0,
    installsByType: {},
    installsByVersion: {},
  });
  const [apiKeyConfigured, setApiKeyConfigured] = useState(false);
  const [typeOrderText, setTypeOrderText] = useState('[]');
  const [typeData, setTypeData] = useState<Record<string, Record<string, { name: string }>>>({});
  const [eggOptions, setEggOptions] = useState<EggGroup[]>([]);
  const [minecraftEggUuids, setMinecraftEggUuids] = useState<Set<string>>(new Set());
  const [eggOptionsLoading, setEggOptionsLoading] = useState(true);
  const [eggLoadFailed, setEggLoadFailed] = useState(false);
  const [typeLoadFailed, setTypeLoadFailed] = useState(false);
  const [serverToolSettingsLoaded, setServerToolSettingsLoaded] = useState(false);
  const [serverToolPages, setServerToolPages] = useState<ServerToolPages>(EMPTY_PAGES);
  const [serverToolEggSettings, setServerToolEggSettings] = useState<ServerToolEggSettings>(EMPTY_EGG_SETTINGS);
  const [allEggs, setAllEggs] = useState(true);
  const [selectedEggUuids, setSelectedEggUuids] = useState<string[]>([]);
  const [eggMappings, setEggMappings] = useState<Record<string, string>>({});
  const [globalStats, setGlobalStats] = useState<Awaited<ReturnType<typeof getMinecraftVersionGlobalStats>> | null>(
    null,
  );
  const [globalStatsError, setGlobalStatsError] = useState(false);
  const [resetStatsOpen, setResetStatsOpen] = useState(false);

  useEffect(() => {
    let active = true;
    void Promise.allSettled([
      getMinecraftVersionAdminSettings(),
      getAdminSettings(),
      getAdminMinecraftVersionTypes(),
    ]).then((results) => {
      if (!active) return;
      const [versionResult, adminResult, typesResult] = results;
      if (versionResult.status === 'fulfilled') {
        const data = versionResult.value.settings;
        const nextSettings: UpdateMinecraftVersionAdminSettings = {
          apiBaseUrl: data.apiBaseUrl,
          apiKey: '',
          clearApiKey: false,
          iconBaseUrl: data.iconBaseUrl,
          iconFormat: data.iconFormat,
          typeOrder: data.typeOrder,
          eggOverrides: data.eggOverrides,
          collectStats: data.collectStats,
          resetLocalStats: false,
        };
        setSettings(nextSettings);
        setLocalStats(data.localStats);
        setApiKeyConfigured(data.apiKeyConfigured);
        setTypeOrderText(JSON.stringify(data.typeOrder, null, 2));
        setEggMappings(Object.fromEntries(data.eggOverrides.map((entry) => [entry.providerType, entry.eggUuid])));
      } else {
        addToast(httpErrorToHuman(versionResult.reason), 'error');
        setLoadFailed(true);
      }
      if (adminResult.status === 'fulfilled') {
        setServerToolSettingsLoaded(true);
        setServerToolPages(adminResult.value.settings.serverToolPages);
        const eggSettings = adminResult.value.settings.serverToolEggSettings;
        setServerToolEggSettings(eggSettings);
        setAllEggs(eggSettings.minecraftVersions === null);
        setSelectedEggUuids(eggSettings.minecraftVersions ?? []);
      } else {
        addToast(httpErrorToHuman(adminResult.reason), 'error');
      }
      if (typesResult.status === 'fulfilled') {
        const types = typesResult.value.types;
        setTypeData(types);
        if (versionResult.status === 'fulfilled' && versionResult.value.settings.typeOrder.length === 0) {
          setTypeOrderText(JSON.stringify(defaultTypeOrder(types), null, 2));
        }
      } else {
        setTypeLoadFailed(true);
        addToast(httpErrorToHuman(typesResult.reason), 'error');
      }
      setLoading(false);
    });

    return () => {
      active = false;
    };
  }, [addToast]);

  useEffect(() => {
    if (!canReadEggs) {
      setEggLoadFailed(true);
      setEggOptionsLoading(false);
      return;
    }
    let active = true;
    setEggOptionsLoading(true);
    setEggLoadFailed(false);
    getAllEggs()
      .then((nests) => {
        if (!active) return;
        setEggOptions(
          nests.map((nest) => ({
            group: nest.nest.name,
            items: nest.eggs.map((egg) => ({ label: egg.name, value: egg.uuid })),
          })),
        );
        setMinecraftEggUuids(
          new Set(
            nests.flatMap((nest) =>
              nest.eggs
                .filter((egg) => isMinecraftEgg({ egg }) && supportsServerToolPage({ egg }, 'minecraftVersions'))
                .map((egg) => egg.uuid),
            ),
          ),
        );
      })
      .catch(() => {
        if (active) setEggLoadFailed(true);
      })
      .finally(() => {
        if (active) setEggOptionsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [canReadEggs]);

  useEffect(() => {
    let active = true;
    getMinecraftVersionGlobalStats()
      .then((stats) => {
        if (active) setGlobalStats(stats);
      })
      .catch(() => {
        if (active) setGlobalStatsError(true);
      });
    return () => {
      active = false;
    };
  }, []);

  const providerTypes = useMemo(
    () =>
      Object.entries(typeData).flatMap(([category, entries]) =>
        Object.entries(entries).map(([providerType, data]) => ({ category, providerType, name: data.name })),
      ),
    [typeData],
  );

  const eggSelectData = useMemo(() => {
    const knownIds = new Set(eggOptions.flatMap((group) => group.items.map((egg) => egg.value)));
    const oldMappings = [...new Set([...selectedEggUuids, ...Object.values(eggMappings)])].filter(
      (eggUuid) => !knownIds.has(eggUuid),
    );
    return [
      ...eggOptions,
      ...(oldMappings.length
        ? [
            {
              group: t('settings.unknownServerEggGroup', {}),
              items: oldMappings.map((uuid) => ({ label: t('settings.unknownServerEgg', { uuid }), value: uuid })),
            },
          ]
        : []),
    ];
  }, [eggMappings, eggOptions, selectedEggUuids, t]);

  const versionEggSelectData = useMemo(() => {
    const compatibleEggOptions = eggOptions
      .map((group) => ({
        ...group,
        items: group.items.filter((egg) => minecraftEggUuids.has(egg.value)),
      }))
      .filter((group) => group.items.length > 0);
    const unknownMappings = [...new Set(Object.values(eggMappings))].filter(
      (eggUuid) => !minecraftEggUuids.has(eggUuid),
    );
    return [
      ...compatibleEggOptions,
      ...(unknownMappings.length
        ? [
            {
              group: t('versionChanger.unsupportedEggGroup', {}),
              items: unknownMappings.map((uuid) => ({
                label: t('versionChanger.unsupportedEggOption', { uuid }),
                value: uuid,
              })),
            },
          ]
        : []),
    ];
  }, [eggMappings, eggOptions, minecraftEggUuids, t]);

  const save = async () => {
    if (!settings) return;
    let typeOrder: MinecraftVersionTypeOrder[];
    try {
      const parsed: unknown = JSON.parse(typeOrderText);
      if (!Array.isArray(parsed)) throw new Error('The type order must be a JSON array.');
      typeOrder = parsed as MinecraftVersionTypeOrder[];
    } catch {
      addToast(t('versionChanger.invalidTypeOrder', {}), 'error');
      return;
    }

    const nextSettings = {
      ...settings,
      typeOrder,
      eggOverrides:
        eggLoadFailed || typeLoadFailed
          ? settings.eggOverrides
          : Object.entries(eggMappings)
              .filter(([, eggUuid]) => Boolean(eggUuid))
              .map(([providerType, eggUuid]) => ({ providerType, eggUuid })),
    };
    setSaving(true);
    try {
      await updateMinecraftVersionAdminSettings(nextSettings);
      if (serverToolSettingsLoaded) {
        const nextPages = { ...serverToolPages };
        const nextEggSettings = eggLoadFailed
          ? serverToolEggSettings
          : { ...serverToolEggSettings, minecraftVersions: allEggs ? null : selectedEggUuids };
        await updateServerToolPages({ serverToolPages: nextPages, serverToolEggSettings: nextEggSettings });
        setServerToolPages(nextPages);
        setServerToolEggSettings(nextEggSettings);
        setCachedServerToolPages(nextPages);
        setCachedServerToolEggSettings(nextEggSettings);
      }
      setSettings({ ...nextSettings, apiKey: '', clearApiKey: false, resetLocalStats: false });
      if (nextSettings.clearApiKey) setApiKeyConfigured(false);
      else if (nextSettings.apiKey.trim()) setApiKeyConfigured(true);
      addToast(t('versionChanger.settingsSaved', {}), 'success');
    } catch (error) {
      addToast(httpErrorToHuman(error), 'error');
    } finally {
      setSaving(false);
    }
  };

  const resetLocalStats = async () => {
    if (!settings) return;
    setSaving(true);
    try {
      await updateMinecraftVersionAdminSettings({ ...settings, apiKey: '', clearApiKey: false, resetLocalStats: true });
      setSettings({ ...settings, resetLocalStats: false });
      setLocalStats({ totalInstalls: 0, installsByType: {}, installsByVersion: {} });
      setResetStatsOpen(false);
      addToast(t('versionChanger.statsReset', {}), 'success');
    } catch (error) {
      addToast(httpErrorToHuman(error), 'error');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <Group justify='center' py='xl'>
        <Loader size='sm' />
        <Text size='sm' c='dimmed'>
          {t('versionChanger.settingsLoading', {})}
        </Text>
      </Group>
    );
  }

  if (!settings || loadFailed) {
    return <Alert color='red'>{t('versionChanger.settingsLoadFailed', {})}</Alert>;
  }

  const localTypeRows = Object.entries(localStats.installsByType).sort((left, right) => right[1] - left[1]);
  const localVersionRows = Object.entries(localStats.installsByVersion).sort((left, right) => right[1] - left[1]);
  const totalLocalInstalls = localStats.totalInstalls;

  return (
    <Stack gap='md' className='calagopus-chat-settings'>
      <Paper withBorder radius='md' p='lg' className='calagopus-chat-settings-card'>
        <Stack gap='md'>
          <Group gap='sm' align='flex-start'>
            <FontAwesomeIcon icon={faCube} aria-hidden='true' />
            <div>
              <Text fw={700}>{t('versionChanger.adminTitle', {})}</Text>
              <Text size='sm' c='dimmed'>
                {t('versionChanger.adminDescription', {})}
              </Text>
            </div>
          </Group>
          <Text size='xs' c='dimmed'>
            {t('versionChanger.providerPrivacyNotice', {})}
          </Text>
          <Alert color='yellow'>{t('versionChanger.safeInstallNote', {})}</Alert>
          {!serverToolSettingsLoaded && (
            <Alert color='yellow'>{t('versionChanger.visibilitySettingsUnavailable', {})}</Alert>
          )}
          <Switch
            label={t('versionChanger.enablePage', {})}
            description={t('settings.serverToolPageDescription', {})}
            checked={serverToolPages.minecraftVersions}
            disabled={saving || !serverToolSettingsLoaded}
            onChange={(event) =>
              setServerToolPages({ ...serverToolPages, minecraftVersions: event.currentTarget.checked })
            }
          />
          <Switch
            label={t('settings.serverToolAllEggsLabel', {})}
            description={t('settings.serverToolAllEggsDescription', {})}
            checked={allEggs}
            disabled={saving || eggLoadFailed || eggOptionsLoading || !serverToolSettingsLoaded}
            onChange={(event) => setAllEggs(event.currentTarget.checked)}
          />
          {!allEggs && (
            <MultiSelect
              label={t('settings.serverToolEggSelectionLabel', {})}
              description={t('settings.serverToolEggSelectionDescription', {})}
              data={eggSelectData}
              value={selectedEggUuids}
              onChange={setSelectedEggUuids}
              searchable
              clearable
              maxValues={1000}
              disabled={saving || eggLoadFailed || eggOptionsLoading || !serverToolSettingsLoaded}
            />
          )}
          {eggLoadFailed && <Alert color='yellow'>{t('settings.eggListPermissionRequired', {})}</Alert>}

          <TextInput
            label={t('versionChanger.apiBaseUrl', {})}
            description={t('versionChanger.apiBaseUrlDescription', {})}
            value={settings.apiBaseUrl}
            onChange={(event) => setSettings({ ...settings, apiBaseUrl: event.currentTarget.value })}
            maxLength={512}
            type='url'
          />
          <PasswordInput
            label={t('versionChanger.apiKey', {})}
            description={
              apiKeyConfigured ? t('versionChanger.apiKeyStored', {}) : t('versionChanger.apiKeyDescription', {})
            }
            value={settings.apiKey}
            placeholder={apiKeyConfigured ? '••••••••••••••••' : t('versionChanger.apiKeyPlaceholder', {})}
            onChange={(event) => setSettings({ ...settings, apiKey: event.currentTarget.value, clearApiKey: false })}
            maxLength={4096}
            autoComplete='new-password'
          />
          <Checkbox
            label={t('versionChanger.clearApiKey', {})}
            disabled={!apiKeyConfigured || saving}
            checked={settings.clearApiKey}
            onChange={(event) => setSettings({ ...settings, clearApiKey: event.currentTarget.checked, apiKey: '' })}
          />
          <Group grow>
            <TextInput
              label={t('versionChanger.iconBaseUrl', {})}
              value={settings.iconBaseUrl}
              onChange={(event) => setSettings({ ...settings, iconBaseUrl: event.currentTarget.value })}
              maxLength={512}
              type='url'
            />
            <Select
              label={t('versionChanger.iconFormat', {})}
              data={[
                { value: 'png', label: 'PNG' },
                { value: 'webp', label: 'WebP' },
              ]}
              value={settings.iconFormat}
              onChange={(value) => value && setSettings({ ...settings, iconFormat: value as 'png' | 'webp' })}
              allowDeselect={false}
            />
          </Group>
          <Textarea
            label={t('versionChanger.typeOrder', {})}
            description={t('versionChanger.typeOrderDescription', {})}
            value={typeOrderText}
            onChange={(event) => setTypeOrderText(event.currentTarget.value)}
            minRows={8}
            maxRows={18}
            autosize
            spellCheck={false}
          />
          <Switch
            label={t('versionChanger.collectStats', {})}
            description={t('versionChanger.collectStatsDescription', {})}
            checked={settings.collectStats}
            onChange={(event) => setSettings({ ...settings, collectStats: event.currentTarget.checked })}
          />
          <Text fw={600}>{t('versionChanger.eggOverridesTitle', {})}</Text>
          {providerTypes.length ? (
            <Stack gap='xs'>
              {providerTypes.map(({ category, providerType, name }) => (
                <Group key={providerType} grow wrap='wrap'>
                  <Text size='sm'>
                    {name}{' '}
                    <Text span size='xs' c='dimmed'>
                      ({category} · {providerType})
                    </Text>
                  </Text>
                  <Select
                    aria-label={t('versionChanger.eggOverrideFor', { type: name })}
                    placeholder={t('versionChanger.noEggOverride', {})}
                    data={versionEggSelectData}
                    value={eggMappings[providerType] ?? null}
                    onChange={(value) =>
                      setEggMappings((current) => {
                        const next = { ...current };
                        if (value) next[providerType] = value;
                        else delete next[providerType];
                        return next;
                      })
                    }
                    searchable
                    clearable
                    disabled={!canReadEggs || eggLoadFailed || eggOptionsLoading || saving}
                  />
                </Group>
              ))}
            </Stack>
          ) : (
            <Alert color='yellow'>{t('versionChanger.typesUnavailable', {})}</Alert>
          )}
          <Group justify='flex-end'>
            <Button loading={saving} disabled={saving} onClick={() => void save()}>
              {t('versionChanger.saveSettings', {})}
            </Button>
          </Group>
        </Stack>
      </Paper>

      <Paper withBorder radius='md' p='lg' className='calagopus-chat-settings-card'>
        <Stack gap='md'>
          <Group justify='space-between'>
            <Group gap='sm'>
              <FontAwesomeIcon icon={faChartColumn} aria-hidden='true' />
              <Text fw={700}>{t('versionChanger.localStatsTitle', {})}</Text>
            </Group>
            <Button
              variant='light'
              color='red'
              leftSection={<FontAwesomeIcon icon={faRotate} />}
              disabled={saving || totalLocalInstalls === 0}
              onClick={() => setResetStatsOpen(true)}
            >
              {t('versionChanger.resetStats', {})}
            </Button>
          </Group>
          <Badge variant='light'>{t('versionChanger.totalInstalls', { count: totalLocalInstalls })}</Badge>
          {localTypeRows.length > 0 && (
            <Table striped>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('versionChanger.typeColumn', {})}</Table.Th>
                  <Table.Th>{t('versionChanger.installsColumn', {})}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {localTypeRows.map(([name, count]) => (
                  <Table.Tr key={name}>
                    <Table.Td>{name}</Table.Td>
                    <Table.Td>{count}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          )}
          {localVersionRows.length > 0 && (
            <Table striped>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('versionChanger.versionColumn', {})}</Table.Th>
                  <Table.Th>{t('versionChanger.installsColumn', {})}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {localVersionRows.map(([name, count]) => (
                  <Table.Tr key={name}>
                    <Table.Td>{name}</Table.Td>
                    <Table.Td>{count}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          )}
          <Text size='xs' c='dimmed'>
            {t('versionChanger.localStatsPrivacy', {})}
          </Text>
        </Stack>
      </Paper>

      <Paper withBorder radius='md' p='lg' className='calagopus-chat-settings-card'>
        <Stack gap='sm'>
          <Text fw={700}>{t('versionChanger.globalStatsTitle', {})}</Text>
          {globalStatsError && <Alert color='yellow'>{t('versionChanger.globalStatsUnavailable', {})}</Alert>}
          {globalStats && (
            <SimpleGrid cols={{ base: 1, md: 2 }} spacing='md'>
              <Stack gap='xs'>
                <Text fw={600}>{t('versionChanger.globalTypesTitle', {})}</Text>
                {Object.entries(globalStats.types.types)
                  .sort((a, b) => b[1].total - a[1].total)
                  .slice(0, 10)
                  .map(([name, row]) => (
                    <Group key={name} justify='space-between'>
                      <Text size='sm'>{name}</Text>
                      <Text size='sm' c='dimmed'>
                        {row.total.toLocaleString()}
                      </Text>
                    </Group>
                  ))}
              </Stack>
              <Stack gap='xs'>
                <Text fw={600}>{t('versionChanger.globalVersionsTitle', {})}</Text>
                {Object.entries(globalStats.versions.versions)
                  .sort((a, b) => b[1].total - a[1].total)
                  .slice(0, 10)
                  .map(([name, row]) => (
                    <Group key={name} justify='space-between'>
                      <Text size='sm'>{name}</Text>
                      <Text size='sm' c='dimmed'>
                        {row.total.toLocaleString()}
                      </Text>
                    </Group>
                  ))}
              </Stack>
            </SimpleGrid>
          )}
          <Text size='xs' c='dimmed'>
            {t('versionChanger.globalStatsPrivacy', {})}
          </Text>
        </Stack>
      </Paper>

      <Modal
        opened={resetStatsOpen}
        onClose={() => setResetStatsOpen(false)}
        title={t('versionChanger.resetStatsTitle', {})}
        centered
      >
        <Stack gap='md'>
          <Text>{t('versionChanger.resetStatsDescription', {})}</Text>
          <Group justify='flex-end'>
            <Button variant='default' disabled={saving} onClick={() => setResetStatsOpen(false)}>
              {t('tools.cancel', {})}
            </Button>
            <Button color='red' loading={saving} onClick={() => void resetLocalStats()}>
              {t('versionChanger.resetStats', {})}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
