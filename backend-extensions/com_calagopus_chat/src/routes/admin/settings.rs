use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use shared::{
    GetState, Payload,
    models::{admin_activity::GetAdminActivityLogger, user::{GetPermissionManager, User}},
    response::{ApiResponse, ApiResponseResult},
};
use utoipa::ToSchema;
use utoipa_axum::{router::OpenApiRouter, routes};

mod models;

mod get {
    use super::*;
    use sqlx::Row;

    #[derive(ToSchema, Serialize)]
    struct SettingsResponse {
        ai_enabled: bool,
        ai_provider: String,
        ai_base_url: String,
        ai_model: String,
        ai_system_prompt: String,
        api_key_configured: bool,
        server_control_api_key_configured: bool,
        ai_server_info_enabled: bool,
        ai_server_power_enabled: bool,
        floating_widget_enabled: bool,
        server_tool_pages: crate::settings::ServerToolPagesSettings,
    }

    #[derive(ToSchema, Serialize)]
    struct Response {
        #[schema(inline)]
        settings: SettingsResponse,
        token_usage: TokenUsageResponse,
    }

    #[derive(ToSchema, Serialize)]
    struct TokenUsageResponse {
        input_tokens: i64,
        output_tokens: i64,
        reported_responses: i64,
    }

    #[utoipa::path(get, path = "/", responses(
        (status = OK, body = inline(Response)),
    ))]
    pub async fn route(
        state: GetState,
        permissions: GetPermissionManager,
    ) -> ApiResponseResult {
        permissions.has_admin_permission("extensions.manage")?;

        let settings = crate::settings::load(&state.0).await?;
        let usage = sqlx::query(
            r#"
            SELECT
                COALESCE(SUM(input_tokens), 0)::BIGINT AS input_tokens,
                COALESCE(SUM(output_tokens), 0)::BIGINT AS output_tokens,
                COUNT(*) FILTER (
                    WHERE input_tokens IS NOT NULL OR output_tokens IS NOT NULL
                ) AS reported_responses
            FROM com_calagopus_chat_messages
            WHERE sender_kind = 'ai'
            "#,
        )
        .fetch_one(state.database.read())
        .await?;

        ApiResponse::new_serialized(Response {
            settings: SettingsResponse {
                ai_enabled: settings.ai_enabled,
                ai_provider: settings.ai_provider.to_string(),
                ai_base_url: settings.ai_base_url.to_string(),
                ai_model: settings.ai_model.to_string(),
                ai_system_prompt: settings.ai_system_prompt.to_string(),
                api_key_configured: !settings.ai_api_key.trim().is_empty(),
                server_control_api_key_configured: !settings.ai_server_control_api_key.trim().is_empty(),
                ai_server_info_enabled: settings.ai_server_info_enabled,
                ai_server_power_enabled: settings.ai_server_power_enabled
                    && !settings.ai_server_control_api_key.trim().is_empty(),
                floating_widget_enabled: settings.floating_widget_enabled,
                server_tool_pages: settings.server_tool_pages,
            },
            token_usage: TokenUsageResponse {
                input_tokens: usage.try_get("input_tokens")?,
                output_tokens: usage.try_get("output_tokens")?,
                reported_responses: usage.try_get("reported_responses")?,
            },
        })
        .ok()
    }
}

mod put {
    use super::*;
    use url::Url;

    fn default_floating_widget_enabled() -> bool {
        true
    }

    #[derive(ToSchema, Deserialize)]
    pub struct PayloadData {
        ai_enabled: bool,
        ai_provider: String,
        ai_base_url: String,
        ai_model: String,
        ai_system_prompt: String,
        ai_api_key: Option<String>,
        server_control_api_key: Option<String>,
        #[serde(default)]
        ai_server_info_enabled: bool,
        #[serde(default)]
        ai_server_power_enabled: bool,
        #[serde(default)]
        clear_server_control_api_key: bool,
        #[serde(default = "default_floating_widget_enabled")]
        floating_widget_enabled: bool,
        #[serde(default)]
        server_tool_pages: Option<crate::settings::ServerToolPagesSettings>,
        #[serde(default)]
        clear_api_key: bool,
    }

    #[derive(ToSchema, Serialize)]
    struct Response {}

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

        let ai_base_url = data.ai_base_url.trim();
        let Ok(parsed_url) = Url::parse(ai_base_url) else {
            return Err(ApiResponse::error("Enter a valid AI provider URL.")
                .with_status(StatusCode::BAD_REQUEST));
        };

        if !matches!(parsed_url.scheme(), "http" | "https") || parsed_url.host_str().is_none() {
            return Err(ApiResponse::error("The AI provider URL must use HTTP or HTTPS.")
                .with_status(StatusCode::BAD_REQUEST));
        }

        let ai_model = data.ai_model.trim();
        let ai_system_prompt = data.ai_system_prompt.trim();
        let api_key = data.ai_api_key.as_deref().unwrap_or_default().trim();
        let server_control_api_key = data
            .server_control_api_key
            .as_deref()
            .unwrap_or_default()
            .trim();
        let ai_provider = data.ai_provider.trim();

        if !matches!(
            ai_provider,
            "openai_compatible" | "openrouter" | "anthropic" | "google_gemini" | "ollama"
        )
            || ai_base_url.len() > 512
            || ai_model.is_empty()
            || ai_model.len() > 128
            || ai_system_prompt.is_empty()
            || ai_system_prompt.chars().count() > 4000
            || api_key.chars().count() > 4096
            || server_control_api_key.chars().count() > 4096
            || (data.ai_server_power_enabled && !data.ai_server_info_enabled)
        {
            return Err(ApiResponse::error("One or more AI settings are outside the allowed limits.")
                .with_status(StatusCode::BAD_REQUEST));
        }

        let current_settings = crate::settings::load(&state.0).await?;
        let server_tool_pages = data
            .server_tool_pages
            .unwrap_or(current_settings.server_tool_pages);
        let effective_server_control_api_key = if data.clear_server_control_api_key {
            ""
        } else if !server_control_api_key.is_empty() {
            server_control_api_key
        } else {
            current_settings.ai_server_control_api_key.trim()
        };

        if data.ai_server_power_enabled
            || (!data.clear_server_control_api_key && !server_control_api_key.is_empty())
        {
            if effective_server_control_api_key.is_empty() {
                return Err(ApiResponse::error(
                    "A Panel user API key is required to enable AI server power controls.",
                )
                .with_status(StatusCode::BAD_REQUEST));
            }

            let Some((control_user, control_api_key)) = User::by_api_key_cached(
                &state.database,
                effective_server_control_api_key,
            )
            .await?
            else {
                return Err(ApiResponse::error(
                    "The Panel server-control API key is invalid or expired.",
                )
                .with_status(StatusCode::BAD_REQUEST));
            };

            const REQUIRED_SERVER_PERMISSIONS: &[&str] =
                &["control.start", "control.stop", "control.restart"];
            if !control_api_key.enabled
                || control_user.frozen
                || control_user.suspended
                || REQUIRED_SERVER_PERMISSIONS.iter().any(|required| {
                    !control_api_key
                        .server_permissions
                        .iter()
                        .any(|permission| permission.as_str() == *required)
                })
            {
                return Err(ApiResponse::error(
                    "The Panel server-control API key must be enabled and include control.start, control.stop, and control.restart permissions.",
                )
                .with_status(StatusCode::BAD_REQUEST));
            }
        }

        let api_key_updated = data.clear_api_key || !api_key.is_empty();
        let server_control_api_key_updated =
            data.clear_server_control_api_key || !server_control_api_key.is_empty();
        let mut settings = state.settings.get_mut().await?;
        {
            let extension_settings: &mut crate::settings::ExtensionSettingsData =
                settings.find_mut_extension_settings()?;

            extension_settings.ai_enabled = data.ai_enabled;
            extension_settings.ai_provider = ai_provider.into();
            extension_settings.ai_base_url = ai_base_url.into();
            extension_settings.ai_model = ai_model.into();
            extension_settings.ai_system_prompt = ai_system_prompt.into();
            extension_settings.ai_server_info_enabled = data.ai_server_info_enabled;
            extension_settings.ai_server_power_enabled = data.ai_server_power_enabled;
            extension_settings.floating_widget_enabled = data.floating_widget_enabled;
            extension_settings.server_tool_pages = server_tool_pages;

            if data.clear_api_key {
                extension_settings.ai_api_key = compact_str::CompactString::default();
            } else if !api_key.is_empty() {
                extension_settings.ai_api_key = api_key.into();
            }

            if data.clear_server_control_api_key {
                extension_settings.ai_server_control_api_key =
                    compact_str::CompactString::default();
            } else if !server_control_api_key.is_empty() {
                extension_settings.ai_server_control_api_key = server_control_api_key.into();
            }
        }

        settings.save().await?;

        activity_logger
            .log(
                "settings:extensions:update",
                serde_json::json!({
                    "extension": "com.calagopus.chat",
                    "ai_enabled": data.ai_enabled,
                    "ai_provider": ai_provider,
                    "ai_server_info_enabled": data.ai_server_info_enabled,
                    "ai_server_power_enabled": data.ai_server_power_enabled,
                    "floating_widget_enabled": data.floating_widget_enabled,
                    "server_tool_pages": server_tool_pages,
                    "api_key_updated": api_key_updated,
                    "server_control_api_key_updated": server_control_api_key_updated,
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
        .nest("/models", models::router(state))
        .with_state(state.clone())
}
