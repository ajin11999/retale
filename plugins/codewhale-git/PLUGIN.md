---
name: codewhale-git
description: Git write tools (add, commit) for CodeWhale via an MCP server. Exposes git_add and git_commit so the agent can stage and commit without leaving the session.
status: draft
---

# CodeWhale Git Plugin

Adds `git_add` and `git_commit` tools to CodeWhale so the agent can stage files
and create commits directly — no need to drop into a terminal for basic git
writes.

## How it works

An MCP stdio server (Python, using the official `mcp` SDK) wraps `git add` and
`git commit`. Register it once in your MCP config and the tools appear as
`mcp_git_add` and `mcp_git_commit` in every session.

## Activation

### 1. Install the MCP Python SDK

```powershell
pip install mcp
```

### 2. Register the server

Add this to `~/.codewhale/mcp.json`:

```json
{
  "mcpServers": {
    "git": {
      "command": "python",
      "args": ["plugins/codewhale-git/mcp/server.py"],
      "cwd": "C:/Users/bidip/retale"
    }
  }
}
```

### 3. Restart CodeWhale

The tools `mcp_git_add` and `mcp_git_commit` will be available on next launch.

## Tools

| Tool | Arguments | Description |
|------|-----------|-------------|
| `git_add` | `paths: string[]` | Stage one or more file paths |
| `git_commit` | `message: string` | Commit staged changes with the given message |

Both tools run in the workspace root (`cwd` from the MCP config). Output is
captured and returned to the agent.
