import json
import os
import shutil
import subprocess
from typing import Any


_TOOL_NAMES = frozenset({"terminal", "execute_code", "patch", "write_file"})


def _contexts(context: dict[str, Any]) -> tuple[dict[str, Any], ...]:
    nested = tuple(
        value
        for key in ("tool_input", "toolInput", "params", "arguments", "input")
        if isinstance((value := context.get(key)), dict)
    )
    return (context, *nested)


def _string(context: dict[str, Any], *keys: str) -> str | None:
    for values in _contexts(context):
        for key in keys:
            value = values.get(key)
            if isinstance(value, str):
                return value
    return None


def _command_payload(context: dict[str, Any]) -> dict[str, Any] | None:
    command = _string(context, "raw_command", "command")
    args = _string(context, "raw_args", "args") or ""
    if not isinstance(command, str) or not isinstance(args, str):
        return None
    command = command.lstrip("/").strip()
    if not command:
        return None
    return {"tool_name": "Bash", "tool_input": {"command": f"{command} {args}".strip()}}


def _tool_name(event_type: str, context: dict[str, Any]) -> str | None:
    if event_type in _TOOL_NAMES:
        return event_type
    if not event_type.startswith("tool:"):
        return None
    event_name = event_type.split(":", 1)[1]
    if event_name in _TOOL_NAMES:
        return event_name
    return _string(context, "tool_name", "toolName", "name")


def _tool_payload(event_type: str, context: dict[str, Any]) -> dict[str, Any] | None:
    tool_name = _tool_name(event_type, context)
    if tool_name not in _TOOL_NAMES:
        return None
    if tool_name == "terminal":
        command = _string(context, "command")
        if command is not None:
            return {"tool_name": "Bash", "tool_input": {"command": command}}
    if tool_name == "execute_code":
        code = _string(context, "code", "command")
        if code is not None:
            return {"tool_name": "Bash", "tool_input": {"command": code}}
    if tool_name == "patch":
        path = _string(context, "path", "file_path", "target_path")
        if path is not None:
            return {"tool_name": "apply_patch", "tool_input": {"file_path": path}}
        patch = _string(context, "patch", "diff", "content")
        if patch is not None:
            return {"tool_name": "apply_patch", "tool_input": {"command": patch}}
    if tool_name == "write_file":
        path = _string(context, "path", "file_path")
        if path is not None:
            return {"tool_name": "Write", "tool_input": {"file_path": path}}
    return None


def _cli() -> str | None:
    return os.environ.get("VIBEBLOAT_CLI") or shutil.which("vibebloat")


async def handle(event_type: str, context: dict[str, Any]) -> dict[str, str] | None:
    if not isinstance(context, dict):
        return None
    if event_type.startswith("command:"):
        payload = _command_payload(context)
    elif _tool_name(event_type, context) in _TOOL_NAMES:
        payload = _tool_payload(event_type, context)
        if payload is None:
            return {"decision": "deny", "message": "VibeBloat hook received an invalid tool payload."}
    else:
        return None
    if payload is None:
        return None
    cli = _cli()
    if cli is None:
        return {"decision": "deny", "message": "VibeBloat CLI unavailable."}
    try:
        result = subprocess.run(
            [cli, "hook"],
            input=json.dumps(payload, separators=(",", ":")),
            text=True,
            capture_output=True,
            check=False,
        )
    except OSError as error:
        return {"decision": "deny", "message": f"VibeBloat CLI failed: {error}"}
    if result.returncode == 0:
        return None
    if result.returncode == 2:
        return {"decision": "deny", "message": result.stderr.strip() or "Blocked by VibeBloat guard."}
    return {"decision": "deny", "message": result.stderr.strip() or f"VibeBloat CLI failed with exit code {result.returncode}."}
