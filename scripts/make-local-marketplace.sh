#!/usr/bin/env bash
# Generate a local marketplace that contains the DevTailor plugin, so it can be
# installed (and copied into Claude Code's plugin cache) like a real plugin.
#
#   scripts/make-local-marketplace.sh
#   claude plugin marketplace add <repo>/claude-plugin-marketplace
#   claude plugin install devtailor@devtailor-local
#   DEVTAILOR_CHANNEL_ENTRY=plugin:devtailor@devtailor-local DEVTAILOR_NO_PLUGIN_DIR=1 scripts/claude-devtailor.sh
#
# Output (gitignored): claude-plugin-marketplace/
set -euo pipefail
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO_DIR/claude-plugin"
OUT="$REPO_DIR/claude-plugin-marketplace"

[ -f "$SRC/server/mcp-main.cjs" ] || { echo "plugin server not built: run 'npm run build:plugin' in devtailor-bridge first" >&2; exit 1; }

rm -rf "$OUT"
mkdir -p "$OUT/.claude-plugin" "$OUT/plugins"
cp -R "$SRC" "$OUT/plugins/devtailor"
cat > "$OUT/.claude-plugin/marketplace.json" <<'JSON'
{
  "name": "devtailor-local",
  "owner": { "name": "DevTailor" },
  "metadata": { "description": "Local marketplace for the DevTailor Claude Code plugin" },
  "plugins": [
    {
      "name": "devtailor",
      "source": "./plugins/devtailor",
      "description": "Let Claude Code see and operate your Chrome tab through the DevTailor extension."
    }
  ]
}
JSON
echo "marketplace written to $OUT"
