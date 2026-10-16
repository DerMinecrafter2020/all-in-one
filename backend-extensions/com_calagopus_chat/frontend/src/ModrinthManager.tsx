import { faBoxOpen, faCube, faDownload, faMagnifyingGlass, faPuzzlePiece } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { Alert, Badge, Button, Card, Group, Image, Loader, Modal, Select, Stack, Text, TextInput } from '@mantine/core';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { httpErrorToHuman } from '@/api/axios.ts';
import { getModrinthVersions, searchModrinthProjects } from './api/modrinth.ts';
import type { ModrinthProject, ModrinthVersion, ModrinthVersionFile } from './api/modrinth.ts';
import {
  installModrinthFile,
  installModrinthModpack,
  PanelFileOperationTimeoutError,
  validateModrinthDownloadUrl,
} from './api/serverFiles.ts';
import type { ModpackInstallProgress } from './api/serverFiles.ts';
import { useExtTranslations } from './translations.ts';
import { useToast } from '@/providers/ToastProvider.tsx';
import type { Websocket } from '@/plugins/websocket/Websocket.ts';

export type ModrinthManagerKind = 'mod' | 'plugin' | 'modpack';

interface LoaderOption {
  value: string;
  label: string;
}

interface Props {
  kind: ModrinthManagerKind;
  serverUuid: string;
  targetFolder?: '/mods' | '/plugins';
  loaderOptions?: LoaderOption[];
  canInstall: boolean;
  serverStopped: boolean;
  socketConnected: boolean;
  socketInstance: Websocket | null;
}

function getProjectKindIcon(kind: ModrinthManagerKind) {
  if (kind === 'mod') return faCube;
  if (kind === 'plugin') return faPuzzlePiece;
  return faBoxOpen;
}

function safeIconUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'cdn.modrinth.com' ? url.toString() : null;
  } catch {
    return null;
  }
}

function getInstallFile(version: ModrinthVersion, kind: ModrinthManagerKind): ModrinthVersionFile | null {
  const extension = kind === 'modpack' ? '.mrpack' : '.jar';
  const matches = version.files.filter((file) => file.filename.toLowerCase().endsWith(extension));
  return matches.find((file) => file.primary) ?? matches[0] ?? null;
}

function formatDownloads(value: number): string {
  return new Intl.NumberFormat().format(value);
}

export default function ModrinthManager({
  kind,
  serverUuid,
  targetFolder,
  loaderOptions = [],
  canInstall,
  serverStopped,
  socketConnected,
  socketInstance,
}: Props) {
  const { t } = useExtTranslations();
  const { addToast } = useToast();
  const [query, setQuery] = useState('');
  const [submittedQuery, setSubmittedQuery] = useState('');
  const [gameVersion, setGameVersion] = useState('');
  const [loader, setLoader] = useState(loaderOptions[0]?.value ?? '');
  const [projects, setProjects] = useState<ModrinthProject[]>([]);
  const [searchLoading, setSearchLoading] = useState(true);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [selectedProject, setSelectedProject] = useState<ModrinthProject | null>(null);
  const [versions, setVersions] = useState<ModrinthVersion[]>([]);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [installLoading, setInstallLoading] = useState(false);
  const [progress, setProgress] = useState<ModpackInstallProgress | null>(null);
  const [installSummary, setInstallSummary] = useState<string | null>(null);

  const selectedVersion = useMemo(
    () => versions.find((version) => version.id === selectedVersionId) ?? null,
    [selectedVersionId, versions],
  );
  const selectedFile = selectedVersion ? getInstallFile(selectedVersion, kind) : null;
  const isModpack = kind === 'modpack';
  const isPlugin = kind === 'plugin';
  const progressLabels: Record<ModpackInstallProgress['stage'], string> = {
    download: t('tools.progress.download', {}),
    extract: t('tools.progress.extract', {}),
    prepare: t('tools.progress.prepare', {}),
    install: t('tools.progress.install', {}),
    cleanup: t('tools.progress.cleanup', {}),
  };

  const loadProjects = useCallback(
    async (searchTerm: string) => {
      setSearchLoading(true);
      setSearchError(null);
      setInstallSummary(null);
      try {
        const response = await searchModrinthProjects({
          query: searchTerm.trim() || undefined,
          projectType: kind,
          gameVersion: gameVersion.trim() || undefined,
          loader: isModpack ? undefined : loader || undefined,
        });
        setProjects(response.hits);
      } catch (error) {
        setSearchError(httpErrorToHuman(error));
        setProjects([]);
      } finally {
        setSearchLoading(false);
      }
    },
    [gameVersion, isModpack, kind, loader],
  );

  useEffect(() => {
    const timeout = window.setTimeout(() => void loadProjects(submittedQuery), 300);
    return () => window.clearTimeout(timeout);
  }, [loadProjects, submittedQuery]);

  const runSearch = (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    const normalizedQuery = query.trim();
    if (normalizedQuery === submittedQuery) void loadProjects(normalizedQuery);
    else setSubmittedQuery(normalizedQuery);
  };

  const openVersions = async (project: ModrinthProject) => {
    setSelectedProject(project);
    setVersions([]);
    setSelectedVersionId(null);
    setVersionsLoading(true);
    setInstallSummary(null);
    try {
      const result = await getModrinthVersions(project.project_id, {
        gameVersion: gameVersion.trim() || undefined,
        loader: isModpack ? undefined : loader || undefined,
      });
      const supported = result.filter((version) => getInstallFile(version, kind));
      setVersions(supported);
      setSelectedVersionId(supported[0]?.id ?? null);
      if (supported.length === 0) addToast(t('tools.noInstallableVersions', {}), 'error');
    } catch (error) {
      setSelectedProject(null);
      addToast(httpErrorToHuman(error), 'error');
    } finally {
      setVersionsLoading(false);
    }
  };

  const startInstall = async () => {
    if (!selectedVersion || !selectedFile || !socketInstance) return;
    if (!canInstall) {
      addToast(t('tools.filePermissionRequired', {}), 'error');
      return;
    }
    if (!serverStopped) {
      addToast(t('tools.serverMustBeOffline', {}), 'error');
      return;
    }
    if (!socketConnected) {
      addToast(t('tools.websocketRequired', {}), 'error');
      return;
    }

    try {
      validateModrinthDownloadUrl(selectedFile.url);
      setInstallLoading(true);
      setInstallSummary(null);

      if (isModpack) {
        setProgress({ stage: 'download', current: 0, total: 1 });
        const result = await installModrinthModpack(serverUuid, socketInstance, selectedFile, setProgress);
        const dependencySummary = Object.entries(result.dependencies)
          .map(([name, version]) => `${name}: ${version}`)
          .join(' · ');
        const summary = t('tools.modpackInstallComplete', {
          installed: result.installed,
          skipped: result.skipped,
        });
        setInstallSummary(
          [summary, dependencySummary ? `${t('tools.packRequirements', {})}: ${dependencySummary}` : '']
            .filter(Boolean)
            .join(' '),
        );
        if (result.cleanupFailed) addToast(t('tools.temporaryCleanupFailed', {}), 'error');
        else addToast(summary, 'success');
      } else {
        if (!targetFolder) throw new Error('The target server folder is not configured.');
        const result = await installModrinthFile(serverUuid, socketInstance, targetFolder, selectedFile);
        const summary = t('tools.fileInstallComplete', { file: selectedFile.filename });
        setInstallSummary(summary);
        if (result.cleanupFailed) addToast(t('tools.temporaryCleanupFailed', {}), 'error');
        else addToast(summary, 'success');
      }
      setSelectedProject(null);
    } catch (error) {
      if (error instanceof PanelFileOperationTimeoutError) {
        addToast(t('tools.operationTimedOut', {}), 'error');
      } else {
        addToast(httpErrorToHuman(error), 'error');
      }
    } finally {
      setInstallLoading(false);
      setProgress(null);
    }
  };

  const title = isModpack
    ? t('tools.modpacksTitle', {})
    : isPlugin
      ? t('tools.pluginsTitle', {})
      : t('tools.modsTitle', {});
  const placeholder = isModpack
    ? t('tools.searchModpacksPlaceholder', {})
    : isPlugin
      ? t('tools.searchPluginsPlaceholder', {})
      : t('tools.searchModsPlaceholder', {});

  return (
    <Stack gap='md'>
      <div>
        <Text size='sm' c='dimmed'>
          {t('tools.modrinthDescription', {})}
        </Text>
      </div>

      {!canInstall && <Alert color='yellow'>{t('tools.filePermissionRequired', {})}</Alert>}
      {!serverStopped && <Alert color='yellow'>{t('tools.serverMustBeOffline', {})}</Alert>}
      {!socketConnected && <Alert color='yellow'>{t('tools.websocketRequired', {})}</Alert>}
      {installSummary && <Alert color='green'>{installSummary}</Alert>}

      <form onSubmit={(event) => void runSearch(event)}>
        <Stack gap='sm'>
          <Group align='end' grow wrap='wrap'>
            <TextInput
              label={t('tools.searchLabel', {})}
              placeholder={placeholder}
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              maxLength={100}
              leftSection={<FontAwesomeIcon icon={faMagnifyingGlass} />}
            />
            <TextInput
              label={t('tools.gameVersion', {})}
              placeholder={t('tools.anyGameVersion', {})}
              value={gameVersion}
              onChange={(event) => setGameVersion(event.currentTarget.value)}
              maxLength={32}
            />
            {!isModpack && (
              <Select
                label={t('tools.loader', {})}
                data={loaderOptions}
                value={loader}
                onChange={(value) => setLoader(value ?? '')}
                allowDeselect={false}
              />
            )}
            <Button type='submit' loading={searchLoading} leftSection={<FontAwesomeIcon icon={faMagnifyingGlass} />}>
              {t('tools.search', {})}
            </Button>
          </Group>
        </Stack>
      </form>

      {searchError && <Alert color='red'>{searchError}</Alert>}
      {searchLoading && (
        <Group justify='center'>
          <Loader size='sm' />
        </Group>
      )}
      {!searchLoading && projects.length === 0 && !searchError && (
        <Text c='dimmed' size='sm'>
          {t('tools.noSearchResults', {})}
        </Text>
      )}

      {projects.length > 0 && (
        <div className='grid grid-cols-1 xl:grid-cols-2 gap-3'>
          {projects.map((project) => {
            const iconUrl = safeIconUrl(project.icon_url);
            return (
              <Card key={project.project_id} withBorder padding='md' radius='md'>
                <Group align='flex-start' wrap='nowrap'>
                  {iconUrl ? (
                    <Image src={iconUrl} alt='' w={48} h={48} radius='sm' fit='cover' referrerPolicy='no-referrer' />
                  ) : (
                    <div className='flex h-12 w-12 shrink-0 items-center justify-center rounded bg-(--mantine-color-default)'>
                      <FontAwesomeIcon icon={getProjectKindIcon(kind)} />
                    </div>
                  )}
                  <Stack gap={4} className='min-w-0 flex-1'>
                    <Group justify='space-between' align='flex-start' wrap='nowrap'>
                      <div className='min-w-0'>
                        <Text fw={700} lineClamp={1}>
                          {project.title}
                        </Text>
                        <Text size='xs' c='dimmed'>
                          {t('tools.projectBy', { author: project.author })}
                        </Text>
                      </div>
                      <Badge variant='light'>{formatDownloads(project.downloads)}</Badge>
                    </Group>
                    <Text size='sm' c='dimmed' lineClamp={3}>
                      {project.description}
                    </Text>
                    <Group justify='space-between' mt='xs'>
                      <Group gap={4}>
                        {project.categories.slice(0, 3).map((category) => (
                          <Badge key={category} size='xs' variant='outline'>
                            {category}
                          </Badge>
                        ))}
                      </Group>
                      <Button
                        size='xs'
                        variant='light'
                        leftSection={<FontAwesomeIcon icon={faDownload} />}
                        loading={versionsLoading && selectedProject?.project_id === project.project_id}
                        onClick={() => void openVersions(project)}
                      >
                        {t('tools.chooseVersion', {})}
                      </Button>
                    </Group>
                  </Stack>
                </Group>
              </Card>
            );
          })}
        </div>
      )}

      <Modal
        opened={selectedProject !== null}
        onClose={() => {
          if (!installLoading) setSelectedProject(null);
        }}
        title={selectedProject?.title ?? title}
        size='lg'
        closeOnClickOutside={!installLoading}
        closeOnEscape={!installLoading}
      >
        <Stack gap='md'>
          {versionsLoading ? (
            <Group justify='center'>
              <Loader size='sm' />
            </Group>
          ) : versions.length === 0 ? (
            <Text size='sm' c='dimmed'>
              {t('tools.noInstallableVersions', {})}
            </Text>
          ) : (
            <>
              <Select
                label={t('tools.version', {})}
                data={versions.map((version) => ({
                  value: version.id,
                  label: `${version.version_number} · ${
                    version.game_versions.slice(0, 2).join(', ') || t('tools.unspecifiedVersion', {})
                  }`,
                }))}
                value={selectedVersionId}
                onChange={setSelectedVersionId}
                searchable
              />
              {isModpack && selectedVersion && (
                <Text size='sm' c='dimmed'>
                  {t('tools.packVersionRequirements', {
                    gameVersions: selectedVersion.game_versions.join(', ') || t('tools.unspecifiedVersion', {}),
                    loaders: selectedVersion.loaders.join(', ') || t('tools.unspecifiedVersion', {}),
                  })}
                </Text>
              )}
              {selectedFile && (
                <Text size='sm' c='dimmed'>
                  {t('tools.fileToInstall', { file: selectedFile.filename })}
                </Text>
              )}
              <Alert color='yellow'>
                {isModpack ? t('tools.modpackInstallWarning', {}) : t('tools.singleFileInstallWarning', {})}
              </Alert>
              {progress && (
                <Text size='sm' c='dimmed'>
                  {t('tools.installProgress', {
                    stage: progressLabels[progress.stage],
                    current: progress.current,
                    total: progress.total,
                  })}
                </Text>
              )}
              <Group justify='flex-end'>
                <Button variant='default' disabled={installLoading} onClick={() => setSelectedProject(null)}>
                  {t('tools.close', {})}
                </Button>
                <Button
                  loading={installLoading}
                  disabled={!selectedFile || !canInstall || !serverStopped || !socketConnected || !socketInstance}
                  leftSection={<FontAwesomeIcon icon={faDownload} />}
                  onClick={() => void startInstall()}
                >
                  {isModpack ? t('tools.installModpack', {}) : t('tools.installFile', {})}
                </Button>
              </Group>
            </>
          )}
        </Stack>
      </Modal>
    </Stack>
  );
}
