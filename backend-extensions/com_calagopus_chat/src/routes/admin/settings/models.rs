use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use shared::{
    GetState, Payload,
    models::user::GetPermissionManager,
    response::{ApiResponse, ApiResponseResult},
};
use utoipa::ToSchema;
use utoipa_axum::{router::OpenApiRouter, routes};
use url::Url;

const SUPPORTED_PROVIDERS: &[&str] = &[
    "openai_compatible",
    "openrouter",
    "anthropic",
    "google_gemini",
    "ollama",
];

mod post {
    use super::*;

    #[derive(ToSchema, Deserialize)]
    pub struct PayloadData {
        ai_provider: String,
        ai_base_url: String,
        ai_api_key: Option<String>,
    }

    #[derive(ToSchema, Serialize)]
    struct Response {
        models: Vec<String>,
    }

    #[utoipa::path(post, path = "/", responses(
        (status = OK, body = inline(Response)),
    ), request_body = inline(PayloadData))]
    pub async fn route(
        state: GetState,
        permissions: GetPermissionManager,
        Payload(data): Payload<PayloadData>,
    ) -> ApiResponseResult {
        permissions.has_admin_permission("extensions.manage")?;

        let provider = data.ai_provider.trim();
        let base_url = data.ai_base_url.trim().trim_end_matches('/');
        let Ok(parsed_url) = Url::parse(base_url) else {
            return Err(ApiResponse::error("Enter a valid AI provider URL.")
                .with_status(StatusCode::BAD_REQUEST));
        };

        if !SUPPORTED_PROVIDERS.contains(&provider)
            || !matches!(parsed_url.scheme(), "http" | "https")
            || parsed_url.host_str().is_none()
        {
            return Err(ApiResponse::error("The selected provider or provider URL is invalid.")
                .with_status(StatusCode::BAD_REQUEST));
        }

        let saved_settings = crate::settings::load(&state.0).await?;
        let submitted_api_key = data.ai_api_key.as_deref().unwrap_or_default().trim();
        let api_key = if submitted_api_key.is_empty() {
            saved_settings.ai_api_key.to_string()
        } else {
            submitted_api_key.to_string()
        };

        if provider != "ollama" && api_key.is_empty() {
            return Err(ApiResponse::error("Enter an API key before loading models.")
                .with_status(StatusCode::BAD_REQUEST));
        }

        let result = load_models(&state.0, provider, base_url, &api_key).await;
        let models = match result {
            Ok(models) => models,
            Err(error) => {
                tracing::warn!(provider, "AI model discovery failed: {error:#}");
                return Err(ApiResponse::error(
                    "Could not load models from the provider. Check the URL, API key, and provider access.",
                )
                .with_status(StatusCode::BAD_GATEWAY));
            }
        };

        ApiResponse::new_serialized(Response { models }).ok()
    }
}

async fn load_models(
    state: &shared::State,
    provider: &str,
    base_url: &str,
    api_key: &str,
) -> Result<Vec<String>, anyhow::Error> {
    let response = match provider {
        "anthropic" => {
            provider_json(
                state
                    .client
                    .get(format!("{base_url}/v1/models?limit=100"))
                    .header("x-api-key", api_key)
                    .header("anthropic-version", "2023-06-01"),
            )
            .await?
        }
        "google_gemini" => {
            provider_json(
                state
                    .client
                    .get(format!("{base_url}/models"))
                    .header("x-goog-api-key", api_key),
            )
            .await?
        }
        "openai_compatible" | "openrouter" | "ollama" => {
            let mut request = state.client.get(format!("{base_url}/models"));
            if !api_key.is_empty() {
                request = request.bearer_auth(api_key);
            }
            if provider == "openrouter" {
                request = request
                    .header("HTTP-Referer", "https://calagopus.com")
                    .header("X-Title", "All-in-One");
            }
            provider_json(request).await?
        }
        _ => return Err(anyhow::anyhow!("unsupported AI provider `{provider}`")),
    };

    let mut models = match provider {
        "google_gemini" => response
            .get("models")
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
            .filter(|model| {
                model
                    .get("supportedGenerationMethods")
                    .and_then(serde_json::Value::as_array)
                    .is_none_or(|methods| {
                        methods.iter().any(|method| {
                            method.as_str() == Some("generateContent")
                        })
                    })
            })
            .filter_map(|model| model.get("name").and_then(serde_json::Value::as_str))
            .map(|name| name.strip_prefix("models/").unwrap_or(name).to_string())
            .collect::<Vec<_>>(),
        _ => response
            .get("data")
            .or_else(|| response.get("models"))
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|model| {
                model
                    .get("id")
                    .or_else(|| model.get("name"))
                    .and_then(serde_json::Value::as_str)
                    .map(ToString::to_string)
            })
            .collect::<Vec<_>>(),
    };

    models.sort_unstable();
    models.dedup();
    models.truncate(250);
    Ok(models)
}

async fn provider_json(
    request: reqwest::RequestBuilder,
) -> Result<serde_json::Value, anyhow::Error> {
    let response = request.send().await?;
    let status = response.status();
    if !status.is_success() {
        return Err(anyhow::anyhow!("AI provider returned HTTP {status}"));
    }

    Ok(response.json().await?)
}

pub fn router(state: &shared::State) -> OpenApiRouter<shared::State> {
    OpenApiRouter::new()
        .routes(routes!(post::route))
        .with_state(state.clone())
}
