# All-in-One

A native Calagopus Panel extension that combines a theme-aware chat widget with Modrinth installers, Minecraft player management, and a `server.properties` editor.

## Features

- A compact bottom-right chat bar when minimized and a responsive, resizable conversation window on larger screens that adapts to mobile viewports, keyboards, and safe areas.
- A standalone Chat page in the Panel account sidebar; administrators choose either the floating widget or page-only mode.
- Direct messages and named group chats between active panel users.
- Optional AI-enabled group chats that answer only when a member explicitly mentions `@AI`.
- A first-use AI chat guide explaining privacy, safe use, and available chat commands.
- A `/status` chat command with a searchable server picker that reads live status directly from the Panel without an AI-provider call.
- Admin-configurable top, bottom, left, and right custom image/link or sandboxed iframe banners across authenticated Panel pages.
- Separate Modrinth modpack, mod, and plugin pages load popular projects automatically, offer version selection, and appear only for compatible Minecraft Eggs; administrators can toggle each page in All-in-One settings.
- The Minecraft player manager shows online, banned, whitelisted, and opped players. Inventory/TPS use server commands where supported, ping is shown when available, and the configured player limit comes from `server.properties` or the server list response.
- File installs follow the server's Panel permissions, avoid overwriting existing files, and require the Java server to be stopped. Mod and plugin installers let the operator select a matching loader/game version; modpacks do not change the server loader or startup command. Saving `server.properties` asks whether to start or restart the server.
- An animated typing indicator while AI responses are being prepared.
- Remove a conversation from your own chat list without deleting it for other participants.
- Conversation history and unread message counts persisted in PostgreSQL.
- AI chats with OpenAI-compatible providers (including OpenRouter and custom endpoints), Anthropic, Google Gemini, and Ollama.
- Optional AI server information tools and start/stop/restart requests, gated by admin settings, provider tool-calling support, and the current user's Panel server permissions.
- Power requests also require a separate encrypted Panel user API key as a permission cap; it cannot grant a user more rights than their own per-server permissions.
- AI replies render standard Markdown emphasis and block quotes instead of showing formatting markers literally.
- Provider-reported input/output token totals for AI requests made by All-in-One Chat.
- Admin model discovery with a searchable model selector, plus a per-user Enter-to-send preference.
- An **All-in-One settings** page in the admin sidebar (also available from **Admin → Extensions → All-in-One**) for AI settings, selectable server-tool pages, token-usage totals, and changelog.
- API keys are stored through Calagopus's encrypted extension-settings API; chat content and API keys are not written to activity-log payloads.
- Mantine components and theme CSS variables keep the widget aligned with the active light/dark theme and custom panel palettes.
- UI strings use Calagopus's translation system, with English fallbacks when a localized extension string is unavailable.

## Extension layout

The extension source lives in `backend-extensions/com_calagopus_chat/`, using the canonical directory structure from the [official extension file-structure guide](https://calagopus.com/docs/panel/extensions/file-structure). Its display name is **All-in-One**. The technical package name remains `com.calagopus.chat` so existing installations can upgrade in place.

This repository is the extension source, not a full Panel checkout. The Rust manifest intentionally uses Calagopus workspace dependencies. To develop it locally, copy `backend-extensions/com_calagopus_chat/` into a matching Calagopus Panel checkout under `backend-extensions/`, then follow the official [development environment](https://calagopus.com/docs/panel/extensions/dev-environment) and [installation](https://calagopus.com/docs/panel/extensions/installing-extensions) guides. Extensions require the Heavy image or a full development environment.

For source development in the Panel checkout:

```bash
cd frontend
pnpm install
pnpm build:fast
cd ..
cargo build --profile heavy-release
```

The extension targets Calagopus Panel `>=1.2.5`. Its frontend uses the official global page slot, separate admin routes for All-in-One settings and Advertising, Minecraft-egg-filtered server pages, frontend API helpers, and the extension card configuration page; the backend uses Rust routes, encrypted extension settings, permissions, and SQL migrations.

## Configure AI

1. Install and enable **All-in-One** in the Panel.
2. Open **Admin → All-in-One settings** from the sidebar, or **Admin → Extensions → All-in-One → Configure**.
3. Choose OpenAI-compatible, OpenRouter, Anthropic, Google Gemini, or Ollama.
4. Enter the provider’s base URL and API key; Ollama can run without one.
5. Load the provider’s available models and select one, or enter a model ID manually.
6. Adjust the system prompt and enable AI chat.
7. To enable server power actions, enter a separate Panel user API key whose owner can access the target servers and whose scopes include `control.start`, `control.stop`, and `control.restart`. Keep the server-information and power-action settings enabled as desired.

OpenAI-compatible providers use `/chat/completions`; Anthropic and Gemini use their native Messages and `generateContent` APIs. AI server tools require a model that supports function calling. The AI can only see servers the current user can access. Start/stop/restart requests require both the caller's per-server permission and the configured Panel API key's scope, and are rechecked at confirmation. AI-enabled groups respond only when a user explicitly mentions `@AI`; the recent group conversation is then sent to the configured AI provider for context. The AI cannot invoke arbitrary console commands or file operations; the separate Minecraft pages expose only fixed player-management commands and permission-checked installers. Token totals reflect only All-in-One Chat calls, using usage fields reported by the configured provider; they are not account-wide billing totals. Providers that omit usage details are excluded. Neither API key is returned by the admin settings endpoint; leave each field blank to preserve its saved key or select its **Remove** option to clear it.

## Advertising banners

Administrators configure advertising on the separate **Admin → Advertising** page, not in All-in-One settings. Four independent placements support per-slot dimensions and can be scoped to all authenticated pages or only the dashboard. Choose a custom HTTPS image/link or a sandboxed HTTPS iframe from a provider that supports embed URLs. Iframes run in an isolated sandbox; the extension does not execute provider JavaScript in the Panel page. Google AdSense uses a script-based embed, so use an iframe-compatible provider for this mode.

## Official documentation

- [Extensions overview](https://calagopus.com/docs/panel/extensions/)
- [Extension file structure](https://calagopus.com/docs/panel/extensions/file-structure)
- [Mounting UI](https://calagopus.com/docs/panel/extensions/concepts/mounting-ui)
- [Settings](https://calagopus.com/docs/panel/extensions/concepts/settings)
- [Routing](https://calagopus.com/docs/panel/extensions/concepts/routing)
- [Permissions](https://calagopus.com/docs/panel/extensions/concepts/permissions)
- [Theming](https://calagopus.com/docs/panel/extensions/concepts/theming)
