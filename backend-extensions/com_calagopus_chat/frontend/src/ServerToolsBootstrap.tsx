import { useEffect } from 'react';
import { useLocation } from 'react-router';
import getServer from '@/api/server/getServer.ts';
import getPublicServerToolPages from './api/getPublicServerToolPages.ts';
import { cacheServerVisibility, getServerIdentifierFromPath } from './serverToolsVisibility.ts';

export default function ServerToolsBootstrap() {
  const { pathname } = useLocation();
  const serverIdentifier = getServerIdentifierFromPath(pathname);

  useEffect(() => {
    if (!serverIdentifier) return;

    let active = true;
    Promise.all([getServer(serverIdentifier), getPublicServerToolPages()])
      .then(([server, response]) => {
        if (!active) return;
        const changed = cacheServerVisibility(serverIdentifier, server, response.settings, response.eggSettings);
        if (changed) window.location.reload();
      })
      .catch(() => {
        // The Panel's own server route reports access errors; keep tools hidden until metadata loads.
      });

    return () => {
      active = false;
    };
  }, [serverIdentifier]);

  return null;
}
