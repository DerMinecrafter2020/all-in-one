import { Alert } from '@mantine/core';
import ServerContentContainer from '@/elements/containers/ServerContentContainer.tsx';
import { useServerCan } from '@/plugins/usePermissions.ts';
import { useServerStore } from '@/stores/server.ts';
import ModrinthManager from './ModrinthManager.tsx';
import PlayerManager from './PlayerManagerPage.tsx';
import ServerPropertiesEditor from './ServerPropertiesEditor.tsx';
import {
  getCachedServerToolPages,
  isMinecraftEgg,
  supportsServerToolPage,
  type ServerToolPageKey,
} from './serverToolsVisibility.ts';
import { useExtTranslations } from './translations.ts';

const MOD_LOADERS = [
  { value: 'fabric', label: 'Fabric' },
  { value: 'forge', label: 'Forge' },
  { value: 'neoforge', label: 'NeoForge' },
  { value: 'quilt', label: 'Quilt' },
];

const PLUGIN_LOADERS = [
  { value: 'paper', label: 'Paper' },
  { value: 'purpur', label: 'Purpur' },
  { value: 'spigot', label: 'Spigot' },
  { value: 'bukkit', label: 'Bukkit' },
  { value: 'folia', label: 'Folia' },
  { value: 'sponge', label: 'Sponge' },
  { value: 'velocity', label: 'Velocity' },
  { value: 'bungeecord', label: 'BungeeCord' },
  { value: 'waterfall', label: 'Waterfall' },
];

interface Props {
  page: ServerToolPageKey;
}

export function ModpackInstallerPage() {
  return <ServerToolPage page='modpacks' />;
}

export function ModManagerPage() {
  return <ServerToolPage page='mods' />;
}

export function PluginManagerPage() {
  return <ServerToolPage page='plugins' />;
}

export function PlayerManagerPage() {
  return <ServerToolPage page='players' />;
}

export function ServerPropertiesPage() {
  return <ServerToolPage page='serverProperties' />;
}

function ServerToolPage({ page }: Props) {
  const { t } = useExtTranslations();
  const server = useServerStore((store) => store.server);
  const state = useServerStore((store) => store.state);
  const socketConnected = useServerStore((store) => store.socketConnected);
  const socketInstance = useServerStore((store) => store.socketInstance);
  const canInstallFiles = useServerCan(['files.read', 'files.create', 'files.delete'], false);
  const canInstallModpack = useServerCan(
    ['files.read', 'files.read-content', 'files.create', 'files.archive', 'files.delete'],
    false,
  );
  const canReadConsole = useServerCan(['control.read-console', 'control.console'], false);
  const canSendCommands = useServerCan('control.console');
  const canReadFileContents = useServerCan('files.read-content');
  const canWriteFiles = useServerCan('files.create');
  const canRestart = useServerCan('control.restart');
  const canStart = useServerCan('control.start');
  const serverStopped = state === 'offline' && !server.isTransferring && !server.status;
  const serverBusy = Boolean(server.isTransferring || server.status || state === 'starting' || state === 'stopping');
  const settings = getCachedServerToolPages();

  const pageTitles: Record<ServerToolPageKey, string> = {
    modpacks: t('tools.modpacksTitle', {}),
    mods: t('tools.modsTitle', {}),
    plugins: t('tools.pluginsTitle', {}),
    players: t('tools.playersTitle', {}),
    serverProperties: t('tools.serverPropertiesTitle', {}),
  };
  const title = pageTitles[page];

  if (!isMinecraftEgg(server)) {
    return (
      <ServerContentContainer title={title}>
        <div className='p-4'>
          <Alert color='yellow'>{t('tools.notMinecraftEgg', {})}</Alert>
        </div>
      </ServerContentContainer>
    );
  }

  if (!supportsServerToolPage(server, page)) {
    return (
      <ServerContentContainer title={title}>
        <div className='p-4'>
          <Alert color='yellow'>{t('tools.pageNotSupportedForEgg', { egg: server.egg.name })}</Alert>
        </div>
      </ServerContentContainer>
    );
  }

  if (settings && !settings[page]) {
    return (
      <ServerContentContainer title={title}>
        <div className='p-4'>
          <Alert color='yellow'>{t('tools.toolPageDisabled', {})}</Alert>
        </div>
      </ServerContentContainer>
    );
  }

  return (
    <ServerContentContainer title={title}>
      <div className='p-4'>
        {serverBusy && (
          <Alert color='yellow' className='mb-4'>
            {t('tools.serverBusy', {})}
          </Alert>
        )}

        {page === 'modpacks' && (
          <ModrinthManager
            kind='modpack'
            serverUuid={server.uuid}
            canInstall={canInstallModpack}
            serverStopped={serverStopped}
            socketConnected={socketConnected}
            socketInstance={socketInstance}
          />
        )}

        {page === 'mods' && (
          <ModrinthManager
            kind='mod'
            serverUuid={server.uuid}
            targetFolder='/mods'
            loaderOptions={MOD_LOADERS}
            canInstall={canInstallFiles}
            serverStopped={serverStopped}
            socketConnected={socketConnected}
            socketInstance={socketInstance}
          />
        )}

        {page === 'plugins' && (
          <ModrinthManager
            kind='plugin'
            serverUuid={server.uuid}
            targetFolder='/plugins'
            loaderOptions={PLUGIN_LOADERS}
            canInstall={canInstallFiles}
            serverStopped={serverStopped}
            socketConnected={socketConnected}
            socketInstance={socketInstance}
          />
        )}

        {page === 'players' && (
          <PlayerManager
            canReadConsole={canReadConsole}
            canSendCommands={canSendCommands}
            canReadFiles={canReadFileContents}
            serverUuid={server.uuid}
            serverRunning={state === 'running'}
            socketConnected={socketConnected}
            socketInstance={socketInstance}
          />
        )}

        {page === 'serverProperties' && (
          <ServerPropertiesEditor
            serverUuid={server.uuid}
            serverState={state}
            serverBusy={serverBusy}
            canRead={canReadFileContents}
            canWrite={canWriteFiles}
            canRestart={canRestart}
            canStart={canStart}
            socketConnected={socketConnected}
            socketInstance={socketInstance}
          />
        )}
      </div>
    </ServerContentContainer>
  );
}
