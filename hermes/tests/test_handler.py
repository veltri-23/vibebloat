import asyncio
import importlib.util
import shutil
import tempfile
from pathlib import Path
from unittest.mock import patch


HANDLER_PATH = Path(__file__).parents[1] / "handler.py"
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


def test_missing_cli_denies_with_gateway_decision():
    with patch.dict(HANDLER.os.environ, {}, clear=True), patch.object(HANDLER.shutil, "which", return_value=None):
        decision = asyncio.run(HANDLER.handle("command:stash", {"command": "stash", "args": "-u"}))

    assert decision == {"decision": "deny", "message": "VibeBloat CLI unavailable."}


def test_cli_runtime_failure_denies_fail_closed():
    completed = HANDLER.subprocess.CompletedProcess([], 1, "", "runtime crash")
    with patch.dict(HANDLER.os.environ, {"VIBEBLOAT_CLI": "vibebloat-bin"}, clear=True), patch.object(HANDLER.subprocess, "run", return_value=completed):
        decision = asyncio.run(HANDLER.handle("command:stash", {"command": "stash", "args": "-u"}))

    assert decision == {"decision": "deny", "message": "runtime crash"}


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
