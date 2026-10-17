use axum::{
    extract::{Path, Query},
    http::StatusCode,
};
use serde::Deserialize;
use shared::{
    GetState,
    models::user::GetUser,
    response::{ApiResponse, ApiResponseResult},
};
use utoipa_axum::{router::OpenApiRouter, routes};
use url::Url;

const USER_AGENT: &str = concat!(
    "CalagopusChat/",
    env!("CARGO_PKG_VERSION"),
    " (https://calagopus.com)"
);

async fn get_modrinth_json(state: &shared::State, url: Url) -> ApiResponseResult {
    let response = state
        .client
        .get(url)
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .send()
        .await
        .map_err(|_| {
            ApiResponse::error("Could not reach Modrinth.").with_status(StatusCode::BAD_GATEWAY)
        })?;

    if !response.status().is_success() {
        return Err(
            ApiResponse::error("Modrinth rejected the request.")
                .with_status(StatusCode::BAD_GATEWAY),
        );
    }

    let json = response.json::<serde_json::Value>().await.map_err(|_| {
        ApiResponse::error("Modrinth returned invalid JSON.").with_status(StatusCode::BAD_GATEWAY)
    })?;

    ApiResponse::new_serialized(json).ok()
}

mod search {
    use super::*;

    #[derive(Deserialize)]
    pub struct SearchQuery {
        query: Option<String>,
        project_type: String,
        game_version: Option<String>,
        loader: Option<String>,
        index: Option<String>,
        limit: Option<u8>,
        offset: Option<u32>,
    }

    #[utoipa::path(get, path = "/search", params(
        ("query" = Option<String>, Query, description = "Optional Modrinth search terms."),
        ("project_type" = String, Query, description = "One of mod, modpack, or plugin."),
        ("game_version" = Option<String>, Query, description = "Optional Minecraft version filter."),
        ("loader" = Option<String>, Query, description = "Optional Modrinth loader/category filter."),
        ("index" = Option<String>, Query, description = "Optional sort order: relevance, downloads, follows, or updated."),
        ("limit" = Option<u8>, Query, description = "Maximum number of results."),
        ("offset" = Option<u32>, Query, description = "Result offset."),
    ), responses(
        (status = OK, description = "Modrinth search results."),
    ))]
    pub async fn route(
        state: GetState,
        _user: GetUser,
        Query(query): Query<SearchQuery>,
    ) -> ApiResponseResult {
        let query_text = query.query.as_deref().unwrap_or_default().trim();
        let project_type = query.project_type.trim();
        if query_text.chars().count() > 100
            || !matches!(project_type, "mod" | "modpack" | "plugin")
            || query
                .game_version
                .as_deref()
                .is_some_and(|version| version.trim().is_empty() || version.len() > 32)
            || query.loader.as_deref().is_some_and(|loader| {
                loader.trim().is_empty()
                    || loader.len() > 32
                    || !loader
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
            })
            || query.index.as_deref().is_some_and(|index| {
                !matches!(index, "relevance" | "downloads" | "follows" | "updated")
            })
        {
            return Err(ApiResponse::error("Invalid Modrinth search parameters.")
                .with_status(StatusCode::BAD_REQUEST));
        }

        // Modrinth versions of plugins are commonly categorized as `mod`; use
        // all_project_types so those projects are not silently left out.
        let mut facets = vec![vec![
            if project_type == "plugin" {
                "all_project_types:plugin".to_string()
            } else {
                format!("project_type:{project_type}")
            },
        ]];
        if matches!(project_type, "mod" | "modpack") {
            // Keep client-only projects out of server installers.
            facets.push(vec![
                "environment:server_only".to_string(),
                "environment:server_only_client_optional".to_string(),
                "environment:dedicated_server_only".to_string(),
                "environment:client_and_server".to_string(),
                "environment:client_or_server".to_string(),
                "environment:client_or_server_prefers_both".to_string(),
            ]);
        }
        if let Some(game_version) = query.game_version.as_deref() {
            facets.push(vec![format!("versions:{}", game_version.trim())]);
        }
        if let Some(loader) = query.loader.as_deref() {
            facets.push(vec![format!("categories:{}", loader.trim())]);
        }
        let facets = serde_json::to_string(&facets)?;
        let index = query
            .index
            .as_deref()
            .unwrap_or(if query_text.is_empty() { "downloads" } else { "relevance" });
        let mut url = Url::parse("https://api.modrinth.com/v2/search")?;
        {
            let mut query_pairs = url.query_pairs_mut();
            if !query_text.is_empty() {
                query_pairs.append_pair("query", query_text);
            }
            query_pairs
                .append_pair("facets", &facets)
                .append_pair(
                    "limit",
                    &query.limit.unwrap_or(20).clamp(1, 50).to_string(),
                )
                .append_pair(
                    "offset",
                    &query.offset.unwrap_or(0).min(10_000).to_string(),
                )
                .append_pair("index", index);
        }

        get_modrinth_json(&state.0, url).await
    }
}

mod versions {
    use super::*;

    #[derive(Deserialize)]
    pub struct VersionsQuery {
        game_version: Option<String>,
        loader: Option<String>,
    }

    #[utoipa::path(get, path = "/projects/{project_id}/versions", params(
        ("project_id" = String, Path, description = "Modrinth project ID or slug."),
        ("game_version" = Option<String>, Query, description = "Optional Minecraft version filter."),
        ("loader" = Option<String>, Query, description = "Optional Modrinth loader filter."),
    ), responses(
        (status = OK, description = "Modrinth project versions."),
    ))]
    pub async fn route(
        state: GetState,
        _user: GetUser,
        Path(project_id): Path<String>,
        Query(query): Query<VersionsQuery>,
    ) -> ApiResponseResult {
        if project_id.is_empty()
            || project_id.len() > 64
            || !project_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return Err(ApiResponse::error("Invalid Modrinth project ID.")
                .with_status(StatusCode::BAD_REQUEST));
        }
        if query
            .game_version
            .as_deref()
            .is_some_and(|version| version.trim().is_empty() || version.len() > 32)
            || query
                .loader
                .as_deref()
                .is_some_and(|loader| loader.trim().is_empty() || loader.len() > 32)
        {
            return Err(ApiResponse::error("Invalid Modrinth version filters.")
                .with_status(StatusCode::BAD_REQUEST));
        }

        let mut url = Url::parse(&format!(
            "https://api.modrinth.com/v2/project/{project_id}/version"
        ))?;
        {
            let mut query_pairs = url.query_pairs_mut();
            if let Some(game_version) = query.game_version.as_deref() {
                query_pairs.append_pair(
                    "game_versions",
                    &serde_json::to_string(&[game_version.trim()])?,
                );
            }
            if let Some(loader) = query.loader.as_deref() {
                query_pairs.append_pair("loaders", &serde_json::to_string(&[loader.trim()])?);
            }
        }

        get_modrinth_json(&state.0, url).await
    }
}

pub fn router(state: &shared::State) -> OpenApiRouter<shared::State> {
    OpenApiRouter::new()
        .routes(routes!(search::route))
        .routes(routes!(versions::route))
        .with_state(state.clone())
}
