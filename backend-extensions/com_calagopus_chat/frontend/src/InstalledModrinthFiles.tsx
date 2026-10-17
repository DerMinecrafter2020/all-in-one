import {
  faArrowRotateRight,
  faCircleInfo,
  faMagnifyingGlass,
  faRotate,
  faTrash,
} from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Loader,
  Modal,
  Pagination,
  Select,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { z } from 'zod';
import { getHttpStatus, httpErrorToHuman } from '@/api/axios.ts';
import deleteFiles from '@/api/server/files/deleteFiles.ts';
import loadDirectory from '@/api/server/files/loadDirectory.ts';
import type { serverDirectoryEntrySchema } from '@/lib/schemas/server/files.ts';
import type { Websocket } from '@/plugins/websocket/Websocket.ts';
import { useToast } from '@/providers/ToastProvider.tsx';
import type { ModrinthProject, ModrinthProjectType, ModrinthVersion } from './api/modrinth.ts';
import { getModrinthVersions, searchModrinthProjects } from './api/modrinth.ts';
import { installModrinthFile, PanelFileOperationTimeoutError, validateModrinthDownloadUrl } from './api/serverFiles.ts';
import { useExtTranslations } from './translations.ts';

type DirectoryEntry = z.infer<typeof serverDirectoryEntrySchema>;

interface InstalledJar {
  name: string;
  size: number;
  modified: Date;
}

interface Props {
  kind: 'mod' | 'plugin';
  serverUuid: string;
  targetFolder: '/mods' | '/plugins';
  gameVersion: string;
  loader: string;
  canReadFiles: boolean;
  canDeleteFiles: boolean;
  canInstall: boolean;
  serverStopped: boolean;
  serverBusy: boolean;
  socketConnected: boolean;
  socketInstance: Websocket | null;
}

function getJarFile(version: ModrinthVersion) {
  const jars = version.files.filter((file) => file.filename.toLowerCase().endsWith('.jar'));
  return jars.find((file) => file.primary) ?? jars[0] ?? null;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = bytes / 1024;
  let unit = units[0];
  for (let index = 1; size >= 1024 && index < units.length; index += 1) {
    size /= 1024;
    unit = units[index];
  }
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(size)} ${unit}`;
}

function normalizeProjectName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export default function InstalledModrinthFiles({
  kind,
  serverUuid,
  targetFolder,
  gameVersion,
  loader,
  canReadFiles,
  canDeleteFiles,
  canInstall,
  serverStopped,
  serverBusy,
  socketConnected,
  socketInstance,
}: Props) {
  const { t } = useExtTranslations();
  const { addToast } = useToast();
  const [files, setFiles] = useState<InstalledJar[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState('48');
  const [detailsFile, setDetailsFile] = useState<InstalledJar | null>(null);
  const [removeFile, setRemoveFile] = useState<InstalledJar | null>(null);
  const [removing, setRemoving] = useState(false);
  const [updateFile, setUpdateFile] = useState<InstalledJar | null>(null);
  const [updateSearch, setUpdateSearch] = useState('');
  const [updateProjects, setUpdateProjects] = useState<ModrinthProject[]>([]);
  const [updateProjectId, setUpdateProjectId] = useState<string | null>(null);
  const [updateVersions, setUpdateVersions] = useState<ModrinthVersion[]>([]);
  const [updateVersionId, setUpdateVersionId] = useState<string | null>(null);
  const [searchingUpdateProjects, setSearchingUpdateProjects] = useState(false);
  const [loadingUpdateVersions, setLoadingUpdateVersions] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);

  const loadInstalledFiles = useCallback(async () => {
    if (!canReadFiles) return;

    setLoading(true);
    try {
      const entries: DirectoryEntry[] = [];
      let total = Number.POSITIVE_INFINITY;
      for (let pageNumber = 1; entries.length < total && pageNumber <= 100; pageNumber += 1) {
        const response = await loadDirectory(serverUuid, targetFolder, pageNumber, 'name_asc');
        entries.push(...response.entries.data);
        total = response.entries.total;
        if (response.entries.data.length === 0) break;
      }

      setFiles(
        entries
          .filter(
            (entry) =>
              entry.file &&
              !entry.directory &&
              !entry.symlink &&
              entry.name.toLowerCase().endsWith('.jar') &&
              !entry.name.includes('/') &&
              !entry.name.includes('\\'),
          )
          .map((entry) => ({ name: entry.name, size: entry.size, modified: entry.modified }))
          .sort((left, right) => left.name.localeCompare(right.name)),
      );
    } catch (error) {
      if (getHttpStatus(error) === 404) setFiles([]);
      else addToast(httpErrorToHuman(error), 'error');
    } finally {
      setLoading(false);
    }
  }, [addToast, canReadFiles, serverUuid, targetFolder]);

  useEffect(() => {
    void loadInstalledFiles();
  }, [loadInstalledFiles]);

  const filteredFiles = useMemo(() => {
    const query = search.trim().toLowerCase();
    return query ? files.filter((file) => file.name.toLowerCase().includes(query)) : files;
  }, [files, search]);
  const numericPageSize = Number(pageSize);
  const pageCount = Math.max(1, Math.ceil(filteredFiles.length / numericPageSize));
  const visibleFiles = filteredFiles.slice((page - 1) * numericPageSize, page * numericPageSize);

  const loadVersionsForProject = async (projectId: string) => {
    setUpdateProjectId(projectId);
    setUpdateVersions([]);
    setUpdateVersionId(null);
    setLoadingUpdateVersions(true);
    setUpdateError(null);
    try {
      const result = await getModrinthVersions(projectId, {
        gameVersion: gameVersion.trim() || undefined,
        loader: loader || undefined,
      });
      const supported = result.filter(getJarFile);
      setUpdateVersions(supported);
      setUpdateVersionId(supported[0]?.id ?? null);
      if (supported.length === 0) setUpdateError(t('tools.noInstallableVersions', {}));
    } catch (error) {
      setUpdateError(httpErrorToHuman(error));
    } finally {
      setLoadingUpdateVersions(false);
    }
  };

  const searchForUpdate = async (file: InstalledJar, query: string) => {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) return;

    setSearchingUpdateProjects(true);
    setUpdateError(null);
    setUpdateProjects([]);
    setUpdateProjectId(null);
    setUpdateVersions([]);
    setUpdateVersionId(null);
    try {
      const response = await searchModrinthProjects({
        query: normalizedQuery,
        projectType: kind as ModrinthProjectType,
        gameVersion: gameVersion.trim() || undefined,
        loader: loader || undefined,
        index: 'relevance',
        limit: 20,
        offset: 0,
      });
      setUpdateProjects(response.hits);
      if (response.hits.length === 0) {
        setUpdateError(t('tools.noUpdateProjects', {}));
        return;
      }

      const normalizedFile = normalizeProjectName(file.name.replace(/\.jar$/i, ''));
      const exact = response.hits.find(
        (project) =>
          normalizeProjectName(project.slug) === normalizedFile ||
          normalizeProjectName(project.title) === normalizedFile,
      );
      const match = exact ?? (response.hits.length === 1 ? response.hits[0] : null);
      if (match) await loadVersionsForProject(match.project_id);
    } catch (error) {
      setUpdateError(httpErrorToHuman(error));
    } finally {
      setSearchingUpdateProjects(false);
    }
  };

  const openUpdate = (file: InstalledJar) => {
    const query = file.name.replace(/\.jar$/i, '');
    setUpdateFile(file);
    setUpdateSearch(query);
    void searchForUpdate(file, query);
  };

  const selectedUpdateVersion = updateVersions.find((version) => version.id === updateVersionId) ?? null;
  const selectedUpdateJar = selectedUpdateVersion ? getJarFile(selectedUpdateVersion) : null;

  const performUpdate = async () => {
    if (!updateFile || !selectedUpdateJar || !socketInstance || !canInstall) return;
    if (kind === 'mod' && !serverStopped) {
      addToast(t('tools.serverMustBeOffline', {}), 'error');
      return;
    }
    if (serverBusy) {
      addToast(t('tools.serverBusy', {}), 'error');
      return;
    }
    if (!socketConnected) {
      addToast(t('tools.websocketRequired', {}), 'error');
      return;
    }

    try {
      validateModrinthDownloadUrl(selectedUpdateJar.url);
      setUpdating(true);
      const result = await installModrinthFile(serverUuid, socketInstance, targetFolder, selectedUpdateJar, {
        replaceExistingFile: updateFile.name,
      });
      if (result.cleanupFailed) addToast(t('tools.temporaryCleanupFailed', {}), 'error');
      else addToast(t('tools.installedFileUpdated', { file: updateFile.name }), 'success');
      setUpdateFile(null);
      await loadInstalledFiles();
    } catch (error) {
      addToast(
        error instanceof PanelFileOperationTimeoutError ? t('tools.operationTimedOut', {}) : httpErrorToHuman(error),
        'error',
      );
    } finally {
      setUpdating(false);
    }
  };

  const removeInstalledFile = async () => {
    if (!removeFile || !canDeleteFiles || serverBusy || (kind === 'mod' && !serverStopped)) return;

    setRemoving(true);
    try {
      await deleteFiles(serverUuid, targetFolder, [removeFile.name]);
      addToast(t('tools.installedFileRemoved', { file: removeFile.name }), 'success');
      setRemoveFile(null);
      if (detailsFile?.name === removeFile.name) setDetailsFile(null);
      await loadInstalledFiles();
    } catch (error) {
      addToast(httpErrorToHuman(error), 'error');
    } finally {
      setRemoving(false);
    }
  };

  if (!canReadFiles) {
    return <Alert color='yellow'>{t('tools.installedFilesPermissionRequired', {})}</Alert>;
  }

  return (
    <Stack gap='md'>
      {kind === 'plugin' && <Alert color='yellow'>{t('tools.pluginFileChangeRestartWarning', {})}</Alert>}
      {kind === 'mod' && !serverStopped && <Alert color='yellow'>{t('tools.serverMustBeOffline', {})}</Alert>}
      {!canInstall && <Alert color='yellow'>{t('tools.filePermissionRequired', {})}</Alert>}
      {!canDeleteFiles && <Alert color='yellow'>{t('tools.installedFilesDeletePermissionRequired', {})}</Alert>}
      {serverBusy && <Alert color='yellow'>{t('tools.serverBusy', {})}</Alert>}

      <Group justify='space-between' align='end' wrap='wrap'>
        <TextInput
          label={t('tools.searchInstalledFiles', {})}
          placeholder={t('tools.searchInstalledFilesPlaceholder', {})}
          value={search}
          onChange={(event) => {
            setSearch(event.currentTarget.value);
            setPage(1);
          }}
          leftSection={<FontAwesomeIcon icon={faMagnifyingGlass} />}
        />
        <Group align='end'>
          <Select
            label={t('tools.installedPageSize', {})}
            data={[
              { value: '24', label: '24' },
              { value: '48', label: '48' },
              { value: '96', label: '96' },
            ]}
            value={pageSize}
            onChange={(value) => {
              if (value) {
                setPageSize(value);
                setPage(1);
              }
            }}
            allowDeselect={false}
            w={120}
          />
          <Button
            variant='default'
            leftSection={<FontAwesomeIcon icon={faRotate} />}
            loading={loading}
            onClick={() => void loadInstalledFiles()}
          >
            {t('tools.refreshInstalledFiles', {})}
          </Button>
        </Group>
      </Group>

      <Group justify='space-between'>
        <Text size='sm' c='dimmed'>
          {t('tools.installedFilesTitle', { count: filteredFiles.length })}
        </Text>
        {filteredFiles.length > 0 && (
          <Text size='xs' c='dimmed'>
            {t('tools.installedFilesShowing', {
              start: (page - 1) * numericPageSize + 1,
              end: Math.min(page * numericPageSize, filteredFiles.length),
              total: filteredFiles.length,
            })}
          </Text>
        )}
      </Group>

      {loading ? (
        <Group justify='center' py='xl'>
          <Loader size='sm' />
        </Group>
      ) : visibleFiles.length === 0 ? (
        <Text size='sm' c='dimmed'>
          {t('tools.installedFilesEmpty', {})}
        </Text>
      ) : (
        <SimpleGrid cols={{ base: 1, xl: 2 }} spacing='sm'>
          {visibleFiles.map((file) => (
            <Card key={file.name} withBorder padding='md' radius='md'>
              <Stack gap='sm'>
                <Group justify='space-between' align='flex-start' wrap='nowrap'>
                  <div className='min-w-0'>
                    <Text fw={700} lineClamp={1}>
                      {file.name}
                    </Text>
                    <Group gap='xs' mt={4}>
                      <Badge size='sm' variant='light'>
                        {formatFileSize(file.size)}
                      </Badge>
                      <Text size='xs' c='dimmed'>
                        {file.modified.toLocaleDateString()}
                      </Text>
                    </Group>
                  </div>
                  <Badge variant='outline'>
                    {kind === 'plugin' ? t('tools.pluginsTitle', {}) : t('tools.modsTitle', {})}
                  </Badge>
                </Group>
                <Group gap='xs' wrap='wrap'>
                  <Button
                    size='xs'
                    variant='default'
                    leftSection={<FontAwesomeIcon icon={faCircleInfo} />}
                    onClick={() => setDetailsFile(file)}
                  >
                    {t('tools.details', {})}
                  </Button>
                  <Button
                    size='xs'
                    variant='light'
                    leftSection={<FontAwesomeIcon icon={faArrowRotateRight} />}
                    disabled={!canInstall || serverBusy || (kind === 'mod' && !serverStopped)}
                    onClick={() => openUpdate(file)}
                  >
                    {t('tools.checkForUpdate', {})}
                  </Button>
                  <Button
                    size='xs'
                    color='red'
                    variant='light'
                    leftSection={<FontAwesomeIcon icon={faTrash} />}
                    disabled={!canDeleteFiles || serverBusy || (kind === 'mod' && !serverStopped)}
                    onClick={() => setRemoveFile(file)}
                  >
                    {t('tools.removeInstalledFile', {})}
                  </Button>
                </Group>
              </Stack>
            </Card>
          ))}
        </SimpleGrid>
      )}

      {pageCount > 1 && <Pagination total={pageCount} value={page} onChange={setPage} withEdges />}

      <Modal
        opened={detailsFile !== null}
        onClose={() => setDetailsFile(null)}
        title={detailsFile?.name ?? t('tools.details', {})}
        centered
      >
        {detailsFile && (
          <Stack gap='md'>
            <Text>
              {t('tools.installedFileDetails', {
                size: formatFileSize(detailsFile.size),
                modified: detailsFile.modified.toLocaleString(),
              })}
            </Text>
            <Group justify='flex-end'>
              <Button variant='default' onClick={() => setDetailsFile(null)}>
                {t('tools.close', {})}
              </Button>
              <Button
                disabled={!canInstall || serverBusy || (kind === 'mod' && !serverStopped)}
                onClick={() => openUpdate(detailsFile)}
              >
                {t('tools.checkForUpdate', {})}
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>

      <Modal
        opened={removeFile !== null}
        onClose={() => {
          if (!removing) setRemoveFile(null);
        }}
        title={t('tools.confirmRemoveInstalledFile', {})}
        centered
      >
        {removeFile && (
          <Stack gap='md'>
            <Text>{t('tools.confirmRemoveInstalledFileDescription', { file: removeFile.name })}</Text>
            {kind === 'plugin' && <Alert color='yellow'>{t('tools.pluginFileChangeRestartWarning', {})}</Alert>}
            <Group justify='flex-end'>
              <Button variant='default' disabled={removing} onClick={() => setRemoveFile(null)}>
                {t('tools.cancel', {})}
              </Button>
              <Button color='red' loading={removing} onClick={() => void removeInstalledFile()}>
                {t('tools.removeInstalledFile', {})}
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>

      <Modal
        opened={updateFile !== null}
        onClose={() => {
          if (!updating) setUpdateFile(null);
        }}
        title={t('tools.updateInstalledFile', {})}
        size='lg'
      >
        {updateFile && (
          <Stack gap='md'>
            <Text size='sm'>{t('tools.currentInstalledFile', { file: updateFile.name })}</Text>
            <Group align='end' grow>
              <TextInput
                label={t('tools.updateProjectSearchLabel', {})}
                value={updateSearch}
                onChange={(event) => setUpdateSearch(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void searchForUpdate(updateFile, updateSearch);
                  }
                }}
              />
              <Button loading={searchingUpdateProjects} onClick={() => void searchForUpdate(updateFile, updateSearch)}>
                {t('tools.searchUpdateProjects', {})}
              </Button>
            </Group>
            {updateProjects.length > 0 && (
              <Select
                label={t('tools.updateProject', {})}
                data={updateProjects.map((project) => ({ value: project.project_id, label: project.title }))}
                value={updateProjectId}
                onChange={(value) => {
                  if (value) void loadVersionsForProject(value);
                }}
                searchable
                allowDeselect={false}
              />
            )}
            {loadingUpdateVersions && (
              <Group>
                <Loader size='xs' />
                <Text size='sm' c='dimmed'>
                  {t('tools.loadingUpdateVersions', {})}
                </Text>
              </Group>
            )}
            {updateProjects.length > 0 && updateVersions.length > 0 && (
              <Select
                label={t('tools.updateVersion', {})}
                data={updateVersions.map((version) => ({
                  value: version.id,
                  label: `${version.version_number} · ${version.game_versions[0] ?? t('tools.unspecifiedVersion', {})}`,
                }))}
                value={updateVersionId}
                onChange={setUpdateVersionId}
                searchable
                allowDeselect={false}
              />
            )}
            {updateError && <Alert color='yellow'>{updateError}</Alert>}
            {selectedUpdateVersion && (
              <Alert color='yellow'>
                {t('tools.replaceInstalledFileWarning', {
                  file: updateFile.name,
                  version: selectedUpdateVersion.version_number,
                })}
              </Alert>
            )}
            {kind === 'plugin' && <Alert color='yellow'>{t('tools.pluginFileChangeRestartWarning', {})}</Alert>}
            <Group justify='flex-end'>
              <Button variant='default' disabled={updating} onClick={() => setUpdateFile(null)}>
                {t('tools.cancel', {})}
              </Button>
              <Button
                loading={updating}
                disabled={!selectedUpdateJar || !canInstall || serverBusy || (kind === 'mod' && !serverStopped)}
                onClick={() => void performUpdate()}
              >
                {t('tools.updateInstalledFile', {})}
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </Stack>
  );
}
