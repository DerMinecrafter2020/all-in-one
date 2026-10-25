use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use shared::{
    GetState, Payload,
    models::{admin_activity::GetAdminActivityLogger, user::GetPermissionManager},
    response::{ApiResponse, ApiResponseResult},
};
use utoipa::ToSchema;
use utoipa_axum::{router::OpenApiRouter, routes};
use url::Url;

#[derive(ToSchema, Serialize)]
struct SettingsResponse {
    api_base_url: String,
    api_key_configured: bool,
    icon_base_url: String,
    icon_format: String,
    type_order: Vec<crate::settings::MinecraftVersionTypeOrder>,
    egg_overrides: Vec<crate::settings::MinecraftVersionEggOverride>,
    collect_stats: bool,
    local_stats: crate::settings::MinecraftVersionStats,
}

#[derive(ToSchema, Serialize)]
struct GetResponse {
    settings: SettingsResponse,
}

#[derive(ToSchema, Deserialize)]
struct PutPayload {
    api_base_url: String,
    api_key: Option<String>,
    #[serde(default)]
    clear_api_key: bool,
    icon_base_url: String,
    icon_format: String,
    #[serde(default)]
    type_order: Vec<crate::settings::MinecraftVersionTypeOrder>,
    #[serde(default)]
    egg_overrides: Vec<crate::settings::MinecraftVersionEggOverride>,
    collect_stats: bool,
    #[serde(default)]
    reset_local_stats: bool,
}

#[derive(ToSchema, Serialize)]
struct PutResponse {}

fn valid_mcv_api_base(value: &str) -> bool {
    if value.len() > 512 {
        return false;
    }
    let Ok(url) = Url::parse(value.trim()) else {
        return false;
    };
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    (host == "mcjars.app" || host.ends_with(".mcjars.app"))
        && url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && (url.path().is_empty() || url.path() == "/")
}

fn valid_icon_base(value: &str) -> bool {
    if value.len() > 512 || !value.ends_with('/') {
        return false;
    }
    let Ok(url) = Url::parse(value.trim()) else {
        return false;
    };
    url.scheme() == "https"
        && url.host_str() == Some("s3.mcjars.app")
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
}

fn valid_type_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
}

mod get {
    use super::*;

    #[utoipa::path(get, path = "/settings", responses((status = OK, body = inline(GetResponse))))]
    pub async fn route(state: GetState, permissions: GetPermissionManager) -> ApiResponseResult {
        permissions.has_admin_permission("extensions.manage")?;
        let settings = crate::settings::load(&state.0).await?;
        let changer = settings.minecraft_version_changer;

        ApiResponse::new_serialized(GetResponse {
            settings: SettingsResponse {
                api_base_url: changer.api_base_url.to_string(),
                api_key_configured: !settings.minecraft_version_api_key.trim().is_empty(),
                icon_base_url: changer.icon_base_url.to_string(),
                icon_format: changer.icon_format.to_string(),
                type_order: changer.type_order,
                egg_overrides: changer.egg_overrides,
                collect_stats: changer.collect_stats,
                local_stats: changer.local_stats,
            },
        })
        .ok()
    }
}

mod types {
    use super::*;

    #[utoipa::path(get, path = "/types", responses((status = OK, description = "Available Minecraft server types.")))]
    pub async fn route(
        state: GetState,
        permissions: GetPermissionManager,
    ) -> ApiResponseResult {
        permissions.has_admin_permission("extensions.manage")?;
        let types = crate::routes::client::minecraft_versions::fetch_types(&state.0).await?;
        ApiResponse::new_serialized(types).ok()
    }
}

mod global_stats {
    use super::*;

    #[utoipa::path(get, path = "/global-stats", responses(
        (status = OK, description = "Aggregate public provider statistics."),
    ))]
    pub async fn route(state: GetState, permissions: GetPermissionManager) -> ApiResponseResult {
        permissions.has_admin_permission("extensions.manage")?;
        let stats = crate::routes::client::minecraft_versions::fetch_global_stats(&state.0).await?;
        ApiResponse::new_serialized(stats).ok()
    }
}

mod put {
    use super::*;

    #[utoipa::path(put, path = "/settings", request_body = inline(PutPayload), responses(
        (status = OK, body = inline(PutResponse)),
        (status = BAD_REQUEST, description = "Invalid Minecraft version settings."),
    ))]
    pub async fn route(
        state: GetState,
        permissions: GetPermissionManager,
        activity_logger: GetAdminActivityLogger,
        Payload(data): Payload<PutPayload>,
    ) -> ApiResponseResult {
        permissions.has_admin_permission("extensions.manage")?;

        let api_base_url = data.api_base_url.trim();
        let icon_base_url = format!("{}/", data.icon_base_url.trim().trim_end_matches('/'));
        let api_key = data.api_key.as_deref().unwrap_or_default().trim();
        if !valid_mcv_api_base(api_base_url)
            || !valid_icon_base(&icon_base_url)
            || !matches!(data.icon_format.as_str(), "png" | "webp")
            || api_key.chars().count() > 4096
            || api_key.chars().any(char::is_control)
            || data.type_order.len() > 64
            || data.egg_overrides.len() > 256
        {
            return Err(ApiResponse::error("One or more Minecraft version settings are invalid.")
                .with_status(StatusCode::BAD_REQUEST));
        }

        let mut seen_categories = std::collections::HashSet::new();
        let mut seen_ordered_types = std::collections::HashSet::new();
        for group in &data.type_order {
            let category = group.category.trim();
            if category.is_empty()
                || category.len() > 64
                || category.chars().any(char::is_control)
                || !seen_categories.insert(category.to_ascii_lowercase())
                || group.types.len() > 256
            {
                return Err(ApiResponse::error("The Minecraft server type order is invalid.")
                    .with_status(StatusCode::BAD_REQUEST));
            }
            let mut seen_types = std::collections::HashSet::new();
            if group.types.iter().any(|provider_type| {
                !valid_type_id(provider_type.trim())
                    || !seen_types.insert(provider_type.trim().to_ascii_uppercase())
                    || !seen_ordered_types.insert(provider_type.trim().to_ascii_uppercase())
            }) {
                return Err(ApiResponse::error("The Minecraft server type order is invalid.")
                    .with_status(StatusCode::BAD_REQUEST));
            }
        }

        let mut seen_egg_types = std::collections::HashSet::new();
        for mapping in &data.egg_overrides {
            if !valid_type_id(mapping.provider_type.trim())
                || uuid::Uuid::parse_str(mapping.egg_uuid.trim()).is_err()
                || !seen_egg_types.insert(mapping.provider_type.trim().to_ascii_uppercase())
            {
                return Err(ApiResponse::error("The Minecraft server type Egg mappings are invalid.")
                    .with_status(StatusCode::BAD_REQUEST));
            }
        }

        let type_order_count = data.type_order.len();
        let egg_override_count = data.egg_overrides.len();
        let type_order = data
            .type_order
            .iter()
            .map(|group| crate::settings::MinecraftVersionTypeOrder {
                category: group.category.trim().into(),
                types: group
                    .types
                    .iter()
                    .map(|provider_type| provider_type.trim().to_ascii_uppercase().into())
                    .collect(),
            })
            .collect();
        let egg_overrides = data
            .egg_overrides
            .iter()
            .filter_map(|mapping| {
                uuid::Uuid::parse_str(mapping.egg_uuid.trim())
                    .ok()
                    .map(|egg_uuid| crate::settings::MinecraftVersionEggOverride {
                        provider_type: mapping.provider_type.trim().to_ascii_uppercase().into(),
                        egg_uuid: egg_uuid.to_string().into(),
                    })
            })
            .collect();
        let icon_format = data.icon_format.trim().to_ascii_lowercase();

        let mut settings = state.settings.get_mut().await?;
        let api_key_updated = data.clear_api_key || !api_key.is_empty();
        {
            let extension_settings: &mut crate::settings::ExtensionSettingsData =
                settings.find_mut_extension_settings()?;
            let changer = &mut extension_settings.minecraft_version_changer;
            changer.api_base_url = api_base_url.into();
            changer.icon_base_url = icon_base_url.into();
            changer.icon_format = icon_format.clone().into();
            changer.type_order = type_order;
            changer.egg_overrides = egg_overrides;
            changer.collect_stats = data.collect_stats;
            if data.reset_local_stats {
                changer.local_stats = crate::settings::MinecraftVersionStats::default();
            }

            if data.clear_api_key {
                extension_settings.minecraft_version_api_key = compact_str::CompactString::default();
            } else if !api_key.is_empty() {
                extension_settings.minecraft_version_api_key = api_key.into();
            }
        }
        settings.save().await?;

        activity_logger
            .log(
                "settings:extensions:update",
                serde_json::json!({
                    "extension": "com.calagopus.chat",
                    "minecraft_version_api_url": api_base_url,
                    "minecraft_version_api_key_updated": api_key_updated,
                    "minecraft_version_icon_format": icon_format,
                    "minecraft_version_type_order_count": type_order_count,
                    "minecraft_version_egg_override_count": egg_override_count,
                    "minecraft_version_stats_enabled": data.collect_stats,
                    "minecraft_version_stats_reset": data.reset_local_stats,
                }),
            )
            .await;

        ApiResponse::new_serialized(PutResponse {}).ok()
    }
}

pub fn router(state: &shared::State) -> OpenApiRouter<shared::State> {
    OpenApiRouter::new()
        .routes(routes!(types::route))
        .routes(routes!(global_stats::route))
        .routes(routes!(get::route))
        .routes(routes!(put::route))
        .with_state(state.clone())
}
