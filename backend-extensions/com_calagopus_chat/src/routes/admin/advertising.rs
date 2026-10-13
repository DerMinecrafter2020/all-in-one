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
    struct Response {
        settings: crate::settings::AdvertisingSettings,
    }

    #[utoipa::path(get, path = "/", responses(
        (status = OK, body = inline(Response)),
    ))]
    pub async fn route(state: GetState, permissions: GetPermissionManager) -> ApiResponseResult {
        permissions.has_admin_permission("extensions.manage")?;

        let settings = crate::settings::load(&state.0).await?;
        ApiResponse::new_serialized(Response {
            settings: settings.advertising,
        })
        .ok()
    }
}

mod put {
    use super::*;
    use crate::settings::{AdvertisingSettings, AdvertisingSlotSettings, AdvertisingSlots};

    #[derive(ToSchema, Deserialize)]
    pub struct PayloadData {
        scope: String,
        slots: AdvertisingSlots,
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

    fn validate_slot(slot: &mut AdvertisingSlotSettings) -> bool {
        let mode = slot.mode.trim().to_string();
        if !matches!(mode.as_str(), "custom_banner" | "sandboxed_iframe")
            || !(1..=2000).contains(&slot.width)
            || !(1..=2000).contains(&slot.height)
        {
            return false;
        }

        slot.mode = mode.into();
        slot.custom_ad_image_url = slot.custom_ad_image_url.trim().into();
        slot.custom_ad_target_url = slot.custom_ad_target_url.trim().into();
        slot.custom_ad_iframe_url = slot.custom_ad_iframe_url.trim().into();
        slot.custom_ad_alt_text = slot.custom_ad_alt_text.trim().into();

        if slot.custom_ad_image_url.len() > 512
            || slot.custom_ad_target_url.len() > 512
            || slot.custom_ad_iframe_url.len() > 512
            || slot.custom_ad_alt_text.chars().count() > 120
        {
            return false;
        }

        if !slot.enabled {
            return true;
        }

        match slot.mode.as_str() {
            "custom_banner" => {
                is_https_url(slot.custom_ad_image_url.as_str())
                    && is_https_url(slot.custom_ad_target_url.as_str())
                    && !slot.custom_ad_alt_text.is_empty()
            }
            "sandboxed_iframe" => is_https_url(slot.custom_ad_iframe_url.as_str()),
            _ => false,
        }
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

        let scope = data.scope.trim().to_string();
        let mut slots = data.slots;
        if !matches!(scope.as_str(), "all" | "dashboard")
            || !validate_slot(&mut slots.top)
            || !validate_slot(&mut slots.bottom)
            || !validate_slot(&mut slots.left)
            || !validate_slot(&mut slots.right)
        {
            return Err(invalid_settings());
        }

        let advertising = AdvertisingSettings {
            scope: scope.clone().into(),
            slots,
        };
        let mut settings = state.settings.get_mut().await?;
        {
            let extension_settings: &mut crate::settings::ExtensionSettingsData =
                settings.find_mut_extension_settings()?;
            extension_settings.advertising = advertising.clone();
        }

        settings.save().await?;

        activity_logger
            .log(
                "settings:extensions:update",
                serde_json::json!({
                    "extension": "com.calagopus.chat",
                    "advertising_scope": scope,
                    "enabled_slots": {
                        "top": advertising.slots.top.enabled,
                        "bottom": advertising.slots.bottom.enabled,
                        "left": advertising.slots.left.enabled,
                        "right": advertising.slots.right.enabled,
                    },
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
