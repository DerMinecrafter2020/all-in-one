# Agent instructions

## Project overview

- This repository contains the All-in-One extension source, not the Panel itself. Its stable package ID is `com.calagopus.chat` in `backend-extensions/com_calagopus_chat`; keep that ID for in-place upgrades unless a package migration is explicitly intended.
- Current extension version: `0.3.4`. Minimum supported Calagopus Panel version: `1.2.6` (`Metadata.toml`). Keep the extension manifests, workflow example, this file, and changelog aligned when bumping the version.
- The extension provides direct/group/AI chat, server information and confirmed power actions, advertising placements, and configurable Minecraft-only Modrinth, player, server.properties, and Minecraft version changer pages.
- The README is for extension features and development only. Do not add a GitHub Releases section or release/tag instructions to it; keep release procedures here, in `.github/workflows/release.yml`, and in `.forgejo/workflows/mirror-github-release.yml`.

## Extension identity and layout

- The Calagopus package name is `com.calagopus.chat`; its extension directory is `backend-extensions/com_calagopus_chat`.
- Keep the extension compatible with the official Calagopus extension layout and APIs. The minimum supported Panel version is set in `backend-extensions/com_calagopus_chat/Metadata.toml`.
- The Panel `panel_version` requirement describes Panel API compatibility. It is **not** the extension release version; change it only when the extension needs a newer Panel API.
- The Rust backend and extension settings live in `backend-extensions/com_calagopus_chat/src/`. The React frontend lives in `backend-extensions/com_calagopus_chat/frontend/`. Database migrations live in `backend-extensions/com_calagopus_chat/migrations/`.
- Put extension UI strings in `frontend/src/translations.ts` and use the Panel/extension translation hooks in components. Keep English base strings complete and maintain at least 90% German coverage in `frontend/public/translations/de/com.calagopus.chat.json`; missing locale entries fall back to English. Reuse Panel common translation keys where available.
- Keep `frontend/src/CHANGELOG.md` current; the Chat & AI Admin page renders its release entries.
- When building from a Panel checkout, build `frontend/dist` before building Rust; the Panel's `shared` crate build script requires those frontend assets.
- Keep the AI provider key in Calagopus encrypted extension settings. Never return it from an API endpoint, commit it, or include it in logs or release notes.

### Main implementation areas

- `src/lib.rs`: extension entry point and registration of admin/client API routers.
- `src/settings.rs`: persistent extension settings. AI provider and Panel control keys use encrypted storage; advertising settings are public configuration, not secrets.
- `src/routes/admin/settings.rs`: AI and configurable server-page settings API; `src/routes/admin/advertising.rs`: separate ad-settings API guarded by `extensions.manage`.
- `src/routes/admin/server_tools.rs`: updates server-tool page toggles and per-page Egg allowlists independently from Chat & AI settings; `src/routes/admin/minecraft_versions.rs`: protects MCJars administration, encrypted API-key updates, Egg mappings, and aggregate statistics.
- `src/routes/client/advertising.rs`: returns only public, enabled banner configuration to authenticated users. It does not require Chat permissions.
- `src/routes/client/server_tools.rs`: returns only public server-page toggles and Egg allowlists to authenticated users.
- `src/routes/client/conversations.rs` and `src/routes/client/conversation/`: chat creation, message history, AI tools, and power-action confirmation.
- `frontend/src/index.ts`: global widget/banner/visibility bootstrap and account/admin/Minecraft server route registration.
- `frontend/src/ChatWidget.tsx`: direct/group/AI chat UI, onboarding, slash commands, and status view.
- `frontend/src/AdvertisingBanner.tsx` and `AdvertisingSettingsPage.tsx`: global ad placements and their separate Admin → Advertising page.
- `src/routes/client/modrinth.rs`, `src/routes/client/minecraft_versions.rs`, `frontend/src/ServerToolsPage.tsx`, `ServerToolSettingsPage.tsx`, `MinecraftVersionSettingsPage.tsx`, `MinecraftVersionChanger.tsx`, `api/minecraftVersionInstall.ts`, `ModrinthManager.tsx`, `InstalledModrinthFiles.tsx`, `InstalledModrinthModpacks.tsx`, `api/modrinthModpacks.ts`, `PlayerManagerPage.tsx`, `PlayerSkinPreview.tsx`, and `ServerPropertiesEditor.tsx`: authenticated Modrinth and MCJars proxies, per-function admin pages, and per-server modpack/mod/plugin/player/properties/version tools.
- `frontend/src/lib/schemas.ts` and `frontend/src/api/`: API validation, serialization, and frontend request helpers.
- `migrations/`: PostgreSQL schema changes; use reversible `up.sql` and `down.sql` migrations.

## Local development and checks

- Develop against a matching Calagopus Panel `1.2.6` checkout; extension frontend imports use the Panel's `shared` package and `@/` aliases.
- The Panel frontend requires Node.js `>=24` and pnpm `>=11`. Install/build from the Panel checkout's `frontend/` directory before building Rust.
- Standard local preflight: `pnpm install`, `pnpm build:fast`, then `cargo build --profile heavy-release --package com_calagopus_chat` from the Panel root. CI runs `pnpm build:ci` and builds against `release-1.2.6`.
- Do not report a build/test as passing unless it actually ran. If Node, pnpm, Cargo, or Rust are missing, report that and continue with static checks only.

### Product and security invariants

- Private AI conversations and AI-enabled groups are distinct. In AI groups the assistant replies only to explicit `@AI` mentions; group server information may only be shared when every member can access the server.
- Provider and Panel API keys stay server-side/encrypted and are never included in model prompts or activity-log payloads. Server start/stop/restart requires the caller's own Panel permission, the configured control-key permission cap, and explicit in-chat confirmation.
- `/status` calls the authenticated Panel Client API directly and must not make an AI-provider request.
- Direct chats are unique per user pair. Selecting the same person reopens that pair's existing thread; do not create duplicate direct threads.
- Advertising has four independent placements (`top`, `bottom`, `left`, `right`) and an `all`/`dashboard` scope. Custom image/link creatives and sandboxed HTTPS iframe URLs are supported. Google AdSense's script-based embed is not supported by this CSP-safe implementation; providers must supply an embeddable iframe URL. Do not add raw HTML or scripts, `allow-same-origin`, or Panel-CSP workarounds. The iframe mode intentionally cannot access Panel storage or navigate the top-level Panel page; some ad providers may therefore be incompatible.
- Keep user-visible advertising opt-in by default. Validate all externally loaded URLs as HTTPS on the backend, mark outbound links `rel="sponsored noopener noreferrer"`, and do not send ad settings/content to the AI provider.
- Modrinth installers must use Calagopus file APIs and the caller's own server permissions, accept only allowlisted HTTPS Modrinth file hosts, and avoid changing server loaders/startup commands. New mod/plugin installs never overwrite existing files; an explicit user-selected mod/plugin update may replace only its selected JAR after staging. Modpack management records only files newly copied by All-in-One in its protected registry; update may replace those tracked files, while pre-existing conflicts are never claimed or removed. Mod and modpack installs/updates require a stopped server; plugin JARs may be installed, updated, or removed while running, but disk changes do not hot-reload and the loaded plugin changes on restart.
- The Minecraft version changer proxies MCJars from the backend; keep the optional organization API key encrypted and never return it to server clients. Use Panel 1.2.6's file fingerprint API for installed-version detection, not a Wings patch. Stage downloads under a random server directory; allow only approved HTTPS download hosts and validated paths. Inspect ZIP central/local headers, path names, links, entry counts, and expanded sizes before calling the Panel archive API. Never add a server-wide wipe: protect worlds, mods, plugins, configuration, and EULA files; move only provider-required paths and individually reviewed software-file conflicts to Panel Trash where configured, after explicit confirmation. Require a stopped server and the needed file permissions (including `files.archive` for ZIP plans). Apply mapped Egg/startup and Java-image changes only after the install confirmation and only via Panel admin APIs with the relevant `servers.read`, `servers.update`, `servers.variables`, and `nests.read` permissions. Local version counts are opt-in aggregates without server/user identifiers; icons load from MCJars and may expose visitors' IP addresses, which is disclosed in the UI.
- On Panel 1.2.6+, normal deletions go to Trash by default; use permanent deletion only for temporary staging cleanup and explicitly confirmed player-data wipes.
- Player actions are limited to fixed, validated kick, ban/pardon, whitelist, operator, IP-ban, clear-inventory, and kill commands and require `control.console`; optional command reasons must be single-line and bounded. The whitelist enable/disable setting also requires `files.read-content` and `files.create`, and confirmation; applying it immediately on a running server additionally requires `control.console`. Reading console responses additionally requires `control.read-console`, while player lists and saved stats require `files.read-content`. Wiping a player's data/advancements/stats requires an explicit confirmation, a fully stopped server, a validated player UUID/world path, and `files.read`, `files.delete`, and `files.read-content`. The opt-in skin preview fetches only from fixed HTTPS `minotar.net`, with credentials and referrer disabled, and only after the user chooses to load it.
- The `server.properties` editor requires `files.read-content` and `files.create`; starting/restarting after a save also requires `control.start`/`control.restart`.
- Each server-tool page (modpack, mod, plugin, player, `server.properties`, and Minecraft versions) has an Admin Egg allowlist (or all Eggs) plus a global page toggle. Loading Egg choices requires `nests.read`; saving requires `extensions.manage`. Controls must also pass the Egg-capability check; show a page-specific compatibility notice instead of rendering incompatible controls. Keep the technical extension package ID stable when changing its display name to All-in-One.

## Extension versioning

Use a three-part version in `MAJOR.MINOR.PATCH` order. Keep these values identical:

- `backend-extensions/com_calagopus_chat/Cargo.toml` → `[package].version`
- `backend-extensions/com_calagopus_chat/frontend/package.json` → `version`
- The Git tag, prefixed with `v` (for example, `v0.3.4`)

Start from the current version, `0.3.4`, and count from the rightmost component. Increment that component through `10`; when it reaches `10`, reset it to `0` and increment the component to its left. Apply the same rollover to the middle component. Examples:

```text
0.2.9 → 0.2.10 → 0.2.11 → 0.3.0
0.3.0 → 0.3.1 → 0.3.2 → 0.3.3
0.10.10 → 1.0.0
```

After `9.10.10`, the next version is `10.0.0`; the major component can continue above 10. Do not add leading zeroes. Before a release, update both package version fields, commit the change, and tag that commit with the matching `vMAJOR.MINOR.PATCH` value. Do not reuse or force-move a published release tag.

- For every requested implementation commit, bump both package version fields to the next unused version and update the changelog and current-version references in that same commit. Do not defer the version bump until the release push unless the user explicitly asks to keep the current version.

Before preparing or pushing release changes, inspect both local and remote tags (for example, `git tag --list 'v*'` and `git ls-remote --tags origin`). If the current package version already has a tag, **do not push additional release-worthy changes with that same version**. Bump both manifests to the next unused version first, and update current-version references in the changelog, workflow example, and this file. Keep the README focused on the extension rather than release procedures. Add a `## MAJOR.MINOR.PATCH — YYYY-MM-DD` section with the release changes to `frontend/src/CHANGELOG.md`; the workflow publishes that matching section in the GitHub Release body and fails if it is missing. A tag is immutable release identity: changes after `v0.1.10` belong in `0.2.0`, not in another push of `0.1.10`.

## GitHub release and `.c7s.zip`

The `.github/workflows/release.yml` workflow automatically checks pushes to `main` and `master` **only on GitHub.com**; its `ubuntu-24.04` jobs are skipped on Forgejo. When the Cargo and frontend versions match and the corresponding tag does not already exist, it builds against Panel release 1.2.6 on an isolated GitHub runner. Cargo and pnpm dependency caches speed up repeated builds. A failed preflight blocks packaging and publication. After the build passes, it creates the version tag and a GitHub Release with `All-in-One.c7s.zip`. Pushes of `v*` tags and manual runs are also supported.

On a branch push, if `v<package version>` already exists remotely, the workflow deliberately skips both preflight and release to avoid duplicate releases. It does not update or recreate the existing release from newer branch commits. Bump to the next unused version before pushing those changes.

For an automatic release:

1. Run the official pre-export checks from a matching Calagopus Panel checkout (Rust formatting/linting and the frontend formatting/build checks).
2. Update both package version fields to the same unused version and commit the changes.
3. Push the commit to `main` or `master`. The workflow derives the `vMAJOR.MINOR.PATCH` tag and creates the GitHub Release after preflight succeeds. A regular code push without a version bump will not create a release.

4. Check the repository's **Actions** tab. When the workflow succeeds, download `All-in-One.c7s.zip` from the generated GitHub Release.

To start a release manually, use **Actions → Release All-in-One → Run workflow**, select the branch containing the release files, and enter the version tag. For the current manifests, that tag is `v0.3.4`.

If the manually selected tag already exists, the workflow checks out and packages the commit that the tag points to—not newer code from the selected branch. Use this to retry a failed release for that exact tagged commit; bump the version to publish later changes.

If an earlier failed run already left a tag pointing at a commit with the wrong package version, remove and recreate that tag only if no GitHub Release was published for it. Never move or reuse a tag for a published release; bump to the next version instead.

## Forgejo pull-mirror releases

Forgejo pull mirrors sync Git branches and tags, not GitHub Release objects. `.forgejo/workflows/mirror-github-release.yml` reacts to a mirrored `v*` tag, waits up to ten minutes for the matching public GitHub Release and `All-in-One.c7s.zip`, then creates or refreshes the Forgejo Release with the upstream title/notes and uploads the same archive. It uses Forgejo's short-lived `forgejo.token`; no personal token or repository secret is needed.

For this to run, enable Forgejo Actions on the mirrored repository and register a runner with the `docker` label; its image must support Node.js for the checkout/setup actions. The runner needs outbound access to GitHub and the Forgejo API; the configured Forgejo URL must use HTTPS except for loopback. Ensure the pull mirror synchronizes tags and that `.forgejo/workflows/` is present on the default branch. To backfill an already-synced tag or recover a missed tag event (including some force-updated tags), run **Mirror GitHub release to Forgejo** manually and enter the existing `vMAJOR.MINOR.PATCH` tag. Re-running is safe: an existing matching `.c7s.zip` asset is left intact; a same-name asset with a different size fails rather than being silently replaced.

The archive layout must have `Metadata.toml` at its root, Rust sources and `Cargo.toml` under `backend/`, frontend sources, `package.json`, and locale files under `frontend/`, and SQL migrations under `migrations/`. Do not include the Panel-generated `frontend/tsconfig.json`, `node_modules`, or an extra enclosing `com_calagopus_chat/` directory.

For manual export from the Panel repository, use the official command from the Panel root:

```bash
panel-rs extensions export com.calagopus.chat
```

The native Panel exporter names its local file from the stable package ID (`exported-extensions/com_calagopus_chat.c7s.zip`); the GitHub Release asset is `All-in-One.c7s.zip`. See the [official extension release guide](https://calagopus.com/docs/panel/extensions/getting-your-extension-ready) for pre-export checks and details.

## Automatic commit policy

- After completing a requested implementation or documentation task, automatically create a Git commit unless the user says not to. Do not ask for separate commit approval.
- Before staging, inspect `git status` and the diff. Stage only files changed for the current task; never stage unrelated or pre-existing user changes wholesale.
- Use a concise Conventional Commit subject (`feat:`, `fix:`, `docs:`, `chore:`, etc.). Do not amend existing commits, force-move tags, or push commits unless the user explicitly asks.
- If `git` is not on `PATH`, check standard installation locations (for example, `C:\Program Files\Git\cmd\git.exe` on Windows) before treating it as unavailable. If the workspace is not a Git repository, no Git executable or identity is available, or the change cannot be isolated from unrelated work, do not fabricate a commit or use destructive workarounds; report why no commit was created.
- Run the relevant formatter/tests/build before committing when available. If tools are unavailable, state that in the final report; do not claim checks passed.
