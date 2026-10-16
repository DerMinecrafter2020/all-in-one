use shared::{
    State,
    extensions::{
        Extension, ExtensionPermissionsBuilder, ExtensionRouteBuilder,
        settings::ExtensionSettingsDeserializer,
    },
    permissions::PermissionGroup,
};
use std::sync::Arc;

mod routes;
pub mod settings;

#[derive(Default)]
pub struct ExtensionStruct;

#[async_trait::async_trait]
impl Extension for ExtensionStruct {
    async fn initialize(&mut self, _state: State) {
        tracing::info!("All-in-One extension initialized");
    }

    async fn initialize_router(
        &mut self,
        state: State,
        builder: ExtensionRouteBuilder,
    ) -> ExtensionRouteBuilder {
        builder
            .add_admin_api_router(|routes| {
                routes.nest(
                    "/extensions/com.calagopus.chat",
                    routes::admin::router(&state),
                )
            })
            .add_client_api_router(|routes| {
                routes.nest(
                    "/extensions/com.calagopus.chat",
                    routes::client::router(&state),
                )
            })
    }

    async fn initialize_permissions(
        &mut self,
        _state: State,
        builder: ExtensionPermissionsBuilder,
    ) -> ExtensionPermissionsBuilder {
        builder.add_user_permission_group(
            "chat",
            PermissionGroup {
                description: "Permissions for All-in-One chat features.",
                permissions: indexmap::IndexMap::from([
                    ("read", "Allows viewing users, conversations, and messages."),
                    ("send", "Allows creating conversations and sending messages."),
                ]),
            },
        )
    }

    async fn settings_deserializer(&self, _state: State) -> ExtensionSettingsDeserializer {
        Arc::new(settings::ExtensionSettingsDataDeserializer)
    }
}
