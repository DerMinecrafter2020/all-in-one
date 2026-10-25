import { faArrowLeft, faCube, faDownload, faRotate } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Group,
  Image,
  Loader,
  Modal,
  Select,
  SimpleGrid,
  Stack,
  Text,
  Textarea,
} from '@mantine/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import getAllEggs from '@/api/admin/nests/getAllEggs.ts';
import getFileFingerprint from '@/api/server/files/getFileFingerprint.ts';
import loadDirectory from '@/api/server/files/loadDirectory.ts';
import { getHttpStatus, httpErrorToHuman } from '@/api/axios.ts';
import { axiosInstance } from '@/api/axios.ts';
import getServerVariables from '@/api/admin/servers/variables/getServerVariables.ts';
import updateServerVariables from '@/api/admin/servers/variables/updateServerVariables.ts';
import { useAdminCan } from '@/plugins/usePermissions.ts';
import type { Websocket } from '@/plugins/websocket/Websocket.ts';
import { useToast } from '@/providers/ToastProvider.tsx';
import {
  getMinecraftVersionBuildDetails,
  getMinecraftVersionBuilds,
  getMinecraftVersionClientConfig,
  getMinecraftVersionList,
  getMinecraftVersionTypes,
  lookupMinecraftVersionFingerprint,
  recordMinecraftVersionInstall,
} from './api/minecraftVersions.ts';
import {
  applyMinecraftVersionInstall,
  discardPreparedMinecraftVersionInstall,
  prepareMinecraftVersionInstall,
  previewMinecraftVersionPlan,
  type MinecraftInstallProgress,
  type PreparedMinecraftVersionInstall,
} from './api/minecraftVersionInstall.ts';
import { PanelFileOperationTimeoutError } from './api/serverFiles.ts';
import type {
  MinecraftVersionBuild,
  MinecraftVersionListItem,
  MinecraftVersionType,
} from './lib/minecraftVersionSchemas.ts';
import { useExtTranslations } from './translations.ts';

interface ServerForVersionChanger {
  uuid: string;
  startup: string;
  image: string;
  egg: {
    uuid: string;
    name: string;
    startupCommands: Record<string, string>;
    dockerImages: Record<string, string>;
  };
}

interface Props {
  server: ServerForVersionChanger;
  serverUuid: string;
  serverState: 'offline' | 'starting' | 'stopping' | 'running';
  serverBusy: boolean;
  serverStopped: boolean;
  canReadFiles: boolean;
  canReadFileContents: boolean;
  canInstallFiles: boolean;
  canDeleteFiles: boolean;
  canArchiveFiles: boolean;
  socketConnected: boolean;
  socketInstance: Websocket | null;
}

interface ProviderGroup {
  category: string;
  types: MinecraftVersionType[];
}

interface EggChoice {
  uuid: string;
  name: string;
  startupCommands: Record<string, string>;
  dockerImages: Record<string, string>;
}

interface InstalledBuild {
  file: string;
  build: MinecraftVersionBuild;
  latest: MinecraftVersionBuild | null;
  javaVersion: number | null;
}

const DEFAULT_CATEGORY_ORDER = ['recommended', 'established', 'experimental', 'miscellaneous', 'limbos'];
const MAX_FINGERPRINT_CANDIDATES = 12;

function orderProviderGroups(
  types: Record<string, Record<string, MinecraftVersionType>>,
  configuredOrder: Array<{ category: string; types: string[] }>,
): ProviderGroup[] {
  const configuredCategories = configuredOrder.map((group) => group.category);
  const categories = [...configuredCategories, ...DEFAULT_CATEGORY_ORDER, ...Object.keys(types).sort()].filter(
    (category, index, all) => Object.hasOwn(types, category) && all.indexOf(category) === index,
  );
  const placedTypeIds = new Set<string>();

  return categories.flatMap((category) => {
    const categoryTypes = types[category];
    if (!categoryTypes) return [];
    const configured = configuredOrder.find((group) => group.category === category)?.types ?? [];
    const typeIds = [...configured, ...Object.keys(categoryTypes)].filter((providerType) => {
      if (!Object.hasOwn(categoryTypes, providerType) || placedTypeIds.has(providerType)) return false;
      placedTypeIds.add(providerType);
      return true;
    });
    return [
      {
        category,
        types: typeIds.map((identifier) => ({ ...categoryTypes[identifier], identifier })),
      },
    ];
  });
}

function safeProviderIcon(identifier: string, baseUrl: string, format: string): string | null {
  if (!/^[A-Z0-9_]{1,64}$/.test(identifier)) return null;
  try {
    const base = new URL(baseUrl);
    if (base.protocol !== 'https:' || base.hostname !== 's3.mcjars.app' || !base.pathname.endsWith('/')) return null;
    return new URL(`${identifier.toLowerCase()}.${format}`, base).toString();
  } catch {
    return null;
  }
}

function safeCandidateName(name: string): boolean {
  return Boolean(name) && name !== '.' && name !== '..' && !/[\\/:\0\r\n]/.test(name);
}

function findLauncherJarPath(files: PreparedMinecraftVersionInstall['files']): string | undefined {
  return (
    files.find((file) => file.relativePath.toLowerCase() === 'server.jar')?.relativePath ??
    files.find(
      (file) => !file.relativePath.includes('/') && /^(?:minecraft_server|server)[^/]*\.jar$/i.test(file.relativePath),
    )?.relativePath
  );
}

async function listVersionJarCandidates(serverUuid: string): Promise<string[]> {
  const candidates = new Set<string>(['/server.jar']);
  try {
    const root = await loadDirectory(serverUuid, '/', 1, 'name_asc');
    for (const entry of root.entries.data) {
      if (
        entry.file &&
        !entry.symlink &&
        safeCandidateName(entry.name) &&
        /^(?:server|minecraft_server)[^/]*\.jar$/i.test(entry.name)
      ) {
        candidates.add(`/${entry.name}`);
      }
    }
  } catch {
    // The known server.jar fingerprint remains available if listing is denied.
  }

  for (const base of ['/libraries/net/minecraftforge/forge', '/libraries/net/neoforged/neoforge']) {
    if (candidates.size >= MAX_FINGERPRINT_CANDIDATES) break;
    try {
      const versions = await loadDirectory(serverUuid, base, 1, 'name_asc');
      for (const version of versions.entries.data.slice(0, 8)) {
        if (!version.directory || version.symlink || !safeCandidateName(version.name)) continue;
        const directory = `${base}/${version.name}`;
        const files = await loadDirectory(serverUuid, directory, 1, 'name_asc');
        for (const file of files.entries.data) {
          if (
            file.file &&
            !file.symlink &&
            safeCandidateName(file.name) &&
            /-(?:server|universal)\.jar$/i.test(file.name)
          ) {
            candidates.add(`${directory}/${file.name}`);
            if (candidates.size >= MAX_FINGERPRINT_CANDIDATES) break;
          }
        }
        if (candidates.size >= MAX_FINGERPRINT_CANDIDATES) break;
      }
    } catch {
      // Loader-specific libraries are optional.
    }
  }

  return [...candidates].slice(0, MAX_FINGERPRINT_CANDIDATES);
}

async function findInstalledVersion(serverUuid: string): Promise<InstalledBuild | null> {
  for (const path of await listVersionJarCandidates(serverUuid)) {
    try {
      const fingerprint = await getFileFingerprint(serverUuid, path, 'sha256');
      const response = await lookupMinecraftVersionFingerprint(serverUuid, fingerprint);
      if (response.build) {
        return {
          file: path,
          build: response.build,
          latest: response.latest ?? null,
          javaVersion: response.version?.java ?? null,
        };
      }
    } catch (error) {
      if (getHttpStatus(error) !== 404) throw error;
    }
  }
  return null;
}

function chooseJavaImage(egg: EggChoice, javaVersion: number | null, fallbackImage: string): string | null {
  const images = Object.entries(egg.dockerImages);
  if (!images.length) return null;
  if (javaVersion !== null) {
    const matchingImage = images.find(([label, image]) => {
      const text = `${label} ${image}`.replace(/[_-]+/g, ' ');
      return [...text.matchAll(/(?:java|jdk|jre)\s*(\d{1,2})/gi)].some((match) => Number(match[1]) === javaVersion);
    });
    if (matchingImage) return matchingImage[1];
    return null;
  }
  return images.find(([, image]) => image === fallbackImage)?.[1] ?? null;
}

export default function MinecraftVersionChanger({
  server,
  serverUuid,
  serverState,
  serverBusy,
  serverStopped,
  canReadFiles,
  canReadFileContents,
  canInstallFiles,
  canDeleteFiles,
  canArchiveFiles,
  socketConnected,
  socketInstance,
}: Props) {
  const { t: translate } = useExtTranslations();
  const t = useCallback(
    (key: string, values: Record<string, string | number> = {}) =>
      translate(
        (key.startsWith('versionChanger.') ? `tools.${key}` : key) as Parameters<typeof translate>[0],
        values as Parameters<typeof translate>[1],
      ),
    [translate],
  );
  const { addToast } = useToast();
  const [loadingTypes, setLoadingTypes] = useState(true);
  const [typeLoadError, setTypeLoadError] = useState<string | null>(null);
  const [groups, setGroups] = useState<ProviderGroup[]>([]);
  const [clientConfig, setClientConfig] = useState<Awaited<ReturnType<typeof getMinecraftVersionClientConfig>> | null>(
    null,
  );
  const [selectedType, setSelectedType] = useState<string | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null);
  const [showSnapshots, setShowSnapshots] = useState(false);
  const [versions, setVersions] = useState<MinecraftVersionListItem[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [builds, setBuilds] = useState<MinecraftVersionBuild[]>([]);
  const [buildsLoading, setBuildsLoading] = useState(false);
  const [selectedBuildId, setSelectedBuildId] = useState<number | null>(null);
  const [installed, setInstalled] = useState<InstalledBuild | null>(null);
  const [installedLoading, setInstalledLoading] = useState(false);
  const [installDetails, setInstallDetails] = useState<Awaited<
    ReturnType<typeof getMinecraftVersionBuildDetails>
  > | null>(null);
  const [installModalOpen, setInstallModalOpen] = useState(false);
  const [preparingInstall, setPreparingInstall] = useState(false);
  const [applyingInstall, setApplyingInstall] = useState(false);
  const [preparedInstall, setPreparedInstall] = useState<PreparedMinecraftVersionInstall | null>(null);
  const [progress, setProgress] = useState<MinecraftInstallProgress | null>(null);
  const [replaceLauncherFiles, setReplaceLauncherFiles] = useState(false);
  const [acceptEula, setAcceptEula] = useState(false);
  const [installSummary, setInstallSummary] = useState<string | null>(null);
  const [installWarning, setInstallWarning] = useState(false);
  const [installTimedOut, setInstallTimedOut] = useState(false);
  const [eggChoices, setEggChoices] = useState<EggChoice[]>([]);
  const [eggChoicesLoading, setEggChoicesLoading] = useState(false);
  const [eggChoicesFailed, setEggChoicesFailed] = useState(false);
  const [eggChangeApplied, setEggChangeApplied] = useState(false);
  const canReadEggCatalog = useAdminCan('nests.read');
  const canUpdateServerSettings = useAdminCan(['servers.read', 'servers.update'], false);
  const canUpdateServerVariables = useAdminCan(['servers.read', 'servers.variables'], false);
  const canChangeServerEgg = canReadEggCatalog && canUpdateServerSettings && canUpdateServerVariables;
  const preparedRef = useRef<PreparedMinecraftVersionInstall | null>(null);
  const aliveRef = useRef(true);

  const selectedBuild = builds.find((build) => build.id === selectedBuildId) ?? null;
  const selectedProviderType = selectedType
    ? (groups.flatMap((group) => group.types).find((providerType) => providerType.identifier === selectedType) ?? null)
    : null;
  const selectedEggOverride =
    clientConfig?.eggOverrides.find((mapping) => mapping.providerType === selectedType) ?? null;
  const mappedEgg = selectedEggOverride
    ? (eggChoices.find((choice) => choice.uuid === selectedEggOverride.eggUuid) ?? null)
    : null;
  const eggMustChange = Boolean(selectedEggOverride && selectedEggOverride.eggUuid !== server.egg.uuid);
  const installTargetEgg = eggMustChange ? mappedEgg : server.egg;
  const installTargetJavaImage =
    installDetails && installTargetEgg
      ? chooseJavaImage(installTargetEgg, installDetails.version?.java ?? null, server.image)
      : null;
  const lacksEggPermission =
    eggMustChange && (!canChangeServerEgg || eggChoicesLoading || !mappedEgg || eggChoicesFailed);
  const planSummary = useMemo(() => {
    if (!installDetails) return null;
    try {
      return previewMinecraftVersionPlan(installDetails.build.installation);
    } catch {
      return null;
    }
  }, [installDetails]);
  const hasReplacementChanges = Boolean(
    preparedInstall && (preparedInstall.conflicts.length > 0 || preparedInstall.removePaths.length > 0),
  );
  const serverIsOffline = serverState === 'offline' && serverStopped;
  const canInstall =
    canInstallFiles &&
    canDeleteFiles &&
    canReadFileContents &&
    serverIsOffline &&
    !serverBusy &&
    socketConnected &&
    Boolean(socketInstance) &&
    !lacksEggPermission;

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      const prepared = preparedRef.current;
      if (prepared) void discardPreparedMinecraftVersionInstall(serverUuid, prepared).catch(() => undefined);
    };
  }, [serverUuid]);

  useEffect(() => {
    let active = true;
    setLoadingTypes(true);
    Promise.all([getMinecraftVersionTypes(serverUuid), getMinecraftVersionClientConfig(serverUuid)])
      .then(([typeResponse, config]) => {
        if (!active) return;
        setClientConfig(config);
        setGroups(orderProviderGroups(typeResponse.types, config.typeOrder));
        setTypeLoadError(null);
      })
      .catch((error) => {
        if (active) {
          setGroups([]);
          setTypeLoadError(httpErrorToHuman(error));
        }
      })
      .finally(() => {
        if (active) setLoadingTypes(false);
      });
    return () => {
      active = false;
    };
  }, [serverUuid]);

  useEffect(() => {
    if (!canReadEggCatalog) {
      setEggChoices([]);
      setEggChoicesFailed(false);
      setEggChoicesLoading(false);
      return;
    }
    let active = true;
    setEggChoicesLoading(true);
    getAllEggs()
      .then((nests) => {
        if (!active) return;
        setEggChoices(
          nests.flatMap((nest) =>
            nest.eggs.map((egg) => ({
              uuid: egg.uuid,
              name: egg.name,
              startupCommands: egg.startupCommands,
              dockerImages: egg.dockerImages,
            })),
          ),
        );
        setEggChoicesFailed(false);
      })
      .catch(() => {
        if (active) setEggChoicesFailed(true);
      })
      .finally(() => {
        if (active) setEggChoicesLoading(false);
      });
    return () => {
      active = false;
    };
  }, [canReadEggCatalog]);

  useEffect(() => {
    if (!selectedType) {
      setVersions([]);
      setSelectedVersion(null);
      setBuilds([]);
      setSelectedBuildId(null);
      return;
    }
    let active = true;
    setVersionsLoading(true);
    setVersions([]);
    setSelectedVersion(null);
    setBuilds([]);
    setSelectedBuildId(null);
    getMinecraftVersionList(serverUuid, selectedType)
      .then((response) => {
        if (!active) return;
        const items = Object.entries(response.builds).map(([version, item]) => ({ ...item, version }));
        items.sort((left, right) => right.version.localeCompare(left.version, undefined, { numeric: true }));
        setVersions(items);
      })
      .catch((error) => {
        if (active) addToast(httpErrorToHuman(error), 'error');
      })
      .finally(() => {
        if (active) setVersionsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [addToast, selectedType, serverUuid]);

  useEffect(() => {
    if (!selectedType || !selectedVersion) {
      setBuilds([]);
      setSelectedBuildId(null);
      return;
    }
    let active = true;
    setBuildsLoading(true);
    setBuilds([]);
    setSelectedBuildId(null);
    getMinecraftVersionBuilds(serverUuid, selectedType, selectedVersion)
      .then((response) => {
        if (!active) return;
        setBuilds(response.builds);
        const preferred = response.builds.find((build) => !build.experimental) ?? response.builds[0];
        setSelectedBuildId(preferred?.id ?? null);
      })
      .catch((error) => {
        if (active) addToast(httpErrorToHuman(error), 'error');
      })
      .finally(() => {
        if (active) setBuildsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [addToast, selectedType, selectedVersion, serverUuid]);

  useEffect(() => {
    if (!canReadFiles || !canReadFileContents) {
      setInstalledLoading(false);
      return;
    }
    let active = true;
    setInstalledLoading(true);
    setInstalled(null);
    void findInstalledVersion(serverUuid)
      .then((result) => {
        if (active) setInstalled(result);
      })
      .catch(() => {
        if (active) setInstalled(null);
      })
      .finally(() => {
        if (active) setInstalledLoading(false);
      });
    return () => {
      active = false;
    };
  }, [canReadFileContents, canReadFiles, serverUuid]);

  const openInstallReview = async () => {
    if (!selectedBuild || !selectedType) return;
    if (!canInstallFiles || !canDeleteFiles) {
      addToast(t('versionChanger.permissionRequired', {}), 'error');
      return;
    }
    if (!serverIsOffline || serverBusy) {
      addToast(t('versionChanger.serverMustBeOffline', {}), 'error');
      return;
    }
    if (!socketConnected || !socketInstance) {
      addToast(t('tools.websocketRequired', {}), 'error');
      return;
    }
    if (lacksEggPermission) {
      addToast(t('versionChanger.eggChangePermissionRequired', {}), 'error');
      return;
    }
    setPreparingInstall(true);
    setInstallDetails(null);
    setInstallSummary(null);
    setInstallWarning(false);
    setEggChangeApplied(false);
    try {
      const details = await getMinecraftVersionBuildDetails(serverUuid, selectedBuild.id);
      if (!details.build.installation) throw new Error(t('versionChanger.installPlanUnavailable', {}));
      previewMinecraftVersionPlan(details.build.installation);
      const changesEgg = Boolean(selectedEggOverride && selectedEggOverride.eggUuid !== server.egg.uuid);
      const targetEgg = changesEgg ? mappedEgg : server.egg;
      if (changesEgg && (!canChangeServerEgg || !targetEgg)) {
        throw new Error(t('versionChanger.eggChangePermissionRequired', {}));
      }
      if (!targetEgg) throw new Error(t('versionChanger.eggOverrideUnavailable', {}));
      if (changesEgg && !Object.values(targetEgg.startupCommands)[0]) {
        throw new Error(t('versionChanger.targetEggInvalid', {}));
      }
      if (changesEgg) await getServerVariables(serverUuid);
      const targetImage = chooseJavaImage(targetEgg, details.version?.java ?? null, server.image);
      if (!targetImage) {
        throw new Error(t('versionChanger.targetJavaImageMissing', { java: details.version?.java ?? '—' }));
      }
      if (targetImage !== server.image && !canUpdateServerSettings) {
        throw new Error(t('versionChanger.serverUpdatePermissionRequired', {}));
      }
      if (canUpdateServerVariables) await getServerVariables(serverUuid);
      setInstallDetails(details);
      setAcceptEula(false);
      setReplaceLauncherFiles(false);
      setPreparedInstall(null);
      preparedRef.current = null;
      setInstallModalOpen(true);
    } catch (error) {
      addToast(error instanceof Error ? error.message : httpErrorToHuman(error), 'error');
    } finally {
      setPreparingInstall(false);
    }
  };

  const prepareInstall = async () => {
    if (!installDetails || !socketInstance) return;
    if (!canInstallFiles || !canDeleteFiles || !serverIsOffline || serverBusy || !socketConnected) {
      addToast(t('versionChanger.permissionOrStateChanged', {}), 'error');
      return;
    }
    setPreparingInstall(true);
    setProgress(null);
    try {
      const prepared = await prepareMinecraftVersionInstall(
        serverUuid,
        socketInstance,
        installDetails.build.installation,
        canArchiveFiles,
        setProgress,
      );
      if (!aliveRef.current) {
        await discardPreparedMinecraftVersionInstall(serverUuid, prepared);
        return;
      }
      preparedRef.current = prepared;
      setPreparedInstall(prepared);
      setReplaceLauncherFiles(false);
    } catch (error) {
      if (error instanceof PanelFileOperationTimeoutError) {
        setInstallTimedOut(true);
        addToast(t('tools.operationTimedOut', {}), 'error');
      } else addToast(error instanceof Error ? error.message : httpErrorToHuman(error), 'error');
    } finally {
      setPreparingInstall(false);
      setProgress(null);
    }
  };

  const cancelInstall = async () => {
    if (preparingInstall || applyingInstall) return;
    const prepared = preparedInstall;
    preparedRef.current = null;
    setPreparedInstall(null);
    setInstallModalOpen(false);
    setInstallDetails(null);
    if (prepared) {
      try {
        await discardPreparedMinecraftVersionInstall(serverUuid, prepared);
      } catch {
        addToast(t('versionChanger.stageCleanupFailed', {}), 'error');
      }
    }
  };

  const applyServerConfiguration = async (
    prepared: PreparedMinecraftVersionInstall,
    buildDetails: Awaited<ReturnType<typeof getMinecraftVersionBuildDetails>>,
  ): Promise<boolean> => {
    if (!selectedType || !clientConfig) return false;
    const override = clientConfig.eggOverrides.find((entry) => entry.providerType === selectedType);
    const changesEgg = Boolean(override && override.eggUuid !== server.egg.uuid);
    const targetEgg: EggChoice | ServerForVersionChanger['egg'] = changesEgg ? mappedEgg! : server.egg;
    if (changesEgg && (!override || !canChangeServerEgg || !mappedEgg)) {
      throw new Error(t('versionChanger.eggChangePermissionRequired', {}));
    }

    const targetStartup = changesEgg ? Object.values(targetEgg.startupCommands)[0] : server.startup;
    if (!targetStartup) throw new Error(t('versionChanger.targetEggInvalid', {}));
    const currentDefaults = Object.values(server.egg.startupCommands);
    const startup = changesEgg && currentDefaults.includes(server.startup) ? targetStartup : server.startup;
    const image = chooseJavaImage(targetEgg, buildDetails.version?.java ?? null, server.image);
    if (!image)
      throw new Error(t('versionChanger.targetJavaImageMissing', { java: buildDetails.version?.java ?? '—' }));
    const changesImage = image !== server.image;
    const changesStartup = startup !== server.startup;
    const changesServerFields = changesEgg || changesImage || changesStartup;
    if (changesServerFields && !canUpdateServerSettings) {
      throw new Error(t('versionChanger.serverUpdatePermissionRequired', {}));
    }

    const launcherJar = findLauncherJarPath(prepared.files);

    let serverFieldsUpdated = false;
    let launcherVariable: Awaited<ReturnType<typeof getServerVariables>>[number] | undefined;
    let launcherVariableUpdateAttempted = false;
    try {
      if (changesServerFields) {
        await axiosInstance.patch(`/api/admin/servers/${serverUuid}`, {
          ...(changesEgg ? { egg_uuid: override?.eggUuid } : {}),
          ...(changesStartup ? { startup } : {}),
          ...(changesImage ? { image } : {}),
        });
        serverFieldsUpdated = true;
      }

      if (launcherJar && canUpdateServerVariables) {
        const variables = await getServerVariables(serverUuid);
        launcherVariable = variables.find((variable) => variable.envVariable === 'SERVER_JARFILE');
        if (launcherVariable && launcherVariable.value !== launcherJar) {
          launcherVariableUpdateAttempted = true;
          await updateServerVariables(serverUuid, [{ envVariable: 'SERVER_JARFILE', value: launcherJar }]);
        }
      }
    } catch (error) {
      let rollbackFailed = false;
      if (launcherVariableUpdateAttempted && launcherVariable) {
        try {
          await updateServerVariables(serverUuid, [{ envVariable: 'SERVER_JARFILE', value: launcherVariable.value }]);
        } catch {
          rollbackFailed = true;
        }
      }
      try {
        if (serverFieldsUpdated) {
          await axiosInstance.patch(`/api/admin/servers/${serverUuid}`, {
            egg_uuid: server.egg.uuid,
            startup: server.startup,
            image: server.image,
          });
        }
      } catch {
        rollbackFailed = true;
      }
      if (rollbackFailed) throw new Error(t('versionChanger.eggRollbackFailed', {}));
      throw error;
    }
    return serverFieldsUpdated || launcherVariableUpdateAttempted;
  };

  const applyInstall = async () => {
    if (!preparedInstall || !installDetails || !socketInstance || !selectedType || !selectedVersion) return;
    if (!canInstallFiles || !canDeleteFiles || !serverIsOffline || serverBusy || !socketConnected) {
      addToast(t('versionChanger.permissionOrStateChanged', {}), 'error');
      return;
    }
    if (hasReplacementChanges && !replaceLauncherFiles) {
      addToast(t('versionChanger.confirmReplaceRequired', {}), 'error');
      return;
    }

    const prepared = preparedInstall;
    preparedRef.current = null;
    setPreparedInstall(null);
    setApplyingInstall(true);
    setProgress(null);
    try {
      const fileResult = await applyMinecraftVersionInstall(
        serverUuid,
        socketInstance,
        prepared,
        replaceLauncherFiles,
        acceptEula,
        setProgress,
      );
      let serverConfigurationUpdated = false;
      let configurationUpdateFailed = false;
      try {
        serverConfigurationUpdated = await applyServerConfiguration(prepared, installDetails);
      } catch (error) {
        configurationUpdateFailed = true;
        setInstallWarning(true);
        setInstallSummary(t('versionChanger.filesInstalledEggUpdateFailed', {}));
        addToast(error instanceof Error ? error.message : httpErrorToHuman(error), 'error');
      }
      try {
        await recordMinecraftVersionInstall(serverUuid, selectedType, selectedVersion);
      } catch {
        // Local statistics are optional and must never block a completed server install.
      }
      if (fileResult.cleanupFailed) addToast(t('tools.temporaryCleanupFailed', {}), 'error');
      else if (!configurationUpdateFailed) addToast(t('versionChanger.installComplete', {}), 'success');
      setEggChangeApplied(serverConfigurationUpdated);
      if (serverConfigurationUpdated) setInstallSummary(t('versionChanger.installCompleteReload', {}));
      setInstallModalOpen(false);
      setInstallDetails(null);
      if (!configurationUpdateFailed && !serverConfigurationUpdated) {
        setInstallSummary(t('versionChanger.installComplete', {}));
      }
      await refreshInstalledBuild();
    } catch (error) {
      setInstallWarning(true);
      setInstallSummary(t('versionChanger.installFailedReview', {}));
      if (error instanceof PanelFileOperationTimeoutError) {
        setInstallTimedOut(true);
        addToast(t('tools.operationTimedOut', {}), 'error');
      } else addToast(error instanceof Error ? error.message : httpErrorToHuman(error), 'error');
    } finally {
      setApplyingInstall(false);
      setProgress(null);
    }
  };

  const visibleVersions = versions.filter((version) => showSnapshots || version.type !== 'SNAPSHOT');
  const installDisabled = !selectedBuild || !canInstall || preparingInstall || applyingInstall || installTimedOut;

  return (
    <Stack gap='md'>
      <Text size='sm' c='dimmed'>
        {t('versionChanger.description', {})}
      </Text>
      <Text size='xs' c='dimmed'>
        {t('versionChanger.providerPrivacyNotice', {})}
      </Text>
      <Text size='xs' c='dimmed'>
        {t('versionChanger.iconPrivacyNotice', {})}
      </Text>
      {!canInstallFiles && <Alert color='yellow'>{t('versionChanger.permissionRequired', {})}</Alert>}
      {!canReadFileContents && <Alert color='yellow'>{t('versionChanger.fingerprintPermissionRequired', {})}</Alert>}
      {!serverIsOffline && <Alert color='yellow'>{t('versionChanger.serverMustBeOffline', {})}</Alert>}
      {serverBusy && <Alert color='yellow'>{t('tools.serverBusy', {})}</Alert>}
      {!socketConnected && <Alert color='yellow'>{t('tools.websocketRequired', {})}</Alert>}
      {installTimedOut && <Alert color='yellow'>{t('tools.operationTimedOut', {})}</Alert>}
      {installSummary && <Alert color={installWarning ? 'yellow' : 'green'}>{installSummary}</Alert>}
      {eggChangeApplied && <Alert color='blue'>{t('versionChanger.reloadAfterEggChange', {})}</Alert>}

      <Card withBorder padding='md' radius='md'>
        <Stack gap='sm'>
          <Group justify='space-between'>
            <Text fw={600}>{t('versionChanger.installedVersionTitle', {})}</Text>
            <Button
              size='xs'
              variant='subtle'
              leftSection={<FontAwesomeIcon icon={faRotate} />}
              loading={installedLoading}
              disabled={!canReadFiles || !canReadFileContents || installedLoading}
              onClick={() => void refreshInstalledBuild()}
            >
              {t('versionChanger.refreshInstalled', {})}
            </Button>
          </Group>
          {installedLoading ? (
            <Group gap='xs'>
              <Loader size='xs' />
              <Text size='sm' c='dimmed'>
                {t('versionChanger.detectingInstalled', {})}
              </Text>
            </Group>
          ) : installed ? (
            <Stack gap={4}>
              <Text fw={600}>
                {installed.build.type}{' '}
                {installed.build.versionId ?? installed.build.projectVersionId ?? installed.build.name}
              </Text>
              <Text size='sm' c='dimmed'>
                {t('versionChanger.detectedFromFile', { file: installed.file })}
              </Text>
              {installed.latest && installed.latest.id !== installed.build.id && (
                <Alert color='yellow'>
                  {t('versionChanger.newerBuildAvailable', { build: installed.latest.name })}
                </Alert>
              )}
            </Stack>
          ) : (
            <Text size='sm' c='dimmed'>
              {t('versionChanger.installedNotDetected', {})}
            </Text>
          )}
        </Stack>
      </Card>

      {loadingTypes ? (
        <Group justify='center' py='md'>
          <Loader size='sm' />
          <Text size='sm' c='dimmed'>
            {t('versionChanger.loadingTypes', {})}
          </Text>
        </Group>
      ) : typeLoadError ? (
        <Alert color='red'>{typeLoadError}</Alert>
      ) : selectedType ? (
        <Card withBorder padding='md' radius='md'>
          <Stack gap='md'>
            <Group justify='space-between' align='end'>
              <div>
                <Text fw={700}>{selectedProviderType?.name ?? selectedType}</Text>
                <Text size='xs' c='dimmed'>
                  {selectedProviderType?.description}
                </Text>
              </div>
              <Button
                variant='subtle'
                leftSection={<FontAwesomeIcon icon={faArrowLeft} />}
                onClick={() => setSelectedType(null)}
              >
                {t('versionChanger.backToTypes', {})}
              </Button>
            </Group>
            {selectedEggOverride && (
              <Alert color={eggMustChange ? (canChangeServerEgg && mappedEgg ? 'blue' : 'yellow') : 'green'}>
                {eggMustChange
                  ? mappedEgg
                    ? t('versionChanger.eggOverrideNotice', { egg: mappedEgg.name })
                    : t('versionChanger.eggOverrideUnavailable', {})
                  : t('versionChanger.eggOverrideCurrent', { egg: mappedEgg?.name ?? server.egg.name })}
              </Alert>
            )}
            {eggMustChange && !canChangeServerEgg && (
              <Alert color='yellow'>{t('versionChanger.eggChangePermissionRequired', {})}</Alert>
            )}
            {eggMustChange && canChangeServerEgg && eggChoicesFailed && (
              <Alert color='yellow'>{t('versionChanger.eggListPermissionRequired', {})}</Alert>
            )}
            <Group grow align='end'>
              <Select
                label={t('versionChanger.selectVersion', {})}
                placeholder={
                  versionsLoading ? t('versionChanger.loadingVersions', {}) : t('versionChanger.chooseVersion', {})
                }
                data={visibleVersions.map((item) => ({
                  value: item.version,
                  label: `${item.version}${item.type === 'SNAPSHOT' ? ` · ${t('versionChanger.snapshot', {})}` : ''} · ${item.builds}`,
                }))}
                value={selectedVersion}
                onChange={(value) => setSelectedVersion(value)}
                searchable
                disabled={versionsLoading || visibleVersions.length === 0}
              />
              {versions.some((version) => version.type === 'SNAPSHOT') && (
                <Checkbox
                  label={t('versionChanger.showSnapshots', {})}
                  checked={showSnapshots}
                  onChange={(event) => {
                    const nextShowSnapshots = event.currentTarget.checked;
                    setShowSnapshots(nextShowSnapshots);
                    if (
                      !nextShowSnapshots &&
                      selectedVersion &&
                      versions.find((version) => version.version === selectedVersion)?.type === 'SNAPSHOT'
                    ) {
                      setSelectedVersion(null);
                    }
                  }}
                />
              )}
              <Select
                label={t('versionChanger.selectBuild', {})}
                placeholder={
                  buildsLoading ? t('versionChanger.loadingBuilds', {}) : t('versionChanger.chooseBuild', {})
                }
                data={builds.map((build) => ({
                  value: String(build.id),
                  label: `${build.name}${build.experimental ? ` · ${t('versionChanger.experimental', {})}` : ''}`,
                }))}
                value={selectedBuildId === null ? null : String(selectedBuildId)}
                onChange={(value) => setSelectedBuildId(value ? Number(value) : null)}
                searchable
                disabled={buildsLoading || builds.length === 0}
              />
            </Group>
            {selectedBuild?.experimental && <Alert color='yellow'>{t('versionChanger.experimentalWarning', {})}</Alert>}
            <Group justify='flex-end'>
              <Button
                leftSection={<FontAwesomeIcon icon={faDownload} />}
                loading={preparingInstall}
                disabled={installDisabled}
                onClick={() => void openInstallReview()}
              >
                {t('versionChanger.reviewInstall', {})}
              </Button>
            </Group>
          </Stack>
        </Card>
      ) : (
        <Stack gap='md'>
          {groups.map((group) => (
            <div key={group.category}>
              <Group gap='sm' mb='xs'>
                <Text size='sm' fw={600} c='dimmed'>
                  {group.category}
                </Text>
                <div className='flex-1 border-b border-gray-700' />
              </Group>
              <SimpleGrid cols={{ base: 1, sm: 2, xl: 3 }} spacing='sm'>
                {group.types.map((providerType) => (
                  <Card
                    key={providerType.identifier}
                    withBorder
                    padding='sm'
                    radius='md'
                    className='cursor-pointer transition-colors hover:bg-gray-700/50'
                    onClick={() => setSelectedType(providerType.identifier!)}
                  >
                    <Group wrap='nowrap' align='flex-start'>
                      {clientConfig &&
                      safeProviderIcon(
                        providerType.identifier ?? '',
                        clientConfig.iconBaseUrl,
                        clientConfig.iconFormat,
                      ) ? (
                        <Image
                          src={
                            safeProviderIcon(
                              providerType.identifier ?? '',
                              clientConfig.iconBaseUrl,
                              clientConfig.iconFormat,
                            ) ?? undefined
                          }
                          alt=''
                          w={48}
                          h={48}
                          radius='sm'
                          referrerPolicy='no-referrer'
                        />
                      ) : (
                        <FontAwesomeIcon icon={faCube} aria-hidden='true' />
                      )}
                      <Stack gap={2} className='min-w-0 flex-1'>
                        <Group gap='xs'>
                          <Text fw={600}>{providerType.name}</Text>
                          {providerType.experimental && (
                            <Badge size='xs' color='yellow'>
                              {t('versionChanger.experimental', {})}
                            </Badge>
                          )}
                          {providerType.deprecated && (
                            <Badge size='xs' color='red'>
                              {t('versionChanger.deprecated', {})}
                            </Badge>
                          )}
                        </Group>
                        <Text size='xs' c='dimmed' lineClamp={2}>
                          {providerType.description}
                        </Text>
                        <Text size='xs' c='dimmed'>
                          {t('versionChanger.typeBuildCounts', {
                            minecraft: providerType.versions.minecraft,
                            project: providerType.versions.project,
                            builds: providerType.builds,
                          })}
                        </Text>
                      </Stack>
                    </Group>
                  </Card>
                ))}
              </SimpleGrid>
            </div>
          ))}
        </Stack>
      )}

      <Modal
        opened={installModalOpen}
        onClose={() => void cancelInstall()}
        title={t('versionChanger.confirmInstallTitle', {})}
        centered
        size='lg'
        closeOnClickOutside={!preparingInstall && !applyingInstall}
        closeOnEscape={!preparingInstall && !applyingInstall}
      >
        {installDetails && planSummary && (
          <Stack gap='md'>
            {installWarning && (
              <Alert color='yellow'>{installSummary ?? t('versionChanger.installFailedReview', {})}</Alert>
            )}
            <Text>
              {t('versionChanger.confirmInstallDescription', {
                type: selectedProviderType?.name ?? selectedType ?? '',
                version: selectedVersion ?? '',
                build: installDetails.build.name,
              })}
            </Text>
            {installDetails.build.experimental && (
              <Alert color='yellow'>{t('versionChanger.experimentalWarning', {})}</Alert>
            )}
            {planSummary.usesArchives && !canArchiveFiles && (
              <Alert color='yellow'>{t('versionChanger.archivePermissionRequired', {})}</Alert>
            )}
            {eggMustChange && mappedEgg && (
              <Alert color='blue'>{t('versionChanger.eggChangeConfirmation', { egg: mappedEgg.name })}</Alert>
            )}
            {!selectedEggOverride && (
              <Alert color='yellow'>{t('versionChanger.noEggOverrideNotice', { egg: server.egg.name })}</Alert>
            )}
            {installTargetJavaImage && installTargetJavaImage !== server.image && (
              <Alert color='blue'>{t('versionChanger.javaImageConfirmation', { image: installTargetJavaImage })}</Alert>
            )}
            <Alert color='yellow'>{t('versionChanger.preserveUserDataNotice', {})}</Alert>
            <Text size='sm' fw={600}>
              {t('versionChanger.planSummaryTitle', {})}
            </Text>
            <Text size='xs' c='dimmed'>
              {t('versionChanger.downloadSteps', { files: planSummary.downloads.join(', ') || '—' })}
            </Text>
            {planSummary.removals.length > 0 && (
              <Alert color='orange'>
                {t('versionChanger.removeSteps', { paths: planSummary.removals.join(', ') })}
              </Alert>
            )}
            <Checkbox
              label={t('versionChanger.acceptEula', {})}
              checked={acceptEula}
              disabled={preparingInstall || applyingInstall}
              onChange={(event) => setAcceptEula(event.currentTarget.checked)}
            />
            {progress && (preparingInstall || applyingInstall) && (
              <Group gap='xs'>
                <Loader size='xs' />
                <Text size='sm'>
                  {t(`versionChanger.progress.${progress.stage}`, { current: progress.current, total: progress.total })}
                </Text>
              </Group>
            )}
            {preparedInstall && (
              <Stack gap='xs'>
                <Text size='sm' fw={600}>
                  {t('versionChanger.preparedFileCount', {
                    count: preparedInstall.files.length,
                    size: preparedInstall.totalBytes,
                  })}
                </Text>
                {canUpdateServerVariables && findLauncherJarPath(preparedInstall.files) && (
                  <Text size='xs' c='dimmed'>
                    {t('versionChanger.launcherVariableConfirmation', {})}
                  </Text>
                )}
                {!canUpdateServerVariables &&
                  server.startup.includes('SERVER_JARFILE') &&
                  findLauncherJarPath(preparedInstall.files) && (
                    <Alert color='yellow'>{t('versionChanger.launcherVariablePermissionMissing', {})}</Alert>
                  )}
                {preparedInstall.removePaths.length > 0 && (
                  <Alert color='orange'>
                    {t('versionChanger.libraryReplacementNotice', { paths: preparedInstall.removePaths.join(', ') })}
                  </Alert>
                )}
                {preparedInstall.conflicts.length > 0 && (
                  <Alert color='yellow'>
                    <Text size='sm' mb='xs'>
                      {t('versionChanger.conflictsFound', { count: preparedInstall.conflicts.length })}
                    </Text>
                    <Textarea
                      aria-label={t('versionChanger.conflictPathsLabel', {})}
                      value={preparedInstall.conflicts.join('\n')}
                      readOnly
                      minRows={3}
                      maxRows={10}
                      autosize
                      spellCheck={false}
                    />
                  </Alert>
                )}
                <Checkbox
                  label={t('versionChanger.replaceLauncherFiles', {})}
                  description={t('versionChanger.replaceLauncherFilesDescription', {})}
                  checked={replaceLauncherFiles}
                  disabled={
                    preparingInstall ||
                    applyingInstall ||
                    (!preparedInstall.conflicts.length && !preparedInstall.removePaths.length)
                  }
                  onChange={(event) => setReplaceLauncherFiles(event.currentTarget.checked)}
                />
              </Stack>
            )}
            <Group justify='flex-end'>
              <Button
                variant='default'
                disabled={preparingInstall || applyingInstall}
                onClick={() => void cancelInstall()}
              >
                {t('tools.cancel', {})}
              </Button>
              {!preparedInstall ? (
                <Button
                  loading={preparingInstall}
                  disabled={
                    preparingInstall ||
                    applyingInstall ||
                    !canInstall ||
                    installTimedOut ||
                    (planSummary.usesArchives && !canArchiveFiles)
                  }
                  onClick={() => void prepareInstall()}
                >
                  {t('versionChanger.prepareInstall', {})}
                </Button>
              ) : (
                <Button
                  color='orange'
                  loading={applyingInstall}
                  disabled={
                    preparingInstall ||
                    applyingInstall ||
                    !canInstall ||
                    (hasReplacementChanges && !replaceLauncherFiles)
                  }
                  onClick={() => void applyInstall()}
                >
                  {t('versionChanger.applyInstall', {})}
                </Button>
              )}
            </Group>
          </Stack>
        )}
      </Modal>
    </Stack>
  );

  async function refreshInstalledBuild() {
    if (!canReadFiles || !canReadFileContents) return;
    setInstalledLoading(true);
    try {
      const result = await findInstalledVersion(serverUuid);
      setInstalled(result);
    } catch (error) {
      addToast(httpErrorToHuman(error), 'error');
    } finally {
      setInstalledLoading(false);
    }
  }
}
