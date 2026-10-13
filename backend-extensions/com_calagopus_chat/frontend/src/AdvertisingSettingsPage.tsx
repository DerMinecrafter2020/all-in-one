import { faBullhorn, faTriangleExclamation } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { zod4Resolver } from 'mantine-form-zod-resolver';
import { useForm } from '@mantine/form';
import {
  Alert,
  Button,
  Group,
  Loader,
  Paper,
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
  type UpdateAdvertisingSettings,
} from './lib/schemas.ts';
import { useExtTranslations } from './translations.ts';

export default function AdvertisingSettingsPage() {
  const { addToast } = useToast();
  const { t } = useExtTranslations();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const form = useForm<UpdateAdvertisingSettings>({
    initialValues: {
      enabled: false,
      customAdImageUrl: '',
      customAdTargetUrl: '',
      customAdAltText: '',
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
              <Switch
                label={t('ads.enable', {})}
                description={t('ads.enableDescription', {})}
                disabled={saving}
                {...form.getInputProps('enabled', { type: 'checkbox' })}
              />

              <Stack gap='sm'>
                <TextInput
                  label={t('ads.customImageUrl', {})}
                  placeholder='https://example.com/banner.png'
                  maxLength={512}
                  disabled={saving}
                  {...form.getInputProps('customAdImageUrl')}
                />
                <TextInput
                  label={t('ads.customTargetUrl', {})}
                  placeholder='https://example.com/'
                  maxLength={512}
                  disabled={saving}
                  {...form.getInputProps('customAdTargetUrl')}
                />
                <TextInput
                  label={t('ads.customAltText', {})}
                  maxLength={120}
                  disabled={saving}
                  {...form.getInputProps('customAdAltText')}
                />
                <Text size='xs' c='dimmed'>{t('ads.customHelp', {})}</Text>
              </Stack>

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
