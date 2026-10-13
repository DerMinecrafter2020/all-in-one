use serde::Serialize;
use shared::{
    GetState,
    models::user::GetUser,
    response::{ApiResponse, ApiResponseResult},
};
use utoipa::ToSchema;
use utoipa_axum::{router::OpenApiRouter, routes};

#[derive(ToSchema, Serialize)]
struct Response {
    enabled: bool,
    mode: String,
    custom_ad_image_url: String,
    custom_ad_target_url: String,
    custom_ad_alt_text: String,
    custom_ad_iframe_url: String,
}

#[utoipa::path(get, path = "/", responses(
    (status = OK, body = inline(Response)),
))]
async fn route(state: GetState, _user: GetUser) -> ApiResponseResult {
    let settings = crate::settings::load(&state.0).await?;
    let enabled = settings.advertising_available();
    let mode = if enabled {
        settings.advertising_mode.as_str()
    } else {
        "custom_banner"
    };
    let custom_banner_is_active = enabled && mode == "custom_banner";
    let iframe_is_active = enabled && mode == "sandboxed_iframe";

    ApiResponse::new_serialized(Response {
        enabled,
        mode: mode.to_string(),
        custom_ad_image_url: if custom_banner_is_active {
            settings.custom_ad_image_url.to_string()
        } else {
            String::new()
        },
        custom_ad_target_url: if custom_banner_is_active {
            settings.custom_ad_target_url.to_string()
        } else {
            String::new()
        },
        custom_ad_alt_text: if custom_banner_is_active {
            settings.custom_ad_alt_text.to_string()
        } else {
            String::new()
        },
        custom_ad_iframe_url: if iframe_is_active {
            settings.custom_ad_iframe_url.to_string()
        } else {
            String::new()
        },
    })
    .ok()
}

pub fn router(state: &shared::State) -> OpenApiRouter<shared::State> {
    OpenApiRouter::new()
        .routes(routes!(route))
        .with_state(state.clone())
}
