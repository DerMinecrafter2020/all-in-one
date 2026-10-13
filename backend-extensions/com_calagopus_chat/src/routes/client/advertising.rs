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
    custom_ad_image_url: String,
    custom_ad_target_url: String,
    custom_ad_alt_text: String,
}

#[utoipa::path(get, path = "/", responses(
    (status = OK, body = inline(Response)),
))]
async fn route(state: GetState, _user: GetUser) -> ApiResponseResult {
    let settings = crate::settings::load(&state.0).await?;
    let enabled = settings.advertising_available();

    ApiResponse::new_serialized(Response {
        enabled,
        custom_ad_image_url: if enabled {
            settings.custom_ad_image_url.to_string()
        } else {
            String::new()
        },
        custom_ad_target_url: if enabled {
            settings.custom_ad_target_url.to_string()
        } else {
            String::new()
        },
        custom_ad_alt_text: if enabled {
            settings.custom_ad_alt_text.to_string()
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
