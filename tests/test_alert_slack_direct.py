"""Silent-failure guards for the failure-alert transport order: Hermes CLI, then Slack direct,
then SMTP (best-effort). urllib and subprocess are monkeypatched, so nothing hits the network
and no CLI is spawned."""

import json
import urllib.request

import pytest

import seo_agents.main as main_mod

_CLEAN = ("SLACK_BOT_TOKEN", "SLACK_ALERT_CHANNEL", "SMTP_APP_PASSWORD", "HERMES_CLI", "HERMES_ALERT_TO")


class _Resp:
    def __init__(self, payload):
        self._body = json.dumps(payload).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self):
        return self._body


@pytest.fixture
def clean_env(monkeypatch):
    for name in _CLEAN:
        monkeypatch.delenv(name, raising=False)
    return monkeypatch


def _alert():
    main_mod._send_failure_alert("weekly", "boom", "topic", "2026-10-13T00:00:00Z")


def test_missing_hermes_cli_falls_through_to_slack(clean_env, capsys):
    clean_env.setenv("HERMES_CLI", "/nonexistent/dir/hermes")
    clean_env.setenv("SLACK_BOT_TOKEN", "xoxb-test-token")
    clean_env.setenv("SLACK_ALERT_CHANNEL", "#seo-ops")

    def no_spawn(*args, **kwargs):
        raise AssertionError("a missing Hermes CLI must not be spawned")

    posted = []

    def fake_urlopen(req, timeout=None):
        posted.append(req)
        return _Resp({"ok": True})

    clean_env.setattr(main_mod.subprocess, "run", no_spawn)
    clean_env.setattr(urllib.request, "urlopen", fake_urlopen)

    _alert()

    assert len(posted) == 1
    assert posted[0].full_url == "https://slack.com/api/chat.postMessage"
    assert posted[0].get_header("Authorization") == "Bearer xoxb-test-token"
    body = json.loads(posted[0].data)
    assert body["channel"] == "#seo-ops"
    assert body["text"].startswith("⚠ SEO Agent FAILED")
    out = capsys.readouterr().out
    assert "via Slack to #seo-ops" in out
    assert "ALL alert channels failed" not in out


def test_all_channels_missing_fails_quietly(clean_env, capsys):
    clean_env.setenv("HERMES_CLI", "/nonexistent/dir/hermes")

    def no_network(*args, **kwargs):
        raise AssertionError("no Slack call without SLACK_BOT_TOKEN and SLACK_ALERT_CHANNEL")

    clean_env.setattr(urllib.request, "urlopen", no_network)

    _alert()  # must not raise

    assert "ALL alert channels failed" in capsys.readouterr().out


def test_working_hermes_cli_never_reaches_slack(clean_env, tmp_path):
    cli = tmp_path / "hermes"
    cli.write_text("")
    clean_env.setenv("HERMES_CLI", str(cli))
    clean_env.setenv("SLACK_BOT_TOKEN", "xoxb-test-token")
    clean_env.setenv("SLACK_ALERT_CHANNEL", "#seo-ops")

    spawned = []
    clean_env.setattr(main_mod.subprocess, "run", lambda *a, **k: spawned.append(a[0]))

    def no_network(*args, **kwargs):
        raise AssertionError("Slack must not be called when the Hermes CLI delivered")

    clean_env.setattr(urllib.request, "urlopen", no_network)

    _alert()

    assert spawned and spawned[0][0] == str(cli)
