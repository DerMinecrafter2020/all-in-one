import { faBullhorn, faTriangleExclamation } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { zod4Resolver } from 'mantine-form-zod-resolver';
import { useForm } from '@mantine/form';
import {
  Alert,
  Button,
  Group,
  Loader,
  NumberInput,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useEffect, useState } from 'react';
import { httpErrorToHuman } from '@/api/axios.ts';
import { useToast } from '@/providers/ToastProvider.tsx';
import getAdvertisingSettings from './api/getAdvertisingSettings.ts';
import updateAdvertisingSettings from './api/updateAdvertisingSettings.ts';
import {
  updateAdvertisingSettingsSchema,
  type AdvertisingMode,
  type AdvertisingScope,
  type AdvertisingSlotName,
  type AdvertisingSlotSettings,
  type UpdateAdvertisingSettings,
} from './lib/schemas.ts';
import { useExtTranslations } from './translations.ts';

function defaultSlot(width: number, height: number): AdvertisingSlotSettings {
  return {
    enabled: false,
    mode: 'custom_banner',
    width,
    height,
    customAdImageUrl: '',
    customAdTargetUrl: '',
    customAdAltText: '',
    customAdIframeUrl: '',
  };
}

export default function AdvertisingSettingsPage() {
  const { addToast } = useToast();
  const { t } = useExtTranslations();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const form = useForm<UpdateAdvertisingSettings>({
    initialValues: {
      scope: 'all',
      slots: {
        top: defaultSlot(728, 90),
        bottom: defaultSlot(728, 90),
        left: defaultSlot(160, 600),
        right: defaultSlot(160, 600),
      },
    },
    validateInputOnBlur: true,
    validate: zod4Resolver(updateAdvertisingSettingsSchema),
  });

  useEffect(() => {
    let active = true;
    getAdvertisingSettings()
      .then(({ settings }) => {
        if (active) form.setValues(settings);
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

  const save = async (values: UpdateAdvertisingSettings) => {
    setSaving(true);
    try {
      await updateAdvertisingSettings(values);
      addToast(t('ads.settingsSaved', {}), 'success');
    } catch (error) {
      addToast(httpErrorToHuman(error), 'error');
    } finally {
      setSaving(false);
    }
  };

  const updateSlot = (
    slotName: AdvertisingSlotName,
    changes: Partial<AdvertisingSlotSettings>,
  ) => {
    const slots = { ...form.values.slots };
    slots[slotName] = { ...slots[slotName], ...changes };
    form.setFieldValue('slots', slots);
  };

  const slotDefinitions: {
    key: AdvertisingSlotName;
    title: string;
    description: string;
  }[] = [
    { key: 'top', title: t('ads.slotTop', {}), description: t('ads.slotTopDescription', {}) },
    { key: 'bottom', title: t('ads.slotBottom', {}), description: t('ads.slotBottomDescription', {}) },
    { key: 'left', title: t('ads.slotLeft', {}), description: t('ads.slotLeftDescription', {}) },
    { key: 'right', title: t('ads.slotRight', {}), description: t('ads.slotRightDescription', {}) },
  ];
  const scopeOptions = [
    { value: 'all', label: t('ads.scopeAll', {}) },
    { value: 'dashboard', label: t('ads.scopeDashboard', {}) },
  ];
  const modeOptions = [
    { value: 'custom_banner', label: t('ads.modeCustom', {}) },
    { value: 'sandboxed_iframe', label: t('ads.modeIframe', {}) },
  ];

  if (loading) {
    return (
      <div className='calagopus-advertising-settings'>
        <div className='calagopus-advertising-loading'>
          <Loader size='sm' />
          <Text size='sm' c='dimmed'>{t('ads.loading', {})}</Text>
        </div>
      </div>
    );
  }

  return (
    <div className='calagopus-advertising-settings'>
      <Stack gap='md'>
        <Group gap='sm'>
          <FontAwesomeIcon icon={faBullhorn} aria-hidden='true' />
          <div>
            <Title order={2} size='h3'>{t('ads.title', {})}</Title>
            <Text size='sm' c='dimmed'>{t('ads.description', {})}</Text>
          </div>
        </Group>

        <Alert
          color='yellow'
          icon={<FontAwesomeIcon icon={faTriangleExclamation} aria-hidden='true' />}
          title={t('ads.privacyTitle', {})}
        >
          {t('ads.privacyNotice', {})}
        </Alert>

        <Paper withBorder radius='md' p='md'>
          <form onSubmit={form.onSubmit(save)}>
            <Stack gap='md'>
              <Select
                label={t('ads.scope', {})}
                data={scopeOptions}
                value={form.values.scope}
                onChange={(value) => {
                  if (value) form.setFieldValue('scope', value as AdvertisingScope);
                }}
                allowDeselect={false}
                disabled={saving}
              />
              <Text size='xs' c='dimmed'>{t('ads.scopeDescription', {})}</Text>

              <SimpleGrid cols={{ base: 1, md: 2 }} spacing='md'>
                {slotDefinitions.map(({ key, title, description }) => {
                  const slot = form.values.slots[key];
                  return (
                    <Paper key={key} withBorder radius='sm' p='sm'>
                      <Stack gap='sm'>
                        <div>
                          <Text fw={700}>{title}</Text>
                          <Text size='xs' c='dimmed'>{description}</Text>
                        </div>
                        <Switch
                          label={t('ads.slotEnabled', {})}
                          checked={slot.enabled}
                          disabled={saving}
                          onChange={(event) =>
                            updateSlot(key, { enabled: event.currentTarget.checked })
                          }
                        />
                        <Select
                          label={t('ads.mode', {})}
                          data={modeOptions}
                          value={slot.mode}
                          onChange={(value) => {
                            if (value) updateSlot(key, { mode: value as AdvertisingMode });
                          }}
                          allowDeselect={false}
                          disabled={saving}
                        />
                        <Group grow>
                          <NumberInput
                            label={t('ads.width', {})}
                            min={1}
                            max={2000}
                            step={1}
                            disabled={saving}
                            value={slot.width}
                            onChange={(value) => updateSlot(key, { width: Number(value) || 1 })}
                          />
                          <NumberInput
                            label={t('ads.height', {})}
                            min={1}
                            max={2000}
                            step={1}
                            disabled={saving}
                            value={slot.height}
                            onChange={(value) => updateSlot(key, { height: Number(value) || 1 })}
                          />
                        </Group>
                        {slot.mode === 'custom_banner' ? (
                          <Stack gap='xs'>
                            <TextInput
                              label={t('ads.customImageUrl', {})}
                              placeholder='https://example.com/banner.png'
                              maxLength={512}
                              disabled={saving}
                              value={slot.customAdImageUrl}
                              error={form.errors[`slots.${key}.customAdImageUrl`]}
                              onChange={(event) =>
                                updateSlot(key, { customAdImageUrl: event.currentTarget.value })
                              }
                            />
                            <TextInput
                              label={t('ads.customTargetUrl', {})}
                              placeholder='https://example.com/'
                              maxLength={512}
                              disabled={saving}
                              value={slot.customAdTargetUrl}
                              error={form.errors[`slots.${key}.customAdTargetUrl`]}
                              onChange={(event) =>
                                updateSlot(key, { customAdTargetUrl: event.currentTarget.value })
                              }
                            />
                            <TextInput
                              label={t('ads.customAltText', {})}
                              maxLength={120}
                              disabled={saving}
                              value={slot.customAdAltText}
                              error={form.errors[`slots.${key}.customAdAltText`]}
                              onChange={(event) =>
                                updateSlot(key, { customAdAltText: event.currentTarget.value })
                              }
                            />
                          </Stack>
                        ) : (
                          <TextInput
                            label={t('ads.iframeUrl', {})}
                            placeholder='https://ads.example.com/embed/…'
                            maxLength={512}
                            disabled={saving}
                            value={slot.customAdIframeUrl}
                            error={form.errors[`slots.${key}.customAdIframeUrl`]}
                            onChange={(event) =>
                              updateSlot(key, { customAdIframeUrl: event.currentTarget.value })
                            }
                          />
                        )}
                      </Stack>
                    </Paper>
                  );
                })}
              </SimpleGrid>

              <Group justify='flex-end'>
                <Button type='submit' loading={saving} disabled={saving}>
                  {t('ads.save', {})}
                </Button>
              </Group>
            </Stack>
          </form>
        </Paper>
      </Stack>
    </div>
  );
}
