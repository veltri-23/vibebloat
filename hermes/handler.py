import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any


ROOT = Path(os.environ.get("VIBEBLOAT_ROOT", Path(__file__).resolve().parents[1]))
CLI = ROOT / "src" / "cli.ts"


def _payload(context: dict[str, Any]) -> dict[str, Any] | None:
    command = context.get("command")
    args = context.get("args") or context.get("tool_args") or {}
    if not isinstance(args, dict):
        return None
    if not isinstance(command, str):
        command = args.get("command")
    if isinstance(command, str):
        return {"tool_name": "Bash", "tool_input": {"command": command}}
    path = args.get("file_path") or args.get("path") or context.get("file_path")
    if isinstance(path, str):
        return {"tool_name": "Write", "tool_input": {"file_path": path}}
    return None


async def handle(event_type: str, context: dict[str, Any]) -> dict[str, str] | None:
    payload = _payload(context)
    if payload is None:
        return None
    bun = shutil.which("bun")
    if bun is None or not CLI.is_file():
        return {"action": "block", "code": "vibebloat_runtime_unavailable", "message": "VibeBloat runtime unavailable."}
    result = subprocess.run(
        [bun, str(CLI), "hook"],
        input=json.dumps(payload, separators=(",", ":")),
        text=True,
        capture_output=True,
        cwd=ROOT,
        check=False,
    )
    if result.returncode != 2:
        return None
    return {"action": "block", "code": "vibebloat_guard", "message": result.stderr.strip()}
