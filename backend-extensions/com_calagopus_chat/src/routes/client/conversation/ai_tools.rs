use axum::{
    body::{Body, to_bytes},
    http::{HeaderValue, Method, Request, header},
};
use serde_json::{Value, json};
use shared::models::{
    server::Server,
    user::{AuthMethod, PermissionManager, User},
};
use std::{collections::HashSet, net::IpAddr};

#[derive(Clone)]
pub(super) struct ToolDefinition {
    pub name: &'static str,
    pub description: &'static str,
    pub parameters: Value,
}

#[derive(Clone, Copy)]
pub(super) enum PowerAction {
    Start,
    Stop,
    Restart,
}

impl PowerAction {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Start => "start",
            Self::Stop => "stop",
            Self::Restart => "restart",
        }
    }

    fn permission(self) -> &'static str {
        match self {
            Self::Start => "control.start",
            Self::Stop => "control.stop",
            Self::Restart => "control.restart",
        }
    }
}

pub(super) struct PendingPowerAction {
    pub server_uuid: uuid::Uuid,
    pub server_name: String,
    pub action: PowerAction,
}

pub(super) enum ToolExecution {
    Result(Value),
    Pending(PendingPowerAction),
}

pub(super) struct ToolContext<'a> {
    pub state: &'a shared::State,
    pub user: &'a User,
    pub auth_method: &'a AuthMethod,
    pub impersonator: Option<&'a User>,
    pub permissions: &'a PermissionManager,
    pub ip: IpAddr,
    pub request_host: Option<&'a str>,
    pub server_info_enabled: bool,
    pub server_power_enabled: bool,
    pub server_control_api_key: &'a str,
    pub group_ai: bool,
    pub group_members: &'a [User],
}

pub(super) fn definitions(
    server_info_enabled: bool,
    server_power_enabled: bool,
    server_control_api_key_configured: bool,
) -> Vec<ToolDefinition> {
    let mut definitions = Vec::new();

    if server_info_enabled {
        definitions.push(ToolDefinition {
            name: "list_my_servers",
            description: "List up to 50 servers the current Panel user can access. Requires the user's servers.read permission. Use search to narrow the list and a returned UUID or short identifier for the other tools.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "search": {
                        "type": "string",
                        "description": "Optional text to narrow the server list by name or identifier."
                    }
                },
                "additionalProperties": false
            }),
        });
        definitions.push(ToolDefinition {
            name: "get_server_status",
            description: "Get the live power state, resource usage, and uptime of a server the current Panel user can access. Requires servers.read. The identifier must come from list_my_servers.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "server_identifier": {
                        "type": "string",
                        "description": "The server UUID or short identifier returned by list_my_servers."
                    }
                },
                "required": ["server_identifier"],
                "additionalProperties": false
            }),
        });
    }

    if server_info_enabled && server_power_enabled && server_control_api_key_configured {
        definitions.push(ToolDefinition {
            name: "request_server_power_action",
            description: "Prepare a start, stop, or restart request for an accessible server. Requires the configured Panel API key and the current user's corresponding control.start, control.stop, or control.restart permission. The user must confirm the request in chat before it is submitted.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "server_identifier": {
                        "type": "string",
                        "description": "The server UUID or short identifier returned by list_my_servers."
                    },
                    "action": {
                        "type": "string",
                        "enum": ["start", "stop", "restart"],
                        "description": "The requested power action."
                    }
                },
                "required": ["server_identifier", "action"],
                "additionalProperties": false
            }),
        });
    }

    definitions
}

pub(super) fn openai_definitions(definitions: &[ToolDefinition]) -> Vec<Value> {
    definitions
        .iter()
        .map(|definition| {
            json!({
                "type": "function",
                "function": {
                    "name": definition.name,
                    "description": definition.description,
                    "parameters": definition.parameters.clone(),
                }
            })
        })
        .collect()
}

pub(super) fn anthropic_definitions(definitions: &[ToolDefinition]) -> Vec<Value> {
    definitions
        .iter()
        .map(|definition| {
            json!({
                "name": definition.name,
                "description": definition.description,
                "input_schema": definition.parameters.clone(),
            })
        })
        .collect()
}

pub(super) fn gemini_definitions(definitions: &[ToolDefinition]) -> Vec<Value> {
    let function_declarations = definitions
        .iter()
        .map(|definition| {
            let mut parameters = definition.parameters.clone();
            normalize_gemini_schema(&mut parameters);

            json!({
                "name": definition.name,
                "description": definition.description,
                "parameters": parameters,
            })
        })
        .collect::<Vec<_>>();

    vec![json!({
        "functionDeclarations": function_declarations,
    })]
}

fn normalize_gemini_schema(schema: &mut Value) {
    match schema {
        Value::Object(properties) => {
            properties.remove("additionalProperties");
            if let Some(Value::String(schema_type)) = properties.get_mut("type") {
                *schema_type = schema_type.to_ascii_uppercase();
            }
            for property in properties.values_mut() {
                normalize_gemini_schema(property);
            }
        }
        Value::Array(items) => {
            for item in items {
                normalize_gemini_schema(item);
            }
        }
        _ => {}
    }
}

pub(super) async fn execute(
    context: &ToolContext<'_>,
    name: &str,
    arguments: &Value,
) -> Result<ToolExecution, anyhow::Error> {
    match name {
        "list_my_servers" if context.server_info_enabled => {
            let search = arguments
                .get("search")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|search| !search.is_empty());
            if search.is_some_and(|search| search.chars().count() > 128) {
                return Err(anyhow::anyhow!("Search terms must be 128 characters or fewer."));
            }
            let query = match search {
                Some(search) => format!("&search={}", urlencoding::encode(search)),
                None => String::new(),
            };
            let response = client_api_json(
                context,
                Method::GET,
                &format!("/api/client/servers?page=1&per_page=50{query}"),
                None,
            )
            .await?;
            let servers = response
                .pointer("/servers/data")
                .and_then(Value::as_array)
                .ok_or_else(|| anyhow::anyhow!("Panel returned an invalid server list"))?;
            let server_entries = servers
                .iter()
                .filter_map(|server| {
                    let uuid = server
                        .get("uuid")
                        .and_then(Value::as_str)
                        .and_then(|uuid| uuid::Uuid::parse_str(uuid).ok())?;
                    Some((server, uuid))
                })
                .collect::<Vec<_>>();
            let server_uuids = server_entries.iter().map(|(_, uuid)| *uuid).collect::<Vec<_>>();
            let group_accessible_uuids =
                group_accessible_server_uuids(context, &server_uuids).await?;
            let mut result = Vec::with_capacity(server_entries.len());
            for (server, uuid) in server_entries {
                if !group_accessible_uuids.contains(&uuid) {
                    continue;
                }
                let Some(identifier) = server.get("uuid_short").and_then(Value::as_str) else {
                    continue;
                };

                result.push(json!({
                    "identifier": identifier,
                    "name": server.get("name"),
                    "install_status": server.get("status"),
                    "suspended": server.get("is_suspended"),
                }));
            }
            let total = response
                .pointer("/servers/total")
                .and_then(Value::as_i64)
                .unwrap_or(servers.len() as i64);
            let truncated = total > servers.len() as i64;
            let displayed_total = if context.group_ai {
                result.len() as i64
            } else {
                total
            };

            Ok(ToolExecution::Result(json!({
                "servers": result,
                "total": displayed_total,
                "truncated": truncated,
            })))
        }
        "get_server_status" if context.server_info_enabled => {
            if context
                .permissions
                .has_user_permission("servers.read")
                .is_err()
            {
                return Err(anyhow::anyhow!(
                    "The current user does not have the Panel servers.read permission."
                ));
            }
            let identifier = required_string(arguments, "server_identifier")?;
            let server = accessible_server(context, identifier).await?;
            if !server_visible_to_group(context, server.uuid).await? {
                return Err(anyhow::anyhow!(
                    "That server is only available to some members of this AI group."
                ));
            }
            let response = client_api_json(
                context,
                Method::GET,
                &format!("/api/client/servers/{}/resources", server.uuid),
                None,
            )
            .await?;
            let resources = response
                .get("resources")
                .ok_or_else(|| anyhow::anyhow!("Panel returned no server resource data"))?;

            Ok(ToolExecution::Result(json!({
                "server": server.name,
                "state": resources.get("state"),
                "cpu_absolute": resources.get("cpu_absolute"),
                "cpu_limit_absolute": resources.get("cpu_limit_absolute"),
                "memory_bytes": resources.get("memory_bytes"),
                "memory_limit_bytes": resources.get("memory_limit_bytes"),
                "disk_bytes": resources.get("disk_bytes"),
                "uptime_seconds": resources.get("uptime"),
            })))
        }
        "request_server_power_action"
            if context.server_info_enabled
                && context.server_power_enabled
                && !context.server_control_api_key.trim().is_empty() =>
        {
            let identifier = required_string(arguments, "server_identifier")?;
            let action = match required_string(arguments, "action")? {
                "start" => PowerAction::Start,
                "stop" => PowerAction::Stop,
                "restart" => PowerAction::Restart,
                _ => return Err(anyhow::anyhow!("Only start, stop, and restart are available.")),
            };
            let server = accessible_server(context, identifier).await?;
            if !server_visible_to_group(context, server.uuid).await? {
                return Err(anyhow::anyhow!(
                    "That server is only available to some members of this AI group."
                ));
            }
            if context
                .permissions
                .for_server(&server)
                .has_server_permission(action.permission())
                .is_err()
            {
                return Err(anyhow::anyhow!(
                    "The current user does not have permission to perform that server action."
                ));
            }
            require_control_api_key_permission(context, &server, action.permission()).await?;

            Ok(ToolExecution::Pending(PendingPowerAction {
                server_uuid: server.uuid,
                server_name: server.name.to_string(),
                action,
            }))
        }
        _ => Err(anyhow::anyhow!("That server tool is not enabled in extension settings.")),
    }
}

pub(super) async fn require_control_api_key_permission(
    context: &ToolContext<'_>,
    server: &Server,
    permission: &str,
) -> Result<(), anyhow::Error> {
    let key = context.server_control_api_key.trim();
    if key.is_empty() {
        return Err(anyhow::anyhow!(
            "Server power actions require an administrator-configured Panel API key."
        ));
    }

    let Some((control_user, control_api_key)) =
        User::by_api_key_cached(&context.state.database, key).await?
    else {
        return Err(anyhow::anyhow!(
            "The configured Panel server-control API key is invalid or expired."
        ));
    };

    if !control_api_key.enabled
        || control_user.frozen
        || control_user.suspended
        || (!control_api_key.allowed_ips.is_empty()
            && !control_api_key
                .allowed_ips
                .iter()
                .any(|allowed_ip| allowed_ip.contains(context.ip)))
    {
        return Err(anyhow::anyhow!(
            "The configured Panel server-control API key is disabled or not allowed from this IP address."
        ));
    }

    let server_identifier = server.uuid.to_string();
    let control_server = Server::by_user_identifier(
        &context.state.database,
        &control_user,
        &server_identifier,
    )
    .await?
    .ok_or_else(|| anyhow::anyhow!("The configured Panel API key cannot access this server."))?;

    let control_auth_method = AuthMethod::ApiKey(control_api_key);
    PermissionManager::new(&control_user, &control_auth_method)
        .for_server(&control_server)
        .has_server_permission(permission)
        .map_err(|_| {
            anyhow::anyhow!(
                "The configured Panel API key does not grant {permission} for this server."
            )
        })
}

async fn accessible_server(
    context: &ToolContext<'_>,
    identifier: &str,
) -> Result<Server, anyhow::Error> {
    Server::by_user_identifier(&context.state.database, context.user, identifier)
        .await
        .map_err(|_| anyhow::anyhow!("Could not check access to that server."))?
        .ok_or_else(|| anyhow::anyhow!("Server not found or not accessible to the current user."))
}

pub(super) async fn server_visible_to_group(
    context: &ToolContext<'_>,
    server_uuid: uuid::Uuid,
) -> Result<bool, anyhow::Error> {
    Ok(group_accessible_server_uuids(context, &[server_uuid])
        .await?
        .contains(&server_uuid))
}

async fn group_accessible_server_uuids(
    context: &ToolContext<'_>,
    server_uuids: &[uuid::Uuid],
) -> Result<HashSet<uuid::Uuid>, anyhow::Error> {
    let mut accessible = server_uuids.iter().copied().collect::<HashSet<_>>();
    if !context.group_ai || server_uuids.is_empty() {
        return Ok(accessible);
    }
    if context.group_members.is_empty()
        || !context
            .group_members
            .iter()
            .any(|member| member.uuid == context.user.uuid)
    {
        return Ok(HashSet::new());
    }

    for member in context.group_members {
        if member.frozen || member.suspended {
            return Ok(HashSet::new());
        }

        // Check each member's server access independently of the requester's credentials.
        let member_accessible = Server::by_user_uuids(&context.state.database, member, server_uuids)
            .await?
            .into_iter()
            .map(|server| server.uuid)
            .collect::<HashSet<_>>();
        accessible.retain(|server_uuid| member_accessible.contains(server_uuid));
        if accessible.is_empty() {
            break;
        }
    }

    Ok(accessible)
}

fn required_string<'a>(arguments: &'a Value, key: &str) -> Result<&'a str, anyhow::Error> {
    arguments
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow::anyhow!("Missing required tool argument `{key}`."))
}

fn panel_route_label(method: &Method, uri: &str) -> String {
    let path = uri.split('?').next().unwrap_or(uri);
    let route = if path == "/api/client/servers" {
        "/api/client/servers"
    } else if path.starts_with("/api/client/servers/") && path.ends_with("/resources") {
        "/api/client/servers/{server}/resources"
    } else if path.starts_with("/api/client/servers/") && path.ends_with("/power") {
        "/api/client/servers/{server}/power"
    } else {
        "/api/client"
    };

    format!("{method} {route}")
}

pub(super) async fn client_api_json(
    context: &ToolContext<'_>,
    method: Method,
    uri: &str,
    body: Option<Value>,
) -> Result<Value, anyhow::Error> {
    let route_label = panel_route_label(&method, uri);
    let body = match body {
        Some(body) => Body::from(serde_json::to_vec(&body)?),
        None => Body::empty(),
    };
    let mut request = Request::builder()
        .method(method)
        .uri(uri)
        .header(header::ACCEPT, "application/json")
        .header(header::CONTENT_TYPE, "application/json")
        .body(body)?;

    request
        .extensions_mut()
        .insert(axum::extract::ConnectInfo(std::net::SocketAddr::new(context.ip, 0)));
    request.extensions_mut().insert(context.ip);
    if let Some(host) = context.request_host {
        request
            .headers_mut()
            .insert(header::HOST, HeaderValue::from_str(host)?);
    }
    if context.impersonator.is_some() {
        request.headers_mut().insert(
            "Calagopus-User",
            HeaderValue::from_str(&context.user.uuid.to_string())?,
        );
    }

    let authenticated_user = (*context.impersonator.unwrap_or(context.user)).clone();
    let response = context
        .state
        .send_authenticated_router_oneshot(
            request,
            authenticated_user,
            (*context.auth_method).clone(),
        )
        .await?;
    let status = response.status();
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("unknown")
        .to_string();
    let body = to_bytes(response.into_body(), 1024 * 1024).await?;
    if body.is_empty() {
        if status.is_success() {
            return Ok(Value::Null);
        }
        return Err(anyhow::anyhow!(
            "Panel server request {route_label} failed with HTTP {status} (content type: {content_type})."
        ));
    }

    if !status.is_success() {
        if status.is_server_error() {
            tracing::warn!(
                panel_route = %route_label,
                http_status = %status,
                content_type = %content_type,
                "Panel server request failed"
            );
        }
        let response = serde_json::from_slice::<Value>(&body).ok();
        let error = response
            .as_ref()
            .and_then(|response| response.get("errors"))
            .and_then(Value::as_array)
            .and_then(|errors| errors.first())
            .and_then(Value::as_str)
            .or_else(|| {
                response
                    .as_ref()
                    .and_then(|response| response.get("error"))
                    .and_then(Value::as_str)
            })
            .or_else(|| {
                response
                    .as_ref()
                    .and_then(|response| response.get("message"))
                    .and_then(Value::as_str)
            });

        return Err(match error {
            Some(error) => anyhow::anyhow!("Panel server request {route_label} failed with HTTP {status}: {error}"),
            None if response.is_none() => anyhow::anyhow!(
                "Panel server request {route_label} failed with HTTP {status} and returned a non-JSON error response (content type: {content_type})."
            ),
            None => anyhow::anyhow!(
                "Panel server request {route_label} failed with HTTP {status} and did not include a readable error message (content type: {content_type})."
            ),
        });
    }

    serde_json::from_slice(&body).map_err(|error| {
        tracing::warn!(
            panel_route = %route_label,
            http_status = %status,
            content_type = %content_type,
            "Panel server request returned invalid JSON: {error}"
        );
        anyhow::anyhow!(
            "Panel server request {route_label} returned an invalid JSON response (HTTP {status}, content type: {content_type}): {error}"
        )
    })
}

#[cfg(test)]
mod tests {
    use super::definitions;

    #[test]
    fn admin_settings_gate_each_server_tool_group() {
        assert!(definitions(false, false, false).is_empty());
        assert!(definitions(false, true, true).is_empty());
        assert_eq!(definitions(true, true, false).len(), 2);

        let read_only = definitions(true, false, false);
        assert_eq!(
            read_only.iter().map(|tool| tool.name).collect::<Vec<_>>(),
            vec!["list_my_servers", "get_server_status"]
        );

        let read_and_power = definitions(true, true, true);
        assert_eq!(read_and_power.len(), 3);
        assert_eq!(
            read_and_power.last().map(|tool| tool.name),
            Some("request_server_power_action")
        );
    }

    #[test]
    fn gemini_function_schema_uses_gemini_type_names() {
        let tools = definitions(true, true, true);
        let declarations = super::gemini_definitions(&tools);
        let list_schema = &declarations[0]["functionDeclarations"][0]["parameters"];

        assert_eq!(list_schema["type"], "OBJECT");
        assert_eq!(list_schema["properties"]["search"]["type"], "STRING");
        assert!(list_schema.get("additionalProperties").is_none());
    }

    #[test]
    fn panel_route_diagnostics_redact_server_identifiers() {
        assert_eq!(
            super::panel_route_label(
                &axum::http::Method::GET,
                "/api/client/servers/123e4567-e89b-12d3-a456-426614174000/resources",
            ),
            "GET /api/client/servers/{server}/resources"
        );
        assert_eq!(
            super::panel_route_label(
                &axum::http::Method::POST,
                "/api/client/servers/123e4567-e89b-12d3-a456-426614174000/power",
            ),
            "POST /api/client/servers/{server}/power"
        );
    }
}
