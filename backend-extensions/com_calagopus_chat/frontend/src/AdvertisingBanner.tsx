import { useEffect, useState } from 'react';
import { useAuth } from '@/providers/AuthProvider.tsx';
import getPublicAdvertisingSettings from './api/getPublicAdvertisingSettings.ts';
import type { AdvertisingSettings } from './lib/schemas.ts';
import { useExtTranslations } from './translations.ts';

export default function AdvertisingBanner() {
  const { user } = useAuth();
  const { t: tExt } = useExtTranslations();
  const userUuid = user?.uuid;
  const [settings, setSettings] = useState<AdvertisingSettings | null>(null);

  useEffect(() => {
    if (!userUuid) {
      setSettings(null);
      return;
    }

    setSettings(null);
    let active = true;
    getPublicAdvertisingSettings()
      .then((result) => {
        if (active) setSettings(result);
      })
      .catch(() => {
        if (active) setSettings(null);
      });

    return () => {
      active = false;
    };
  }, [userUuid]);

  if (!userUuid || !settings?.enabled) return null;

  return (
    <aside className='calagopus-ad-banner-slot' aria-label={tExt('ads.bannerLabel', {})}>
      <div className='calagopus-ad-banner-inner'>
        <span className='calagopus-ad-banner-label'>{tExt('ads.bannerLabel', {})}</span>
        <a
          className='calagopus-custom-ad-link'
          href={settings.customAdTargetUrl}
          target='_blank'
          rel='sponsored noopener noreferrer'
        >
          <img
            className='calagopus-custom-ad-image'
            src={settings.customAdImageUrl}
            alt={settings.customAdAltText}
            loading='lazy'
            referrerPolicy='no-referrer'
          />
        </a>
      </div>
    </aside>
  );
}
