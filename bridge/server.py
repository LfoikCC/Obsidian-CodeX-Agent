#!/usr/bin/env python3
"""Local HTTP bridge between Obsidian and Codex CLI."""

from __future__ import annotations

import json
import logging
import os
import shlex
import subprocess
import tempfile
import time
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


SERVICE_NAME = "codex-obsidian-bridge"
SERVICE_VERSION = "0.1.0"
ALLOWED_ACTIONS = {"chat", "rewrite", "summarize", "create_note"}


def parse_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "y", "on"}


def parse_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if not raw:
        return default
    return int(raw)


def parse_extra_args(raw: str) -> list[str]:
    if not raw.strip():
        return []
    return shlex.split(raw, posix=(os.name != "nt"))


HOST = os.getenv("CODEX_BRIDGE_HOST", "127.0.0.1").strip() or "127.0.0.1"
PORT = parse_int("CODEX_BRIDGE_PORT", 8765)
BRIDGE_TOKEN = os.getenv("CODEX_BRIDGE_TOKEN", "").strip()
FAKE_RESPONSES = parse_bool("CODEX_BRIDGE_FAKE_RESPONSES", False)

CODEX_COMMAND = os.getenv("CODEX_COMMAND", "").strip()
CODEX_MODEL = os.getenv("CODEX_MODEL", "gpt-5-codex").strip() or "gpt-5-codex"
CODEX_REASONING_EFFORT = os.getenv("CODEX_REASONING_EFFORT", "high").strip() or "high"
CODEX_TIMEOUT_SEC = parse_int("CODEX_TIMEOUT_SEC", 600)
CODEX_CWD = os.getenv("CODEX_CWD", str(Path.cwd())).strip() or str(Path.cwd())
CODEX_SANDBOX = os.getenv("CODEX_SANDBOX", "read-only").strip()
CODEX_EXTRA_ARGS = parse_extra_args(os.getenv("CODEX_EXTRA_ARGS", ""))
CODEX_EPHEMERAL = parse_bool("CODEX_EPHEMERAL", False)
CODEX_SKIP_GIT_REPO_CHECK = parse_bool("CODEX_SKIP_GIT_REPO_CHECK", True)


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)


@dataclass
class BridgeError(Exception):
    status: HTTPStatus
    message: str

    def __str__(self) -> str:
        return self.message


def json_dumps(data: Any) -> bytes:
    return json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8")


def resolve_windows_node_launcher() -> list[str] | None:
    appdata = os.getenv("APPDATA", "").strip()
    if not appdata:
        return None

    script_path = (
        Path(appdata) / "npm" / "node_modules" / "@openai" / "codex" / "bin" / "codex.js"
    )
    if not script_path.exists():
        return None

    bundled_node = Path(appdata) / "npm" / "node.exe"
    node_command = str(bundled_node) if bundled_node.exists() else "node"
    return [node_command, str(script_path)]


def resolve_codex_launcher() -> list[str]:
    if CODEX_COMMAND:
        if os.name == "nt" and CODEX_COMMAND.lower().endswith((".cmd", ".bat")):
            direct_launcher = resolve_windows_node_launcher()
            if direct_launcher:
                return direct_launcher
        return [CODEX_COMMAND]

    if os.name == "nt":
        direct_launcher = resolve_windows_node_launcher()
        if direct_launcher:
            return direct_launcher
        return ["codex.cmd"]

    return ["codex"]


def build_codex_command() -> list[str]:
    launcher = resolve_codex_launcher()
    command = launcher + ["exec", "-", "--model", CODEX_MODEL, "--color", "never"]
    if CODEX_REASONING_EFFORT:
        command.extend(["-c", f'model_reasoning_effort="{CODEX_REASONING_EFFORT}"'])
    if CODEX_SKIP_GIT_REPO_CHECK:
        command.append("--skip-git-repo-check")
    if CODEX_SANDBOX:
        command.extend(["--sandbox", CODEX_SANDBOX])
    if CODEX_EPHEMERAL:
        command.append("--ephemeral")
    command.extend(CODEX_EXTRA_ARGS)

    if os.name == "nt" and launcher[0].lower().endswith((".cmd", ".bat")):
        return ["cmd", "/c", *command]
    return command


def ensure_valid_payload(payload: dict[str, Any]) -> tuple[str, str]:
    action = str(payload.get("action") or "").strip()
    instruction = str(payload.get("instruction") or "").strip()

    if action not in ALLOWED_ACTIONS:
        raise BridgeError(
            HTTPStatus.BAD_REQUEST,
            f"Unsupported action '{action}'. Allowed values: {', '.join(sorted(ALLOWED_ACTIONS))}.",
        )

    if action in {"chat", "rewrite", "create_note"} and not instruction:
        raise BridgeError(HTTPStatus.BAD_REQUEST, "Field 'instruction' is required.")

    if action == "rewrite" and not str(payload.get("selection") or "").strip():
        raise BridgeError(HTTPStatus.BAD_REQUEST, "Rewrite action requires a non-empty selection.")

    return action, instruction


def format_headings(headings: list[dict[str, Any]]) -> str:
    if not headings:
        return "No heading metadata."

    lines = []
    for item in headings:
        heading = str(item.get("heading") or "").strip()
        level = int(item.get("level") or 0)
        prefix = "#" * max(level, 1)
        if heading:
            lines.append(f"{prefix} {heading}")
    return "\n".join(lines) if lines else "No heading metadata."


def format_note_context(note: dict[str, Any] | None) -> str:
    if not note:
        return "No active note was provided."

    title = str(note.get("title") or "").strip()
    path = str(note.get("path") or "").strip()
    frontmatter = note.get("frontmatter")
    headings = note.get("headings") or []
    content = str(note.get("content") or "")

    parts = [
        f"Title: {title or '(unknown)'}",
        f"Path: {path or '(unknown)'}",
    ]

    if frontmatter:
        parts.append("Frontmatter:\n" + json.dumps(frontmatter, ensure_ascii=False, indent=2))
    else:
        parts.append("Frontmatter:\n(none)")

    parts.append("Headings:\n" + format_headings(headings))
    parts.append("Full note content:\n" + (content or "(empty note)"))
    return "\n\n".join(parts)


def format_reference_notes(references: list[dict[str, Any]] | None) -> str:
    if not references:
        return "No extra referenced notes were provided."

    blocks = []
    for index, note in enumerate(references, start=1):
        blocks.append(f"## Referenced note {index}\n{format_note_context(note)}")
    return "\n\n".join(blocks)


def format_selection(selection: str) -> str:
    return selection.strip() or "(no selection provided)"


def build_prompt(action: str, instruction: str, payload: dict[str, Any]) -> str:
    note = payload.get("note") if isinstance(payload.get("note"), dict) else None
    references = payload.get("references") if isinstance(payload.get("references"), list) else []
    selection = str(payload.get("selection") or "")

    note_block = format_note_context(note)
    references_block = format_reference_notes(references)
    selection_block = format_selection(selection)

    if action == "chat":
        return (
            "You are Codex working inside Obsidian.\n"
            "Answer the user's request using the supplied note context.\n"
            "Rules:\n"
            "- Use the note context when it is relevant.\n"
            "- If the note does not contain enough information, say what is missing.\n"
            "- Return Markdown only.\n"
            "- Do not wrap the entire answer in code fences.\n\n"
            f"User request:\n{instruction}\n\n"
            f"Selected text:\n{selection_block}\n\n"
            f"Referenced notes:\n{references_block}\n\n"
            f"Active note:\n{note_block}\n"
        )

    if action == "rewrite":
        return (
            "You are Codex working inside Obsidian.\n"
            "Rewrite the selected text according to the user's instruction.\n"
            "Rules:\n"
            "- Return only the rewritten replacement text.\n"
            "- Preserve meaning, facts, links, and Markdown unless the instruction changes them.\n"
            "- Keep the original language unless the instruction says otherwise.\n\n"
            f"Rewrite instruction:\n{instruction}\n\n"
            f"Selected text:\n{selection_block}\n\n"
            f"Referenced notes:\n{references_block}\n\n"
            f"Parent note context:\n{note_block}\n"
        )

    if action == "summarize":
        user_instruction = instruction or "Summarize this note for quick review."
        return (
            "You are Codex working inside Obsidian.\n"
            "Produce a useful Markdown summary of the current note.\n"
            "Rules:\n"
            "- Return a standalone Markdown note.\n"
            "- Use a level-1 heading.\n"
            "- Keep the summary compact and useful for later review.\n"
            "- Include open questions only if they are supported by the note.\n\n"
            f"Summary instruction:\n{user_instruction}\n\n"
            f"Referenced notes:\n{references_block}\n\n"
            f"Current note:\n{note_block}\n"
        )

    if action == "create_note":
        return (
            "You are Codex working inside Obsidian.\n"
            "Draft a new Markdown note based on the user's instruction and the supplied context.\n"
            "Rules:\n"
            "- Return only the note content.\n"
            "- Start with a level-1 heading.\n"
            "- Make the note internally coherent and usable as a real Obsidian note.\n"
            "- Add sections only when they are justified by the topic.\n\n"
            f"New note request:\n{instruction}\n\n"
            f"Selected text:\n{selection_block}\n\n"
            f"Referenced notes:\n{references_block}\n\n"
            f"Reference note context:\n{note_block}\n"
        )

    raise BridgeError(HTTPStatus.BAD_REQUEST, f"Unsupported action '{action}'.")


def fake_response(action: str, instruction: str, payload: dict[str, Any]) -> str:
    note = payload.get("note") if isinstance(payload.get("note"), dict) else {}
    references = payload.get("references") if isinstance(payload.get("references"), list) else []
    title = str(note.get("title") or "Untitled").strip() or "Untitled"
    selection = str(payload.get("selection") or "").strip()

    if action == "chat":
        return (
            f"## Mock Response\n\n"
            f"- Request: {instruction}\n"
            f"- Active note: {title}\n"
            f"- Selection present: {'yes' if selection else 'no'}\n"
            f"- Referenced notes: {len(references)}\n"
        )

    if action == "rewrite":
        return f"[Mock rewrite] {selection or '(empty selection)'}"

    if action == "summarize":
        return (
            f"# Summary of {title}\n\n"
            f"## TL;DR\n\n"
            f"Mock summary for: {instruction or 'quick review'}\n\n"
            f"## Key Points\n\n"
            f"- This response is generated with `CODEX_BRIDGE_FAKE_RESPONSES=1`.\n"
        )

    if action == "create_note":
        return (
            f"# {instruction}\n\n"
            f"## Context\n\n"
            f"- Source note: {title}\n"
            f"- Generated in fake-response mode.\n"
        )

    return "# Unsupported action"


def run_codex(prompt: str) -> str:
    command = build_codex_command()
    temp_fd, temp_path = tempfile.mkstemp(prefix="codex-last-message-", suffix=".txt")
    os.close(temp_fd)
    command.extend(["--output-last-message", temp_path])
    logging.info("Running command: %s", " ".join(shlex.quote(part) for part in command))

    try:
        result = subprocess.run(
            command,
            input=prompt,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            cwd=CODEX_CWD,
            timeout=CODEX_TIMEOUT_SEC,
            check=False,
        )
    except FileNotFoundError as exc:
        raise BridgeError(
            HTTPStatus.BAD_GATEWAY,
            f"Unable to start Codex CLI. Command not found: {CODEX_COMMAND or 'codex'}.",
        ) from exc
    except subprocess.TimeoutExpired as exc:
        raise BridgeError(
            HTTPStatus.GATEWAY_TIMEOUT,
            f"Codex timed out after {CODEX_TIMEOUT_SEC} seconds.",
        ) from exc
    except OSError as exc:
        raise BridgeError(
            HTTPStatus.BAD_GATEWAY,
            f"Unable to start Codex CLI: {exc}.",
        ) from exc
    try:
        stdout = (result.stdout or "").strip()
        stderr = (result.stderr or "").strip()
        output_file = Path(temp_path)
        output_text = ""
        if output_file.exists():
            output_text = output_file.read_text(encoding="utf-8", errors="replace").strip()

        if result.returncode != 0:
            detail = stderr or stdout or f"Codex exited with status {result.returncode}."
            if "Token data is not available" in detail:
                detail = (
                    "Codex CLI is not authenticated in this environment. "
                    "Run `codex login` or ensure your Codex/OpenAI credentials are available, then retry."
                )
            elif "Unsupported value: 'xhigh'" in detail and "reasoning.effort" in detail:
                detail = (
                    "Your Codex CLI config is forcing `model_reasoning_effort = \"xhigh\"`, "
                    "but the current model does not support it. "
                    "The bridge now overrides this to a supported value. Restart the bridge and retry."
                )
            elif "拒绝访问" in detail or "Access is denied" in detail:
                detail = (
                    "Codex CLI could not access a required local path. "
                    "Check your shell permissions and Codex configuration paths, then retry."
                )
            raise BridgeError(HTTPStatus.BAD_GATEWAY, detail)

        if output_text:
            return output_text

        if not stdout:
            raise BridgeError(HTTPStatus.BAD_GATEWAY, "Codex returned an empty response.")

        if stderr:
            logging.warning("Codex stderr: %s", stderr)

        return stdout
    finally:
        try:
            Path(temp_path).unlink(missing_ok=True)
        except OSError:
            logging.warning("Failed to remove temporary file: %s", temp_path)


class BridgeHandler(BaseHTTPRequestHandler):
    server_version = f"{SERVICE_NAME}/{SERVICE_VERSION}"

    def log_message(self, fmt: str, *args: Any) -> None:
        logging.info("%s - %s", self.address_string(), fmt % args)

    def end_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Bridge-Token")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def send_json(self, status: HTTPStatus, payload: dict[str, Any]) -> None:
        body = json_dumps(payload)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self) -> dict[str, Any]:
        length_raw = self.headers.get("Content-Length", "0")
        try:
            length = int(length_raw)
        except ValueError as exc:
            raise BridgeError(HTTPStatus.BAD_REQUEST, "Invalid Content-Length header.") from exc

        raw = self.rfile.read(length) if length > 0 else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError as exc:
            raise BridgeError(HTTPStatus.BAD_REQUEST, "Request body must be valid JSON.") from exc

        if not isinstance(payload, dict):
            raise BridgeError(HTTPStatus.BAD_REQUEST, "Request body must be a JSON object.")

        return payload

    def authorize(self) -> None:
        if not BRIDGE_TOKEN:
            return
        incoming = self.headers.get("X-Bridge-Token", "").strip()
        if incoming != BRIDGE_TOKEN:
            raise BridgeError(HTTPStatus.UNAUTHORIZED, "Invalid bridge token.")

    def do_OPTIONS(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self.end_headers()

    def do_GET(self) -> None:
        if self.path not in {"/", "/health"}:
            self.send_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "Not found."})
            return

        self.send_json(
            HTTPStatus.OK,
            {
                "ok": True,
                "service": SERVICE_NAME,
                "version": SERVICE_VERSION,
                "host": HOST,
                "port": PORT,
                "model": CODEX_MODEL,
                "cwd": CODEX_CWD,
                "fake_responses": FAKE_RESPONSES,
                "token_required": bool(BRIDGE_TOKEN),
            },
        )

    def do_POST(self) -> None:
        request_started = time.time()
        try:
            self.authorize()

            if self.path != "/v1/tasks":
                raise BridgeError(HTTPStatus.NOT_FOUND, "Not found.")

            payload = self.read_json()
            action, instruction = ensure_valid_payload(payload)

            if FAKE_RESPONSES:
                result_text = fake_response(action, instruction, payload)
            else:
                prompt = build_prompt(action, instruction, payload)
                result_text = run_codex(prompt)

            elapsed_ms = int((time.time() - request_started) * 1000)
            self.send_json(
                HTTPStatus.OK,
                {
                    "ok": True,
                    "result": result_text,
                    "meta": {
                        "action": action,
                        "model": CODEX_MODEL,
                        "elapsed_ms": elapsed_ms,
                        "fake_responses": FAKE_RESPONSES,
                    },
                },
            )
        except BridgeError as exc:
            self.send_json(exc.status, {"ok": False, "error": exc.message})
        except Exception as exc:  # pragma: no cover - defensive error path
            logging.exception("Unhandled server error")
            self.send_json(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {
                    "ok": False,
                    "error": f"Unhandled server error: {exc}",
                },
            )


def main() -> None:
    if CODEX_TIMEOUT_SEC <= 0:
        raise RuntimeError("CODEX_TIMEOUT_SEC must be greater than zero.")

    server = ThreadingHTTPServer((HOST, PORT), BridgeHandler)
    logging.info(
        "Starting %s on http://%s:%s (model=%s, fake_responses=%s)",
        SERVICE_NAME,
        HOST,
        PORT,
        CODEX_MODEL,
        FAKE_RESPONSES,
    )

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logging.info("Stopping %s", SERVICE_NAME)
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
