"""Hermes Socket Mode handlers for bounded SEO Slack approvals.

This plugin owns no Slack credential and exposes no listener. Hermes receives
the Slack click over its existing Socket Mode connection, verifies that the
clicker is on its allowlist, then calls only a fixed loopback bridge endpoint.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

LOGGER = logging.getLogger(__name__)
ACTION_RE = re.compile(
    r"^seo_(approve|dismiss|retry):([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})$",
    re.IGNORECASE,
)
ENDPOINTS = {
    "approve": "/seo/actions/approve",
    "dismiss": "/seo/actions/dismiss",
    "retry": "/seo/actions/retry",
}


def parse_action(action_id: object) -> tuple[str, str] | None:
    """Accept only the three explicitly supported Slack action IDs."""
    if not isinstance(action_id, str):
        return None
    match = ACTION_RE.fullmatch(action_id)
    if not match:
        return None
    return match.group(1).lower(), match.group(2).lower()


def allowed_users(raw: str | None) -> set[str]:
    """Parse Hermes' Slack allowlist; an absent list intentionally grants none."""
    return {user for user in re.split(r"[\s,]+", raw or "") if user}


def bridge_url(verb: str) -> str:
    """Build a fixed loopback-only target; never accept a caller supplied URL."""
    try:
        port = int(os.environ.get("MAV_BRIDGE_PORT", "8790"))
    except ValueError:
        port = 8790
    if not 1 <= port <= 65535:
        port = 8790
    return f"http://127.0.0.1:{port}{ENDPOINTS[verb]}"


def _post_to_bridge(verb: str, action_id: str) -> tuple[bool, str]:
    request = Request(
        bridge_url(verb),
        data=json.dumps({"actionId": action_id}).encode("utf-8"),
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urlopen(request, timeout=10) as response:  # nosec B310: fixed loopback target
            payload = json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        return False, f"Bridge rejected the action ({exc.code})."
    except (URLError, TimeoutError, OSError, json.JSONDecodeError):
        return False, "The local SEO bridge is unavailable."
    if not payload.get("ok"):
        return False, str(payload.get("error") or "The bridge did not accept the action.")
    return True, str(payload.get("message") or "SEO action accepted.")


async def dispatch_action(action_id: object, slack_user_id: object) -> tuple[bool, str]:
    parsed = parse_action(action_id)
    if not parsed:
        return False, "Unsupported SEO Slack action."
    if not isinstance(slack_user_id, str) or slack_user_id not in allowed_users(os.environ.get("SLACK_ALLOWED_USERS")):
        return False, "You are not allowed to approve SEO actions."
    verb, item_id = parsed
    return await asyncio.to_thread(_post_to_bridge, verb, item_id)


def register(ctx: Any) -> None:
    """Register one strict matcher with Hermes' existing Slack Socket Mode app."""

    async def on_action(ack: Any, body: dict[str, Any], action: dict[str, Any]) -> None:
        # Ack immediately so Slack never retries a slow local DB transaction.
        await ack()
        ok, detail = await dispatch_action(action.get("action_id"), (body.get("user") or {}).get("id"))
        if ok:
            LOGGER.info("SEO Slack action accepted by local bridge")
        else:
            LOGGER.warning("SEO Slack action refused: %s", detail)

    ctx.register_slack_action_handler(ACTION_RE, on_action)
