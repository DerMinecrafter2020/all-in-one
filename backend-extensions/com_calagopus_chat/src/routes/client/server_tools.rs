use serde::Serialize;
use shared::{
    GetState,
    models::user::GetUser,
    response::{ApiResponse, ApiResponseResult},
};
use utoipa::ToSchema;
use utoipa_axum::{router::OpenApiRouter, routes};

#[derive(ToSchema, Serialize)]
struct SettingsResponse {
    settings: crate::settings::ServerToolPagesSettings,
}

#[utoipa::path(get, path = "/settings", responses(
    (status = OK, body = inline(SettingsResponse)),
))]
async fn route(state: GetState, _user: GetUser) -> ApiResponseResult {
    let settings = crate::settings::load(&state.0).await?;

    ApiResponse::new_serialized(SettingsResponse {
        settings: settings.server_tool_pages,
    })
    .ok()
}

pub fn router(state: &shared::State) -> OpenApiRouter<shared::State> {
    OpenApiRouter::new()
        .routes(routes!(route))
        .with_state(state.clone())
}
