use serde::Serialize;
use shared::{
    GetState,
    models::user::GetUser,
    response::{ApiResponse, ApiResponseResult},
};
use utoipa::ToSchema;
use utoipa_axum::{router::OpenApiRouter, routes};

#[derive(ToSchema, Serialize)]
struct SlotResponse {
    enabled: bool,
    mode: String,
    width: u16,
    height: u16,
    custom_ad_image_url: String,
    custom_ad_target_url: String,
    custom_ad_alt_text: String,
    custom_ad_iframe_url: String,
}

#[derive(ToSchema, Serialize)]
struct SlotsResponse {
    top: SlotResponse,
    bottom: SlotResponse,
    left: SlotResponse,
    right: SlotResponse,
}

#[derive(ToSchema, Serialize)]
struct Response {
    scope: String,
    slots: SlotsResponse,
}

fn public_slot(slot: &crate::settings::AdvertisingSlotSettings) -> SlotResponse {
    let enabled = slot.is_available();
    let mode = if slot.mode.as_str() == "sandboxed_iframe" {
        "sandboxed_iframe"
    } else {
        "custom_banner"
    };
    let custom_banner_is_active = enabled && mode == "custom_banner";
    let iframe_is_active = enabled && mode == "sandboxed_iframe";

    SlotResponse {
        enabled,
        mode: mode.to_string(),
        width: slot.width.clamp(1, 2000),
        height: slot.height.clamp(1, 2000),
        custom_ad_image_url: if custom_banner_is_active {
            slot.custom_ad_image_url.to_string()
        } else {
            String::new()
        },
        custom_ad_target_url: if custom_banner_is_active {
            slot.custom_ad_target_url.to_string()
        } else {
            String::new()
        },
        custom_ad_alt_text: if custom_banner_is_active {
            slot.custom_ad_alt_text.to_string()
        } else {
            String::new()
        },
        custom_ad_iframe_url: if iframe_is_active {
            slot.custom_ad_iframe_url.to_string()
        } else {
            String::new()
        },
    }
}

#[utoipa::path(get, path = "/", responses(
    (status = OK, body = inline(Response)),
))]
async fn route(state: GetState, _user: GetUser) -> ApiResponseResult {
    let settings = crate::settings::load(&state.0).await?;
    let advertising = &settings.advertising;

    ApiResponse::new_serialized(Response {
        scope: if advertising.scope.as_str() == "dashboard" {
            "dashboard".to_string()
        } else {
            "all".to_string()
        },
        slots: SlotsResponse {
            top: public_slot(&advertising.slots.top),
            bottom: public_slot(&advertising.slots.bottom),
            left: public_slot(&advertising.slots.left),
            right: public_slot(&advertising.slots.right),
        },
    })
    .ok()
}

pub fn router(state: &shared::State) -> OpenApiRouter<shared::State> {
    OpenApiRouter::new()
        .routes(routes!(route))
        .with_state(state.clone())
}
