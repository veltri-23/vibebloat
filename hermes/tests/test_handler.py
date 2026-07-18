import asyncio
import importlib.util
from pathlib import Path
from unittest.mock import patch


HANDLER_PATH = Path(__file__).parents[1] / "handler.py"
SPEC = importlib.util.spec_from_file_location("vibebloat_handler", HANDLER_PATH)
assert SPEC and SPEC.loader
HANDLER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HANDLER)


def test_terminal_command_maps_to_hook_and_blocks():
    completed = HANDLER.subprocess.CompletedProcess([], 2, "", "blocked by guard")
    with patch.object(HANDLER.subprocess, "run", return_value=completed) as run:
        decision = asyncio.run(HANDLER.handle("command:before", {"command": "git stash -u"}))

    assert decision == {"action": "block", "code": "vibebloat_guard", "message": "blocked by guard"}
    assert run.call_args.kwargs["input"] == '{"tool_name":"Bash","tool_input":{"command":"git stash -u"}}'


def test_file_write_maps_to_hook_and_blocks():
    completed = HANDLER.subprocess.CompletedProcess([], 2, "", "wrong config")
    with patch.object(HANDLER.subprocess, "run", return_value=completed):
        decision = asyncio.run(HANDLER.handle("tool:before", {"tool_name": "write_file", "args": {"file_path": ".mcp.json"}}))

    assert decision == {"action": "block", "code": "vibebloat_guard", "message": "wrong config"}


def test_unrecognized_event_preserves_handler_fallback():
    assert asyncio.run(HANDLER.handle("agent:step", {})) is None
