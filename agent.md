# Agent instructions

## Extension identity and layout

- The Calagopus package name is `com.calagopus.chat`; its extension directory is `backend-extensions/com_calagopus_chat`.
- Keep the extension compatible with the official Calagopus extension layout and APIs. The minimum supported Panel version is set in `backend-extensions/com_calagopus_chat/Metadata.toml`.
- The Panel `panel_version` requirement describes Panel API compatibility. It is **not** the extension release version; change it only when the extension needs a newer Panel API.
- The Rust backend and extension settings live in `backend-extensions/com_calagopus_chat/src/`. The React frontend lives in `backend-extensions/com_calagopus_chat/frontend/`. Database migrations live in `backend-extensions/com_calagopus_chat/migrations/`.
- Put extension UI strings in `frontend/src/translations.ts` and use the Panel/extension translation hooks in components. Keep English base strings complete; missing locale entries should fall back to English. Reuse Panel common translation keys where available.
- Keep `frontend/src/CHANGELOG.md` current; the admin Chat Settings page renders its release entries.
- When building from a Panel checkout, build `frontend/dist` before building Rust; the Panel's `shared` crate build script requires those frontend assets.
- Keep the AI provider key in Calagopus encrypted extension settings. Never return it from an API endpoint, commit it, or include it in logs or release notes.

## Extension versioning

Use a three-part version in `MAJOR.MINOR.PATCH` order. Keep these values identical:

- `backend-extensions/com_calagopus_chat/Cargo.toml` → `[package].version`
- `backend-extensions/com_calagopus_chat/frontend/package.json` → `version`
- The Git tag, prefixed with `v` (for example, `v0.2.4`)

Start from the current version, `0.2.4`, and count from the rightmost component. Increment that component through `10`; when it reaches `10`, reset it to `0` and increment the component to its left. Apply the same rollover to the middle component. Examples:

```text
0.2.4 → 0.2.5 → … → 0.2.10 → 0.3.0
0.10.10 → 1.0.0
```

After `9.10.10`, the next version is `10.0.0`; the major component can continue above 10. Do not add leading zeroes. Before a release, update both package version fields, commit the change, and tag that commit with the matching `vMAJOR.MINOR.PATCH` value. Do not reuse or force-move a published release tag.

Before preparing or pushing release changes, inspect both local and remote tags (for example, `git tag --list 'v*'` and `git ls-remote --tags origin`). If the current package version already has a tag, **do not push additional release-worthy changes with that same version**. Bump both manifests to the next unused version first, and update current-version references in the changelog, workflow example, and this file. Keep the README focused on the extension rather than release procedures. Add a `## MAJOR.MINOR.PATCH — YYYY-MM-DD` section with the release changes to `frontend/src/CHANGELOG.md`; the workflow publishes that matching section in the GitHub Release body and fails if it is missing. A tag is immutable release identity: changes after `v0.1.10` belong in `0.2.0`, not in another push of `0.1.10`.

## GitHub release and `.c7s.zip`

The `.github/workflows/release.yml` workflow automatically checks pushes to `main` and `master`. When the Cargo and frontend versions match and the corresponding tag does not already exist, it builds against Panel release 1.2.5 on an isolated GitHub runner. Cargo and pnpm dependency caches speed up repeated builds. A failed preflight blocks packaging and publication. After the build passes, it creates the version tag and a GitHub Release with `com_calagopus_chat.c7s.zip`. Pushes of `v*` tags and manual runs are also supported.

On a branch push, if `v<package version>` already exists remotely, the workflow deliberately skips both preflight and release to avoid duplicate releases. It does not update or recreate the existing release from newer branch commits. Bump to the next unused version before pushing those changes.

For an automatic release:

1. Run the official pre-export checks from a matching Calagopus Panel checkout (Rust formatting/linting and the frontend formatting/build checks).
2. Update both package version fields to the same unused version and commit the changes.
3. Push the commit to `main` or `master`. The workflow derives the `vMAJOR.MINOR.PATCH` tag and creates the GitHub Release after preflight succeeds. A regular code push without a version bump will not create a release.

4. Check the repository's **Actions** tab. When the workflow succeeds, download the `.c7s.zip` from the generated GitHub Release.

To start a release manually, use **Actions → Release Calagopus Chat → Run workflow**, select the branch containing the release files, and enter the version tag. For the current manifests, that tag is `v0.2.4`.

If the manually selected tag already exists, the workflow checks out and packages the commit that the tag points to—not newer code from the selected branch. Use this to retry a failed release for that exact tagged commit; bump the version to publish later changes.

If an earlier failed run already left a tag pointing at a commit with the wrong package version, remove and recreate that tag only if no GitHub Release was published for it. Never move or reuse a tag for a published release; bump to the next version instead.

The archive layout must have `Metadata.toml` at its root, Rust sources and `Cargo.toml` under `backend/`, frontend sources and `package.json` under `frontend/`, and SQL migrations under `migrations/`. Do not include the Panel-generated `frontend/tsconfig.json`, `node_modules`, or an extra enclosing `com_calagopus_chat/` directory.

For manual export from the Panel repository, use the official command from the Panel root:

```bash
panel-rs extensions export com.calagopus.chat
```

It writes `exported-extensions/com_calagopus_chat.c7s.zip`. See the [official extension release guide](https://calagopus.com/docs/panel/extensions/getting-your-extension-ready) for pre-export checks and details.
