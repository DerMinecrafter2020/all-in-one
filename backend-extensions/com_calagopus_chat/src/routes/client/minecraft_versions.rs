use axum::{
    extract::Path,
    http::StatusCode,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use shared::{
    GetState,
    models::{ByUuid, server::Server, user::{GetPermissionManager, GetUser}},
    response::{ApiResponse, ApiResponseResult},
};
use std::time::Duration;
use utoipa::ToSchema;
use utoipa_axum::{router::OpenApiRouter, routes};
use url::Url;
use reqwest::Method;

const USER_AGENT: &str = concat!(
    "All-in-One/",
    env!("CARGO_PKG_VERSION"),
    " (https://github.com/DerMinecrafter2020/all-in-one)"
);
const MAX_VERSION_API_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
const VERSION_FIELDS: &str = "id,type,projectVersionId,versionId,name,experimental,created";
const BUILD_FIELDS: &str = "id,type,projectVersionId,versionId,name,experimental,created,installation";

fn bad_gateway(message: &str) -> ApiResponse {
    ApiResponse::error(message).with_status(StatusCode::BAD_GATEWAY)
}

async fn require_server_permission(
    state: &shared::State,
    permissions: &GetPermissionManager,
    server_uuid: uuid::Uuid,
    permission: &str,
) -> Result<(), ApiResponse> {
    let server = Server::by_uuid_optional_cached(&state.database, server_uuid)
        .await
        .map_err(ApiResponse::from)?
        .ok_or_else(|| ApiResponse::error("Server not found.").with_status(StatusCode::NOT_FOUND))?;
    permissions.for_server(&server).has_server_permission(permission)
}

fn validate_type_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
}

fn validate_version_id(value: &str) -> bool {
    let normalized = value.to_ascii_lowercase();
    !value.is_empty()
        && value.len() <= 128
        && value != "."
        && value != ".."
        && !matches!(normalized.as_str(), "__proto__" | "constructor" | "prototype")
        && !value
            .chars()
            .any(|character| character.is_control() || matches!(character, '/' | '\\'))
}

fn api_url(
    base_url: &str,
    path: &[&str],
    query: &[(&str, &str)],
) -> Result<Url, ApiResponse> {
    if base_url.len() > 512 {
        return Err(ApiResponse::error("The Minecraft version API URL is invalid."));
    }

    let base = format!("{}/", base_url.trim_end_matches('/'));
    let mut url = Url::parse(&base)
        .map_err(|_| ApiResponse::error("The Minecraft version API URL is invalid."))?;
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    if url.scheme() != "https"
        || !(host == "mcjars.app" || host.ends_with(".mcjars.app"))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(ApiResponse::error(
            "The Minecraft version API must use a valid HTTPS base URL without credentials or query parameters.",
        ));
    }

    let mut segments = url
        .path_segments_mut()
        .map_err(|_| ApiResponse::error("The Minecraft version API URL is invalid."))?;
    segments.pop_if_empty();
    segments.extend(path.iter().copied());
    drop(segments);

    if !query.is_empty() {
        let mut pairs = url.query_pairs_mut();
        for (key, value) in query {
            pairs.append_pair(key, value);
        }
    }

    Ok(url)
}

async fn send_request(
    state: &shared::State,
    url: Url,
    method: Method,
    body: Option<Value>,
    api_key: Option<&str>,
) -> Result<Value, ApiResponse> {
    let mut request = state
        .client
        .request(method, url)
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .timeout(Duration::from_secs(15));

    if let Ok(origin) = std::env::var("APP_URL") {
        request = request.header(reqwest::header::ORIGIN, origin);
    }

    if let Some(api_key) = api_key.filter(|value| !value.trim().is_empty()) {
        request = request.header(reqwest::header::AUTHORIZATION, api_key.trim());
    }
    if let Some(body) = body {
        request = request.json(&body);
    }

    let mut response = request.send().await.map_err(|_| {
        bad_gateway("Could not reach the configured Minecraft version provider.")
    })?;
    if !response.status().is_success() {
        return Err(bad_gateway("The Minecraft version provider rejected the request."));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_VERSION_API_RESPONSE_BYTES as u64)
    {
        return Err(bad_gateway("The Minecraft version provider response is too large."));
    }

    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| bad_gateway("The Minecraft version provider returned an incomplete response."))?
    {
        if body.len().saturating_add(chunk.len()) > MAX_VERSION_API_RESPONSE_BYTES {
            return Err(bad_gateway("The Minecraft version provider response is too large."));
        }
        body.extend_from_slice(&chunk);
    }

    serde_json::from_slice(&body)
        .map_err(|_| bad_gateway("The Minecraft version provider returned invalid JSON."))
}

pub(crate) async fn fetch_types(state: &shared::State) -> Result<Value, ApiResponse> {
    let settings = crate::settings::load(state).await.map_err(ApiResponse::from)?;
    let path: &[&str] = if settings.minecraft_version_api_key.trim().is_empty() {
        &["api", "v2", "types"]
    } else {
        &["api", "organization", "v1", "types"]
    };
    let url = api_url(&settings.minecraft_version_changer.api_base_url, path, &[])?;
    send_request(
        state,
        url,
        Method::GET,
        None,
        Some(settings.minecraft_version_api_key.as_str()),
    )
    .await
}

pub(crate) async fn fetch_global_stats(state: &shared::State) -> Result<Value, ApiResponse> {
    let base = "https://versions.mcjars.app/api/v2/lookups";
    let types = Url::parse(&format!("{base}/types"))
        .map_err(|_| bad_gateway("Could not reach the Minecraft version statistics provider."))?;
    let versions = Url::parse(&format!("{base}/versions"))
        .map_err(|_| bad_gateway("Could not reach the Minecraft version statistics provider."))?;
    let types = send_request(state, types, Method::GET, None, None).await?;
    let versions = send_request(state, versions, Method::GET, None, None).await?;
    Ok(json!({ "types": types, "versions": versions }))
}

mod types {
    use super::*;

    #[utoipa::path(get, path = "/types", params(
        ("server" = uuid::Uuid, Path, description = "The server ID")
    ), responses((status = OK, description = "Available Minecraft server types.")))]
    pub async fn route(
        state: GetState,
        _user: GetUser,
        permissions: GetPermissionManager,
        Path(server_uuid): Path<uuid::Uuid>,
    ) -> ApiResponseResult {
        require_server_permission(&state.0, &permissions, server_uuid, "files.read-content").await?;
        let response = fetch_types(&state.0).await?;
        ApiResponse::new_serialized(response).ok()
    }
}

mod versions {
    use super::*;

    #[utoipa::path(get, path = "/types/{type_id}", params(
        ("server" = uuid::Uuid, Path, description = "The server ID"),
        ("type_id" = String, Path, description = "MCJars server type identifier")
    ), responses((status = OK, description = "Versions for a server type.")))]
    pub async fn route(
        state: GetState,
        _user: GetUser,
        permissions: GetPermissionManager,
        Path((server_uuid, type_id)): Path<(uuid::Uuid, String)>,
    ) -> ApiResponseResult {
        require_server_permission(&state.0, &permissions, server_uuid, "files.read-content").await?;
        let settings = crate::settings::load(&state.0).await?;
        if !validate_type_id(&type_id) {
            return Err(ApiResponse::error("Invalid Minecraft server type.")
                .with_status(StatusCode::BAD_REQUEST));
        }
        let url = api_url(
            &settings.minecraft_version_changer.api_base_url,
            &["api", "v2", "builds", &type_id],
            &[("fields", VERSION_FIELDS)],
        )?;
        let response = send_request(
            &state.0,
            url,
            Method::GET,
            None,
            Some(settings.minecraft_version_api_key.as_str()),
        )
        .await?;

        ApiResponse::new_serialized(response).ok()
    }
}

mod builds {
    use super::*;

    #[utoipa::path(get, path = "/types/{type_id}/{version}", params(
        ("server" = uuid::Uuid, Path, description = "The server ID"),
        ("type_id" = String, Path, description = "MCJars server type identifier"),
        ("version" = String, Path, description = "Minecraft or project version")
    ), responses((status = OK, description = "Builds for a Minecraft version.")))]
    pub async fn route(
        state: GetState,
        _user: GetUser,
        permissions: GetPermissionManager,
        Path((server_uuid, type_id, version)): Path<(uuid::Uuid, String, String)>,
    ) -> ApiResponseResult {
        require_server_permission(&state.0, &permissions, server_uuid, "files.read-content").await?;
        let settings = crate::settings::load(&state.0).await?;
        if !validate_type_id(&type_id) || !validate_version_id(&version) {
            return Err(ApiResponse::error("Invalid Minecraft version selector.")
                .with_status(StatusCode::BAD_REQUEST));
        }

        let url = api_url(
            &settings.minecraft_version_changer.api_base_url,
            &["api", "v2", "builds", &type_id, &version],
            &[("fields", VERSION_FIELDS)],
        )?;
        let response = send_request(
            &state.0,
            url,
            Method::GET,
            None,
            Some(settings.minecraft_version_api_key.as_str()),
        )
        .await?;

        ApiResponse::new_serialized(response).ok()
    }
}

mod build {
    use super::*;

    #[derive(ToSchema, Deserialize)]
    pub struct Payload {
        id: i64,
    }

    #[utoipa::path(post, path = "/build", params(
        ("server" = uuid::Uuid, Path, description = "The server ID")
    ), request_body = inline(Payload), responses(
        (status = OK, description = "Build details and staged installation plan."),
        (status = BAD_REQUEST, description = "Invalid build identifier."),
    ))]
    pub async fn route(
        state: GetState,
        _user: GetUser,
        permissions: GetPermissionManager,
        Path(server_uuid): Path<uuid::Uuid>,
        shared::Payload(data): shared::Payload<Payload>,
    ) -> ApiResponseResult {
        require_server_permission(&state.0, &permissions, server_uuid, "files.read-content").await?;
        if data.id < 1 {
            return Err(ApiResponse::error("Invalid Minecraft build identifier.")
                .with_status(StatusCode::BAD_REQUEST));
        }

        let settings = crate::settings::load(&state.0).await?;
        let url = api_url(
            &settings.minecraft_version_changer.api_base_url,
            &["api", "v2", "build"],
            &[("fields", BUILD_FIELDS)],
        )?;
        let response = send_request(
            &state.0,
            url,
            Method::POST,
            Some(json!({ "id": data.id })),
            Some(settings.minecraft_version_api_key.as_str()),
        )
        .await?;

        ApiResponse::new_serialized(response).ok()
    }
}

mod lookup {
    use super::*;

    #[derive(ToSchema, Deserialize)]
    pub struct Payload {
        sha256: String,
    }

    #[utoipa::path(post, path = "/lookup", params(
        ("server" = uuid::Uuid, Path, description = "The server ID")
    ), request_body = inline(Payload), responses(
        (status = OK, description = "Looks up an installed server build by SHA-256."),
        (status = BAD_REQUEST, description = "Invalid file fingerprint."),
    ))]
    pub async fn route(
        state: GetState,
        _user: GetUser,
        permissions: GetPermissionManager,
        Path(server_uuid): Path<uuid::Uuid>,
        shared::Payload(data): shared::Payload<Payload>,
    ) -> ApiResponseResult {
        require_server_permission(&state.0, &permissions, server_uuid, "files.read-content").await?;
        let fingerprint = data.sha256.trim();
        if fingerprint.len() != 64 || !fingerprint.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(ApiResponse::error("Invalid file fingerprint.")
                .with_status(StatusCode::BAD_REQUEST));
        }

        let settings = crate::settings::load(&state.0).await?;
        let url = api_url(
            &settings.minecraft_version_changer.api_base_url,
            &["api", "v2", "build"],
            &[("fields", BUILD_FIELDS)],
        )?;
        let response = send_request(
            &state.0,
            url,
            Method::POST,
            Some(json!({ "hash": { "sha256": fingerprint.to_ascii_lowercase() } })),
            Some(settings.minecraft_version_api_key.as_str()),
        )
        .await?;

        ApiResponse::new_serialized(response).ok()
    }
}

mod config {
    use super::*;

    #[derive(ToSchema, Serialize)]
    struct Response {
        icon_base_url: String,
        icon_format: String,
        type_order: Vec<crate::settings::MinecraftVersionTypeOrder>,
        egg_overrides: Vec<crate::settings::MinecraftVersionEggOverride>,
        collect_stats: bool,
    }

    #[utoipa::path(get, path = "/config", params(
        ("server" = uuid::Uuid, Path, description = "The server ID")
    ), responses((status = OK, body = inline(Response))))]
    pub async fn route(
        state: GetState,
        _user: GetUser,
        permissions: GetPermissionManager,
        Path(server_uuid): Path<uuid::Uuid>,
    ) -> ApiResponseResult {
        require_server_permission(&state.0, &permissions, server_uuid, "files.read-content").await?;
        let settings = crate::settings::load(&state.0).await?;
        ApiResponse::new_serialized(Response {
            icon_base_url: settings.minecraft_version_changer.icon_base_url.to_string(),
            icon_format: settings.minecraft_version_changer.icon_format.to_string(),
            type_order: settings.minecraft_version_changer.type_order,
            egg_overrides: settings.minecraft_version_changer.egg_overrides,
            collect_stats: settings.minecraft_version_changer.collect_stats,
        })
        .ok()
    }
}

mod install_stats {
    use super::*;

    #[derive(ToSchema, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct Payload {
        provider_type: String,
        version: String,
    }

    #[derive(ToSchema, Serialize)]
    struct Response {}

    #[utoipa::path(post, path = "/stats/install", params(
        ("server" = uuid::Uuid, Path, description = "The server ID")
    ), request_body = inline(Payload), responses(
        (status = OK, body = inline(Response)),
        (status = BAD_REQUEST, description = "Invalid server build details."),
    ))]
    pub async fn route(
        state: GetState,
        _user: GetUser,
        permissions: GetPermissionManager,
        Path(server_uuid): Path<uuid::Uuid>,
        shared::Payload(data): shared::Payload<Payload>,
    ) -> ApiResponseResult {
        require_server_permission(&state.0, &permissions, server_uuid, "files.create").await?;
        let provider_type = data.provider_type.trim().to_ascii_uppercase();
        let version = data.version.trim();
        if !validate_type_id(&provider_type) || !validate_version_id(version) {
            return Err(ApiResponse::error("Invalid Minecraft build details.")
                .with_status(StatusCode::BAD_REQUEST));
        }

        let mut settings = state.settings.get_mut().await?;
        {
            let extension_settings: &mut crate::settings::ExtensionSettingsData =
                settings.find_mut_extension_settings()?;
            let changer = &mut extension_settings.minecraft_version_changer;
            if !changer.collect_stats {
                return ApiResponse::new_serialized(Response {}).ok();
            }

            if !changer.local_stats.installs_by_type.contains_key(&provider_type)
                && changer.local_stats.installs_by_type.len() >= 256
            {
                return Err(ApiResponse::error("The local Minecraft version statistics limit was reached.")
                    .with_status(StatusCode::BAD_REQUEST));
            }
            if !changer.local_stats.installs_by_version.contains_key(version)
                && changer.local_stats.installs_by_version.len() >= 4096
            {
                return Err(ApiResponse::error("The local Minecraft version statistics limit was reached.")
                    .with_status(StatusCode::BAD_REQUEST));
            }
            changer.local_stats.total_installs = changer.local_stats.total_installs.saturating_add(1);
            let type_count = changer
                .local_stats
                .installs_by_type
                .entry(provider_type.clone())
                .or_default();
            *type_count = type_count.saturating_add(1);
            let version_count = changer
                .local_stats
                .installs_by_version
                .entry(version.to_string())
                .or_default();
            *version_count = version_count.saturating_add(1);
        }
        settings.save().await?;

        ApiResponse::new_serialized(Response {}).ok()
    }
}

pub fn router(state: &shared::State) -> OpenApiRouter<shared::State> {
    OpenApiRouter::new()
        .nest(
            "/servers/{server}",
            OpenApiRouter::new()
                .routes(routes!(types::route))
                .routes(routes!(versions::route))
                .routes(routes!(builds::route))
                .routes(routes!(build::route))
                .routes(routes!(lookup::route))
                .routes(routes!(config::route))
                .routes(routes!(install_stats::route)),
        )
        .with_state(state.clone())
}
