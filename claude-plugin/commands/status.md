---
description: Check the DevTailor bridge and browser takeover status
allowed-tools: Bash(curl:*), mcp__plugin_devtailor_devtailor__get_page_snapshot
---

Check the DevTailor connection and report in two or three short lines:

1. Run `curl -s -m 3 http://127.0.0.1:34781/health`. No answer means the bridge is not running (it only runs while this Claude Code session has the devtailor plugin loaded).
2. Call `get_page_snapshot`. `NO_ACTIVE_TAB` means the user has not clicked "接管" on a page yet; any other error means the extension is not connected.
3. Remind the user that the session must be started with `scripts/claude-devtailor.sh` (development channels flag), otherwise side-panel messages are silently dropped.
