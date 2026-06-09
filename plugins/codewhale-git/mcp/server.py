"""MCP server that exposes git_add and git_commit tools for CodeWhale.

Run via: python server.py
Registered in ~/.codewhale/mcp.json as a stdio server.
"""

import subprocess
import sys
from pathlib import Path

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import Tool, TextContent


WORKSPACE = Path.cwd()

server = Server("codewhale-git")


def _run_git(args: list[str]) -> tuple[int, str, str]:
    """Run a git command in the workspace and return (code, stdout, stderr)."""
    try:
        r = subprocess.run(
            ["git"] + args,
            cwd=str(WORKSPACE),
            capture_output=True,
            text=True,
            timeout=30,
        )
        return r.returncode, r.stdout.strip(), r.stderr.strip()
    except FileNotFoundError:
        return 1, "", "git: command not found — is Git installed and on PATH?"
    except subprocess.TimeoutExpired:
        return 1, "", "git: command timed out after 30s"


@server.list_tools()
async def list_tools() -> list[Tool]:
    return [
        Tool(
            name="git_add",
            description="Stage one or more file paths for commit. Paths are relative to the workspace root.",
            inputSchema={
                "type": "object",
                "properties": {
                    "paths": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "File paths to stage (globs supported, e.g. 'packages/console/')",
                    }
                },
                "required": ["paths"],
            },
        ),
        Tool(
            name="git_commit",
            description="Commit staged changes with a message. Follows Conventional Commits style (feat:, fix:, chore:, etc.).",
            inputSchema={
                "type": "object",
                "properties": {
                    "message": {
                        "type": "string",
                        "description": "Commit message (Conventional Commits format recommended)",
                    }
                },
                "required": ["message"],
            },
        ),
    ]


@server.call_tool()
async def call_tool(name: str, arguments: dict) -> list[TextContent]:
    if name == "git_add":
        paths = arguments.get("paths", [])
        if not paths:
            return [TextContent(type="text", text="git_add: no paths provided")]
        code, stdout, stderr = _run_git(["add", "--"] + paths)
        if code == 0:
            text = f"Staged {len(paths)} path(s):\n{stdout}" if stdout else f"Staged {len(paths)} path(s)"
        else:
            text = f"git add failed (exit {code}):\n{stderr}"
        return [TextContent(type="text", text=text)]

    if name == "git_commit":
        message = arguments.get("message", "")
        if not message:
            return [TextContent(type="text", text="git_commit: no commit message provided")]
        code, stdout, stderr = _run_git(["commit", "-m", message])
        if code == 0:
            text = stdout or "Committed successfully"
        else:
            text = f"git commit failed (exit {code}):\n{stderr}"
        return [TextContent(type="text", text=text)]

    return [TextContent(type="text", text=f"Unknown tool: {name}")]


async def main():
    async with stdio_server() as (read, write):
        await server.run(read, write, server.create_initialization_options())


if __name__ == "__main__":
    import asyncio
    asyncio.run(main())
