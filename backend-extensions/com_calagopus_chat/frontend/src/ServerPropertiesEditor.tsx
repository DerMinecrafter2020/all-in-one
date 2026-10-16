import { faFloppyDisk, faRotateRight } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  Alert,
  Button,
  Code,
  Group,
  Loader,
  Modal,
  NumberInput,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  TextInput,
} from '@mantine/core';
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

interface RawLine {
  kind: 'raw';
  id: number;
  content: string;
}

interface PropertyLine {
  kind: 'property';
  id: number;
  prefix: string;
  key: string;
  separator: string;
  value: string;
}

type ServerPropertiesLine = RawLine | PropertyLine;

interface ParsedServerProperties {
  lines: ServerPropertiesLine[];
  lineEnding: string;
  hasBom: boolean;
}

const BOOLEAN_PROPERTIES = new Set([
  'allow-flight',
  'allow-nether',
  'allow-end',
  'broadcast-console-to-ops',
  'broadcast-rcon-to-ops',
  'debug',
  'enable-command-block',
  'enable-jmx-monitoring',
  'enable-query',
  'enable-rcon',
  'enable-status',
  'enforce-secure-profile',
  'enforce-whitelist',
  'force-gamemode',
  'hardcore',
  'hide-online-players',
  'online-mode',
  'prevent-proxy-connections',
  'pvp',
  'spawn-animals',
  'spawn-monsters',
  'spawn-npcs',
  'sync-chunk-writes',
  'use-native-transport',
  'white-list',
]);

const NUMBER_PROPERTIES = new Set([
  'entity-broadcast-range-percentage',
  'function-permission-level',
  'max-build-height',
  'max-chained-neighbor-updates',
  'max-players',
  'max-tick-time',
  'max-world-size',
  'network-compression-threshold',
  'op-permission-level',
  'player-idle-timeout',
  'query.port',
  'rate-limit',
  'rcon.port',
  'server-port',
  'simulation-distance',
  'spawn-protection',
  'view-distance',
]);

const SELECT_PROPERTIES: Record<string, string[]> = {
  difficulty: ['peaceful', 'easy', 'normal', 'hard', '0', '1', '2', '3'],
  gamemode: ['survival', 'creative', 'adventure', 'spectator', '0', '1', '2', '3'],
  'level-type': [
    'minecraft:normal',
    'minecraft:flat',
    'minecraft:large_biomes',
    'minecraft:amplified',
    'minecraft:single_biome_surface',
    'default',
    'flat',
    'largeBiomes',
    'amplified',
  ],
};

function parseServerProperties(text: string): ParsedServerProperties {
  const hasBom = text.startsWith('\uFEFF');
  const content = hasBom ? text.slice(1) : text;
  const lineEnding = content.match(/\r\n|\n/)?.[0] ?? '\n';
  const lines = content.split(/\r\n|\n/).map((line, id): ServerPropertiesLine => {
    const trimmed = line.trimStart();
    const equalsIndex = line.indexOf('=');
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!') || equalsIndex < 0) {
      return { kind: 'raw', id, content: line };
    }

    const left = line.slice(0, equalsIndex);
    const key = left.trim();
    if (!key) return { kind: 'raw', id, content: line };

    const leadingWhitespaceLength = left.length - left.trimStart().length;
    const prefix = left.slice(0, leadingWhitespaceLength);
    const keyEnd = leadingWhitespaceLength + key.length;
    const keySpacing = left.slice(keyEnd);
    const rawValue = line.slice(equalsIndex + 1);
    const valueSpacing = rawValue.match(/^\s*/)?.[0] ?? '';

    return {
      kind: 'property',
      id,
      prefix,
      key,
      separator: `${keySpacing}=${valueSpacing}`,
      value: rawValue.slice(valueSpacing.length),
    };
  });

  return { lines, lineEnding, hasBom };
}

function serializeServerProperties(parsed: ParsedServerProperties, lines: ServerPropertiesLine[]): string {
  const content = lines
    .map((line) => (line.kind === 'raw' ? line.content : `${line.prefix}${line.key}${line.separator}${line.value}`))
    .join(parsed.lineEnding);

  return `${parsed.hasBom ? '\uFEFF' : ''}${content}`;
}

function humanizePropertyKey(key: string): string {
  const words = key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[-_.]+/g, ' ')
    .trim();
  return words ? words[0].toUpperCase() + words.slice(1) : key;
}

const PROPERTY_LABEL_TRANSLATORS: Record<string, (t: ReturnType<typeof useExtTranslations>['t']) => string> = {
  'allow-flight': (t: ReturnType<typeof useExtTranslations>['t']) => t('tools.serverPropertiesFields.allowFlight', {}),
  'allow-nether': (t: ReturnType<typeof useExtTranslations>['t']) => t('tools.serverPropertiesFields.allowNether', {}),
  'allow-end': (t: ReturnType<typeof useExtTranslations>['t']) => t('tools.serverPropertiesFields.allowEnd', {}),
  'broadcast-console-to-ops': (t: ReturnType<typeof useExtTranslations>['t']) =>
    t('tools.serverPropertiesFields.broadcastConsoleToOps', {}),
  'broadcast-rcon-to-ops': (t: ReturnType<typeof useExtTranslations>['t']) =>
    t('tools.serverPropertiesFields.broadcastRconToOps', {}),
  debug: (t: ReturnType<typeof useExtTranslations>['t']) => t('tools.serverPropertiesFields.debug', {}),
  difficulty: (t: ReturnType<typeof useExtTranslations>['t']) => t('tools.serverPropertiesFields.difficulty', {}),
  'enable-command-block': (t: ReturnType<typeof useExtTranslations>['t']) =>
    t('tools.serverPropertiesFields.enableCommandBlock', {}),
  'enable-jmx-monitoring': (t: ReturnType<typeof useExtTranslations>['t']) =>
    t('tools.serverPropertiesFields.enableJmxMonitoring', {}),
  'enable-query': (t: ReturnType<typeof useExtTranslations>['t']) => t('tools.serverPropertiesFields.enableQuery', {}),
  'enable-rcon': (t: ReturnType<typeof useExtTranslations>['t']) => t('tools.serverPropertiesFields.enableRcon', {}),
  'enable-status': (t: ReturnType<typeof useExtTranslations>['t']) => t('tools.serverPropertiesFields.enableStatus', {}),
  'enforce-secure-profile': (t: ReturnType<typeof useExtTranslations>['t']) =>
    t('tools.serverPropertiesFields.enforceSecureProfile', {}),
  'enforce-whitelist': (t: ReturnType<typeof useExtTranslations>['t']) =>
    t('tools.serverPropertiesFields.enforceWhitelist', {}),
  'entity-broadcast-range-percentage': (t: ReturnType<typeof useExtTranslations>['t']) =>
    t('tools.serverPropertiesFields.entityBroadcastRangePercentage', {}),
  'force-gamemode': (t: ReturnType<typeof useExtTranslations>['t']) =>
    t('tools.serverPropertiesFields.forceGamemode', {}),
  'function-permission-level': (t: ReturnType<typeof useExtTranslations>['t']) =>
    t('tools.serverPropertiesFields.functionPermissionLevel', {}),
  gamemode: (t: ReturnType<typeof useExtTranslations>['t']) => t('tools.serverPropertiesFields.gameMode', {}),
  'generate-structures': (t: ReturnType<typeof useExtTranslations>['t']) =>
    t('tools.serverPropertiesFields.generateStructures', {}),
  'generator-settings': (t: ReturnType<typeof useExtTranslations>['t']) =>
    t('tools.serverPropertiesFields.generatorSettings', {}),
  hardcore: (t: ReturnType<typeof useExtTranslations>['t']) => t('tools.serverPropertiesFields.hardcore', {}),
  'hide-online-players': (t: ReturnType<typeof useExtTranslations>['t']) =>
    t('tools.serverPropertiesFields.hideOnlinePlayers', {}),
  'initial-disabled-packs': (t: ReturnType<typeof useExtTranslations>['t']) =>
    t('tools.serverPropertiesFields.initialDisabledPacks', {}),
  'initial-enabled-packs': (t: ReturnType<typeof useExtTranslations>['t']) =>
    t('tools.serverPropertiesFields.initialEnabledPacks', {}),
  'level-name': (t: ReturnType<typeof useExtTranslations>['t']) => t('tools.serverPropertiesFields.levelName', {}),
  'level-seed': (t: ReturnType<typeof useExtTranslations>['t']) => t('tools.serverPropertiesFields.levelSeed', {}),
  'level-type': (t: ReturnType<typeof useExtTranslations>['t']) => t('tools.serverPropertiesFields.levelType', {}),
  'log-ips': (t: ReturnType<typeof useExtTranslations>['t']) => t('tools.serverPropertiesFields.logIps', {}),
  'max-build-height': (t: ReturnType<typeof useExtTranslations>['t']) =>
    t('tools.serverPropertiesFields.maxBuildHeight', {}),
  'max-chained-neighbor-updates': (t: ReturnType<typeof useExtTranslations>['t']) =>
    t('tools.serverPropertiesFields.maxChainedNeighborUpdates', {}),
  'max-players': (t: ReturnType<typeof useExtTranslations>['t']) => t('tools.serverPropertiesFields.maxPlayers', {}),
  'max-tick-time': (t: ReturnType<typeof useExtTranslations>['t']) => t('tools.serverPropertiesFields.maxTickTime', {}),
  'max-world-size': (t: ReturnType<typeof useExtTranslations>['t']) =>
    t('tools.serverPropertiesFields.maxWorldSize', {}),
  motd: (t: ReturnType<typeof useExtTranslations>['t']) => t('tools.serverPropertiesFields.motd', {}),
  'network-compression-threshold': (t: ReturnType<typeof useExtTranslations>['t']) =>
    t('tools.serverPropertiesFields.networkCompressionThreshold', {}),
  'online-mode': (t: ReturnType<typeof useExtTranslations>['t']) => t('tools.serverPropertiesFields.onlineMode', {}),
  'op-permission-level': (t: ReturnType<typeof useExtTranslations>['t']) =>
    t('tools.serverPropertiesFields.opPermissionLevel', {}),
  'player-idle-timeout': (t: ReturnType<typeof useExtTranslations>['t']) =>
    t('tools.serverPropertiesFields.playerIdleTimeout', {}),
  'prevent-proxy-connections': (t: ReturnType<typeof useExtTranslations>['t']) =>
    t('tools.serverPropertiesFields.preventProxyConnections', {}),
  pvp: (t: ReturnType<typeof useExtTranslations>['t']) => t('tools.serverPropertiesFields.pvp', {}),
  'query.port': (t: ReturnType<typeof useExtTranslations>['t']) => t('tools.serverPropertiesFields.queryPort', {}),
  'rate-limit': (t: ReturnType<typeof useExtTranslations>['t']) => t('tools.serverPropertiesFields.rateLimit', {}),
  'rcon.password': (t: ReturnType<typeof useExtTranslations>['t']) =>
    t('tools.serverPropertiesFields.rconPassword', {}),
  'rcon.port': (t: ReturnType<typeof useExtTranslations>['t']) => t('tools.serverPropertiesFields.rconPort', {}),
  'region-file-compression': (t: ReturnType<typeof useExtTranslations>['t']) =>
    t('tools.serverPropertiesFields.regionFileCompression', {}),
  'require-resource-pack': (t: ReturnType<typeof useExtTranslations>['t']) =>
    t('tools.serverPropertiesFields.requireResourcePack', {}),
  'resource-pack': (t: ReturnType<typeof useExtTranslations>['t']) =>
    t('tools.serverPropertiesFields.resourcePack', {}),
  'resource-pack-id': (t: ReturnType<typeof useExtTranslations>['t']) =>
    t('tools.serverPropertiesFields.resourcePackId', {}),
  'resource-pack-prompt': (t: ReturnType<typeof useExtTranslations>['t']) =>
    t('tools.serverPropertiesFields.resourcePackPrompt', {}),
  'resource-pack-sha1': (t: ReturnType<typeof useExtTranslations>['t']) =>
    t('tools.serverPropertiesFields.resourcePackSha1', {}),
  'server-ip': (t: ReturnType<typeof useExtTranslations>['t']) => t('tools.serverPropertiesFields.serverIp', {}),
  'server-port': (t: ReturnType<typeof useExtTranslations>['t']) => t('tools.serverPropertiesFields.serverPort', {}),
  'simulation-distance': (t: ReturnType<typeof useExtTranslations>['t']) =>
    t('tools.serverPropertiesFields.simulationDistance', {}),
  'spawn-animals': (t: ReturnType<typeof useExtTranslations>['t']) =>
    t('tools.serverPropertiesFields.spawnAnimals', {}),
  'spawn-monsters': (t: ReturnType<typeof useExtTranslations>['t']) =>
    t('tools.serverPropertiesFields.spawnMonsters', {}),
  'spawn-npcs': (t: ReturnType<typeof useExtTranslations>['t']) => t('tools.serverPropertiesFields.spawnNpcs', {}),
  'spawn-protection': (t: ReturnType<typeof useExtTranslations>['t']) =>
    t('tools.serverPropertiesFields.spawnProtection', {}),
  'sync-chunk-writes': (t: ReturnType<typeof useExtTranslations>['t']) =>
    t('tools.serverPropertiesFields.syncChunkWrites', {}),
  'text-filtering-config': (t: ReturnType<typeof useExtTranslations>['t']) =>
    t('tools.serverPropertiesFields.textFilteringConfig', {}),
  'use-native-transport': (t: ReturnType<typeof useExtTranslations>['t']) =>
    t('tools.serverPropertiesFields.useNativeTransport', {}),
  'view-distance': (t: ReturnType<typeof useExtTranslations>['t']) =>
    t('tools.serverPropertiesFields.viewDistance', {}),
  'white-list': (t: ReturnType<typeof useExtTranslations>['t']) => t('tools.serverPropertiesFields.whiteList', {}),
  'pause-when-empty-seconds': (t: ReturnType<typeof useExtTranslations>['t']) =>
    t('tools.serverPropertiesFields.pauseWhenEmptySeconds', {}),
};

function PropertyLabel({ propertyKey }: { propertyKey: string }) {
  const { t } = useExtTranslations();
  const label = PROPERTY_LABEL_TRANSLATORS[propertyKey]?.(t) ??
    t('tools.serverPropertiesCustomField', { key: humanizePropertyKey(propertyKey) });

  return (
    <Group justify='space-between' gap='xs' wrap='wrap'>
      <Text size='sm' fw={500}>
        {label}
      </Text>
      <Code>{propertyKey}</Code>
    </Group>
  );
}

function PropertyField({
  property,
  disabled,
  onChange,
}: {
  property: PropertyLine;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const label = <PropertyLabel propertyKey={property.key} />;
  const normalizedValue = property.value.trim().toLowerCase();

  if (BOOLEAN_PROPERTIES.has(property.key) && ['true', 'false'].includes(normalizedValue)) {
    return (
      <Switch
        label={label}
        aria-label={property.key}
        checked={normalizedValue === 'true'}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked ? 'true' : 'false')}
      />
    );
  }

  const options = SELECT_PROPERTIES[property.key];
  if (options?.includes(property.value.trim())) {
    return (
      <Select
        label={label}
        aria-label={property.key}
        data={options.map((value) => ({ value, label: value }))}
        value={property.value.trim()}
        allowDeselect={false}
        disabled={disabled}
        onChange={(value) => {
          if (value !== null) onChange(value);
        }}
      />
    );
  }

  if (NUMBER_PROPERTIES.has(property.key)) {
    return (
      <NumberInput
        label={label}
        aria-label={property.key}
        value={property.value}
        allowDecimal={false}
        disabled={disabled}
        onChange={(value) => onChange(String(value))}
      />
    );
  }

  return (
    <TextInput
      label={label}
      aria-label={property.key}
      value={property.value}
      disabled={disabled}
      onChange={(event) => onChange(event.currentTarget.value)}
    />
  );
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
  const [parsedFile, setParsedFile] = useState<ParsedServerProperties>({
    lines: [],
    lineEnding: '\n',
    hasBom: false,
  });
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
        if (active) setParsedFile(parseServerProperties(text));
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

  const updateProperty = (id: number, value: string) => {
    setParsedFile((current) => ({
      ...current,
      lines: current.lines.map((line) => (line.kind === 'property' && line.id === id ? { ...line, value } : line)),
    }));
  };

  const save = async () => {
    if (!canWrite || !canRead || loadError || serverBusy) return;

    setSaving(true);
    try {
      await saveFileContent(serverUuid, '/server.properties', serializeServerProperties(parsedFile, parsedFile.lines));
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
  const propertyLines = parsedFile.lines.filter((line): line is PropertyLine => line.kind === 'property');

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
      <Text size='sm' c='dimmed'>
        {t('tools.serverPropertiesDescription', {})}
      </Text>

      {(!canRead || !canWrite) && <Alert color='yellow'>{t('tools.serverPropertiesPermissionRequired', {})}</Alert>}
      {loadError && <Alert color='red'>{t('tools.serverPropertiesLoadFailed', {})}</Alert>}
      {serverBusy && <Alert color='yellow'>{t('tools.serverBusy', {})}</Alert>}
      {canRead && !loadError && <Alert color='blue'>{t('tools.serverPropertiesCommentsPreserved', {})}</Alert>}
      {canRead && propertyLines.length === 0 && !loadError && (
        <Alert color='yellow'>{t('tools.serverPropertiesNoFields', {})}</Alert>
      )}

      <SimpleGrid cols={{ base: 1, sm: 2, xl: 3 }} spacing='sm'>
        {propertyLines.map((property) => (
          <Paper key={property.id} withBorder radius='sm' p='sm'>
            <PropertyField
              property={property}
              disabled={!canRead || !canWrite || serverBusy || saving || loadError}
              onChange={(value) => updateProperty(property.id, value)}
            />
          </Paper>
        ))}
      </SimpleGrid>

      <Group justify='flex-end'>
        <Button
          leftSection={<FontAwesomeIcon icon={faFloppyDisk} />}
          loading={saving}
          disabled={!canRead || !canWrite || loadError || serverBusy || propertyLines.length === 0}
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
