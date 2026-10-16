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
    {
        let extension_settings: &mut crate::settings::ExtensionSettingsData =
            settings.find_mut_extension_settings()?;
        extension_settings.server_tool_pages = data.server_tool_pages;
    }

    settings.save().await?;
    activity_logger
        .log(
            "settings:extensions:update",
            serde_json::json!({
                "extension": "com.calagopus.chat",
                "server_tool_pages": data.server_tool_pages,
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
