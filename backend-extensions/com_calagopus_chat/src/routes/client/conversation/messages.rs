use axum::{extract::Path, http::StatusCode};
use serde::{Deserialize, Serialize};
use shared::{
    GetIp, GetRequestHost, GetState, Payload,
    models::{
        user::{GetAuthMethod, GetPermissionManager, GetUser, GetUserImpersonator},
        user_activity::GetUserActivityLogger,
    },
    response::{ApiResponse, ApiResponseResult},
};
use sqlx::Row;
use utoipa::ToSchema;
use utoipa_axum::{router::OpenApiRouter, routes};

use super::ai_tools;
use crate::routes::client::models::{MessageSummary, PendingActionSummary};

mod get {
    use super::*;

    #[derive(ToSchema, Serialize)]
    struct Response {
        messages: Vec<MessageSummary>,
    }

    #[utoipa::path(get, path = "/", params(
        ("conversation" = uuid::Uuid, Path, description = "The conversation ID."),
    ), responses(
        (status = OK, body = inline(Response)),
    ))]
    pub async fn route(
        state: GetState,
        user: GetUser,
        permissions: GetPermissionManager,
        Path(conversation_uuid): Path<uuid::Uuid>,
    ) -> ApiResponseResult {
        permissions.has_user_permission("chat.read")?;

        if !super::super::is_member(&state.0, conversation_uuid, user.uuid).await? {
            return Err(ApiResponse::error("Conversation not found.")
                .with_status(StatusCode::NOT_FOUND));
        }

        let rows = sqlx::query(
            r#"
            SELECT
                messages.uuid,
                messages.conversation_uuid,
                messages.sender_uuid,
                COALESCE(
                    users.username::text,
                    CASE
                        WHEN messages.sender_kind = 'ai' THEN 'Calagopus AI'
                        ELSE 'Former user'
                    END
                ) AS sender_username,
                messages.sender_kind = 'ai' AS is_ai,
                messages.content,
                messages.created_at,
                messages.ai_action_server_name,
                messages.ai_action_type,
                messages.ai_action_owner_uuid,
                CASE
                    WHEN messages.ai_action_status = 'pending'
                      AND messages.ai_action_expires_at <= now() THEN 'expired'
                    ELSE messages.ai_action_status
                END AS ai_action_status,
                messages.ai_action_expires_at,
                COALESCE(
                    messages.ai_action_owner_uuid = $2
                    OR (
                        messages.ai_action_owner_uuid IS NULL
                        AND conversations.kind = 'ai'
                        AND conversations.created_by = $2
                    ),
                    false
                ) AS ai_action_can_confirm
            FROM com_calagopus_chat_messages AS messages
            LEFT JOIN users ON users.uuid = messages.sender_uuid
            JOIN com_calagopus_chat_conversations AS conversations
              ON conversations.uuid = messages.conversation_uuid
            WHERE messages.conversation_uuid = $1
              AND EXISTS (
                  SELECT 1
                  FROM com_calagopus_chat_members AS members
                  WHERE members.conversation_uuid = messages.conversation_uuid
                    AND members.user_uuid = $2
              )
            ORDER BY messages.created_at DESC, messages.uuid DESC
            LIMIT 100
            "#,
        )
        .bind(conversation_uuid)
        .bind(user.uuid)
        .fetch_all(state.database.read())
        .await?;

        let mut messages = rows
            .into_iter()
            .map(|row| {
                let pending_action = match (
                    row.try_get::<Option<String>, _>("ai_action_type")?,
                    row.try_get::<Option<String>, _>("ai_action_server_name")?,
                    row.try_get::<Option<String>, _>("ai_action_status")?,
                    row.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>(
                        "ai_action_expires_at",
                    )?,
                    row.try_get::<bool, _>("ai_action_can_confirm")?,
                ) {
                    (Some(action_type), Some(server_name), Some(status), Some(expires_at), can_confirm) => {
                        Some(PendingActionSummary {
                            action_type,
                            server_name,
                            status,
                            expires_at,
                            can_confirm,
                        })
                    }
                    _ => None,
                };

                Ok(MessageSummary {
                    uuid: row.try_get("uuid")?,
                    conversation_uuid: row.try_get("conversation_uuid")?,
                    sender_uuid: row.try_get("sender_uuid")?,
                    sender_username: row.try_get("sender_username")?,
                    is_ai: row.try_get("is_ai")?,
                    content: row.try_get("content")?,
                    created_at: row.try_get("created_at")?,
                    pending_action,
                })
            })
            .collect::<Result<Vec<_>, sqlx::Error>>()?;
        messages.reverse();

        ApiResponse::new_serialized(Response { messages }).ok()
    }
}

mod post {
    use super::*;
    use shared::models::ByUuid;

    #[derive(ToSchema, Deserialize)]
    pub struct PayloadData {
        content: String,
    }

    #[derive(ToSchema, Serialize)]
    struct Response {
        message_uuid: uuid::Uuid,
        ai_message_uuid: Option<uuid::Uuid>,
    }

    struct AiReply {
        content: String,
        input_tokens: Option<i64>,
        output_tokens: Option<i64>,
        pending_action: Option<ai_tools::PendingPowerAction>,
    }

    const MAX_TOOL_ROUNDS: usize = 4;
    const MAX_TOOL_CALLS_PER_TURN: usize = 8;
    const MAX_AI_PROVIDER_RESPONSE_BYTES: usize = 4 * 1024 * 1024;

    fn accumulate_token_count(total: &mut Option<i64>, next: Option<i64>) {
        if let Some(next) = next {
            *total = Some((*total).unwrap_or(0).saturating_add(next));
        }
    }

    fn pending_action_reply(
        action: ai_tools::PendingPowerAction,
        input_tokens: Option<i64>,
        output_tokens: Option<i64>,
    ) -> AiReply {
        AiReply {
            content: String::new(),
            input_tokens,
            output_tokens,
            pending_action: Some(action),
        }
    }

    fn explicitly_mentions_ai(content: &str) -> bool {
        content.split_whitespace().any(|word| {
            word.trim_matches(|character: char| {
                !character.is_alphanumeric() && character != '@' && character != '_'
            })
            .eq_ignore_ascii_case("@ai")
        })
    }

    #[utoipa::path(post, path = "/", params(
        ("conversation" = uuid::Uuid, Path, description = "The conversation ID."),
    ), responses(
        (status = OK, body = inline(Response)),
    ), request_body = inline(PayloadData))]
    pub async fn route(
        state: GetState,
        user: GetUser,
        permissions: GetPermissionManager,
        activity_logger: GetUserActivityLogger,
        auth_method: GetAuthMethod,
        user_impersonator: GetUserImpersonator,
        ip: GetIp,
        request_host: GetRequestHost,
        Path(conversation_uuid): Path<uuid::Uuid>,
        Payload(data): Payload<PayloadData>,
    ) -> ApiResponseResult {
        permissions.has_user_permission("chat.send")?;

        let content = data.content.trim();
        if content.is_empty() || content.chars().count() > 4000 {
            return Err(ApiResponse::error(
                "Messages must contain between 1 and 4000 characters.",
            )
            .with_status(StatusCode::BAD_REQUEST));
        }

        let Some((kind, conversation_ai_enabled)) =
            super::super::conversation_info(&state.0, conversation_uuid, user.uuid).await?
        else {
            return Err(ApiResponse::error("Conversation not found.")
                .with_status(StatusCode::NOT_FOUND));
        };

        let group_ai = kind == "group" && conversation_ai_enabled;
        let should_invoke_ai = kind == "ai" || (group_ai && explicitly_mentions_ai(content));
        let group_members: Vec<shared::models::user::User> = if group_ai && should_invoke_ai {
            let group_member_uuids: Vec<uuid::Uuid> = sqlx::query_scalar(
                "SELECT user_uuid FROM com_calagopus_chat_members WHERE conversation_uuid = $1",
            )
            .bind(conversation_uuid)
            .fetch_all(state.database.read())
            .await?;
            let mut members = Vec::with_capacity(group_member_uuids.len());
            for member_uuid in group_member_uuids {
                let Some(member) = shared::models::user::User::by_uuid_optional_cached(
                    &state.database,
                    member_uuid,
                )
                .await?
                else {
                    return Err(ApiResponse::error(
                        "Could not verify every member of this AI group.",
                    )
                    .with_status(StatusCode::BAD_GATEWAY));
                };
                members.push(member);
            }
            members
        } else {
            Vec::new()
        };
        let ai_settings = if should_invoke_ai {
            let settings = crate::settings::load(&state.0).await?;
            if !settings.ai_available() {
                return Err(ApiResponse::error(
                    "AI chat is not available. Ask an administrator to configure it.",
                )
                .with_status(StatusCode::SERVICE_UNAVAILABLE));
            }
            Some(settings)
        } else {
            None
        };

        let message_uuid = uuid::Uuid::new_v4();
        sqlx::query(
            r#"
            INSERT INTO com_calagopus_chat_messages
                (uuid, conversation_uuid, sender_uuid, sender_kind, content)
            VALUES ($1, $2, $3, 'user', $4)
            "#,
        )
        .bind(message_uuid)
        .bind(conversation_uuid)
        .bind(user.uuid)
        .bind(content)
        .execute(state.database.write())
        .await?;

        activity_logger
            .log(
                "user:chat.message.create",
                serde_json::json!({
                    "conversation_uuid": conversation_uuid,
                    "message_uuid": message_uuid,
                    "ai_chat": kind == "ai" || group_ai,
                    "ai_mentioned": group_ai && should_invoke_ai,
                }),
            )
            .await;

        let ai_message_uuid = if let Some(settings) = ai_settings {
            let tool_context = ai_tools::ToolContext {
                state: &state.0,
                user: &user.0,
                auth_method: auth_method.0.as_ref(),
                impersonator: user_impersonator.0.as_ref().map(|impersonator| &impersonator.0),
                permissions: &permissions.0,
                ip: ip.0,
                request_host: request_host.0.as_deref(),
                server_info_enabled: settings.ai_server_info_enabled,
                server_power_enabled: settings.ai_server_power_enabled,
                server_control_api_key: settings.ai_server_control_api_key.as_str(),
                group_ai,
                group_members: &group_members,
            };
            let answer = match generate_ai_reply(
                &state.0,
                &settings,
                conversation_uuid,
                group_ai,
                &tool_context,
            )
            .await
            {
                Ok(answer) => answer,
                Err(error) => {
                    tracing::warn!(
                        conversation_uuid = %conversation_uuid,
                        "All-in-One AI request failed: {error:#}"
                    );
                    return Err(ApiResponse::error(
                        "The AI provider could not complete the request. Check the chat settings and try again.",
                    )
                    .with_status(StatusCode::BAD_GATEWAY));
                }
            };

            let AiReply {
                content,
                input_tokens,
                output_tokens,
                pending_action,
            } = answer;
            let (action_server_uuid, action_server_name, action_type, action_status) =
                match pending_action {
                    Some(action) => (
                        Some(action.server_uuid),
                        Some(action.server_name),
                        Some(action.action.as_str().to_string()),
                        Some("pending".to_string()),
                    ),
                    None => (None, None, None, None),
                };
            let action_owner_uuid = action_server_uuid.map(|_| user.uuid);
            let ai_message_uuid = uuid::Uuid::new_v4();
            sqlx::query(
                r#"
                INSERT INTO com_calagopus_chat_messages
                    (uuid, conversation_uuid, sender_uuid, sender_kind, content, input_tokens, output_tokens,
                     ai_action_server_uuid, ai_action_server_name, ai_action_type, ai_action_status,
                     ai_action_expires_at, ai_action_owner_uuid)
                VALUES ($1, $2, NULL, 'ai', $3, $4, $5, $6, $7, $8, $9,
                        CASE WHEN $6::uuid IS NULL THEN NULL ELSE now() + INTERVAL '5 minutes' END, $10)
                "#,
            )
            .bind(ai_message_uuid)
            .bind(conversation_uuid)
            .bind(content)
            .bind(input_tokens)
            .bind(output_tokens)
            .bind(action_server_uuid)
            .bind(action_server_name)
            .bind(action_type)
            .bind(action_status)
            .bind(action_owner_uuid)
            .execute(state.database.write())
            .await?;

            Some(ai_message_uuid)
        } else {
            None
        };

        sqlx::query(
            r#"
            UPDATE com_calagopus_chat_members
            SET last_read_at = now()
            WHERE conversation_uuid = $1 AND user_uuid = $2
            "#,
        )
        .bind(conversation_uuid)
        .bind(user.uuid)
        .execute(state.database.write())
        .await?;

        ApiResponse::new_serialized(Response {
            message_uuid,
            ai_message_uuid,
        })
        .ok()
    }

    async fn generate_ai_reply(
        state: &shared::State,
        settings: &crate::settings::ExtensionSettingsData,
        conversation_uuid: uuid::Uuid,
        group_ai: bool,
        tool_context: &ai_tools::ToolContext<'_>,
    ) -> Result<AiReply, anyhow::Error> {
        let rows = sqlx::query(
            r#"
            SELECT
                messages.sender_kind,
                COALESCE(users.username::text, 'Former user') AS sender_username,
                messages.content,
                messages.ai_action_server_name,
                messages.ai_action_type,
                CASE
                    WHEN messages.ai_action_status = 'pending' AND messages.ai_action_expires_at <= now()
                        THEN 'expired'
                    ELSE messages.ai_action_status
                END AS ai_action_status
            FROM com_calagopus_chat_messages AS messages
            LEFT JOIN users ON users.uuid = messages.sender_uuid
            WHERE messages.conversation_uuid = $1
            ORDER BY messages.created_at DESC, messages.uuid DESC
            LIMIT 20
            "#,
        )
        .bind(conversation_uuid)
        .fetch_all(state.database.read())
        .await?;

        let mut history = rows
            .into_iter()
            .map(|row| {
                let sender_kind: String = row.try_get("sender_kind")?;
                let mut content: String = row.try_get("content")?;
                if group_ai && sender_kind == "user" {
                    let sender_username: String = row.try_get("sender_username")?;
                    content = format!("{sender_username}: {content}");
                }

                if sender_kind == "ai"
                    && let (Some(action), Some(server), Some(status)) = (
                        row.try_get::<Option<String>, _>("ai_action_type")?,
                        row.try_get::<Option<String>, _>("ai_action_server_name")?,
                        row.try_get::<Option<String>, _>("ai_action_status")?,
                    )
                {
                    let summary = format!(
                        "[Panel server action record: {action} {server}; status: {status}.]"
                    );
                    if content.trim().is_empty() {
                        content = summary;
                    } else {
                        content.push_str("\n\n");
                        content.push_str(&summary);
                    }
                }

                Ok((sender_kind, content))
            })
            .collect::<Result<Vec<_>, sqlx::Error>>()?;
        history.reverse();

        let mut answer = match settings.ai_provider.as_str() {
            "openai_compatible" | "openrouter" | "ollama" => {
                generate_openai_compatible_reply(state, settings, &history, group_ai, tool_context)
                    .await?
            }
            "anthropic" => {
                generate_anthropic_reply(state, settings, &history, group_ai, tool_context).await?
            }
            "google_gemini" => {
                generate_gemini_reply(state, settings, &history, group_ai, tool_context).await?
            }
            provider => return Err(anyhow::anyhow!("unsupported AI provider `{provider}`")),
        };
        let content = answer.content.trim().chars().take(8000).collect::<String>();
        if content.is_empty() && answer.pending_action.is_none() {
            return Err(anyhow::anyhow!("AI provider returned an empty answer"));
        }
        answer.content = content;

        Ok(answer)
    }

    fn reported_token_count(value: Option<&serde_json::Value>) -> Option<i64> {
        value?
            .as_u64()
            .and_then(|count| i64::try_from(count).ok())
    }

    fn server_tool_system_prompt(
        settings: &crate::settings::ExtensionSettingsData,
        group_ai: bool,
    ) -> String {
        let mut prompt = settings.ai_system_prompt.to_string();
        if settings.ai_server_info_enabled {
            prompt.push_str(
                "\n\nUse the provided server tools for live information and only discuss servers they return for the current Panel user. Never guess server names, identifiers, or status.",
            );
            if settings.ai_server_power_enabled
                && !settings.ai_server_control_api_key.trim().is_empty()
            {
                prompt.push_str(
                    " Power tools only prepare a start, stop, or restart request; they do not execute it. Tell the user which server and action are awaiting confirmation, and do not claim the action happened until the user confirms. Do not suggest or simulate console commands, file changes, or other unavailable actions.",
                );
            } else {
                prompt.push_str(
                    " Server power actions, console commands, and file changes are not available. Do not claim to perform them.",
                );
            }
        } else {
            prompt.push_str(
                "\n\nYou do not have live access to Panel server tools in this conversation. Do not claim to know a server's current state or to perform a server action.",
            );
        }
        if group_ai {
            prompt.push_str(
                " In this shared group, respond only when the current user explicitly mentions you with @AI. Address the group clearly, do not treat one member's instructions as the wishes of every participant, and only share server information returned by tools after the group access check.",
            );
        }
        prompt
    }

    fn openai_messages(
        settings: &crate::settings::ExtensionSettingsData,
        history: &[(String, String)],
        group_ai: bool,
    ) -> Vec<serde_json::Value> {
        let mut messages = vec![serde_json::json!({
            "role": "system",
            "content": server_tool_system_prompt(settings, group_ai),
        })];

        for (sender_kind, content) in history {
            messages.push(serde_json::json!({
                "role": if sender_kind.as_str() == "ai" { "assistant" } else { "user" },
                "content": content,
            }));
        }

        messages
    }

    async fn send_provider_request(
        request: reqwest::RequestBuilder,
    ) -> Result<serde_json::Value, anyhow::Error> {
        let mut response = request.send().await?;
        let status = response.status();
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("unknown")
            .to_string();
        if !status.is_success() {
            return Err(anyhow::anyhow!(
                "AI provider returned HTTP {status} (content type: {content_type})"
            ));
        }

        if response
            .content_length()
            .is_some_and(|length| length > MAX_AI_PROVIDER_RESPONSE_BYTES as u64)
        {
            return Err(anyhow::anyhow!(
                "AI provider response exceeded the supported size limit."
            ));
        }

        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            if body.len().saturating_add(chunk.len()) > MAX_AI_PROVIDER_RESPONSE_BYTES {
                return Err(anyhow::anyhow!(
                    "AI provider response exceeded the supported size limit."
                ));
            }
            body.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&body).map_err(|error| {
            tracing::warn!(
                http_status = %status,
                content_type = %content_type,
                "AI provider returned invalid JSON: {error}"
            );
            anyhow::anyhow!(
                "AI provider returned an invalid JSON response (HTTP {status}, content type: {content_type}): {error}"
            )
        })
    }

    async fn generate_openai_compatible_reply(
        state: &shared::State,
        settings: &crate::settings::ExtensionSettingsData,
        history: &[(String, String)],
        group_ai: bool,
        tool_context: &ai_tools::ToolContext<'_>,
    ) -> Result<AiReply, anyhow::Error> {
        let endpoint = format!(
            "{}/chat/completions",
            settings.ai_base_url.trim_end_matches('/')
        );
        let definitions = ai_tools::definitions(
            settings.ai_server_info_enabled,
            settings.ai_server_power_enabled,
            !settings.ai_server_control_api_key.trim().is_empty(),
        );
        let tools = ai_tools::openai_definitions(&definitions);
        let mut messages = openai_messages(settings, history, group_ai);
        let mut input_tokens = None;
        let mut output_tokens = None;
        let mut tool_call_count = 0;

        for round in 0..=MAX_TOOL_ROUNDS {
            let mut payload = serde_json::json!({
                "model": settings.ai_model.as_str(),
                "messages": messages.clone(),
                "max_tokens": 1024,
            });
            if !tools.is_empty() {
                payload["tools"] = serde_json::json!(tools.clone());
                payload["tool_choice"] = serde_json::json!("auto");
            }

            let mut request = state.client.post(&endpoint).json(&payload);
            if !settings.ai_api_key.trim().is_empty() {
                request = request.bearer_auth(settings.ai_api_key.as_str());
            }
            if settings.ai_provider.as_str() == "openrouter" {
                request = request
                    .header("HTTP-Referer", "https://calagopus.com")
                    .header("X-Title", "All-in-One");
            }

            let response = send_provider_request(request).await?;
            let usage = response.get("usage");
            accumulate_token_count(
                &mut input_tokens,
                reported_token_count(usage.and_then(|usage| usage.get("prompt_tokens"))),
            );
            accumulate_token_count(
                &mut output_tokens,
                reported_token_count(usage.and_then(|usage| usage.get("completion_tokens"))),
            );

            let message = response
                .pointer("/choices/0/message")
                .ok_or_else(|| anyhow::anyhow!("AI provider returned no chat-completion message"))?;
            let tool_calls = message
                .get("tool_calls")
                .and_then(serde_json::Value::as_array)
                .filter(|calls| !calls.is_empty());

            let Some(tool_calls) = tool_calls else {
                let content = message
                    .get("content")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(|| anyhow::anyhow!("AI provider returned no chat-completion text"))?;
                return Ok(AiReply {
                    content: content.to_string(),
                    input_tokens,
                    output_tokens,
                    pending_action: None,
                });
            };

            if round == MAX_TOOL_ROUNDS {
                return Err(anyhow::anyhow!("The AI exceeded the server tool-call limit."));
            }

            messages.push(serde_json::json!({
                "role": "assistant",
                "content": message.get("content"),
                "tool_calls": tool_calls,
            }));

            for tool_call in tool_calls {
                if tool_call_count >= MAX_TOOL_CALLS_PER_TURN {
                    return Err(anyhow::anyhow!("The AI exceeded the server tool-call limit."));
                }
                tool_call_count += 1;

                let call_id = tool_call
                    .get("id")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default();
                let function = tool_call.get("function");
                let name = function
                    .and_then(|function| function.get("name"))
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default();
                let arguments = function
                    .and_then(|function| function.get("arguments"))
                    .and_then(serde_json::Value::as_str)
                    .and_then(|arguments| serde_json::from_str(arguments).ok())
                    .unwrap_or(serde_json::Value::Null);

                let result = match ai_tools::execute(tool_context, name, &arguments).await {
                    Ok(ai_tools::ToolExecution::Result(result)) => result,
                    Ok(ai_tools::ToolExecution::Pending(action)) => {
                        return Ok(pending_action_reply(action, input_tokens, output_tokens));
                    }
                    Err(error) => serde_json::json!({ "error": error.to_string() }),
                };

                messages.push(serde_json::json!({
                    "role": "tool",
                    "tool_call_id": call_id,
                    "content": result.to_string(),
                }));
            }
        }

        Err(anyhow::anyhow!("The AI could not finish the server tool request."))
    }

    async fn generate_anthropic_reply(
        state: &shared::State,
        settings: &crate::settings::ExtensionSettingsData,
        history: &[(String, String)],
        group_ai: bool,
        tool_context: &ai_tools::ToolContext<'_>,
    ) -> Result<AiReply, anyhow::Error> {
        let mut messages = history
            .iter()
            .map(|(sender_kind, content)| {
                serde_json::json!({
                    "role": if sender_kind.as_str() == "ai" { "assistant" } else { "user" },
                    "content": content,
                })
            })
            .collect::<Vec<_>>();
        let endpoint = format!("{}/v1/messages", settings.ai_base_url.trim_end_matches('/'));
        let definitions = ai_tools::definitions(
            settings.ai_server_info_enabled,
            settings.ai_server_power_enabled,
            !settings.ai_server_control_api_key.trim().is_empty(),
        );
        let tools = ai_tools::anthropic_definitions(&definitions);
        let system_prompt = server_tool_system_prompt(settings, group_ai);
        let mut input_tokens = None;
        let mut output_tokens = None;
        let mut tool_call_count = 0;

        for round in 0..=MAX_TOOL_ROUNDS {
            let mut payload = serde_json::json!({
                    "model": settings.ai_model.as_str(),
                    "max_tokens": 1024,
                    "system": system_prompt.as_str(),
                    "messages": messages.clone(),
                });
            if !tools.is_empty() {
                payload["tools"] = serde_json::json!(tools.clone());
            }

            let response = send_provider_request(
                state
                    .client
                    .post(&endpoint)
                    .header("x-api-key", settings.ai_api_key.as_str())
                    .header("anthropic-version", "2023-06-01")
                    .json(&payload),
            )
            .await?;
            let usage = response.get("usage");
            accumulate_token_count(
                &mut input_tokens,
                reported_token_count(usage.and_then(|usage| usage.get("input_tokens"))),
            );
            accumulate_token_count(
                &mut output_tokens,
                reported_token_count(usage.and_then(|usage| usage.get("output_tokens"))),
            );

            let blocks = response
                .get("content")
                .and_then(serde_json::Value::as_array)
                .ok_or_else(|| anyhow::anyhow!("Anthropic returned no message content"))?;
            let tool_uses = blocks
                .iter()
                .filter(|block| {
                    block.get("type").and_then(serde_json::Value::as_str) == Some("tool_use")
                })
                .collect::<Vec<_>>();

            if tool_uses.is_empty() {
                let content = blocks
                    .iter()
                    .filter(|block| {
                        block.get("type").and_then(serde_json::Value::as_str) == Some("text")
                    })
                    .filter_map(|block| block.get("text").and_then(serde_json::Value::as_str))
                    .collect::<Vec<_>>()
                    .join("");

                return Ok(AiReply {
                    content,
                    input_tokens,
                    output_tokens,
                    pending_action: None,
                });
            }

            if round == MAX_TOOL_ROUNDS {
                return Err(anyhow::anyhow!("The AI exceeded the server tool-call limit."));
            }

            messages.push(serde_json::json!({
                "role": "assistant",
                "content": blocks.clone(),
            }));
            let mut tool_results = Vec::with_capacity(tool_uses.len());
            for tool_use in tool_uses {
                if tool_call_count >= MAX_TOOL_CALLS_PER_TURN {
                    return Err(anyhow::anyhow!("The AI exceeded the server tool-call limit."));
                }
                tool_call_count += 1;

                let name = tool_use
                    .get("name")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default();
                let id = tool_use
                    .get("id")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default();
                let arguments = tool_use
                    .get("input")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null);

                let result = match ai_tools::execute(tool_context, name, &arguments).await {
                    Ok(ai_tools::ToolExecution::Result(result)) => result,
                    Ok(ai_tools::ToolExecution::Pending(action)) => {
                        return Ok(pending_action_reply(action, input_tokens, output_tokens));
                    }
                    Err(error) => serde_json::json!({ "error": error.to_string() }),
                };
                tool_results.push(serde_json::json!({
                    "type": "tool_result",
                    "tool_use_id": id,
                    "content": result.to_string(),
                }));
            }
            messages.push(serde_json::json!({
                "role": "user",
                "content": tool_results,
            }));
        }

        Err(anyhow::anyhow!("The AI could not finish the server tool request."))
    }

    async fn generate_gemini_reply(
        state: &shared::State,
        settings: &crate::settings::ExtensionSettingsData,
        history: &[(String, String)],
        group_ai: bool,
        tool_context: &ai_tools::ToolContext<'_>,
    ) -> Result<AiReply, anyhow::Error> {
        let mut contents = history
            .iter()
            .map(|(sender_kind, content)| {
                serde_json::json!({
                    "role": if sender_kind.as_str() == "ai" { "model" } else { "user" },
                    "parts": [{ "text": content }],
                })
            })
            .collect::<Vec<_>>();
        let model = urlencoding::encode(settings.ai_model.as_str());
        let endpoint = format!(
            "{}/models/{model}:generateContent",
            settings.ai_base_url.trim_end_matches('/')
        );
        let definitions = ai_tools::definitions(
            settings.ai_server_info_enabled,
            settings.ai_server_power_enabled,
            !settings.ai_server_control_api_key.trim().is_empty(),
        );
        let tools = ai_tools::gemini_definitions(&definitions);
        let system_prompt = server_tool_system_prompt(settings, group_ai);
        let mut input_tokens = None;
        let mut output_tokens = None;
        let mut tool_call_count = 0;

        for round in 0..=MAX_TOOL_ROUNDS {
            let mut payload = serde_json::json!({
                "systemInstruction": {
                    "parts": [{ "text": system_prompt.as_str() }]
                },
                "contents": contents.clone(),
                "generationConfig": { "maxOutputTokens": 1024 },
            });
            if !definitions.is_empty() {
                payload["tools"] = serde_json::json!(tools.clone());
            }

            let response = send_provider_request(
                state
                    .client
                    .post(&endpoint)
                    .header("x-goog-api-key", settings.ai_api_key.as_str())
                    .json(&payload),
            )
            .await?;
            let usage = response.get("usageMetadata");
            accumulate_token_count(
                &mut input_tokens,
                reported_token_count(usage.and_then(|usage| usage.get("promptTokenCount"))),
            );
            accumulate_token_count(
                &mut output_tokens,
                reported_token_count(usage.and_then(|usage| usage.get("candidatesTokenCount"))),
            );

            let candidate = response
                .pointer("/candidates/0")
                .ok_or_else(|| anyhow::anyhow!("Google Gemini returned no candidate"))?;
            let content = candidate
                .get("content")
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("Google Gemini returned no candidate content"))?;
            let parts = content
                .get("parts")
                .and_then(serde_json::Value::as_array)
                .ok_or_else(|| anyhow::anyhow!("Google Gemini returned no candidate parts"))?;
            let function_calls = parts
                .iter()
                .filter_map(|part| part.get("functionCall").cloned())
                .collect::<Vec<_>>();

            if function_calls.is_empty() {
                let answer = parts
                    .iter()
                    .filter_map(|part| part.get("text").and_then(serde_json::Value::as_str))
                    .collect::<Vec<_>>()
                    .join("");
                return Ok(AiReply {
                    content: answer,
                    input_tokens,
                    output_tokens,
                    pending_action: None,
                });
            }

            if round == MAX_TOOL_ROUNDS {
                return Err(anyhow::anyhow!("The AI exceeded the server tool-call limit."));
            }

            contents.push(content);
            let mut function_responses = Vec::with_capacity(function_calls.len());
            for function_call in function_calls {
                if tool_call_count >= MAX_TOOL_CALLS_PER_TURN {
                    return Err(anyhow::anyhow!("The AI exceeded the server tool-call limit."));
                }
                tool_call_count += 1;

                let name = function_call
                    .get("name")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default();
                let arguments = function_call
                    .get("args")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null);

                let result = match ai_tools::execute(tool_context, name, &arguments).await {
                    Ok(ai_tools::ToolExecution::Result(result)) => result,
                    Ok(ai_tools::ToolExecution::Pending(action)) => {
                        return Ok(pending_action_reply(action, input_tokens, output_tokens));
                    }
                    Err(error) => serde_json::json!({ "error": error.to_string() }),
                };
                function_responses.push(serde_json::json!({
                    "functionResponse": {
                        "name": name,
                        "response": result,
                    }
                }));
            }
            contents.push(serde_json::json!({
                "role": "user",
                "parts": function_responses,
            }));
        }

        Err(anyhow::anyhow!("The AI could not finish the server tool request."))
    }

    #[cfg(test)]
    mod tests {
        use super::explicitly_mentions_ai;

        #[test]
        fn group_ai_requires_an_explicit_at_ai_mention() {
            assert!(explicitly_mentions_ai("@AI, can you summarize this?"));
            assert!(explicitly_mentions_ai("Please ask (@ai)!"));
            assert!(!explicitly_mentions_ai("I use ai for this."));
            assert!(!explicitly_mentions_ai("email @ai_team about it"));
            assert!(!explicitly_mentions_ai("mail ai@example.com"));
        }
    }
}

pub fn router(state: &shared::State) -> OpenApiRouter<shared::State> {
    OpenApiRouter::new()
        .routes(routes!(get::route))
        .routes(routes!(post::route))
        .with_state(state.clone())
}
