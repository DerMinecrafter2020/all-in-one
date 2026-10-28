use axum::{extract::Path, http::StatusCode};
use serde::{Deserialize, Serialize};
use shared::{
    GetIp, GetRequestHost, GetState, Payload,
    models::{
        server::Server,
        user::{GetAuthMethod, GetPermissionManager, GetUser, GetUserImpersonator},
        user_activity::GetUserActivityLogger,
    },
    response::{ApiResponse, ApiResponseResult},
};
use sqlx::Row;
use utoipa::ToSchema;
use utoipa_axum::{router::OpenApiRouter, routes};

use super::ai_tools::{self, ToolContext};

mod post {
    use super::*;
    use shared::models::ByUuid;

    #[derive(ToSchema, Deserialize)]
    pub struct PayloadData {
        confirm: bool,
    }

    #[derive(ToSchema, Serialize)]
    struct Response {
        status: String,
    }

    #[utoipa::path(post, path = "/{message}", params(
        ("conversation" = uuid::Uuid, Path, description = "The conversation ID."),
        ("message" = uuid::Uuid, Path, description = "The AI message containing the pending action."),
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
        Path((conversation_uuid, message_uuid)): Path<(uuid::Uuid, uuid::Uuid)>,
        Payload(data): Payload<PayloadData>,
    ) -> ApiResponseResult {
        permissions.has_user_permission("chat.read")?;
        permissions.has_user_permission("chat.send")?;
        if !super::super::is_member(&state.0, conversation_uuid, user.uuid).await? {
            return Err(ApiResponse::error("Conversation not found.")
                .with_status(StatusCode::NOT_FOUND));
        }
        let Some((conversation_kind, conversation_ai_enabled)) =
            super::super::conversation_info(&state.0, conversation_uuid, user.uuid).await?
        else {
            return Err(ApiResponse::error("Conversation not found.")
                .with_status(StatusCode::NOT_FOUND));
        };
        let group_ai = conversation_kind == "group" && conversation_ai_enabled;
        let group_members: Vec<shared::models::user::User> = if group_ai {
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

        if !data.confirm {
            let status: Option<String> = sqlx::query_scalar(
                r#"
                UPDATE com_calagopus_chat_messages
                SET ai_action_status = CASE
                    WHEN ai_action_expires_at <= now() THEN 'expired'
                    ELSE 'cancelled'
                END
                WHERE uuid = $1
                  AND conversation_uuid = $2
                  AND sender_kind = 'ai'
                  AND ai_action_status = 'pending'
                  AND (
                      ai_action_owner_uuid = $3
                      OR (
                          ai_action_owner_uuid IS NULL
                          AND EXISTS (
                              SELECT 1
                              FROM com_calagopus_chat_conversations AS conversations
                              WHERE conversations.uuid = $2
                                AND conversations.kind = 'ai'
                                AND conversations.created_by = $3
                          )
                      )
                  )
                  AND EXISTS (
                      SELECT 1
                      FROM com_calagopus_chat_members AS members
                      WHERE members.conversation_uuid = $2
                        AND members.user_uuid = $3
                  )
                RETURNING ai_action_status
                "#,
            )
            .bind(message_uuid)
            .bind(conversation_uuid)
            .bind(user.uuid)
            .fetch_optional(state.database.write())
            .await?;

            let Some(status) = status else {
                return Err(ApiResponse::error("This server action is no longer pending.")
                    .with_status(StatusCode::CONFLICT));
            };

            activity_logger
                .log(
                    "user:chat.server-action.cancel",
                    serde_json::json!({
                        "conversation_uuid": conversation_uuid,
                        "message_uuid": message_uuid,
                    }),
                )
                .await;

            return ApiResponse::new_serialized(Response { status }).ok();
        }

        let settings = crate::settings::load(&state.0).await?;
        if !settings.ai_available()
            || !settings.ai_server_info_enabled
            || !settings.ai_server_power_enabled
            || settings.ai_server_control_api_key.trim().is_empty()
        {
            let status: Option<String> = sqlx::query_scalar(
                r#"
                UPDATE com_calagopus_chat_messages
                SET ai_action_status = CASE
                    WHEN ai_action_expires_at <= now() THEN 'expired'
                    ELSE 'failed'
                END
                WHERE uuid = $1
                  AND conversation_uuid = $2
                  AND sender_kind = 'ai'
                  AND ai_action_status = 'pending'
                  AND (
                      ai_action_owner_uuid = $3
                      OR (
                          ai_action_owner_uuid IS NULL
                          AND EXISTS (
                              SELECT 1
                              FROM com_calagopus_chat_conversations AS conversations
                              WHERE conversations.uuid = $2
                                AND conversations.kind = 'ai'
                                AND conversations.created_by = $3
                          )
                      )
                  )
                  AND EXISTS (
                      SELECT 1
                      FROM com_calagopus_chat_members AS members
                      WHERE members.conversation_uuid = $2
                        AND members.user_uuid = $3
                  )
                RETURNING ai_action_status
                "#,
            )
            .bind(message_uuid)
            .bind(conversation_uuid)
            .bind(user.uuid)
            .fetch_optional(state.database.write())
            .await?;

            let Some(status) = status else {
                return Err(ApiResponse::error("This server action is no longer pending.")
                    .with_status(StatusCode::CONFLICT));
            };

            return ApiResponse::new_serialized(Response {
                status,
            })
            .ok();
        }

        let action = sqlx::query(
            r#"
            UPDATE com_calagopus_chat_messages
            SET ai_action_status = 'executing'
            WHERE uuid = $1
              AND conversation_uuid = $2
              AND sender_kind = 'ai'
              AND ai_action_status = 'pending'
              AND ai_action_expires_at > now()
              AND (
                  ai_action_owner_uuid = $3
                  OR (
                      ai_action_owner_uuid IS NULL
                      AND EXISTS (
                          SELECT 1
                          FROM com_calagopus_chat_conversations AS conversations
                          WHERE conversations.uuid = $2
                            AND conversations.kind = 'ai'
                            AND conversations.created_by = $3
                      )
                  )
              )
              AND EXISTS (
                  SELECT 1
                  FROM com_calagopus_chat_members AS members
                  WHERE members.conversation_uuid = $2
                    AND members.user_uuid = $3
              )
            RETURNING ai_action_server_uuid, ai_action_type
            "#,
        )
        .bind(message_uuid)
        .bind(conversation_uuid)
        .bind(user.uuid)
        .fetch_optional(state.database.write())
        .await?;

        let Some(action) = action else {
            let expired: Option<uuid::Uuid> = sqlx::query_scalar(
                r#"
                UPDATE com_calagopus_chat_messages
                SET ai_action_status = 'expired'
                WHERE uuid = $1
                  AND conversation_uuid = $2
                  AND sender_kind = 'ai'
                  AND ai_action_status = 'pending'
                  AND ai_action_expires_at <= now()
                  AND (
                      ai_action_owner_uuid = $3
                      OR (
                          ai_action_owner_uuid IS NULL
                          AND EXISTS (
                              SELECT 1
                              FROM com_calagopus_chat_conversations AS conversations
                              WHERE conversations.uuid = $2
                                AND conversations.kind = 'ai'
                                AND conversations.created_by = $3
                          )
                      )
                  )
                  AND EXISTS (
                      SELECT 1
                      FROM com_calagopus_chat_members AS members
                      WHERE members.conversation_uuid = $2
                        AND members.user_uuid = $3
                  )
                RETURNING uuid
                "#,
            )
            .bind(message_uuid)
            .bind(conversation_uuid)
            .bind(user.uuid)
            .fetch_optional(state.database.write())
            .await?;

            if expired.is_some() {
                return ApiResponse::new_serialized(Response {
                    status: "expired".to_string(),
                })
                .ok();
            }

            return Err(ApiResponse::error("This server action is no longer pending.")
                .with_status(StatusCode::CONFLICT));
        };

        let server_uuid: uuid::Uuid = action.try_get("ai_action_server_uuid")?;
        let action_name: String = action.try_get("ai_action_type")?;
        let server = match Server::by_user_identifier(
            &state.database,
            &user.0,
            &server_uuid.to_string(),
        )
        .await
        {
            Ok(Some(server)) => server,
            Ok(None) => {
                mark_action_failed(&state.0, message_uuid).await?;
                return Err(ApiResponse::error("The server is no longer accessible.")
                    .with_status(StatusCode::FORBIDDEN));
            }
            Err(error) => {
                tracing::warn!(conversation_uuid = %conversation_uuid, "failed to reload server for AI action: {error:#}");
                mark_action_failed(&state.0, message_uuid).await?;
                return Err(ApiResponse::error("The server could not be checked before the action.")
                    .with_status(StatusCode::BAD_GATEWAY));
            }
        };

        let action_permission = match action_name.as_str() {
            "start" => "control.start",
            "stop" => "control.stop",
            "restart" => "control.restart",
            _ => {
                mark_action_failed(&state.0, message_uuid).await?;
                return Err(ApiResponse::error("This server action is not supported.")
                    .with_status(StatusCode::BAD_REQUEST));
            }
        };
        if permissions
            .0
            .for_server(&server)
            .has_server_permission(action_permission)
            .is_err()
        {
            mark_action_failed(&state.0, message_uuid).await?;
            return Err(ApiResponse::error(
                "Your Panel permissions do not allow this server action.",
            )
            .with_status(StatusCode::FORBIDDEN));
        }

        let tool_context = ToolContext {
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
        if let Err(error) =
            ai_tools::require_control_api_key_permission(&tool_context, &server, action_permission)
                .await
        {
            tracing::warn!(
                conversation_uuid = %conversation_uuid,
                server_uuid = %server.uuid,
                "AI server control API key rejected the action: {error:#}"
            );
            mark_action_failed(&state.0, message_uuid).await?;
            return Err(ApiResponse::error(
                "The configured Panel server-control API key no longer permits this action.",
            )
            .with_status(StatusCode::FORBIDDEN));
        }
        if !ai_tools::server_visible_to_group(&tool_context, server.uuid).await? {
            mark_action_failed(&state.0, message_uuid).await?;
            return Err(ApiResponse::error(
                "The server is no longer visible to every member of this AI group.",
            )
            .with_status(StatusCode::FORBIDDEN));
        }
        match ai_tools::client_api_json(
            &tool_context,
            axum::http::Method::POST,
            &format!("/api/client/servers/{}/power", server.uuid),
            Some(serde_json::json!({ "action": action_name })),
        )
        .await
        {
            Ok(_) => {
                set_action_status(&state.0, message_uuid, "confirmed").await?;
                activity_logger
                    .log(
                        "user:chat.server-action.confirm",
                        serde_json::json!({
                            "conversation_uuid": conversation_uuid,
                            "message_uuid": message_uuid,
                            "server_uuid": server.uuid,
                            "action": action_name,
                        }),
                    )
                    .await;
                ApiResponse::new_serialized(Response {
                    status: "confirmed".to_string(),
                })
                .ok()
            }
            Err(error) => {
                tracing::warn!(
                    conversation_uuid = %conversation_uuid,
                    server_uuid = %server.uuid,
                    "AI server power action failed: {error:#}"
                );
                mark_action_failed(&state.0, message_uuid).await?;
                Err(ApiResponse::error(
                    "The server action could not be submitted. Check the server status and permissions, then ask the AI again.",
                )
                .with_status(StatusCode::BAD_GATEWAY))
            }
        }
    }

    async fn set_action_status(
        state: &shared::State,
        message_uuid: uuid::Uuid,
        status: &str,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "UPDATE com_calagopus_chat_messages SET ai_action_status = $2 WHERE uuid = $1 AND ai_action_status = 'executing'",
        )
        .bind(message_uuid)
        .bind(status)
        .execute(state.database.write())
        .await?;

        Ok(())
    }

    async fn mark_action_failed(
        state: &shared::State,
        message_uuid: uuid::Uuid,
    ) -> Result<(), sqlx::Error> {
        set_action_status(state, message_uuid, "failed").await
    }
}

pub fn router(state: &shared::State) -> OpenApiRouter<shared::State> {
    OpenApiRouter::new()
        .routes(routes!(post::route))
        .with_state(state.clone())
}
