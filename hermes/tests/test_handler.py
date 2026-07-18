import asyncio
import contextlib
import importlib.util
import io
import json
import shutil
import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest


HANDLER_PATH = Path(__file__).parents[1] / "handler.py"
HOOK_PATH = Path(__file__).parents[1] / "HOOK.yaml"
SPEC = importlib.util.spec_from_file_location("vibebloat_handler", HANDLER_PATH)
assert SPEC and SPEC.loader
HANDLER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HANDLER)


def test_gateway_command_event_uses_configured_cli_and_denies():
    completed = HANDLER.subprocess.CompletedProcess([], 2, "", "blocked by guard")
    with patch.dict(HANDLER.os.environ, {"VIBEBLOAT_CLI": "vibebloat-bin"}, clear=True), patch.object(HANDLER.subprocess, "run", return_value=completed) as run:
        decision = asyncio.run(HANDLER.handle("command:stash", {"command": "stash", "raw_command": "/stash", "args": "-u", "raw_args": "-u"}))

    assert decision == {"decision": "deny", "message": "blocked by guard"}
    assert run.call_args.args[0] == ["vibebloat-bin", "hook"]
    assert run.call_args.kwargs["input"] == '{"tool_name":"Bash","tool_input":{"command":"stash -u"}}'


@pytest.mark.parametrize(
    ("event_type", "context", "payload"),
    [
        (
            "tool:terminal",
            {"command": "git stash -u"},
            '{"tool_name":"Bash","tool_input":{"command":"git stash -u"}}',
        ),
        (
            "tool:execute_code",
            {"code": "import os; os.system('git stash -u')"},
            "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"import os; os.system('git stash -u')\"}}",
        ),
        (
            "tool:patch",
            {"patch": "*** Update File: .mcp.json"},
            '{"tool_name":"apply_patch","tool_input":{"command":"*** Update File: .mcp.json"}}',
        ),
        (
            "tool:write_file",
            {"path": ".mcp.json", "content": "{}"},
            '{"tool_name":"Write","tool_input":{"file_path":".mcp.json"}}',
        ),
    ],
)
def test_mutating_tool_events_map_to_shared_hook_payload(event_type, context, payload):
    completed = HANDLER.subprocess.CompletedProcess([], 2, "", "blocked by guard")
    with patch.dict(HANDLER.os.environ, {"VIBEBLOAT_CLI": "vibebloat-bin"}, clear=True), patch.object(HANDLER.subprocess, "run", return_value=completed) as run:
        decision = asyncio.run(HANDLER.handle(event_type, context))

    assert decision == {"decision": "deny", "message": "blocked by guard"}
    assert run.call_args.args[0] == ["vibebloat-bin", "hook"]
    assert run.call_args.kwargs["input"] == payload


def test_generic_tool_event_uses_nested_hermes_arguments():
    completed = HANDLER.subprocess.CompletedProcess([], 2, "", "blocked by guard")
    context = {"tool_name": "write_file", "arguments": {"path": ".mcp.json", "content": "{}"}}
    with patch.dict(HANDLER.os.environ, {"VIBEBLOAT_CLI": "vibebloat-bin"}, clear=True), patch.object(HANDLER.subprocess, "run", return_value=completed) as run:
        decision = asyncio.run(HANDLER.handle("tool:before", context))

    assert decision == {"decision": "deny", "message": "blocked by guard"}
    assert run.call_args.kwargs["input"] == '{"tool_name":"Write","tool_input":{"file_path":".mcp.json"}}'


def test_invalid_mutating_tool_payload_denies_without_cli_execution():
    with patch.object(HANDLER.subprocess, "run") as run:
        decision = asyncio.run(HANDLER.handle("tool:write_file", {}))

    assert decision == {"decision": "deny", "message": "VibeBloat hook received an invalid tool payload."}
    run.assert_not_called()


def test_missing_cli_denies_with_gateway_decision():
    with patch.dict(HANDLER.os.environ, {}, clear=True), patch.object(HANDLER.shutil, "which", return_value=None):
        decision = asyncio.run(HANDLER.handle("command:stash", {"command": "stash", "args": "-u"}))

    assert decision == {"decision": "deny", "message": "VibeBloat CLI unavailable."}


def test_cli_runtime_failure_denies_fail_closed():
    completed = HANDLER.subprocess.CompletedProcess([], 1, "", "runtime crash")
    with patch.dict(HANDLER.os.environ, {"VIBEBLOAT_CLI": "vibebloat-bin"}, clear=True), patch.object(HANDLER.subprocess, "run", return_value=completed):
        decision = asyncio.run(HANDLER.handle("command:stash", {"command": "stash", "args": "-u"}))

    assert decision == {"decision": "deny", "message": "runtime crash"}


def test_tool_cli_os_error_denies_fail_closed():
    with patch.dict(HANDLER.os.environ, {"VIBEBLOAT_CLI": "vibebloat-bin"}, clear=True), patch.object(HANDLER.subprocess, "run", side_effect=OSError("spawn failed")):
        decision = asyncio.run(HANDLER.handle("tool:terminal", {"command": "git stash -u"}))

    assert decision == {"decision": "deny", "message": "VibeBloat CLI failed: spawn failed"}


def test_shell_hook_protocol_maps_mutating_tool_to_shared_hook_payload():
    completed = HANDLER.subprocess.CompletedProcess([], 2, "", "blocked by guard")
    payload = {"hook_event_name": "pre_tool_call", "tool_name": "terminal", "tool_input": {"command": "git stash -u"}}
    with patch.dict(HANDLER.os.environ, {"VIBEBLOAT_CLI": "vibebloat-bin"}, clear=True), patch.object(HANDLER.subprocess, "run", return_value=completed) as run:
        decision = asyncio.run(HANDLER.handle_shell_hook(payload))

    assert decision == {"decision": "block", "reason": "blocked by guard"}
    assert run.call_args.args[0] == ["vibebloat-bin", "hook"]
    assert run.call_args.kwargs["input"] == '{"tool_name":"Bash","tool_input":{"command":"git stash -u"}}'


def test_invalid_shell_hook_payload_blocks_fail_closed():
    decision = asyncio.run(HANDLER.handle_shell_hook({"hook_event_name": "pre_tool_call", "tool_name": "terminal", "tool_input": None}))

    assert decision == {"decision": "block", "reason": "VibeBloat hook received an invalid Hermes tool payload."}


def test_shell_hook_executable_writes_hermes_block_json():
    async def block(_: object):
        return {"decision": "block", "reason": "blocked by guard"}

    output = io.StringIO()
    with patch.object(HANDLER.sys, "stdin", io.StringIO(json.dumps({"hook_event_name": "pre_tool_call"}))), patch.object(HANDLER, "handle_shell_hook", side_effect=block), contextlib.redirect_stdout(output):
        assert HANDLER.main() == 0

    assert json.loads(output.getvalue()) == {"decision": "block", "reason": "blocked by guard"}


def test_shell_hook_executable_blocks_unexpected_runtime_error():
    async def crash(_: object):
        raise RuntimeError("guard crash")

    output = io.StringIO()
    with patch.object(HANDLER.sys, "stdin", io.StringIO(json.dumps({"hook_event_name": "pre_tool_call"}))), patch.object(HANDLER, "handle_shell_hook", side_effect=crash), contextlib.redirect_stdout(output):
        assert HANDLER.main() == 0

    assert json.loads(output.getvalue()) == {"decision": "block", "reason": "VibeBloat hook could not evaluate Hermes input: guard crash"}


def test_copied_handler_uses_cli_contract_without_source_tree():
    with tempfile.TemporaryDirectory() as directory:
        copied_handler = Path(directory) / "handler.py"
        shutil.copyfile(HANDLER_PATH, copied_handler)
        spec = importlib.util.spec_from_file_location("copied_vibebloat_handler", copied_handler)
        assert spec and spec.loader
        handler = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(handler)
        completed = handler.subprocess.CompletedProcess([], 2, "", "blocked by guard")
        with patch.dict(handler.os.environ, {"VIBEBLOAT_CLI": "vibebloat-bin"}, clear=True), patch.object(handler.subprocess, "run", return_value=completed) as run:
            decision = asyncio.run(handler.handle("command:stash", {"command": "stash", "args": "-u"}))

    assert decision == {"decision": "deny", "message": "blocked by guard"}
    assert run.call_args.args[0] == ["vibebloat-bin", "hook"]


def test_unrecognized_event_preserves_handler_fallback():
    assert asyncio.run(HANDLER.handle("agent:step", {})) is None


def test_manifest_declares_only_supported_hookregistry_events():
    manifest = HOOK_PATH.read_text(encoding="utf-8")
    assert "- command:*" in manifest
    assert "tool:*" not in manifest
