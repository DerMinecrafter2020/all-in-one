import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'react-router';
import { useAuth } from '@/providers/AuthProvider.tsx';
import getPublicAdvertisingSettings from './api/getPublicAdvertisingSettings.ts';
import type { AdvertisingSettings, AdvertisingSlotName, AdvertisingSlotSettings } from './lib/schemas.ts';
import { useExtTranslations } from './translations.ts';

function AdPlacement({
  name,
  slot,
  label,
  iframeTitle,
}: {
  name: AdvertisingSlotName;
  slot: AdvertisingSlotSettings;
  label: string;
  iframeTitle: string;
}) {
  if (!slot.enabled) return null;

  return (
    <aside
      className={`calagopus-ad-placement calagopus-ad-placement-${name}`}
      style={{ width: `${slot.width}px`, height: `${slot.height + 16}px` }}
      aria-label={label}
    >
      <span className='calagopus-ad-placement-label'>{label}</span>
      {slot.mode === 'sandboxed_iframe' ? (
        <iframe
          className='calagopus-ad-placement-frame'
          src={slot.customAdIframeUrl}
          title={iframeTitle}
          sandbox='allow-scripts allow-popups'
          loading='lazy'
          referrerPolicy='no-referrer'
          width={slot.width}
          height={slot.height}
        />
      ) : (
        <a
          className='calagopus-ad-placement-link'
          href={slot.customAdTargetUrl}
          target='_blank'
          rel='sponsored noopener noreferrer'
        >
          <img
            className='calagopus-ad-placement-image'
            src={slot.customAdImageUrl}
            alt={slot.customAdAltText}
            loading='lazy'
            referrerPolicy='no-referrer'
            width={slot.width}
            height={slot.height}
          />
        </a>
      )}
    </aside>
  );
}

export default function AdvertisingBanner() {
  const { user } = useAuth();
  const { pathname } = useLocation();
  const { t: tExt } = useExtTranslations();
  const userUuid = user?.uuid;
  const [settings, setSettings] = useState<AdvertisingSettings | null>(null);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const [viewportWidth, setViewportWidth] = useState(0);

  useEffect(() => {
    const updateViewportWidth = () => setViewportWidth(window.innerWidth);
    updateViewportWidth();
    setPortalTarget(document.body);
    window.addEventListener('resize', updateViewportWidth);
    return () => window.removeEventListener('resize', updateViewportWidth);
  }, []);

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

  if (!userUuid || !settings) return null;
  if (settings.scope === 'dashboard' && pathname !== '/') return null;

  const label = tExt('ads.bannerLabel', {});
  const iframeTitle = tExt('ads.iframeTitle', {});
  const slots = settings.slots;
  const leftSideFits = viewportWidth >= 1200 + 2 * (slots.left.width + 16);
  const rightSideFits = viewportWidth >= 1200 + 2 * (slots.right.width + 16);

  return (
    <>
      <AdPlacement name='top' slot={slots.top} label={label} iframeTitle={iframeTitle} />
      {portalTarget && createPortal(
        <>
          <AdPlacement name='bottom' slot={slots.bottom} label={label} iframeTitle={iframeTitle} />
          {leftSideFits && (
            <AdPlacement name='left' slot={slots.left} label={label} iframeTitle={iframeTitle} />
          )}
          {rightSideFits && (
            <AdPlacement name='right' slot={slots.right} label={label} iframeTitle={iframeTitle} />
          )}
        </>,
        portalTarget,
      )}
    </>
  );
}
