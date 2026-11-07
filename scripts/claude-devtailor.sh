#!/usr/bin/env bash
# Start Claude Code with the DevTailor plugin loaded as a development channel.
#
#   scripts/claude-devtailor.sh [claude args...]
#
# Uses `--plugin-dir` (session-only plugin; its id is `devtailor@inline`) plus
# `--dangerously-load-development-channels plugin:devtailor@inline`. Channels are
# a research preview and custom ones are not on the allowlist, so the dev flag is
# required; without it browser messages are silently dropped.
#
# Run from the project you want Claude to edit (its directory becomes
# CLAUDE_PROJECT_DIR and receives .devtailor/).
#
# Overrides:
#   DEVTAILOR_CHANNEL_ENTRY   channel entry, e.g. plugin:devtailor@devtailor-local
#                             (installed via marketplace) or server:devtailor
#                             (project .mcp.json). Default: plugin:devtailor@inline
#   DEVTAILOR_NO_PLUGIN_DIR=1 do not pass --plugin-dir (plugin already installed)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PLUGIN_DIR="$REPO_DIR/claude-plugin"
BUNDLE="$PLUGIN_DIR/server/mcp-main.cjs"

die() { echo "claude-devtailor: $*" >&2; exit 1; }

command -v claude >/dev/null 2>&1 || die "'claude' not found in PATH. Install Claude Code (>= 2.1.80) first."
command -v node >/dev/null 2>&1 || die "'node' not found in PATH (Node >= 20 required)."

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node >= 20 required, found $(node --version)."

if [ ! -f "$BUNDLE" ] || [ ! -f "$PLUGIN_DIR/server/sql-wasm.wasm" ]; then
  die "plugin server not built. Run: (cd '$REPO_DIR/devtailor-bridge' && npm install && npm run build:plugin)"
fi

if curl -s -m 1 -o /dev/null "http://127.0.0.1:34781/health" 2>/dev/null; then
  echo "claude-devtailor: warning: port 34781 already answers; another DevTailor bridge may be running. The new session's bridge will fail to bind." >&2
fi

# Insurance: keep MCP servers on the legacy handshake so channel registration
# is not affected by the newer protocol negotiation (see docs/CLAUDE_CHANNEL_PROTOCOL.md).
export MCP_PROTOCOL_NEGOTIATION=legacy

ENTRY="${DEVTAILOR_CHANNEL_ENTRY:-plugin:devtailor@inline}"
ARGS=()
if [ -z "${DEVTAILOR_NO_PLUGIN_DIR:-}" ]; then
  ARGS+=(--plugin-dir "$PLUGIN_DIR")
fi
ARGS+=(--dangerously-load-development-channels "$ENTRY")

echo "claude-devtailor: channel=$ENTRY project=$PWD" >&2
exec claude "${ARGS[@]}" "$@"
