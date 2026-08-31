"""Small dependency-free checks for the bounded Hermes SEO approval plugin."""

from __future__ import annotations

import asyncio
import importlib.util
import os
from pathlib import Path

SOURCE = Path(__file__).with_name("__init__.py")
SPEC = importlib.util.spec_from_file_location("seo_slack_approvals", SOURCE)
assert SPEC and SPEC.loader
PLUGIN = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PLUGIN)

TASK = "11111111-2222-3333-4444-555555555555"
assert PLUGIN.parse_action(f"seo_approve:{TASK}") == ("approve", TASK)
assert PLUGIN.parse_action("seo_delete:11111111-2222-3333-4444-555555555555") is None
assert PLUGIN.parse_action("seo_approve:not-a-uuid") is None
assert PLUGIN.allowed_users("U1, U2 U3") == {"U1", "U2", "U3"}

old_port = os.environ.get("MAV_BRIDGE_PORT")
os.environ["MAV_BRIDGE_PORT"] = "not-a-port"
assert PLUGIN.bridge_url("retry") == "http://127.0.0.1:8790/seo/actions/retry"
if old_port is None:
    os.environ.pop("MAV_BRIDGE_PORT", None)
else:
    os.environ["MAV_BRIDGE_PORT"] = old_port


class Context:
    def __init__(self) -> None:
        self.handler = None

    def register_slack_action_handler(self, matcher, handler) -> None:
        self.matcher = matcher
        self.handler = handler


ctx = Context()
PLUGIN.register(ctx)
assert ctx.handler is not None
assert ctx.matcher.fullmatch(f"seo_dismiss:{TASK}")

old_allowlist = os.environ.get("SLACK_ALLOWED_USERS")
os.environ["SLACK_ALLOWED_USERS"] = "U-allowed"
original = PLUGIN._post_to_bridge
PLUGIN._post_to_bridge = lambda verb, item: (verb == "approve" and item == TASK, "accepted")
assert asyncio.run(PLUGIN.dispatch_action(f"seo_approve:{TASK}", "U-allowed")) == (True, "accepted")
assert asyncio.run(PLUGIN.dispatch_action(f"seo_approve:{TASK}", "U-other")) == (False, "You are not allowed to approve SEO actions.")
PLUGIN._post_to_bridge = original
if old_allowlist is None:
    os.environ.pop("SLACK_ALLOWED_USERS", None)
else:
    os.environ["SLACK_ALLOWED_USERS"] = old_allowlist

print("ok hermes-seo-slack-approvals")
