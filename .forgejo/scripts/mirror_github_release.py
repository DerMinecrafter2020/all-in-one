#!/usr/bin/env python3
"""Create or refresh a Forgejo release from the matching public GitHub release."""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import tempfile
import time
import zipfile
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlparse
from urllib.request import Request, urlopen


GITHUB_OWNER = "DerMinecrafter2020"
GITHUB_REPOSITORY = "all-in-one"
ASSET_NAME = "All-in-One.c7s.zip"
MAX_ASSET_SIZE = 64 * 1024 * 1024
RELEASE_WAIT_ATTEMPTS = 40
RELEASE_WAIT_SECONDS = 15
VERSION_TAG = re.compile(r"v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\Z")


def decode_json(response_body: bytes) -> object:
    if not response_body:
        return {}
    try:
        return json.loads(response_body)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return response_body.decode("utf-8", errors="replace")


def request_json(
    url: str,
    *,
    method: str = "GET",
    token: str | None = None,
    payload: dict[str, object] | None = None,
    raw_body: bytes | None = None,
    content_type: str | None = None,
    extra_headers: dict[str, str] | None = None,
) -> tuple[int, object]:
    if payload is not None and raw_body is not None:
        raise ValueError("Use either a JSON payload or a raw body, not both")

    headers = {
        "Accept": "application/json",
        "User-Agent": "All-in-One-Forgejo-Release-Mirror",
    }
    if extra_headers:
        headers.update(extra_headers)
    if token:
        headers["Authorization"] = f"token {token}"

    body = raw_body
    if payload is not None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    elif content_type:
        headers["Content-Type"] = content_type

    request = Request(url, data=body, headers=headers, method=method)
    try:
        with urlopen(request, timeout=30) as response:
            return response.status, decode_json(response.read())
    except HTTPError as error:
        return error.code, decode_json(error.read())


def response_message(payload: object) -> str:
    if isinstance(payload, dict):
        message = payload.get("message")
        if isinstance(message, str) and message:
            return message
    if isinstance(payload, str) and payload:
        return payload[:1000]
    return "no response details"


def require_status(label: str, status: int, payload: object, expected: set[int]) -> object:
    if status not in expected:
        raise RuntimeError(f"{label} failed with HTTP {status}: {response_message(payload)}")
    return payload


def select_release_tag() -> str:
    event_name = os.environ.get("EVENT_NAME", "")
    if event_name == "workflow_dispatch":
        tag = os.environ.get("INPUT_TAG", "").strip()
    elif event_name == "push":
        tag = os.environ.get("REF_NAME", "").strip()
    else:
        raise RuntimeError(f"Unsupported workflow event: {event_name or '(empty)'}")

    if VERSION_TAG.fullmatch(tag) is None:
        raise RuntimeError(f"Release tag {tag!r} must use the form vMAJOR.MINOR.PATCH")
    return tag


def wait_for_github_release(tag: str) -> tuple[dict[str, object], dict[str, object]]:
    release_url = (
        f"https://api.github.com/repos/{GITHUB_OWNER}/{GITHUB_REPOSITORY}"
        f"/releases/tags/{quote(tag, safe='')}"
    )
    headers = {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    last_reason = "the release or its asset is not published yet"

    for attempt in range(1, RELEASE_WAIT_ATTEMPTS + 1):
        try:
            status, payload = request_json(release_url, extra_headers=headers)
        except URLError as error:
            status, payload = 0, {}
            last_reason = f"GitHub API is temporarily unavailable: {error.reason}"

        if status == 200:
            if not isinstance(payload, dict) or payload.get("tag_name") != tag:
                raise RuntimeError(f"GitHub returned an unexpected release for {tag}")
            if payload.get("draft"):
                last_reason = "the GitHub release is still a draft"
            else:
                assets = payload.get("assets")
                matching_asset = (
                    next(
                        (
                            asset
                            for asset in assets
                            if isinstance(asset, dict) and asset.get("name") == ASSET_NAME
                        ),
                        None,
                    )
                    if isinstance(assets, list)
                    else None
                )
                if matching_asset is not None:
                    return payload, matching_asset
                last_reason = f"GitHub release {tag} does not have {ASSET_NAME} yet"
        elif status == 404:
            last_reason = f"GitHub release {tag} is not published yet"
        elif status == 0 or status >= 500:
            last_reason = f"GitHub API returned HTTP {status}: {response_message(payload)}"
        else:
            raise RuntimeError(f"GitHub API returned HTTP {status}: {response_message(payload)}")

        if attempt < RELEASE_WAIT_ATTEMPTS:
            print(
                f"Waiting for upstream release ({attempt}/{RELEASE_WAIT_ATTEMPTS}): {last_reason}"
            )
            time.sleep(RELEASE_WAIT_SECONDS)

    raise RuntimeError(
        f"Timed out after {RELEASE_WAIT_ATTEMPTS * RELEASE_WAIT_SECONDS} seconds waiting for "
        f"GitHub release {tag}: {last_reason}"
    )


def validate_asset(asset: dict[str, object], tag: str) -> tuple[str, int, str | None]:
    asset_size = asset.get("size")
    if type(asset_size) is not int or asset_size < 1 or asset_size > MAX_ASSET_SIZE:
        raise RuntimeError(
            f"GitHub asset size must be between 1 byte and {MAX_ASSET_SIZE} bytes; got {asset_size!r}"
        )

    asset_url = asset.get("browser_download_url")
    if not isinstance(asset_url, str):
        raise RuntimeError("GitHub release asset has no download URL")

    parsed_url = urlparse(asset_url)
    expected_path = (
        f"/{GITHUB_OWNER}/{GITHUB_REPOSITORY}/releases/download/"
        f"{quote(tag, safe='')}/{ASSET_NAME}"
    )
    if (
        parsed_url.scheme != "https"
        or parsed_url.hostname != "github.com"
        or parsed_url.username is not None
        or parsed_url.password is not None
        or parsed_url.port not in {None, 443}
        or parsed_url.query
        or parsed_url.fragment
        or parsed_url.path != expected_path
    ):
        raise RuntimeError("GitHub release asset URL did not match the expected repository and tag")

    digest = asset.get("digest")
    if digest is not None and not isinstance(digest, str):
        raise RuntimeError("GitHub release asset has an invalid digest")
    return asset_url, asset_size, digest


def download_asset(asset_url: str, expected_size: int, expected_digest: str | None, destination: Path) -> None:
    request = Request(
        asset_url,
        headers={
            "Accept": "application/octet-stream",
            "User-Agent": "All-in-One-Forgejo-Release-Mirror",
        },
    )
    digest = hashlib.sha256()
    bytes_written = 0

    with urlopen(request, timeout=60) as response, destination.open("wb") as output:
        final_url = urlparse(response.geturl())
        if final_url.scheme != "https" or not (
            final_url.hostname == "github.com"
            or (final_url.hostname is not None and final_url.hostname.endswith(".githubusercontent.com"))
        ):
            raise RuntimeError("GitHub asset download redirected to an unexpected host")

        content_length = response.headers.get("Content-Length")
        if content_length and int(content_length) > MAX_ASSET_SIZE:
            raise RuntimeError(f"GitHub asset exceeds the {MAX_ASSET_SIZE}-byte safety limit")

        while chunk := response.read(1024 * 1024):
            bytes_written += len(chunk)
            if bytes_written > MAX_ASSET_SIZE:
                raise RuntimeError(f"GitHub asset exceeds the {MAX_ASSET_SIZE}-byte safety limit")
            output.write(chunk)
            digest.update(chunk)

    if bytes_written != expected_size:
        raise RuntimeError(
            f"Downloaded asset size mismatch: GitHub reports {expected_size}, downloaded {bytes_written}"
        )

    if expected_digest and expected_digest.startswith("sha256:"):
        if digest.hexdigest().lower() != expected_digest.removeprefix("sha256:").lower():
            raise RuntimeError("Downloaded release asset did not match GitHub's SHA-256 digest")

    if not zipfile.is_zipfile(destination):
        raise RuntimeError(f"GitHub asset {ASSET_NAME} is not a valid ZIP archive")


def make_release_body(github_release: dict[str, object], tag: str) -> str:
    body = github_release.get("body")
    notes = body.strip() if isinstance(body, str) else ""
    source_url = f"https://github.com/{GITHUB_OWNER}/{GITHUB_REPOSITORY}/releases/tag/{quote(tag, safe='')}"
    source_note = f"Mirrored automatically from [the GitHub release]({source_url})."
    return f"{notes}\n\n---\n{source_note}" if notes else source_note


def mirror_release(tag: str) -> None:
    server_url = os.environ.get("FORGEJO_SERVER_URL", "").rstrip("/")
    repository = os.environ.get("FORGEJO_REPOSITORY", "")
    token = os.environ.get("FORGEJO_TOKEN", "")
    if not server_url or not repository or not token:
        raise RuntimeError("Forgejo server URL, repository, and workflow token are required")

    server = urlparse(server_url)
    if (
        server.scheme not in {"http", "https"}
        or not server.hostname
        or server.username is not None
        or server.password is not None
        or server.query
        or server.fragment
    ):
        raise RuntimeError("FORGEJO_SERVER_URL must be an absolute HTTP(S) URL")
    if server.scheme != "https" and server.hostname not in {"localhost", "127.0.0.1", "::1"}:
        raise RuntimeError("The Forgejo API must use HTTPS when sending the workflow token")

    owner, separator, repo = repository.partition("/")
    if not separator or not owner or not repo or "/" in repo:
        raise RuntimeError(f"Invalid Forgejo repository name: {repository!r}")

    api_base = (
        f"{server_url}/api/v1/repos/{quote(owner, safe='')}/{quote(repo, safe='')}"
    )

    tag_status, tag_payload = request_json(
        f"{api_base}/tags/{quote(tag, safe='')}", token=token
    )
    if tag_status != 200:
        raise RuntimeError(
            f"Mirrored tag {tag} is not available in Forgejo (HTTP {tag_status}): "
            f"{response_message(tag_payload)}"
        )

    github_release, asset = wait_for_github_release(tag)
    asset_url, asset_size, asset_digest = validate_asset(asset, tag)

    name = github_release.get("name")
    release_name = name.strip() if isinstance(name, str) and name.strip() else f"All-in-One {tag}"
    release_body = make_release_body(github_release, tag)
    release_metadata = {
        "name": release_name,
        "body": release_body,
        "draft": False,
        "prerelease": bool(github_release.get("prerelease", False)),
    }

    release_path = f"/releases/tags/{quote(tag, safe='')}"
    release_status, release = request_json(f"{api_base}{release_path}", token=token)
    if release_status == 404:
        create_payload = {"tag_name": tag, **release_metadata}
        release_status, release = request_json(
            f"{api_base}/releases", method="POST", token=token, payload=create_payload
        )
        if release_status in {409, 422}:
            release_status, release = request_json(f"{api_base}{release_path}", token=token)
    require_status("Create Forgejo release", release_status, release, {200, 201})

    if not isinstance(release, dict) or not isinstance(release.get("id"), int):
        raise RuntimeError("Forgejo did not return a release ID")
    release_id = release["id"]

    update_status, updated_release = request_json(
        f"{api_base}/releases/{release_id}",
        method="PATCH",
        token=token,
        payload=release_metadata,
    )
    require_status("Update Forgejo release metadata", update_status, updated_release, {200})
    if isinstance(updated_release, dict):
        release = updated_release

    refreshed_status, refreshed_release = request_json(
        f"{api_base}/releases/{release_id}", token=token
    )
    require_status("Read Forgejo release assets", refreshed_status, refreshed_release, {200})
    if isinstance(refreshed_release, dict):
        release = refreshed_release

    assets = release.get("assets") if isinstance(release, dict) else None
    matching_assets = [
        existing
        for existing in (assets if isinstance(assets, list) else [])
        if isinstance(existing, dict) and existing.get("name") == ASSET_NAME
    ]
    if matching_assets:
        existing_size = matching_assets[0].get("size")
        if existing_size != asset_size:
            raise RuntimeError(
                f"Forgejo already has {ASSET_NAME} with size {existing_size}; "
                f"GitHub has size {asset_size}. Remove or correct the conflicting asset before retrying."
            )
        print(f"Forgejo release {tag} already has the matching {ASSET_NAME} asset.")
        return

    with tempfile.TemporaryDirectory(prefix="all-in-one-release-") as temp_dir:
        archive = Path(temp_dir) / ASSET_NAME
        download_asset(asset_url, asset_size, asset_digest, archive)
        boundary = f"----AllInOneRelease{os.urandom(16).hex()}"
        prefix = (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="attachment"; filename="{ASSET_NAME}"\r\n'
            "Content-Type: application/zip\r\n\r\n"
        ).encode("utf-8")
        suffix = f"\r\n--{boundary}--\r\n".encode("ascii")
        archive_content = archive.read_bytes()
        multipart_body = prefix + archive_content + suffix
        upload_url = (
            f"{api_base}/releases/{release_id}/assets?{urlencode({'name': ASSET_NAME})}"
        )
        upload_status, uploaded_asset = request_json(
            upload_url,
            method="POST",
            token=token,
            raw_body=multipart_body,
            content_type=f"multipart/form-data; boundary={boundary}",
        )
        require_status("Upload Forgejo release asset", upload_status, uploaded_asset, {201})
        if not isinstance(uploaded_asset, dict) or uploaded_asset.get("name") != ASSET_NAME:
            raise RuntimeError("Forgejo did not confirm the expected release asset upload")

    print(f"Created or updated Forgejo release {tag} with {ASSET_NAME}.")


def main() -> None:
    try:
        mirror_release(select_release_tag())
    except (OSError, RuntimeError, URLError, ValueError) as error:
        print(f"Forgejo release mirror failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error


if __name__ == "__main__":
    main()
