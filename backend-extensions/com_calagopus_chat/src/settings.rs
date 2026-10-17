use serde::{Deserialize, Serialize};
use compact_str::ToCompactString;
use shared::{
    State,
    extensions::settings::{
        ExtensionSettings, SettingsDeserializeExt, SettingsDeserializer, SettingsSerializeExt,
        SettingsSerializer,
    },
};
use utoipa::ToSchema;
use url::Url;

#[derive(Clone, ToSchema, Serialize, Deserialize)]
#[serde(default)]
pub struct AdvertisingSlotSettings {
    pub enabled: bool,
    pub mode: compact_str::CompactString,
    pub width: u16,
    pub height: u16,
    pub custom_ad_image_url: compact_str::CompactString,
    pub custom_ad_target_url: compact_str::CompactString,
    pub custom_ad_alt_text: compact_str::CompactString,
    pub custom_ad_iframe_url: compact_str::CompactString,
}

impl AdvertisingSlotSettings {
    fn banner_default() -> Self {
        Self {
            width: 728,
            height: 90,
            ..Self::default()
        }
    }

    fn side_default() -> Self {
        Self {
            width: 160,
            height: 600,
            ..Self::default()
        }
    }

    pub fn is_available(&self) -> bool {
        if !self.enabled || !(1..=2000).contains(&self.width) || !(1..=2000).contains(&self.height) {
            return false;
        }

        match self.mode.as_str() {
            "custom_banner" => {
                is_https_url(self.custom_ad_image_url.trim())
                    && is_https_url(self.custom_ad_target_url.trim())
                    && !self.custom_ad_alt_text.trim().is_empty()
            }
            "sandboxed_iframe" => is_https_url(self.custom_ad_iframe_url.trim()),
            _ => false,
        }
    }
}

impl Default for AdvertisingSlotSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            mode: "custom_banner".into(),
            width: 728,
            height: 90,
            custom_ad_image_url: compact_str::CompactString::default(),
            custom_ad_target_url: compact_str::CompactString::default(),
            custom_ad_alt_text: compact_str::CompactString::default(),
            custom_ad_iframe_url: compact_str::CompactString::default(),
        }
    }
}

#[derive(Clone, ToSchema, Serialize, Deserialize)]
#[serde(default)]
pub struct AdvertisingSlots {
    pub top: AdvertisingSlotSettings,
    pub bottom: AdvertisingSlotSettings,
    pub left: AdvertisingSlotSettings,
    pub right: AdvertisingSlotSettings,
}

impl Default for AdvertisingSlots {
    fn default() -> Self {
        Self {
            top: AdvertisingSlotSettings::banner_default(),
            bottom: AdvertisingSlotSettings::banner_default(),
            left: AdvertisingSlotSettings::side_default(),
            right: AdvertisingSlotSettings::side_default(),
        }
    }
}

#[derive(Clone, ToSchema, Serialize, Deserialize)]
#[serde(default)]
pub struct AdvertisingSettings {
    pub scope: compact_str::CompactString,
    pub slots: AdvertisingSlots,
}

impl Default for AdvertisingSettings {
    fn default() -> Self {
        Self {
            scope: "all".into(),
            slots: AdvertisingSlots::default(),
        }
    }
}

#[derive(Clone, Copy, Debug, ToSchema, Serialize, Deserialize)]
#[serde(default)]
pub struct ServerToolPagesSettings {
    pub modpacks: bool,
    pub mods: bool,
    pub plugins: bool,
    pub players: bool,
    pub server_properties: bool,
}

impl Default for ServerToolPagesSettings {
    fn default() -> Self {
        Self {
            modpacks: true,
            mods: true,
            plugins: true,
            players: true,
            server_properties: true,
        }
    }
}

#[derive(Clone, ToSchema, Serialize, Deserialize)]
#[serde(default)]
pub struct ServerToolEggSettings {
    pub modpacks: Option<Vec<String>>,
    pub mods: Option<Vec<String>>,
    pub plugins: Option<Vec<String>>,
    pub players: Option<Vec<String>>,
    pub server_properties: Option<Vec<String>>,
}

impl Default for ServerToolEggSettings {
    fn default() -> Self {
        Self {
            modpacks: None,
            mods: None,
            plugins: None,
            players: None,
            server_properties: None,
        }
    }
}

impl ServerToolEggSettings {
    pub fn is_valid(&self) -> bool {
        fn valid_egg_ids(ids: &Option<Vec<String>>) -> bool {
            match ids {
                None => true,
                Some(ids) => ids.len() <= 1000 && ids.iter().all(|id| uuid::Uuid::parse_str(id).is_ok()),
            }
        }

        valid_egg_ids(&self.modpacks)
            && valid_egg_ids(&self.mods)
            && valid_egg_ids(&self.plugins)
            && valid_egg_ids(&self.players)
            && valid_egg_ids(&self.server_properties)
    }
}

#[derive(Clone, ToSchema, Serialize, Deserialize)]
#[serde(default)]
pub struct ExtensionSettingsData {
    pub ai_enabled: bool,
    pub ai_provider: compact_str::CompactString,
    pub ai_base_url: compact_str::CompactString,
    pub ai_model: compact_str::CompactString,
    pub ai_api_key: compact_str::CompactString,
    pub ai_server_control_api_key: compact_str::CompactString,
    pub ai_system_prompt: compact_str::CompactString,
    pub ai_server_info_enabled: bool,
    pub ai_server_power_enabled: bool,
    pub floating_widget_enabled: bool,
    pub advertising: AdvertisingSettings,
    pub server_tool_pages: ServerToolPagesSettings,
    pub server_tool_egg_settings: ServerToolEggSettings,
}

impl Default for ExtensionSettingsData {
    fn default() -> Self {
        Self {
            ai_enabled: false,
            ai_provider: "openai_compatible".into(),
            ai_base_url: "https://api.openai.com/v1".into(),
            ai_model: "gpt-4o-mini".into(),
            ai_api_key: compact_str::CompactString::default(),
            ai_server_control_api_key: compact_str::CompactString::default(),
            ai_system_prompt: "You are the All-in-One assistant. Be helpful, clear, and concise."
                .into(),
            ai_server_info_enabled: false,
            ai_server_power_enabled: false,
            floating_widget_enabled: true,
            advertising: AdvertisingSettings::default(),
            server_tool_pages: ServerToolPagesSettings::default(),
            server_tool_egg_settings: ServerToolEggSettings::default(),
        }
    }
}

impl ExtensionSettingsData {
    pub fn ai_available(&self) -> bool {
        let supported_provider = matches!(
            self.ai_provider.as_str(),
            "openai_compatible" | "openrouter" | "anthropic" | "google_gemini" | "ollama"
        );
        let key_configured =
            self.ai_provider.as_str() == "ollama" || !self.ai_api_key.trim().is_empty();

        self.ai_enabled
            && supported_provider
            && key_configured
            && !self.ai_model.trim().is_empty()
            && is_valid_ai_base_url(self.ai_base_url.trim())
    }
}

fn is_valid_ai_base_url(value: &str) -> bool {
    if value.len() > 512 {
        return false;
    }

    let Ok(url) = Url::parse(value) else {
        return false;
    };

    matches!(url.scheme(), "http" | "https")
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
}

fn is_https_url(value: &str) -> bool {
    let Ok(url) = Url::parse(value) else {
        return false;
    };

    url.scheme() == "https"
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
}

#[cfg(test)]
mod tests {
    use super::is_valid_ai_base_url;

    #[test]
    fn accepts_http_and_https_ai_base_urls_without_embedded_credentials() {
        assert!(is_valid_ai_base_url("http://localhost:11434/v1"));
        assert!(is_valid_ai_base_url("https://api.example.test/v1"));
        assert!(!is_valid_ai_base_url("https://user:secret@api.example.test/v1"));
        assert!(!is_valid_ai_base_url("https://api.example.test/v1?key=secret"));
        assert!(!is_valid_ai_base_url("https://api.example.test/v1#fragment"));
        assert!(!is_valid_ai_base_url("file:///etc/passwd"));
    }
}

#[async_trait::async_trait]
impl SettingsSerializeExt for ExtensionSettingsData {
    async fn serialize(
        &self,
        serializer: SettingsSerializer,
    ) -> Result<SettingsSerializer, anyhow::Error> {
        let serializer = serializer
            .write_raw_setting("ai_enabled", self.ai_enabled.to_compact_string())
            .write_raw_setting("ai_provider", self.ai_provider.clone())
            .write_raw_setting("ai_base_url", self.ai_base_url.clone())
            .write_raw_setting("ai_model", self.ai_model.clone())
            .write_raw_setting("ai_system_prompt", self.ai_system_prompt.clone())
            .write_raw_setting(
                "ai_server_info_enabled",
                self.ai_server_info_enabled.to_compact_string(),
            )
            .write_raw_setting(
                "ai_server_power_enabled",
                self.ai_server_power_enabled.to_compact_string(),
            )
            .write_raw_setting(
                "floating_widget_enabled",
                self.floating_widget_enabled.to_compact_string(),
            )
            .write_raw_setting(
                "advertising_config",
                serde_json::to_string(&self.advertising)?,
            )
            .write_raw_setting(
                "server_tool_pages_config",
                serde_json::to_string(&self.server_tool_pages)?,
            )
            .write_raw_setting(
                "server_tool_egg_settings_config",
                serde_json::to_string(&self.server_tool_egg_settings)?,
            );

        let serializer = serializer
            .write_raw_encrypted_setting("ai_api_key", self.ai_api_key.clone())
            .await?;

        Ok(serializer
            .write_raw_encrypted_setting(
                "ai_server_control_api_key",
                self.ai_server_control_api_key.clone(),
            )
            .await?)
    }
}

pub struct ExtensionSettingsDataDeserializer;

#[async_trait::async_trait]
impl SettingsDeserializeExt for ExtensionSettingsDataDeserializer {
    async fn deserialize_boxed(
        &self,
        mut deserializer: SettingsDeserializer<'_>,
    ) -> Result<ExtensionSettings, anyhow::Error> {
        let ai_api_key = deserializer
            .read_raw_encrypted_setting("ai_api_key")
            .await?
            .unwrap_or_default();
        let ai_server_control_api_key = deserializer
            .read_raw_encrypted_setting("ai_server_control_api_key")
            .await?
            .unwrap_or_default();

        let advertising = deserializer
            .take_raw_setting("advertising_config")
            .and_then(|value| serde_json::from_str(value.as_str()).ok())
            .unwrap_or_else(|| {
                let mut advertising = AdvertisingSettings::default();
                advertising.slots.top.enabled = deserializer
                    .take_raw_setting("advertising_enabled")
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(false);
                advertising.slots.top.mode = deserializer
                    .take_raw_setting("advertising_mode")
                    .filter(|value| matches!(value.as_str(), "custom_banner" | "sandboxed_iframe"))
                    .unwrap_or_else(|| "custom_banner".into());
                advertising.slots.top.custom_ad_image_url = deserializer
                    .take_raw_setting("custom_ad_image_url")
                    .unwrap_or_default();
                advertising.slots.top.custom_ad_target_url = deserializer
                    .take_raw_setting("custom_ad_target_url")
                    .unwrap_or_default();
                advertising.slots.top.custom_ad_alt_text = deserializer
                    .take_raw_setting("custom_ad_alt_text")
                    .unwrap_or_default();
                advertising.slots.top.custom_ad_iframe_url = deserializer
                    .take_raw_setting("custom_ad_iframe_url")
                    .unwrap_or_default();
                advertising
            });
        let server_tool_pages = deserializer
            .take_raw_setting("server_tool_pages_config")
            .and_then(|value| serde_json::from_str(value.as_str()).ok())
            .unwrap_or_default();
        let server_tool_egg_settings = deserializer
            .take_raw_setting("server_tool_egg_settings_config")
            .and_then(|value| serde_json::from_str(value.as_str()).ok())
            .unwrap_or_default();

        Ok(Box::new(ExtensionSettingsData {
            ai_enabled: deserializer
                .take_raw_setting("ai_enabled")
                .and_then(|value| value.parse().ok())
                .unwrap_or(false),
            ai_provider: deserializer
                .take_raw_setting("ai_provider")
                .unwrap_or_else(|| "openai_compatible".into()),
            ai_base_url: deserializer
                .take_raw_setting("ai_base_url")
                .unwrap_or_else(|| "https://api.openai.com/v1".into()),
            ai_model: deserializer
                .take_raw_setting("ai_model")
                .unwrap_or_else(|| "gpt-4o-mini".into()),
            ai_api_key,
            ai_server_control_api_key,
            ai_system_prompt: deserializer
                .take_raw_setting("ai_system_prompt")
                .unwrap_or_else(|| {
                    "You are the All-in-One assistant. Be helpful, clear, and concise.".into()
                }),
            ai_server_info_enabled: deserializer
                .take_raw_setting("ai_server_info_enabled")
                .and_then(|value| value.parse().ok())
                .unwrap_or(false),
            ai_server_power_enabled: deserializer
                .take_raw_setting("ai_server_power_enabled")
                .and_then(|value| value.parse().ok())
                .unwrap_or(false),
            floating_widget_enabled: deserializer
                .take_raw_setting("floating_widget_enabled")
                .and_then(|value| value.parse().ok())
                .unwrap_or(true),
            advertising,
            server_tool_pages,
            server_tool_egg_settings,
        }))
    }
}

pub async fn load(state: &State) -> Result<ExtensionSettingsData, anyhow::Error> {
    let settings = state.settings.get().await?;
    Ok(settings
        .find_extension_settings::<ExtensionSettingsData>()?
        .clone())
}
