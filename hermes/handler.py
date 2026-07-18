import json
import os
import shutil
import subprocess
from typing import Any


def _payload(context: dict[str, Any]) -> dict[str, Any] | None:
    command = context.get("raw_command") or context.get("command")
    args = context.get("raw_args") or context.get("args") or ""
    if not isinstance(command, str) or not isinstance(args, str):
        return None
    command = command.lstrip("/").strip()
    if not command:
        return None
    return {"tool_name": "Bash", "tool_input": {"command": f"{command} {args}".strip()}}


def _cli() -> str | None:
    return os.environ.get("VIBEBLOAT_CLI") or shutil.which("vibebloat")


async def handle(event_type: str, context: dict[str, Any]) -> dict[str, str] | None:
    if not event_type.startswith("command:"):
        return None
    payload = _payload(context)
    if payload is None:
        return None
    cli = _cli()
    if cli is None:
        return {"decision": "deny", "message": "VibeBloat CLI unavailable."}
    result = subprocess.run(
        [cli, "hook"],
        input=json.dumps(payload, separators=(",", ":")),
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 2:
        return None
    return {"decision": "deny", "message": result.stderr.strip() or "Blocked by VibeBloat guard."}
