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

mod get {
    use super::*;

    #[derive(ToSchema, Serialize)]
    struct SettingsResponse {
        enabled: bool,
        custom_ad_image_url: String,
        custom_ad_target_url: String,
        custom_ad_alt_text: String,
    }

    #[derive(ToSchema, Serialize)]
    struct Response {
        settings: SettingsResponse,
    }

    #[utoipa::path(get, path = "/", responses(
        (status = OK, body = inline(Response)),
    ))]
    pub async fn route(state: GetState, permissions: GetPermissionManager) -> ApiResponseResult {
        permissions.has_admin_permission("extensions.manage")?;

        let settings = crate::settings::load(&state.0).await?;
        ApiResponse::new_serialized(Response {
            settings: SettingsResponse {
                enabled: settings.advertising_enabled,
                custom_ad_image_url: settings.custom_ad_image_url.to_string(),
                custom_ad_target_url: settings.custom_ad_target_url.to_string(),
                custom_ad_alt_text: settings.custom_ad_alt_text.to_string(),
            },
        })
        .ok()
    }
}

mod put {
    use super::*;

    #[derive(ToSchema, Deserialize)]
    struct PayloadData {
        enabled: bool,
        custom_ad_image_url: String,
        custom_ad_target_url: String,
        custom_ad_alt_text: String,
    }

    #[derive(ToSchema, Serialize)]
    struct Response {}

    fn is_https_url(value: &str) -> bool {
        let Ok(url) = Url::parse(value) else {
            return false;
        };

        url.scheme() == "https"
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
    }

    fn invalid_settings() -> ApiResponse {
        ApiResponse::error("One or more advertising settings are invalid.")
            .with_status(StatusCode::BAD_REQUEST)
    }

    #[utoipa::path(put, path = "/", responses(
        (status = OK, body = inline(Response)),
    ), request_body = inline(PayloadData))]
    pub async fn route(
        state: GetState,
        permissions: GetPermissionManager,
        activity_logger: GetAdminActivityLogger,
        Payload(data): Payload<PayloadData>,
    ) -> ApiResponseResult {
        permissions.has_admin_permission("extensions.manage")?;

        let custom_ad_image_url = data.custom_ad_image_url.trim();
        let custom_ad_target_url = data.custom_ad_target_url.trim();
        let custom_ad_alt_text = data.custom_ad_alt_text.trim();

        let values_are_within_limits = custom_ad_image_url.len() <= 512
            && custom_ad_target_url.len() <= 512
            && custom_ad_alt_text.chars().count() <= 120;
        let banner_settings_are_valid = !data.enabled
            || (is_https_url(custom_ad_image_url)
                && is_https_url(custom_ad_target_url)
                && !custom_ad_alt_text.is_empty());

        if !values_are_within_limits || !banner_settings_are_valid {
            return Err(invalid_settings());
        }

        let mut settings = state.settings.get_mut().await?;
        {
            let extension_settings: &mut crate::settings::ExtensionSettingsData =
                settings.find_mut_extension_settings()?;

            extension_settings.advertising_enabled = data.enabled;
            extension_settings.custom_ad_image_url = custom_ad_image_url.into();
            extension_settings.custom_ad_target_url = custom_ad_target_url.into();
            extension_settings.custom_ad_alt_text = custom_ad_alt_text.into();
        }

        settings.save().await?;

        activity_logger
            .log(
                "settings:extensions:update",
                serde_json::json!({
                    "extension": "com.calagopus.chat",
                    "advertising_enabled": data.enabled,
                }),
            )
            .await;

        ApiResponse::new_serialized(Response {}).ok()
    }
}

pub fn router(state: &shared::State) -> OpenApiRouter<shared::State> {
    OpenApiRouter::new()
        .routes(routes!(get::route))
        .routes(routes!(put::route))
        .with_state(state.clone())
}
