use shared::State;
use utoipa_axum::router::OpenApiRouter;

mod advertising;
mod conversation;
mod conversations;
pub(crate) mod minecraft_versions;
mod models;
mod modrinth;
mod server_tools;
mod users;

pub fn router(state: &State) -> OpenApiRouter<State> {
    OpenApiRouter::new()
        .nest("/users", users::router(state))
        .nest("/conversations", conversations::router(state))
        .nest("/advertising", advertising::router(state))
        .nest("/modrinth", modrinth::router(state))
        .nest("/minecraft-versions", minecraft_versions::router(state))
        .nest("/server-tools", server_tools::router(state))
        .with_state(state.clone())
}
