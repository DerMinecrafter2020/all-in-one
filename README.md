# Calagopus Chat

A native Calagopus Panel extension that adds an always-available, theme-aware chat widget. It supports direct messages, group conversations, unread counts, and private AI conversations configured by a panel administrator.

## Features

- A compact bottom-right chat bar when minimized and a responsive, resizable conversation window on larger screens that adapts to mobile viewports, keyboards, and safe areas.
- A standalone Chat page in the Panel account sidebar; administrators choose either the floating widget or page-only mode.
- Direct messages and named group chats between active panel users.
- Optional AI-enabled group chats that answer only when a member explicitly mentions `@AI`.
- A first-use AI chat guide explaining privacy, safe use, and available chat commands.
- A `/status` chat command with a searchable server picker that reads live status directly from the Panel without an AI-provider call.
- Admin-configurable custom HTTPS image/link banners across authenticated Panel pages.
- An animated typing indicator while AI responses are being prepared.
- Remove a conversation from your own chat list without deleting it for other participants.
- Conversation history and unread message counts persisted in PostgreSQL.
- AI chats with OpenAI-compatible providers (including OpenRouter and custom endpoints), Anthropic, Google Gemini, and Ollama.
- Optional AI server information tools and start/stop/restart requests, gated by admin settings, provider tool-calling support, and the current user's Panel server permissions.
- Power requests also require a separate encrypted Panel user API key as a permission cap; it cannot grant a user more rights than their own per-server permissions.
- AI replies render standard Markdown emphasis and block quotes instead of showing formatting markers literally.
- Provider-reported input/output token totals for AI requests made by Calagopus Chat.
- Admin model discovery with a searchable model selector, plus a per-user Enter-to-send preference.
- A **Chat settings** page in the admin sidebar (also available from **Admin → Extensions → Calagopus Chat**) for the AI URL, model, provider key, Panel server-control key, system prompt, token-usage totals, and changelog.
- API keys are stored through Calagopus's encrypted extension-settings API; chat content and API keys are not written to activity-log payloads.
- Mantine components and theme CSS variables keep the widget aligned with the active light/dark theme and custom panel palettes.
- UI strings use Calagopus's translation system, with English fallbacks when a localized extension string is unavailable.

## Extension layout

The extension source lives in `backend-extensions/com_calagopus_chat/`, using the canonical directory structure from the [official extension file-structure guide](https://calagopus.com/docs/panel/extensions/file-structure). Its dotted package name is `com.calagopus.chat`.

This repository is the extension source, not a full Panel checkout. The Rust manifest intentionally uses Calagopus workspace dependencies. To develop it locally, copy `backend-extensions/com_calagopus_chat/` into a matching Calagopus Panel checkout under `backend-extensions/`, then follow the official [development environment](https://calagopus.com/docs/panel/extensions/dev-environment) and [installation](https://calagopus.com/docs/panel/extensions/installing-extensions) guides. Extensions require the Heavy image or a full development environment.

For source development in the Panel checkout:

```bash
cd frontend
pnpm install
pnpm build:fast
cd ..
cargo build --profile heavy-release
```

The extension targets Calagopus Panel `>=1.2.5`. Its frontend uses the official global page slot, separate admin sidebar routes for Chat settings and Advertising, frontend API helpers, and the extension card configuration page; the backend uses Rust routes, encrypted extension settings, permissions, and SQL migrations.

## Configure AI

1. Install and enable **Calagopus Chat** in the Panel.
2. Open **Admin → Chat settings** from the sidebar, or **Admin → Extensions → Calagopus Chat → Configure**.
3. Choose OpenAI-compatible, OpenRouter, Anthropic, Google Gemini, or Ollama.
4. Enter the provider’s base URL and API key; Ollama can run without one.
5. Load the provider’s available models and select one, or enter a model ID manually.
6. Adjust the system prompt and enable AI chat.
7. To enable server power actions, enter a separate Panel user API key whose owner can access the target servers and whose scopes include `control.start`, `control.stop`, and `control.restart`. Keep the server-information and power-action settings enabled as desired.

OpenAI-compatible providers use `/chat/completions`; Anthropic and Gemini use their native Messages and `generateContent` APIs. Server tools require a model that supports function calling. The AI can only see servers the current user can access. Start/stop/restart requests require both the caller's per-server permission and the configured Panel API key's scope, and are rechecked at confirmation. AI-enabled groups respond only when a user explicitly mentions `@AI`; the recent group conversation is then sent to the configured AI provider for context. Arbitrary console commands and file operations are not exposed. Token totals reflect only Calagopus Chat calls, using usage fields reported by the configured provider; they are not account-wide billing totals. Providers that omit usage details are excluded. Neither API key is returned by the admin settings endpoint; leave each field blank to preserve its saved key or select its **Remove** option to clear it.

## Advertising banners

Administrators configure custom HTTPS image/link banners on the separate **Admin → Advertising** page, not in Chat settings. Banners appear across authenticated Panel pages. Links are marked as sponsored and opened in a new tab; the extension does not accept arbitrary banner HTML or JavaScript or load an advertising-network script.

## Official documentation

- [Extensions overview](https://calagopus.com/docs/panel/extensions/)
- [Extension file structure](https://calagopus.com/docs/panel/extensions/file-structure)
- [Mounting UI](https://calagopus.com/docs/panel/extensions/concepts/mounting-ui)
- [Settings](https://calagopus.com/docs/panel/extensions/concepts/settings)
- [Routing](https://calagopus.com/docs/panel/extensions/concepts/routing)
- [Permissions](https://calagopus.com/docs/panel/extensions/concepts/permissions)
- [Theming](https://calagopus.com/docs/panel/extensions/concepts/theming)
