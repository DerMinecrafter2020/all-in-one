use shared::State;
use utoipa_axum::router::OpenApiRouter;

mod advertising;
mod minecraft_versions;
mod server_tools;
mod settings;

pub fn router(state: &State) -> OpenApiRouter<State> {
    OpenApiRouter::new()
        .nest("/settings", settings::router(state))
        .nest("/advertising", advertising::router(state))
        .nest("/minecraft-versions", minecraft_versions::router(state))
        .nest("/server-tools", server_tools::router(state))
        .with_state(state.clone())
}
