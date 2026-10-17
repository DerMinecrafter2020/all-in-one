import {
  faArrowRotateRight,
  faBoxOpen,
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
import { httpErrorToHuman } from '@/api/axios.ts';
import type { Websocket } from '@/plugins/websocket/Websocket.ts';
import { useToast } from '@/providers/ToastProvider.tsx';
import type { ModrinthVersion, ModrinthVersionFile } from './api/modrinth.ts';
import { getModrinthVersions } from './api/modrinth.ts';
import type { ManagedModrinthModpack } from './api/modrinthModpacks.ts';
import {
  deleteManagedModrinthModpackFiles,
  deleteManagedModrinthModpackRecord,
  listManagedModrinthModpacks,
  saveManagedModrinthModpack,
} from './api/modrinthModpacks.ts';
import type { ModpackInstallProgress } from './api/serverFiles.ts';
import {
  installModrinthModpack,
  PanelFileOperationTimeoutError,
  validateModrinthDownloadUrl,
} from './api/serverFiles.ts';
import { useExtTranslations } from './translations.ts';

interface Props {
  serverUuid: string;
  gameVersion: string;
  canReadFiles: boolean;
  canReadFileContents: boolean;
  canDeleteFiles: boolean;
  canInstall: boolean;
  serverStopped: boolean;
  serverBusy: boolean;
  socketConnected: boolean;
  socketInstance: Websocket | null;
}

function getMrpackFile(version: ModrinthVersion): ModrinthVersionFile | null {
  const files = version.files.filter((file) => file.filename.toLowerCase().endsWith('.mrpack'));
  return files.find((file) => file.primary) ?? files[0] ?? null;
}

function safeIconUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'cdn.modrinth.com' ? url.toString() : null;
  } catch {
    return null;
  }
}

function formatFileCount(count: number): string {
  return new Intl.NumberFormat().format(count);
}

export default function InstalledModrinthModpacks({
  serverUuid,
  gameVersion,
  canReadFiles,
  canReadFileContents,
  canDeleteFiles,
  canInstall,
  serverStopped,
  serverBusy,
  socketConnected,
  socketInstance,
}: Props) {
  const { t } = useExtTranslations();
  const { addToast } = useToast();
  const [records, setRecords] = useState<ManagedModrinthModpack[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState('24');
  const [detailsRecord, setDetailsRecord] = useState<ManagedModrinthModpack | null>(null);
  const [removeRecord, setRemoveRecord] = useState<ManagedModrinthModpack | null>(null);
  const [removing, setRemoving] = useState(false);
  const [updateRecord, setUpdateRecord] = useState<ManagedModrinthModpack | null>(null);
  const [versions, setVersions] = useState<ModrinthVersion[]>([]);
  const [versionId, setVersionId] = useState<string | null>(null);
  const [loadingVersions, setLoadingVersions] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ModpackInstallProgress | null>(null);
  const progressLabels: Record<ModpackInstallProgress['stage'], string> = {
    download: t('tools.progress.download', {}),
    extract: t('tools.progress.extract', {}),
    prepare: t('tools.progress.prepare', {}),
    install: t('tools.progress.install', {}),
    cleanup: t('tools.progress.cleanup', {}),
  };

  const loadInstalledModpacks = useCallback(async () => {
    if (!canReadFiles || !canReadFileContents) return;
    setLoading(true);
    try {
      setRecords(await listManagedModrinthModpacks(serverUuid));
    } catch (error) {
      addToast(httpErrorToHuman(error), 'error');
    } finally {
      setLoading(false);
    }
  }, [addToast, canReadFileContents, canReadFiles, serverUuid]);

  useEffect(() => {
    void loadInstalledModpacks();
  }, [loadInstalledModpacks]);

  const filteredRecords = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return records;
    return records.filter((record) =>
      [record.title, record.slug, record.author, record.versionNumber].some((value) =>
        value.toLowerCase().includes(query),
      ),
    );
  }, [records, search]);
  const numericPageSize = Number(pageSize);
  const pageCount = Math.max(1, Math.ceil(filteredRecords.length / numericPageSize));
  const visibleRecords = filteredRecords.slice((page - 1) * numericPageSize, page * numericPageSize);
  const openUpdate = async (record: ManagedModrinthModpack) => {
    setDetailsRecord(null);
    setUpdateRecord(record);
    setVersions([]);
    setVersionId(null);
    setUpdateError(null);
    setLoadingVersions(true);
    try {
      const result = await getModrinthVersions(record.projectId, {
        gameVersion: gameVersion.trim() || undefined,
      });
      const supported = result.filter(getMrpackFile);
      setVersions(supported);
      setVersionId(supported[0]?.id ?? null);
      if (supported.length === 0) setUpdateError(t('tools.noInstallableVersions', {}));
    } catch (error) {
      setUpdateError(httpErrorToHuman(error));
    } finally {
      setLoadingVersions(false);
    }
  };

  const selectedVersion = versions.find((version) => version.id === versionId) ?? null;
  const selectedFile = selectedVersion ? getMrpackFile(selectedVersion) : null;

  const updateInstalledModpack = async () => {
    if (!updateRecord || !selectedVersion || !selectedFile || !socketInstance || !canInstall) return;
    if (!serverStopped) {
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
      validateModrinthDownloadUrl(selectedFile.url);
      setUpdating(true);
      setProgress({ stage: 'download', current: 0, total: 1 });
      const result = await installModrinthModpack(serverUuid, socketInstance, selectedFile, setProgress, {
        managedFiles: updateRecord.managedFiles,
        onManagedFilesCopied: async (managedFiles) => {
          await saveManagedModrinthModpack(
            serverUuid,
            { ...updateRecord, managedFiles: [...new Set([...updateRecord.managedFiles, ...managedFiles])].sort() },
            true,
          );
        },
      });

      const managedFiles = [...new Set([...updateRecord.managedFiles, ...result.managedFiles])].sort();
      const nextRecord: ManagedModrinthModpack = {
        ...updateRecord,
        versionId: selectedVersion.id,
        versionNumber: selectedVersion.version_number,
        gameVersions: selectedVersion.game_versions,
        loaders: selectedVersion.loaders,
        updatedAt: new Date().toISOString(),
        managedFiles,
      };
      await saveManagedModrinthModpack(serverUuid, nextRecord, true);

      const obsoleteFiles = updateRecord.managedFiles.filter((path) => !result.managedFiles.includes(path));
      let obsoleteCleanupFailed = false;
      if (obsoleteFiles.length > 0) {
        try {
          await deleteManagedModrinthModpackFiles(serverUuid, obsoleteFiles);
          await saveManagedModrinthModpack(serverUuid, { ...nextRecord, managedFiles: result.managedFiles }, true);
        } catch {
          obsoleteCleanupFailed = true;
        }
      }

      if (result.cleanupFailed) addToast(t('tools.temporaryCleanupFailed', {}), 'error');
      if (result.failedManagedUpdates.length > 0) {
        addToast(t('tools.modpackUpdatePartial', { count: result.failedManagedUpdates.length }), 'error');
      }
      if (obsoleteCleanupFailed) addToast(t('tools.modpackUpdatedOldFilesRemain', {}), 'error');
      if (result.failedManagedUpdates.length === 0 && !obsoleteCleanupFailed) {
        addToast(
          t('tools.modpackUpdated', { title: updateRecord.title, version: selectedVersion.version_number }),
          'success',
        );
      }
      setUpdateRecord(null);
      await loadInstalledModpacks();
    } catch (error) {
      addToast(
        error instanceof PanelFileOperationTimeoutError ? t('tools.operationTimedOut', {}) : httpErrorToHuman(error),
        'error',
      );
      await loadInstalledModpacks();
    } finally {
      setUpdating(false);
      setProgress(null);
    }
  };

  const removeInstalledModpack = async () => {
    if (!removeRecord || !canDeleteFiles || serverBusy || !serverStopped) return;
    setRemoving(true);
    try {
      await deleteManagedModrinthModpackFiles(serverUuid, removeRecord.managedFiles);
      await deleteManagedModrinthModpackRecord(serverUuid, removeRecord.projectId);
      addToast(t('tools.modpackRemoved', { title: removeRecord.title }), 'success');
      setRemoveRecord(null);
      if (detailsRecord?.projectId === removeRecord.projectId) setDetailsRecord(null);
      await loadInstalledModpacks();
    } catch (error) {
      addToast(httpErrorToHuman(error), 'error');
    } finally {
      setRemoving(false);
    }
  };

  if (!canReadFiles || !canReadFileContents) {
    return <Alert color='yellow'>{t('tools.installedModpacksPermissionRequired', {})}</Alert>;
  }

  return (
    <Stack gap='md'>
      {!serverStopped && <Alert color='yellow'>{t('tools.serverMustBeOffline', {})}</Alert>}
      {serverBusy && <Alert color='yellow'>{t('tools.serverBusy', {})}</Alert>}
      {!socketConnected && <Alert color='yellow'>{t('tools.websocketRequired', {})}</Alert>}
      {!canInstall && <Alert color='yellow'>{t('tools.filePermissionRequired', {})}</Alert>}
      {!canDeleteFiles && <Alert color='yellow'>{t('tools.installedModpackDeletePermissionRequired', {})}</Alert>}

      <Alert color='blue'>{t('tools.modpackRegistryNote', {})}</Alert>
      <Group justify='space-between' align='end' wrap='wrap'>
        <TextInput
          label={t('tools.searchInstalledModpacks', {})}
          placeholder={t('tools.searchInstalledModpacksPlaceholder', {})}
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
              { value: '12', label: '12' },
              { value: '24', label: '24' },
              { value: '48', label: '48' },
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
            onClick={() => void loadInstalledModpacks()}
          >
            {t('tools.refreshInstalledModpacks', {})}
          </Button>
        </Group>
      </Group>

      <Group justify='space-between'>
        <Text size='sm' c='dimmed'>
          {t('tools.installedModpacksTitle', { count: filteredRecords.length })}
        </Text>
        {filteredRecords.length > 0 && (
          <Text size='xs' c='dimmed'>
            {t('tools.installedFilesShowing', {
              start: (page - 1) * numericPageSize + 1,
              end: Math.min(page * numericPageSize, filteredRecords.length),
              total: filteredRecords.length,
            })}
          </Text>
        )}
      </Group>

      {loading ? (
        <Group justify='center' py='xl'>
          <Loader size='sm' />
        </Group>
      ) : visibleRecords.length === 0 ? (
        <Text size='sm' c='dimmed'>
          {t('tools.installedModpacksEmpty', {})}
        </Text>
      ) : (
        <SimpleGrid cols={{ base: 1, xl: 2 }} spacing='sm'>
          {visibleRecords.map((record) => {
            const icon = safeIconUrl(record.iconUrl);
            return (
              <Card key={record.projectId} withBorder padding='md' radius='md'>
                <Stack gap='sm'>
                  <Group align='flex-start' wrap='nowrap'>
                    {icon ? (
                      <img
                        src={icon}
                        alt=''
                        className='h-12 w-12 shrink-0 rounded object-cover'
                        referrerPolicy='no-referrer'
                      />
                    ) : (
                      <div className='flex h-12 w-12 shrink-0 items-center justify-center rounded bg-(--mantine-color-default)'>
                        <FontAwesomeIcon icon={faBoxOpen} />
                      </div>
                    )}
                    <Stack gap={4} className='min-w-0 flex-1'>
                      <Group justify='space-between' align='flex-start' wrap='nowrap'>
                        <div className='min-w-0'>
                          <Text fw={700} lineClamp={1}>
                            {record.title}
                          </Text>
                          <Text size='xs' c='dimmed'>
                            {t('tools.projectBy', { author: record.author })}
                          </Text>
                        </div>
                        <Badge variant='light'>{record.versionNumber}</Badge>
                      </Group>
                      <Group gap='xs' wrap='wrap'>
                        {record.gameVersions.slice(0, 2).map((version) => (
                          <Badge key={version} size='xs' variant='outline'>
                            {version}
                          </Badge>
                        ))}
                        {record.loaders.slice(0, 2).map((loader) => (
                          <Badge key={loader} size='xs' color='gray' variant='outline'>
                            {loader}
                          </Badge>
                        ))}
                        <Badge size='xs' color='blue' variant='light'>
                          {t('tools.managedModpackFiles', { count: formatFileCount(record.managedFiles.length) })}
                        </Badge>
                      </Group>
                    </Stack>
                  </Group>
                  <Text size='sm' c='dimmed' lineClamp={2}>
                    {record.description}
                  </Text>
                  <Group gap='xs' wrap='wrap'>
                    <Button
                      size='xs'
                      variant='default'
                      leftSection={<FontAwesomeIcon icon={faCircleInfo} />}
                      onClick={() => setDetailsRecord(record)}
                    >
                      {t('tools.details', {})}
                    </Button>
                    <Button
                      size='xs'
                      variant='light'
                      leftSection={<FontAwesomeIcon icon={faArrowRotateRight} />}
                      disabled={!canInstall || !serverStopped || serverBusy || !socketConnected}
                      onClick={() => void openUpdate(record)}
                    >
                      {t('tools.checkForModpackUpdate', {})}
                    </Button>
                    <Button
                      size='xs'
                      color='red'
                      variant='light'
                      leftSection={<FontAwesomeIcon icon={faTrash} />}
                      disabled={!canDeleteFiles || !serverStopped || serverBusy}
                      onClick={() => setRemoveRecord(record)}
                    >
                      {t('tools.removeInstalledModpack', {})}
                    </Button>
                  </Group>
                </Stack>
              </Card>
            );
          })}
        </SimpleGrid>
      )}

      {pageCount > 1 && <Pagination total={pageCount} value={page} onChange={setPage} withEdges />}

      <Modal
        opened={detailsRecord !== null}
        onClose={() => setDetailsRecord(null)}
        title={detailsRecord?.title ?? t('tools.details', {})}
        size='lg'
        centered
      >
        {detailsRecord && (
          <Stack gap='md'>
            <Text size='sm' c='dimmed'>
              {t('tools.projectBy', { author: detailsRecord.author })}
            </Text>
            <Text size='sm'>{detailsRecord.description}</Text>
            <Group gap='xs' wrap='wrap'>
              {detailsRecord.categories.map((category) => (
                <Badge key={category} size='xs' variant='outline'>
                  {category}
                </Badge>
              ))}
            </Group>
            <Text size='sm'>
              {t('tools.managedModpackDetails', {
                version: detailsRecord.versionNumber,
                count: formatFileCount(detailsRecord.managedFiles.length),
              })}
            </Text>
            <Group justify='flex-end'>
              <Button variant='default' onClick={() => setDetailsRecord(null)}>
                {t('tools.close', {})}
              </Button>
              <Button
                disabled={!canInstall || !serverStopped || serverBusy || !socketConnected}
                onClick={() => void openUpdate(detailsRecord)}
              >
                {t('tools.checkForModpackUpdate', {})}
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>

      <Modal
        opened={removeRecord !== null}
        onClose={() => {
          if (!removing) setRemoveRecord(null);
        }}
        title={t('tools.confirmRemoveInstalledModpack', {})}
        centered
        closeOnClickOutside={!removing}
        closeOnEscape={!removing}
      >
        {removeRecord && (
          <Stack gap='md'>
            <Text>
              {t('tools.confirmRemoveInstalledModpackDescription', {
                title: removeRecord.title,
                count: formatFileCount(removeRecord.managedFiles.length),
              })}
            </Text>
            <Alert color='yellow'>{t('tools.removeModpackTrackedFilesWarning', {})}</Alert>
            <Group justify='flex-end'>
              <Button variant='default' disabled={removing} onClick={() => setRemoveRecord(null)}>
                {t('tools.cancel', {})}
              </Button>
              <Button
                color='red'
                loading={removing}
                disabled={!canDeleteFiles || !serverStopped || serverBusy}
                onClick={() => void removeInstalledModpack()}
              >
                {t('tools.removeInstalledModpack', {})}
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>

      <Modal
        opened={updateRecord !== null}
        onClose={() => {
          if (!updating) setUpdateRecord(null);
        }}
        title={t('tools.updateInstalledModpack', {})}
        size='lg'
        closeOnClickOutside={!updating}
        closeOnEscape={!updating}
      >
        {updateRecord && (
          <Stack gap='md'>
            <Text size='sm'>
              {t('tools.currentInstalledModpack', {
                title: updateRecord.title,
                version: updateRecord.versionNumber,
              })}
            </Text>
            {loadingVersions ? (
              <Group>
                <Loader size='sm' />
                <Text size='sm' c='dimmed'>
                  {t('tools.loadingUpdateVersions', {})}
                </Text>
              </Group>
            ) : versions.length === 0 ? (
              <Text size='sm' c='dimmed'>
                {t('tools.noInstallableVersions', {})}
              </Text>
            ) : (
              <Select
                label={t('tools.updateModpackVersion', {})}
                data={versions.map((version) => ({ value: version.id, label: version.version_number }))}
                value={versionId}
                onChange={setVersionId}
                searchable
                allowDeselect={false}
              />
            )}
            {updateError && <Alert color='yellow'>{updateError}</Alert>}
            {selectedVersion && selectedVersion.id !== updateRecord.versionId && (
              <Alert color='yellow'>
                {t('tools.modpackUpdateWarning', {
                  title: updateRecord.title,
                  oldVersion: updateRecord.versionNumber,
                  newVersion: selectedVersion.version_number,
                })}
              </Alert>
            )}
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
              <Button variant='default' disabled={updating} onClick={() => setUpdateRecord(null)}>
                {t('tools.cancel', {})}
              </Button>
              <Button
                loading={updating}
                disabled={
                  !selectedFile ||
                  selectedVersion?.id === updateRecord.versionId ||
                  !canInstall ||
                  !serverStopped ||
                  serverBusy ||
                  !socketConnected
                }
                onClick={() => void updateInstalledModpack()}
              >
                {t('tools.updateInstalledModpack', {})}
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </Stack>
  );
}
