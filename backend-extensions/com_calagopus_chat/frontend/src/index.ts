import {
  faBoxOpen,
  faBullhorn,
  faComments,
  faCube,
  faFileLines,
  faLayerGroup,
  faPuzzlePiece,
  faUsers,
} from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { createElement, type FC } from 'react';
import { Navigate } from 'react-router';
import { Extension, type ExtensionContext } from 'shared';
import './app.css';
import AdvertisingBanner from './AdvertisingBanner.tsx';
import AdvertisingSettingsPage from './AdvertisingSettingsPage.tsx';
import ChatPage from './ChatPage.tsx';
import ChatWidget from './ChatWidget.tsx';
import ConfigurationPage from './ConfigurationPage.tsx';
import {
  ModManagerSettingsPage,
  ModpackInstallerSettingsPage,
  PlayerManagerSettingsPage,
  PluginManagerSettingsPage,
  ServerPropertiesSettingsPage,
} from './ServerToolSettingsPage.tsx';
import ServerToolsBootstrap from './ServerToolsBootstrap.tsx';
import MinecraftVersionSettingsPage from './MinecraftVersionSettingsPage.tsx';
import {
  MinecraftVersionChangerPage,
  ModManagerPage,
  ModpackInstallerPage,
  PlayerManagerPage,
  PluginManagerPage,
  ServerPropertiesPage,
} from './ServerToolsPage.tsx';
import { isServerToolPageVisible } from './serverToolsVisibility.ts';
import { getExtTranslations } from './translations.ts';

const LegacyChatRoute: FC = () => createElement(Navigate, { to: '/account/all-in-one/chat', replace: true });
const LegacyChatSettingsRoute: FC = () => createElement(Navigate, { to: '/admin/all-in-one/settings', replace: true });
const LegacyAdvertisingRoute: FC = () =>
  createElement(Navigate, { to: '/admin/all-in-one/advertising', replace: true });

class AllInOneExtension extends Extension {
  public cardConfigurationPage: FC | null = ConfigurationPage;
  public cardIcon = createElement(FontAwesomeIcon, { icon: faLayerGroup });

  public initialize(ctx: ExtensionContext): void {
    ctx.extensionRegistry.pages.global.prependComponent(ServerToolsBootstrap);
    ctx.extensionRegistry.pages.global.prependComponent(AdvertisingBanner);
    ctx.extensionRegistry.pages.global.appendComponent(ChatWidget);
    ctx.extensionRegistry.routes.addAccountRoute({
      name: () => getExtTranslations().t('chat.sidebarTitle', {}),
      path: '/all-in-one/chat',
      icon: faComments,
      element: ChatPage,
      exact: true,
    });
    ctx.extensionRegistry.routes.addAccountRoute({
      name: undefined,
      path: '/calagopus-chat',
      element: LegacyChatRoute,
      exact: true,
    });
    ctx.extensionRegistry.routes.addAdminRoute({
      name: () => getExtTranslations().t('settings.sidebarTitle', {}),
      path: '/all-in-one/settings',
      icon: faLayerGroup,
      element: ConfigurationPage,
      permission: 'extensions.manage',
      category: 'system',
      exact: true,
    });
    ctx.extensionRegistry.routes.addAdminRoute({
      name: undefined,
      path: '/calagopus-chat',
      element: LegacyChatSettingsRoute,
      permission: 'extensions.manage',
      exact: true,
    });
    ctx.extensionRegistry.routes.addAdminRoute({
      name: () => getExtTranslations().t('ads.sidebarTitle', {}),
      path: '/all-in-one/advertising',
      icon: faBullhorn,
      element: AdvertisingSettingsPage,
      permission: 'extensions.manage',
      category: 'system',
      exact: true,
    });
    ctx.extensionRegistry.routes.addAdminRoute({
      name: undefined,
      path: '/calagopus-ads',
      element: LegacyAdvertisingRoute,
      permission: 'extensions.manage',
      exact: true,
    });
    ctx.extensionRegistry.routes.addAdminRoute({
      name: () => getExtTranslations().t('tools.sidebar.modpacks', {}),
      path: '/all-in-one/modpacks',
      icon: faBoxOpen,
      element: ModpackInstallerSettingsPage,
      permission: 'extensions.manage',
      category: 'system',
      exact: true,
    });
    ctx.extensionRegistry.routes.addAdminRoute({
      name: () => getExtTranslations().t('tools.sidebar.mods', {}),
      path: '/all-in-one/mods',
      icon: faCube,
      element: ModManagerSettingsPage,
      permission: 'extensions.manage',
      category: 'system',
      exact: true,
    });
    ctx.extensionRegistry.routes.addAdminRoute({
      name: () => getExtTranslations().t('tools.sidebar.plugins', {}),
      path: '/all-in-one/plugins',
      icon: faPuzzlePiece,
      element: PluginManagerSettingsPage,
      permission: 'extensions.manage',
      category: 'system',
      exact: true,
    });
    ctx.extensionRegistry.routes.addAdminRoute({
      name: () => getExtTranslations().t('tools.sidebar.players', {}),
      path: '/all-in-one/players',
      icon: faUsers,
      element: PlayerManagerSettingsPage,
      permission: 'extensions.manage',
      category: 'system',
      exact: true,
    });
    ctx.extensionRegistry.routes.addAdminRoute({
      name: () => getExtTranslations().t('tools.sidebar.serverProperties', {}),
      path: '/all-in-one/server-properties',
      icon: faFileLines,
      element: ServerPropertiesSettingsPage,
      permission: 'extensions.manage',
      category: 'system',
      exact: true,
    });
    ctx.extensionRegistry.routes.addAdminRoute({
      name: () => getExtTranslations().t('tools.sidebar.minecraftVersions', {}),
      path: '/all-in-one/minecraft-versions',
      icon: faCube,
      element: MinecraftVersionSettingsPage,
      permission: 'extensions.manage',
      category: 'system',
      exact: true,
    });
    ctx.extensionRegistry.routes.addServerRoute({
      name: () => getExtTranslations().t('tools.sidebar.modpacks', {}),
      path: '/all-in-one/modpacks',
      icon: faBoxOpen,
      element: ModpackInstallerPage,
      permission: ['files.read', 'files.create'],
      filter: () => isServerToolPageVisible('modpacks'),
      exact: true,
    });
    ctx.extensionRegistry.routes.addServerRoute({
      name: () => getExtTranslations().t('tools.sidebar.mods', {}),
      path: '/all-in-one/mods',
      icon: faCube,
      element: ModManagerPage,
      permission: ['files.read', 'files.create'],
      filter: () => isServerToolPageVisible('mods'),
      exact: true,
    });
    ctx.extensionRegistry.routes.addServerRoute({
      name: () => getExtTranslations().t('tools.sidebar.plugins', {}),
      path: '/all-in-one/plugins',
      icon: faPuzzlePiece,
      element: PluginManagerPage,
      permission: ['files.read', 'files.create'],
      filter: () => isServerToolPageVisible('plugins'),
      exact: true,
    });
    ctx.extensionRegistry.routes.addServerRoute({
      name: () => getExtTranslations().t('tools.sidebar.players', {}),
      path: '/all-in-one/players',
      icon: faUsers,
      element: PlayerManagerPage,
      permission: ['control.console', 'control.read-console', 'files.read-content'],
      filter: () => isServerToolPageVisible('players'),
      exact: true,
    });
    ctx.extensionRegistry.routes.addServerRoute({
      name: () => getExtTranslations().t('tools.sidebar.serverProperties', {}),
      path: '/all-in-one/server-properties',
      icon: faFileLines,
      element: ServerPropertiesPage,
      permission: ['files.read-content', 'files.create'],
      filter: () => isServerToolPageVisible('serverProperties'),
      exact: true,
    });
    ctx.extensionRegistry.routes.addServerRoute({
      name: () => getExtTranslations().t('tools.sidebar.minecraftVersions', {}),
      path: '/all-in-one/minecraft-versions',
      icon: faCube,
      element: MinecraftVersionChangerPage,
      permission: ['files.read', 'files.read-content'],
      filter: () => isServerToolPageVisible('minecraftVersions'),
      exact: true,
    });
  }
}

export default new AllInOneExtension();
