# All-in-One changelog

## 0.2.8 — 2026-10-17
- Reworked the `server.properties` editor into individual setting fields, added a separate Admin sidebar page for each server-tool setting, and added a demo advertising preview.
- Added a complete German locale for extension UI strings and included locale files in the release archive.
- Allowed new plugin JARs to be installed while the server is running and added console-detected, whitelist-rejected connection attempts to the ban workflow.
- Added separate installed/browse views for mods and plugins, with paged Modrinth search, project details, staged version updates, and confirmed file removal.
- Expanded player management with offline players, banned IPs, max-player editing, player details and stats, fixed operator/IP/inventory/kill actions, and a confirmed stopped-server data wipe.

## 0.2.7 — 2026-10-16
- Rebranded the extension display name to All-in-One while preserving its `com.calagopus.chat` package ID for upgrades.
- Added separate, administrator-configurable Minecraft server pages for modpacks, mods, plugins, players, and `server.properties`, filtered by egg compatibility.
- Changed Modrinth catalogs to load popular projects automatically, with optional search and game-version/loader filters.
- Expanded Player Manager with online, banned, whitelisted, and operator lists; added best-effort inventory, TPS, and optional ping display.
- Added a `server.properties` editor that offers to start or restart the server after saving.

## 0.2.6 — 2026-10-15
- Added a permission-gated server-tools page with Modrinth search and installers for server-side mods, plugins, and `.mrpack` modpacks.
- Added confirmed Minecraft Java player actions (kick, ban, unban, and whitelist management) and online-player listing through the Panel WebSocket.
- Kept existing server files intact during installs, added safe temporary modpack staging/cleanup, and left server loaders and startup commands unchanged.
- Fixed the server-tools TypeScript check and removed a duplicate player translation key.

## 0.2.5 — 2026-10-13
- Ported four independent top, bottom, left, and right advertising placements with per-slot sizes and dashboard/all-page scope.

## 0.2.4 — 2026-10-13
- Added sandboxed HTTPS iframe ads for providers that supply an embeddable ad URL, without relaxing the Panel CSP.

## 0.2.3 — 2026-10-13
- Added a separate Advertising admin page and custom HTTPS image/link banners across authenticated Panel pages.
- Upgraded the minimum supported Panel version to 1.2.5.

## 0.2.2 — 2026-10-07
- Added a first-use AI chat guide covering privacy, server-data handling, confirmations, and chat commands.
- Improved reopening a direct chat with the same person so the existing thread opens immediately.

## 0.2.1 — 2026-10-07
- Added a `/status` chat command with a searchable server picker and a direct live status/resource view, without an AI-provider call.

## 0.2.0 — 2026-10-07
- Fixed internal Panel API requests by forwarding the connection and host metadata expected by the Panel router.
- Added an animated three-dot typing indicator while the AI prepares a direct-chat or `@AI` group reply.
- Improved server-tool error details to identify the failing Panel route without exposing server UUIDs.

## 0.1.10 — 2026-10-07
- Added a dedicated encrypted Panel user API key for AI server control. The key's per-server scopes and the requesting user's own server permissions are both required, and confirmations remain mandatory.
- Added AI-enabled group chats; the AI responds only when mentioned with `@AI`, and only the user who requested a pending power action can confirm it.

## 0.1.9 — 2026-10-07
- Added a standalone Chat page and an exclusive widget/page display setting; users get one active Chat view at a time.
- Added unread-count badges to both collapsed and expanded chat views.
- Made the floating chat window resizable on larger screens.
- Rendered AI Markdown emphasis and block quotes instead of showing raw formatting markers.
- Improved diagnostics when AI-provider or Panel-tool endpoints return invalid JSON.

## 0.1.8 — 2026-10-07
- Added optional AI server-list, live-status, and confirmed start/stop/restart tools, respecting each user's Panel permissions.
- Added administrator settings for which server tools are available; arbitrary console commands and file operations remain disabled.

## 0.1.7 — 2026-10-07
- Improved phone layouts with safe-area spacing, keyboard-aware chat sizing, and larger touch targets.

## 0.1.6 — 2026-10-06
- Added a confirmed option to remove a direct, group, or AI conversation from your chat list without deleting it for other participants.

## 0.1.5 — 2026-10-06
- Added provider-reported input and output token totals for AI requests made by the extension.
- Added a dedicated Chat Settings page in the admin sidebar and an in-page changelog.
- Made the chat widget resize for mobile, tablet, and desktop viewports, and improved the settings layout on narrow screens.

## 0.1.4
- Localized chat and AI settings UI through the Panel translation system, with English fallback strings.

## 0.1.3
- Added model discovery and a searchable model selector for supported AI providers.
- Added a per-user Enter-to-send preference; Shift+Enter inserts a newline.
