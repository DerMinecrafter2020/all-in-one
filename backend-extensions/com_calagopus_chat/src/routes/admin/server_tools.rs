use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use shared::{
    GetState, Payload,
    models::{admin_activity::GetAdminActivityLogger, user::GetPermissionManager},
    response::{ApiResponse, ApiResponseResult},
};
use utoipa::ToSchema;
use utoipa_axum::{router::OpenApiRouter, routes};

#[derive(ToSchema, Deserialize)]
struct PayloadData {
    server_tool_pages: crate::settings::ServerToolPagesSettings,
    #[serde(default)]
    server_tool_egg_settings: Option<crate::settings::ServerToolEggSettings>,
}

#[derive(ToSchema, Serialize)]
struct Response {}

#[utoipa::path(put, path = "/", request_body = inline(PayloadData), responses(
    (status = OK, body = inline(Response)),
))]
async fn route(
    state: GetState,
    permissions: GetPermissionManager,
    activity_logger: GetAdminActivityLogger,
    Payload(data): Payload<PayloadData>,
) -> ApiResponseResult {
    permissions.has_admin_permission("extensions.manage")?;

    let mut settings = state.settings.get_mut().await?;
    let server_tool_pages = data.server_tool_pages;
    let server_tool_egg_settings = {
        let extension_settings: &mut crate::settings::ExtensionSettingsData =
            settings.find_mut_extension_settings()?;
        let server_tool_egg_settings = data
            .server_tool_egg_settings
            .unwrap_or_else(|| extension_settings.server_tool_egg_settings.clone());
        if !server_tool_egg_settings.is_valid() {
            return Err(ApiResponse::error("One or more selected Egg IDs are invalid.")
                .with_status(StatusCode::BAD_REQUEST));
        }
        extension_settings.server_tool_pages = server_tool_pages;
        extension_settings.server_tool_egg_settings = server_tool_egg_settings.clone();
        server_tool_egg_settings
    };

    settings.save().await?;
    activity_logger
        .log(
            "settings:extensions:update",
            serde_json::json!({
                "extension": "com.calagopus.chat",
                "server_tool_pages": server_tool_pages,
                "server_tool_egg_settings": server_tool_egg_settings,
            }),
        )
        .await;

    ApiResponse::new_serialized(Response {}).ok()
}

pub fn router(state: &shared::State) -> OpenApiRouter<shared::State> {
    OpenApiRouter::new()
        .routes(routes!(route))
        .with_state(state.clone())
}
