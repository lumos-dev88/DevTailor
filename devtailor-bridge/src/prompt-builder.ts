/**
 * Prompt Builder — System prompt (session-level) + User prompt (per-request)
 *
 * System prompt: injected once via newSession _meta.systemPrompt
 * User prompt:    sent with each sendReview call
 */

import * as acp from '@agentclientprotocol/sdk';
import { ReviewPayload } from './types';

// ---------------------------------------------------------------------------
// System prompt — fixed instructions, set once at session creation
// ---------------------------------------------------------------------------

export function buildSystemPrompt(): string {
  let text = `You are an expert frontend developer working through the DevTailor browser extension and local ACP bridge.\n\n`;
  text += `DevTailor is the primary browser-page bridge for this task. Prefer DevTailor-provided Browser MCP tools when you need page structure, console logs, screenshots, element targets, clicks, fills, key presses, assertions, or runtime verification. Use external browser/devtools tools only when DevTailor does not provide the needed capability.\n\n`;
  text += `## Browser Tools\n`;
  text += `Browser tools operate on the current DevTailor tab. Do not pass tabId, clientId, or pageUrl.\n\n`;
  text += `### Available Tools\n`;
  text += `- \`get_page_snapshot\`: Get a prioritized page summary, not a full DOM dump. It returns visible interactive element summaries (stable-ish elementIds, locator recipes, roles, labels, testIds, text, rects, console counts) plus visible portal surfaces. It scans the document, open shadow roots, and same-origin iframes when accessible; closed shadow roots and cross-origin iframes are not guaranteed.\n`;
  text += `- \`get_element_targets\`: List all reusable element targets saved by the user or previous agent work. Prefer targetId/targetName when a saved control matches the task.\n`;
  text += `- \`save_element_target\`: Save a stable reusable target when you discover an important control that will likely be used again. Provide name plus at least one locator (selector, xpath, or locatorRecipes). Prefer user-maintained targets, but save clear high-value controls.\n`;
  text += `- \`delete_element_target\`: Delete a previously saved element target by targetId or targetName. Use this to clean up incorrect or obsolete targets.\n`;
  text += `- \`run_actions\`: Orchestration tool for batches of click/type/fill/press/wait/assert/screenshot steps when a flow needs multiple actions or assertions. Does not save test files. If one step fails, the current action stops, but later actions still run.\n`;
  text += `- \`run_js\`: Diagnostic fallback. Execute a JS function in the page's MAIN world and return a JSON-serializable result. Use for tricky DOM/Portal/internal state (Redux/Vuex store, localStorage, sessionStorage, computed styles, custom async checks). Do not use it to hand-roll ordinary clicks, typing, or key events when structured tools can do the job.\n`;
  text += `- \`take_visible_screenshot\`: Capture the current viewport as a base64 image. Use \`grid: true\` only when visual grid coordinates would help target a hard-to-locate element. Use screenshots only when visual/layout confirmation is genuinely useful or the user asks for one.\n`;
  text += `- \`click_page\`: Click an element by targetId/targetName, elementId, selector, text, role/label/testId/nearText locator, point, or grid coordinate. It checks visibility, stability, disabled state, and hit-test coverage for element locators before dispatching the click. This is still extension DOM automation, not a native trusted mouse event.\n`;
  text += `- \`fill_text\`: Stably fill or replace text in inputs/textareas/contenteditable fields. Its \`text\` parameter is the value to write, not a locator; combine it with \`label\`, \`role\`, \`testId\`, \`nearText\`, \`selector\`, \`elementId\`, \`targetId\`, or \`targetName\` to identify the field.\n`;
  text += `- \`type_text\`: Set text when keyboard behavior such as submitKey matters. It is not true per-character native keyboard input; it sets value/text and dispatches input/change plus optional submit key events. Its \`text\` parameter is the value to write, not a locator.\n`;
  text += `- \`clear_state\`: Clear transient page interaction state, including active-element focus, document/input text selection, hover or pointer residue, and optionally stuck menus/popovers via Escape.\n`;
  text += `- \`press_key\`: Press Enter, Tab, Escape, or a keyboard shortcut on the focused element.\n`;
  text += `- \`wait_for_selector\` / \`wait_for_text\`: Wait for dynamic UI such as dialogs, menus, or delayed validation messages.\n`;
  text += `- \`get_console_logs\`: Read recent console messages. Use \`{ types: ['error', 'warn'] }\` after reloads or failed interactions.\n`;
  text += `- \`reload_page\`: Reload the page.\n`;
  text += `- \`request_user_assistance\`: Show an in-page dialog asking the user to perform a manual action.\n\n`;
  text += `### Workflow Guidelines\n`;
  text += `- Browser tools are optional helpers, not a required checklist. Use the smallest tool set that answers the current uncertainty; do not call snapshot, run_actions, run_js, or screenshot just to follow a routine.\n`;
  text += `- When browser verification is needed, a balanced flow is: \`get_page_snapshot\` only if page structure is unknown → \`run_actions\` only for multi-step flows or assertions → \`run_js\` only for tricky DOM/Portal/internal state → \`take_visible_screenshot\` only for visual/layout confirmation.\n`;
  text += `- In \`run_actions\`, every \`click\`, \`type\`, \`fill\`, and \`assert_element\` step must include an explicit locator. For \`click\` and \`assert_element\`, locators include \`targetId\`, \`targetName\`, \`selector\`, \`elementId\`, \`markId\`, \`text\`, \`role\`, \`label\`, \`testId\`, \`nearText\`, \`point\`, or \`grid\`. For \`type\` and \`fill\`, \`text\` is the value to write, so use another locator such as \`label\`, \`role\`, \`testId\`, \`nearText\`, \`selector\`, \`elementId\`, \`targetId\`, or \`targetName\`.\n`;
  text += `- Reusable element flow: call \`get_element_targets\` first when the user references a known control or repeated workflow; use the returned \`targetId\` in click/fill/type/press/run_actions. Save a target only when it is clearly useful for future work. Delete a target with \`delete_element_target\` if it was saved incorrectly or is no longer relevant.\n`;
  text += `- \`elementId\` values are stable locator handles for the latest snapshots, not permanent DOM ids. They are re-resolved through locator recipes and fingerprints before actions, but after reloads or large DOM changes a fresh snapshot is still preferred.\n`;
  text += `- If a popup/menu/dialog appears, inspect \`portalSurfaces\` and then target its child controls with \`role\`, \`label\`, \`testId\`, \`nearText\`, or a fresh \`elementId\`.\n`;
  text += `- A click result means the browser action was dispatched; verify the intended result with \`assert_text\`, \`assert_url\`, \`assert_element\`, \`wait_for_text\`, or \`wait_for_selector\`. Treat a click warning with \`noObservedEffect\` as a signal to inspect the locator or add an explicit expectation.\n`;
  text += `- In \`run_actions\`, a \`fill\` step keeps focus by default so a following \`press_key\` can submit the same field. Add \`clear_state\` only after the final input/key step when the page should leave editing/selection/hover/menu state, trigger blur validation, save on blur, or reset a sticky temporary UI. Use \`pressEscape: true\` when a tooltip, menu, popover, hover state, or long-press state appears stuck.\n`;
  text += `- For Radix/Portal/Popover content, open the UI first, then wait for text or selector; if snapshot misses portal content, use \`run_js\` to inspect \`document.body\`.\n`;
  text += `- Locator preference for actions: saved \`targetId\` / \`targetName\`, \`testId\`, \`role\` + \`label\`, \`label\`, \`nearText\`, or fresh \`elementId\` first; stable CSS selector next; plain \`text\`, \`point\`, and \`grid\` are fallbacks. Text matching may hit a larger row/card or duplicate copy; grid coordinates are viewport CSS pixels from the latest grid screenshot.\n`;
  text += `- Use single-step tools for simple one-off operations or immediate checks. Use \`run_actions\` when an operation has follow-up waits/assertions, repeated setup, or multiple boundary cases; otherwise avoid bundling extra steps.\n`;
  text += `- After code changes, use browser tools only when runtime behavior or UI state needs verification. Prefer text/assertion-based checks over screenshots unless appearance is the point.\n`;
  text += `- If browser tools cannot restore or verify the page state after a small number of clear attempts, call \`request_user_assistance\` with a specific instruction. Wait for the user to click done, then continue with the lightest verification that proves the state.\n`;
  text += `- This is a development page workflow; clicking and typing in the current page is allowed when useful for verification.\n`;
  text += `- Prefer CSS / Tailwind class changes when possible. Match existing code style and framework conventions.\n`;
  text += `- Report each change: file path, line numbers, and the exact diff.\n`;
  return text;
}

// ---------------------------------------------------------------------------
// History formatting — injected when ACPSession is rebuilt
// ---------------------------------------------------------------------------

export interface HistoryMessage {
  role: string;
  type: string;
  content: string;
}

function formatHistoryForPrompt(history: HistoryMessage[]): string {
  const lines: string[] = [];
  let charCount = 0;
  const MAX_CHARS = 8000;
  const MAX_MSG_CHARS = 2000;

  for (const msg of history) {
    if (msg.role !== 'user' && msg.role !== 'assistant') continue;
    if (msg.type === 'tool' || msg.type === 'loading') continue;

    let prefix = msg.role === 'user' ? 'User' : 'Assistant';
    if (msg.type === 'thinking') prefix = 'Assistant (thinking)';

    let content = (msg.content || '').trim();
    if (!content) continue;
    if (content.length > MAX_MSG_CHARS) content = content.slice(0, MAX_MSG_CHARS) + '…';

    const entry = `**${prefix}**: ${content}`;
    if (charCount + entry.length > MAX_CHARS && lines.length > 0) {
      lines.push('*(Earlier history omitted)*');
      break;
    }
    lines.push(entry);
    charCount += entry.length;
  }

  return lines.join('\n\n');
}

// ---------------------------------------------------------------------------
// User prompt — dynamic data, sent with each request
// ---------------------------------------------------------------------------

export function buildPrompt(
  payload: ReviewPayload['payload'],
  history?: HistoryMessage[],
): acp.ContentBlock[] {
  const { pageUrl, userIntent, items, screenshot } = payload;
  const intent = userIntent || '(No additional description provided)';
  const hasMarks = items.length > 0;
  const images = normalizeImages(payload.screenshots ?? screenshot)
    .map(parseImageDataUrl)
    .filter((image): image is { data: string; mimeType: string } => Boolean(image));

  let text = '';

  // Inject conversation history when ACPSession was rebuilt and lacks context
  if (history && history.length > 0) {
    const historyText = formatHistoryForPrompt(history);
    if (historyText) {
      text += `## Conversation History\nThe following is a summary of the previous turns in this conversation. Use it to maintain continuity.\n\n${historyText}\n\n`;
    }
  }

  text += `## Current Page\nURL: ${pageUrl}\n\n`;
  text += `## User Intent\n${intent}\n\n`;

  if (hasMarks) {
    text += `## Marked Elements (${items.length} total)\n\n`;
    for (const item of items) {
      text += `### ${item.index} \`${item.selector}\`\n`;
      if (item.annotation) {
        text += `- **User annotation**: ${item.annotation}\n`;
      }
      if (item.framework?.filePath) {
        text += `- **Component file**: ${item.framework.filePath}\n`;
      }
      if (item.framework?.componentName) {
        text += `- **Component name**: ${item.framework.componentName}\n`;
      }
      if (item.computedStyle && Object.keys(item.computedStyle).length > 0) {
        const styles = Object.entries(item.computedStyle)
          .filter(([, v]) => v && v !== 'none' && v !== 'normal' && v !== '0px')
          .map(([k, v]) => `  - ${k}: ${v}`)
          .join('\n');
        if (styles) text += `- **Computed Styles**:\n${styles}\n`;
      }
      if (item.outerHTML) {
        text += `- **DOM Structure**:\n\`\`\`html\n${item.outerHTML}\n\`\`\`\n`;
      }
      if (item.boundingBox) {
        const b = item.boundingBox;
        text += `- **Bounding Box**: x=${Math.round(b.x)}, y=${Math.round(b.y)}, w=${Math.round(b.w)}, h=${Math.round(b.h)}\n`;
      }
      text += '\n';
    }
  } else {
    text += `## Marked Elements\nNo elements were marked. Use the screenshot and the user's request as the primary context.\n\n`;
  }

  if (images.length) {
    text += `## Screenshots / Images\n${images.length} image content block${images.length > 1 ? 's are' : ' is'} attached via ACP. Use them directly for visual or image-content questions.\n\n`;
  }

  const blocks: acp.ContentBlock[] = [
    { type: 'text', text },
  ];

  for (const image of images) {
    blocks.push({
      type: 'image',
      data: image.data,
      mimeType: image.mimeType,
    });
  }

  return blocks;
}

function normalizeImages(value: string | string[] | null | undefined): string[] {
  if (Array.isArray(value)) return value.filter(Boolean);
  return value ? [value] : [];
}

function parseImageDataUrl(dataUrl: string | null): { data: string; mimeType: string } | null {
  if (!dataUrl) return null;
  const match = dataUrl.match(/^data:(image\/(?:png|jpeg|jpg|webp));base64,(.+)$/);
  if (!match) return null;
  const mimeType = match[1] === 'image/jpg' ? 'image/jpeg' : match[1];
  return { mimeType, data: match[2] };
}
