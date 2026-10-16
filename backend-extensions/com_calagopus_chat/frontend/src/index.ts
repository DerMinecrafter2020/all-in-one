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
import { Extension, type ExtensionContext } from 'shared';
import './app.css';
import AdvertisingBanner from './AdvertisingBanner.tsx';
import AdvertisingSettingsPage from './AdvertisingSettingsPage.tsx';
import ChatPage from './ChatPage.tsx';
import ChatWidget from './ChatWidget.tsx';
import ConfigurationPage from './ConfigurationPage.tsx';
import ServerToolsBootstrap from './ServerToolsBootstrap.tsx';
import {
  ModManagerPage,
  ModpackInstallerPage,
  PlayerManagerPage,
  PluginManagerPage,
  ServerPropertiesPage,
} from './ServerToolsPage.tsx';
import { isServerToolPageVisible } from './serverToolsVisibility.ts';
import { getExtTranslations } from './translations.ts';

class AllInOneExtension extends Extension {
  public cardConfigurationPage: FC | null = ConfigurationPage;
  public cardIcon = createElement(FontAwesomeIcon, { icon: faLayerGroup });

  public initialize(ctx: ExtensionContext): void {
    ctx.extensionRegistry.pages.global.prependComponent(ServerToolsBootstrap);
    ctx.extensionRegistry.pages.global.prependComponent(AdvertisingBanner);
    ctx.extensionRegistry.pages.global.appendComponent(ChatWidget);
    ctx.extensionRegistry.routes.addAccountRoute({
      name: () => getExtTranslations().t('chat.sidebarTitle', {}),
      path: '/calagopus-chat',
      icon: faComments,
      element: ChatPage,
      exact: true,
    });
    ctx.extensionRegistry.routes.addAdminRoute({
      name: () => getExtTranslations().t('settings.sidebarTitle', {}),
      path: '/calagopus-chat',
      icon: faLayerGroup,
      element: ConfigurationPage,
      permission: 'extensions.manage',
      category: 'system',
      exact: true,
    });
    ctx.extensionRegistry.routes.addAdminRoute({
      name: () => getExtTranslations().t('ads.sidebarTitle', {}),
      path: '/calagopus-ads',
      icon: faBullhorn,
      element: AdvertisingSettingsPage,
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
  }
}

export default new AllInOneExtension();
