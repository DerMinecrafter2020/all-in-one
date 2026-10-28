# All-in-One changelog

## 0.3.5 — 2026-10-28
- Set the current All-in-One release version to 0.3.5; the extension continues to require Calagopus Panel `>=1.2.6`.

## 0.3.4 — 2026-10-25
- Added a Minecraft version changer with MCJars type/version/build browsing and installed-build detection through the Panel file fingerprint API.
- Added admin settings for an encrypted MCJars organization key, provider ordering, per-type Egg mappings, icon format, opt-in local statistics, and public aggregate statistics.
- Added a stopped-server installer that stages provider files, validates HTTPS sources and archive paths/sizes, and requires confirmation before moving only conflicting launcher files or provider-required paths to Panel Trash where configured; it never wipes the server root.
- Applied mapped Egg, startup, `SERVER_JARFILE`, and Java image updates only through the corresponding Panel admin permissions.

## 0.3.3 — 2026-10-25
- Added automatic Forgejo releases for mirrored GitHub tags, including matching release notes and the `.c7s.zip` asset.

## 0.3.2 — 2026-10-25
- Added a confirmed whitelist toggle, optional reasons for kick and bans, configured-versus-live player-limit status, and an on-demand 3D skin preview.

## 0.3.1 — 2026-10-23
- Raised the minimum supported Calagopus Panel version to 1.2.6 and verified the extension against its updated Egg response schema and file APIs.
- Accounted for the new Trash behavior: temporary staging folders and explicitly wiped player data are permanently deleted; ordinary user-requested removals remain recoverable through Panel Trash.

## 0.3.0 — 2026-10-18
- Added per-function Egg selection to the Admin server-tool settings; unsupported Egg pages explain incompatibility while their controls remain gated.
- Matched `server.properties` cards to consistent heights and aligned labels and inputs.
- Fixed the Egg-list permission hint (`nests.read`), reset tool state on server changes, and isolate chat state between accounts.
- Bounded Modrinth override pagination and external JSON responses, rejected AI base URLs containing credentials or query strings, and applied file-operation timeouts to request startup and completion.

## 0.2.9 — 2026-10-17
- Added installed/browse views for mods, plugins, and modpacks, including paged Modrinth catalogs, project details, staged updates, and confirmed removals limited to files tracked by All-in-One.
- Expanded player management with offline players, banned IPs, max-player editing, player details and stats, fixed operator/IP/inventory/kill actions, and a confirmed stopped-server data wipe.
- Restyled `server.properties` as a responsive settings-card grid and added per-function Egg compatibility notices across all server-tool pages.
- Moved visible Chat, Chat & AI settings, and Advertising routes under `/all-in-one`; the old Chat and Ads paths redirect to their new locations while the package/API ID remains stable.

## 0.2.8 — 2026-10-17
- Reworked the `server.properties` editor into individual setting fields, added a separate Admin sidebar page for each server-tool setting, and added a demo advertising preview.
- Added a complete German locale for extension UI strings and included locale files in the release archive.
- Allowed new plugin JARs to be installed while the server is running and added console-detected, whitelist-rejected connection attempts to the ban workflow.

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
