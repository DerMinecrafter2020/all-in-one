import { Alert, Tabs } from '@mantine/core';
import ServerContentContainer from '@/elements/containers/ServerContentContainer.tsx';
import { useServerCan } from '@/plugins/usePermissions.ts';
import { useServerStore } from '@/stores/server.ts';
import ModrinthManager from './ModrinthManager.tsx';
import PlayerManager from './PlayerManager.tsx';
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

export default function ServerToolsPage() {
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
  const canReadConsole = useServerCan('control.read-console');
  const canSendCommands = useServerCan('control.console');
  const serverStopped = state === 'offline' && !server.isTransferring && !server.status;

  return (
    <ServerContentContainer title={t('tools.title', {})} subtitle={t('tools.description', {})}>
      <div className='p-4'>
        {(server.isTransferring || server.status) && (
          <Alert color='yellow' className='mb-4'>
            {t('tools.serverBusy', {})}
          </Alert>
        )}

        <Tabs defaultValue='mods' keepMounted={false}>
          <Tabs.List mb='md' grow>
            <Tabs.Tab value='modpacks'>{t('tools.tabs.modpacks', {})}</Tabs.Tab>
            <Tabs.Tab value='mods'>{t('tools.tabs.mods', {})}</Tabs.Tab>
            <Tabs.Tab value='plugins'>{t('tools.tabs.plugins', {})}</Tabs.Tab>
            <Tabs.Tab value='players'>{t('tools.tabs.players', {})}</Tabs.Tab>
          </Tabs.List>

          <Tabs.Panel value='modpacks'>
            <ModrinthManager
              kind='modpack'
              serverUuid={server.uuid}
              canInstall={canInstallModpack}
              serverStopped={serverStopped}
              socketConnected={socketConnected}
              socketInstance={socketInstance}
            />
          </Tabs.Panel>

          <Tabs.Panel value='mods'>
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
          </Tabs.Panel>

          <Tabs.Panel value='plugins'>
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
          </Tabs.Panel>

          <Tabs.Panel value='players'>
            <PlayerManager
              canReadConsole={canReadConsole}
              canSendCommands={canSendCommands}
              serverRunning={state === 'running'}
              socketConnected={socketConnected}
              socketInstance={socketInstance}
            />
          </Tabs.Panel>
        </Tabs>
      </div>
    </ServerContentContainer>
  );
}
