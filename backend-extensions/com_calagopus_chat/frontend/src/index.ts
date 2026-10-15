import { faBullhorn, faComments, faScrewdriverWrench } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { createElement, type FC } from 'react';
import { Extension, type ExtensionContext } from 'shared';
import './app.css';
import AdvertisingBanner from './AdvertisingBanner.tsx';
import AdvertisingSettingsPage from './AdvertisingSettingsPage.tsx';
import ChatPage from './ChatPage.tsx';
import ChatWidget from './ChatWidget.tsx';
import ConfigurationPage from './ConfigurationPage.tsx';
import ServerToolsPage from './ServerToolsPage.tsx';
import { getExtTranslations } from './translations.ts';

class CalagopusChatExtension extends Extension {
  public cardConfigurationPage: FC | null = ConfigurationPage;
  public cardIcon = createElement(FontAwesomeIcon, { icon: faComments });

  public initialize(ctx: ExtensionContext): void {
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
      icon: faComments,
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
      name: () => getExtTranslations().t('tools.sidebarTitle', {}),
      path: '/calagopus-tools',
      icon: faScrewdriverWrench,
      element: ServerToolsPage,
      permission: ['files.read', 'files.create', 'control.read-console', 'control.console'],
      exact: true,
    });
  }
}

export default new CalagopusChatExtension();
