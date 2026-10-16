import { faChartColumn, faLock, faRobot } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { zod4Resolver } from 'mantine-form-zod-resolver';
import { useForm } from '@mantine/form';
import {
  Alert,
  Button,
  Checkbox,
  Group,
  Loader,
  List,
  Paper,
  PasswordInput,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core';
import { useEffect, useState } from 'react';
import { httpErrorToHuman } from '@/api/axios.ts';
import { useTranslations } from '@/providers/TranslationProvider.tsx';
import { useToast } from '@/providers/ToastProvider.tsx';
import getAdminSettings from './api/getAdminSettings.ts';
import getProviderModels from './api/getProviderModels.ts';
import updateAdminSettings from './api/updateAdminSettings.ts';
import CHANGELOG from './CHANGELOG.md?raw';
import {
  updateAdminSettingsSchema,
  type AiProvider,
  type TokenUsage,
  type UpdateAdminSettings,
} from './lib/schemas.ts';
import { useExtTranslations } from './translations.ts';

const changelogEntries = CHANGELOG.split(/^##\s+/m)
  .slice(1)
  .map((section) => {
    const [heading = '', ...lines] = section.trim().split(/\r?\n/);
    const [, version, date = ''] = heading.match(/^\[?([^\]\s]+)\]?(?:\s*[—–-]\s*(.*))?$/) ?? [];

    return {
      version: version ?? heading,
      date,
      changes: lines.filter((line) => line.trimStart().startsWith('- ')).map((line) => line.trim().slice(2)),
    };
  })
  .filter((entry) => entry.changes.length > 0);

const providerPresets: Record<AiProvider, { baseUrl: string; model: string }> = {
  openai_compatible: {
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
  },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-4o-mini',
  },
  anthropic: {
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-3-5-haiku-latest',
  },
  google_gemini: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-2.5-flash',
  },
  ollama: {
    baseUrl: 'http://localhost:11434/v1',
    model: 'llama3.2',
  },
};

export default function ConfigurationPage() {
  const { addToast } = useToast();
  const { t: tExt } = useExtTranslations();
  const { t: tPanel } = useTranslations();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [apiKeyConfigured, setApiKeyConfigured] = useState(false);
  const [serverControlApiKeyConfigured, setServerControlApiKeyConfigured] = useState(false);
  const [tokenUsage, setTokenUsage] = useState<TokenUsage>({
    inputTokens: 0,
    outputTokens: 0,
    reportedResponses: 0,
  });

  const providerOptions = [
    { value: 'openai_compatible', label: tExt('settings.providers.openaiCompatible', {}) },
    { value: 'openrouter', label: tExt('settings.providers.openrouter', {}) },
    { value: 'anthropic', label: tExt('settings.providers.anthropic', {}) },
    { value: 'google_gemini', label: tExt('settings.providers.googleGemini', {}) },
    { value: 'ollama', label: tExt('settings.providers.ollama', {}) },
  ];

  const providerDescription: Record<AiProvider, string> = {
    openai_compatible: tExt('settings.providers.openaiCompatibleDescription', {}),
    openrouter: tExt('settings.providers.openrouterDescription', {}),
    anthropic: tExt('settings.providers.anthropicDescription', {}),
    google_gemini: tExt('settings.providers.googleGeminiDescription', {}),
    ollama: tExt('settings.providers.ollamaDescription', {}),
  };

  const form = useForm<UpdateAdminSettings>({
    initialValues: {
      aiEnabled: false,
      aiProvider: 'openai_compatible',
      aiBaseUrl: 'https://api.openai.com/v1',
      aiModel: 'gpt-4o-mini',
      aiSystemPrompt: 'You are the All-in-One assistant. Be helpful, clear, and concise.',
      aiApiKey: '',
      serverControlApiKey: '',
      aiServerInfoEnabled: false,
      aiServerPowerEnabled: false,
      floatingWidgetEnabled: true,
      clearServerControlApiKey: false,
      clearApiKey: false,
    },
    validateInputOnBlur: true,
    validate: zod4Resolver(updateAdminSettingsSchema),
  });

  useEffect(() => {
    let active = true;
    getAdminSettings()
      .then(({ settings, tokenUsage: usage }) => {
        if (!active) return;
        setTokenUsage(usage);
        form.setValues({
          aiEnabled: settings.aiEnabled,
          aiProvider: settings.aiProvider,
          aiBaseUrl: settings.aiBaseUrl,
          aiModel: settings.aiModel,
          aiSystemPrompt: settings.aiSystemPrompt,
          aiApiKey: '',
          serverControlApiKey: '',
          aiServerInfoEnabled: settings.aiServerInfoEnabled,
          aiServerPowerEnabled: settings.aiServerPowerEnabled,
          floatingWidgetEnabled: settings.floatingWidgetEnabled,
          clearServerControlApiKey: false,
          clearApiKey: false,
        });
        setApiKeyConfigured(settings.apiKeyConfigured);
        setServerControlApiKeyConfigured(settings.serverControlApiKeyConfigured);
      })
      .catch((error) => {
        if (active) addToast(httpErrorToHuman(error), 'error');
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, []);

  const doSave = async (values: UpdateAdminSettings) => {
    setSaving(true);
    try {
      await updateAdminSettings(values);
      if (values.clearApiKey) setApiKeyConfigured(false);
      else if (values.aiApiKey.trim()) setApiKeyConfigured(true);
      if (values.clearServerControlApiKey) setServerControlApiKeyConfigured(false);
      else if (values.serverControlApiKey.trim()) setServerControlApiKeyConfigured(true);
      form.setFieldValue('aiApiKey', '');
      form.setFieldValue('serverControlApiKey', '');
      form.setFieldValue('clearServerControlApiKey', false);
      form.setFieldValue('clearApiKey', false);
      addToast(tExt('settings.settingsSaved', {}), 'success');
    } catch (error) {
      addToast(httpErrorToHuman(error), 'error');
    } finally {
      setSaving(false);
    }
  };

  const hasPanelControlApiKey =
    !form.values.clearServerControlApiKey &&
    (serverControlApiKeyConfigured || form.values.serverControlApiKey.trim().length > 0);

  const loadModels = async () => {
    setLoadingModels(true);
    try {
      const response = await getProviderModels({
        aiProvider: form.values.aiProvider,
        aiBaseUrl: form.values.aiBaseUrl,
        aiApiKey: form.values.aiApiKey,
      });
      setAvailableModels(response.models);
      addToast(
        response.models.length > 0
          ? tExt('settings.modelsLoaded', { count: response.models.length })
          : tExt('settings.noModels', {}),
        response.models.length > 0 ? 'success' : 'warning',
      );
    } catch (error) {
      addToast(httpErrorToHuman(error), 'error');
    } finally {
      setLoadingModels(false);
    }
  };

  if (loading) {
    return (
      <Group justify='center' py='xl'>
        <Loader size='sm' />
        <Text size='sm' c='dimmed'>
          {tExt('settings.loading', {})}
        </Text>
      </Group>
    );
  }

  return (
    <Stack gap='md' className='calagopus-chat-settings'>
      <Paper withBorder radius='md' p='lg' className='calagopus-chat-settings-card'>
        <Stack gap='md'>
          <Group gap='sm' align='flex-start'>
            <FontAwesomeIcon icon={faRobot} aria-hidden='true' />
            <div>
              <Text fw={700}>{tExt('settings.title', {})}</Text>
              <Text size='sm' c='dimmed'>
                {tExt('settings.description', {})}
              </Text>
            </div>
          </Group>

          <form onSubmit={form.onSubmit(doSave)} autoComplete='off'>
            <Stack gap='md'>
              <Switch
                label={tExt('settings.enableAi', {})}
                description={tExt('settings.enableAiDescription', {})}
                {...form.getInputProps('aiEnabled', { type: 'checkbox' })}
              />

              <Switch
                label={tExt('settings.enableFloatingWidget', {})}
                description={tExt('settings.enableFloatingWidgetDescription', {})}
                {...form.getInputProps('floatingWidgetEnabled', { type: 'checkbox' })}
              />

              <Switch
                label={tExt('settings.enableServerInfo', {})}
                description={tExt('settings.enableServerInfoDescription', {})}
                checked={form.values.aiServerInfoEnabled}
                onChange={(event) => {
                  const enabled = event.currentTarget.checked;
                  form.setFieldValue('aiServerInfoEnabled', enabled);
                  if (!enabled) form.setFieldValue('aiServerPowerEnabled', false);
                }}
              />

              <PasswordInput
                label={tExt('settings.serverControlApiKey', {})}
                description={tExt('settings.serverControlApiKeyDescription', {})}
                leftSection={<FontAwesomeIcon icon={faLock} aria-hidden='true' />}
                autoComplete='new-password'
                placeholder={
                  serverControlApiKeyConfigured ? '••••••••••••••••' : tExt('settings.enterServerControlApiKey', {})
                }
                {...form.getInputProps('serverControlApiKey')}
              />

              <Checkbox
                label={tExt('settings.removeServerControlApiKey', {})}
                disabled={!serverControlApiKeyConfigured}
                checked={form.values.clearServerControlApiKey}
                onChange={(event) => {
                  const clearKey = event.currentTarget.checked;
                  form.setFieldValue('clearServerControlApiKey', clearKey);
                  if (clearKey && !form.values.serverControlApiKey.trim()) {
                    form.setFieldValue('aiServerPowerEnabled', false);
                  }
                }}
              />

              <Switch
                label={tExt('settings.enableServerPower', {})}
                description={tExt('settings.enableServerPowerDescription', {})}
                disabled={!form.values.aiServerInfoEnabled || !hasPanelControlApiKey}
                {...form.getInputProps('aiServerPowerEnabled', { type: 'checkbox' })}
              />

              <SimpleGrid cols={{ base: 1, md: 2 }} spacing='md'>
                <Select
                  label={tExt('settings.provider', {})}
                  data={providerOptions}
                  value={form.values.aiProvider}
                  onChange={(value) => {
                    if (!value) return;
                    const provider = value as AiProvider;
                    form.setFieldValue('aiProvider', provider);
                    form.setFieldValue('aiBaseUrl', providerPresets[provider].baseUrl);
                    form.setFieldValue('aiModel', providerPresets[provider].model);
                    setAvailableModels([]);
                  }}
                  allowDeselect={false}
                />

                <TextInput
                  label={tExt('settings.baseUrl', {})}
                  description={providerDescription[form.values.aiProvider]}
                  placeholder={providerPresets[form.values.aiProvider].baseUrl}
                  type='url'
                  {...form.getInputProps('aiBaseUrl')}
                />
              </SimpleGrid>

              <SimpleGrid cols={{ base: 1, md: 2 }} spacing='md'>
                <TextInput
                  label={tExt('settings.model', {})}
                  placeholder={providerPresets[form.values.aiProvider].model}
                  {...form.getInputProps('aiModel')}
                />

                <Group className='calagopus-chat-model-picker' align='flex-end' gap='xs' wrap='wrap'>
                  <Select
                    label={tExt('settings.availableModels', {})}
                    placeholder={
                      availableModels.length > 0
                        ? tExt('settings.chooseModel', {})
                        : tExt('settings.loadModelsFirst', {})
                    }
                    data={availableModels}
                    value={availableModels.includes(form.values.aiModel) ? form.values.aiModel : null}
                    onChange={(model) => {
                      if (model) form.setFieldValue('aiModel', model);
                    }}
                    searchable
                    clearable
                    nothingFoundMessage={tExt('settings.noMatchingModels', {})}
                    style={{ flex: 1 }}
                  />
                  <Button
                    type='button'
                    variant='default'
                    loading={loadingModels}
                    disabled={form.values.aiProvider !== 'ollama' && !apiKeyConfigured && !form.values.aiApiKey.trim()}
                    onClick={() => void loadModels()}
                  >
                    {tExt('settings.loadModels', {})}
                  </Button>
                </Group>
              </SimpleGrid>

              <PasswordInput
                label={tPanel('common.form.apiKey', {})}
                description={
                  apiKeyConfigured
                    ? tExt('settings.keepStoredKey', {})
                    : form.values.aiProvider === 'ollama'
                      ? tExt('settings.optionalOllamaKey', {})
                      : tExt('settings.encryptedKey', {})
                }
                leftSection={<FontAwesomeIcon icon={faLock} aria-hidden='true' />}
                autoComplete='new-password'
                placeholder={apiKeyConfigured ? '••••••••••••••••' : tExt('settings.enterApiKey', {})}
                {...form.getInputProps('aiApiKey')}
              />

              <Checkbox
                label={tExt('settings.removeStoredKey', {})}
                disabled={!apiKeyConfigured}
                {...form.getInputProps('clearApiKey', { type: 'checkbox' })}
              />

              <Textarea
                label={tExt('settings.systemPrompt', {})}
                description={tExt('settings.systemPromptDescription', {})}
                minRows={3}
                maxRows={8}
                autosize
                {...form.getInputProps('aiSystemPrompt')}
              />

              {!apiKeyConfigured && form.values.aiEnabled && form.values.aiProvider !== 'ollama' && (
                <Alert color='yellow' title={tExt('settings.apiKeyRequired', {})}>
                  {tExt('settings.apiKeyRequiredDescription', {})}
                </Alert>
              )}

              <Group justify='flex-end'>
                <Button type='submit' loading={saving} disabled={!form.isValid()}>
                  {tPanel('common.button.save', {})}
                </Button>
              </Group>
            </Stack>
          </form>
        </Stack>
      </Paper>

      <Paper withBorder radius='md' p='lg' className='calagopus-chat-settings-card'>
        <Stack gap='sm'>
          <Group gap='sm' align='flex-start'>
            <FontAwesomeIcon icon={faChartColumn} aria-hidden='true' />
            <div>
              <Text fw={700}>{tExt('settings.tokenUsageTitle', {})}</Text>
              <Text size='sm' c='dimmed'>
                {tExt('settings.tokenUsageDescription', {})}
              </Text>
            </div>
          </Group>
          <SimpleGrid cols={{ base: 1, sm: 3 }} spacing='xs'>
            <TokenUsageMetric label={tExt('settings.inputTokens', {})} value={tokenUsage.inputTokens} />
            <TokenUsageMetric label={tExt('settings.outputTokens', {})} value={tokenUsage.outputTokens} />
            <TokenUsageMetric
              label={tExt('settings.totalTokens', {})}
              value={tokenUsage.inputTokens + tokenUsage.outputTokens}
            />
          </SimpleGrid>
          <Text size='xs' c='dimmed'>
            {tExt('settings.tokenUsageResponses', { count: tokenUsage.reportedResponses })}
          </Text>
          <Text size='xs' c='dimmed'>
            {tExt('settings.tokenUsageScope', {})}
          </Text>
        </Stack>
      </Paper>

      <Paper withBorder radius='md' p='lg' className='calagopus-chat-settings-card'>
        <Stack gap='sm'>
          <div>
            <Text fw={700}>{tExt('settings.changelogTitle', {})}</Text>
            <Text size='sm' c='dimmed'>
              {tExt('settings.changelogDescription', {})}
            </Text>
          </div>
          <Stack gap='md'>
            {changelogEntries.map((entry) => (
              <div className='calagopus-chat-changelog-entry' key={entry.version}>
                <Group justify='space-between' gap='xs' align='baseline'>
                  <Text fw={600}>{entry.version}</Text>
                  {entry.date && (
                    <Text size='xs' c='dimmed'>
                      {entry.date}
                    </Text>
                  )}
                </Group>
                <List size='sm' spacing='xs' mt='xs'>
                  {entry.changes.map((change, index) => (
                    <List.Item key={`${entry.version}-${index}`}>{change}</List.Item>
                  ))}
                </List>
              </div>
            ))}
          </Stack>
        </Stack>
      </Paper>
    </Stack>
  );
}

function TokenUsageMetric({ label, value }: { label: string; value: number }) {
  return (
    <Paper withBorder radius='sm' p='sm' className='calagopus-chat-token-metric'>
      <Text size='xs' c='dimmed'>
        {label}
      </Text>
      <Text fw={700} size='lg' style={{ fontVariantNumeric: 'tabular-nums' }}>
        {Intl.NumberFormat().format(value)}
      </Text>
    </Paper>
  );
}
