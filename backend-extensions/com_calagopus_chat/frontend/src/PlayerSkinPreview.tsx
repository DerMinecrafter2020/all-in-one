import { Alert, Button, Card, Group, Loader, Stack, Text } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
import { IdleAnimation, SkinViewer } from 'skinview3d';
import { useExtTranslations } from './translations.ts';

const PLAYER_UUID_PATTERN = /^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i;

export default function PlayerSkinPreview({ uuid }: { uuid?: string }) {
  const { t } = useExtTranslations();
  const [requestedUuid, setRequestedUuid] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const requested = Boolean(uuid && requestedUuid === uuid);
  const normalizedUuid = uuid?.toLowerCase();
  const isValidUuid = Boolean(normalizedUuid && PLAYER_UUID_PATTERN.test(uuid ?? ''));

  useEffect(() => {
    if (!requested || !isValidUuid || !normalizedUuid) return;
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    let viewer: SkinViewer;
    try {
      const bounds = container.getBoundingClientRect();
      viewer = new SkinViewer({
        canvas,
        width: Math.max(1, Math.floor(bounds.width)),
        height: Math.max(1, Math.floor(bounds.height)),
        animation: new IdleAnimation(),
      });
      viewer.autoRotate = true;
      viewer.autoRotateSpeed = 0.6;
    } catch {
      setLoading(false);
      setFailed(true);
      return;
    }

    let active = true;
    let disposed = false;
    let skinObjectUrl: string | undefined;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 10_000);
    const disposeViewer = () => {
      if (disposed) return;
      disposed = true;
      viewer.dispose();
    };
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver((entries) => {
            const bounds = entries[0]?.contentRect;
            if (bounds && bounds.width > 0 && bounds.height > 0) {
              viewer.setSize(bounds.width, bounds.height);
            }
          });
    observer?.observe(container);

    const loadSkin = async () => {
      try {
        const response = await fetch(`https://minotar.net/skin/${normalizedUuid}`, {
          credentials: 'omit',
          mode: 'cors',
          referrerPolicy: 'no-referrer',
          redirect: 'error',
          signal: controller.signal,
        });
        if (!response.ok || new URL(response.url).hostname !== 'minotar.net') {
          throw new Error('The skin provider returned an unexpected response.');
        }

        const contentLength = Number(response.headers.get('content-length'));
        if (Number.isFinite(contentLength) && contentLength > 1024 * 1024) {
          throw new Error('The skin image exceeds the supported size limit.');
        }
        const skin = await response.blob();
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(skin.type.toLowerCase()) || skin.size > 1024 * 1024) {
          throw new Error('The skin provider returned an invalid image.');
        }
        if (!active) return;

        skinObjectUrl = URL.createObjectURL(skin);
        await viewer.loadSkin(skinObjectUrl);
        if (active) setLoading(false);
      } catch {
        if (active) {
          disposeViewer();
          if (skinObjectUrl) {
            URL.revokeObjectURL(skinObjectUrl);
            skinObjectUrl = undefined;
          }
          setLoading(false);
          setFailed(true);
        }
      } finally {
        window.clearTimeout(timeout);
      }
    };
    void loadSkin();

    return () => {
      active = false;
      window.clearTimeout(timeout);
      controller.abort();
      observer?.disconnect();
      disposeViewer();
      if (skinObjectUrl) URL.revokeObjectURL(skinObjectUrl);
    };
  }, [attempt, isValidUuid, normalizedUuid, requested]);

  if (!isValidUuid) {
    return (
      <Text size='sm' c='dimmed'>
        {t('tools.playerSkinUuidUnavailable', {})}
      </Text>
    );
  }

  if (!requested) {
    return (
      <Stack gap='sm'>
        <Text size='sm' c='dimmed'>
          {t('tools.playerSkinPrivacyNotice', {})}
        </Text>
        <Button
          variant='light'
          onClick={() => {
            setFailed(false);
            setLoading(true);
            setRequestedUuid(uuid ?? null);
          }}
        >
          {t('tools.loadPlayerSkin', {})}
        </Button>
      </Stack>
    );
  }

  return (
    <Stack gap='sm'>
      <Text size='sm' c='dimmed'>
        {t('tools.playerSkinPrivacyNotice', {})}
      </Text>
      {failed ? (
        <Stack gap='xs'>
          <Alert color='yellow'>{t('tools.playerSkinFailed', {})}</Alert>
          <Button
            variant='light'
            onClick={() => {
              setFailed(false);
              setLoading(true);
              setAttempt((current) => current + 1);
            }}
          >
            {t('tools.loadPlayerSkin', {})}
          </Button>
        </Stack>
      ) : (
        <Card withBorder padding={0} radius='md' className='mx-auto h-80 w-full max-w-xs overflow-hidden'>
          <div ref={containerRef} className='h-full w-full'>
            <canvas ref={canvasRef} className='block h-full w-full' aria-label={t('tools.playerSkinTab', {})} />
          </div>
        </Card>
      )}
      {loading && (
        <Group justify='center' gap='xs'>
          <Loader size='xs' />
          <Text size='xs' c='dimmed'>
            {t('tools.playerSkinLoading', {})}
          </Text>
        </Group>
      )}
    </Stack>
  );
}
