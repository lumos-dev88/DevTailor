import { IncomingMessage, ServerResponse } from 'http';
import { mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { BrowserActionRouter } from './browser-action-router';
import { BrowserActionName } from './browser-action-types';

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: any;
}

const TOOL_SCHEMAS = [
  {
    name: 'take_visible_screenshot',
    description: 'Capture the visible area of the current DevTailor browser tab. The DevTailor UI is hidden by default.',
    inputSchema: {
      type: 'object',
      properties: {
        hideDevTailor: { type: 'boolean', description: 'Hide DevTailor UI while capturing. Defaults to true.' },
        grid: { type: 'boolean', description: 'Draw a viewport grid overlay on the screenshot for coordinate targeting. Defaults to false.' },
        gridSize: { type: 'number', description: 'Grid cell size in viewport CSS pixels. Defaults to 80.' },
        gridLabels: { type: 'boolean', description: 'Draw cell labels such as A1, B2. Defaults to true when grid is enabled.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_page_snapshot',
    description: 'Read URL, title, viewport, optional element rect/visibility, portal surfaces, and visible interactive elements with stable-ish elementId locator handles from the current DevTailor browser tab. Snapshot scans the document plus open shadow roots and same-origin iframes when accessible.',
    inputSchema: {
      type: 'object',
      properties: {
        selectors: { type: 'array', items: { type: 'string' }, description: 'Optional CSS selectors to check for existence and visibility.' },
        level: { type: 'string', enum: ['summary', 'interactive-only', 'full'], description: 'summary returns page metadata and counts; interactive-only returns visible interactive elements; full currently aliases interactive-only plus selector checks. Defaults to interactive-only.' },
        maxElements: { type: 'number', description: 'Maximum visible interactive elements to return. Defaults to 80, capped at 200.' },
        roles: { type: 'array', items: { type: 'string' }, description: 'Optional role filter for interactive elements.' },
        visibleOnly: { type: 'boolean', description: 'Only return visible elements. Defaults to true.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_element_targets',
    description: 'List all reusable element targets saved for this project. Use these targetId values to avoid rediscovering important controls.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'save_element_target',
    description: 'Save a reusable element target for the current page. Provide name plus at least one locator: selector, xpath, or locatorRecipes. Prefer user-maintained targets, but save stable controls when useful.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Optional explicit target id. If omitted, one is generated.' },
        name: { type: 'string', description: 'Human-readable name for the target, e.g. "Login button".' },
        description: { type: 'string', description: 'Optional longer description of what this target represents.' },
        pagePattern: { type: 'string', description: 'Optional URL pattern this target applies to, e.g. "http://localhost:3000/dashboard".' },
        selector: { type: 'string', description: 'CSS selector that locates this element.' },
        xpath: { type: 'string', description: 'XPath expression that locates this element.' },
        locatorRecipes: {
          type: 'array',
          description: 'Ordered list of locator strategies for resilient rediscovery. Each item should have: type (testId|role+label|role+text|label|css|text), value or relevant fields, weight (0-100), priority (lower = tried first), recommended (boolean).',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', description: 'Locator type: testId, role+label, role+text, label, css, text.' },
              value: { type: 'string', description: 'Primary value for this locator.' },
              role: { type: 'string', description: 'ARIA role (for role+label and role+text types).' },
              label: { type: 'string', description: 'Accessible label (for role+label type).' },
              text: { type: 'string', description: 'Visible text (for role+text and text types).' },
              attr: { type: 'string', description: 'HTML attribute name (for testId type).' },
              weight: { type: 'number', description: 'Confidence weight 0-100. Higher means more reliable.' },
              priority: { type: 'number', description: 'Try order (lower = tried first).' },
              recommended: { type: 'boolean', description: 'Whether this is the recommended primary locator.' },
            },
            required: ['type'],
            additionalProperties: false,
          },
        },
        semantic: {
          type: 'object',
          description: 'Semantic metadata about the element for AI rediscovery.',
          properties: {
            role: { type: 'string', description: 'ARIA role.' },
            name: { type: 'string', description: 'Accessible name.' },
            label: { type: 'string', description: 'Accessible label.' },
            text: { type: 'string', description: 'Visible text content.' },
            ariaLabel: { type: 'string', description: 'aria-label attribute.' },
            placeholder: { type: 'string', description: 'Placeholder attribute.' },
            title: { type: 'string', description: 'Title attribute.' },
            testId: { type: 'string', description: 'Test identifier value.' },
            testIdAttr: { type: 'string', description: 'Test identifier attribute name.' },
            inputType: { type: 'string', description: 'Input type attribute.' },
          },
          additionalProperties: false,
        },
        context: {
          type: 'object',
          description: 'Contextual metadata for page-level matching.',
          properties: {
            pagePath: { type: 'string', description: 'Page pathname.' },
            sectionTitle: { type: 'string', description: 'Section or component name.' },
            nearbyTexts: { type: 'array', items: { type: 'string' }, description: 'Nearby text snippets for context matching.' },
            containerText: { type: 'string', description: 'Parent container text.' },
            aiRegion: { type: 'string', description: 'data-ai-region attribute value.' },
          },
          additionalProperties: false,
        },
        structure: {
          type: 'object',
          description: 'Structural metadata for DOM-based lookup.',
          properties: {
            tag: { type: 'string', description: 'HTML tag name.' },
            selector: { type: 'string', description: 'CSS selector.' },
          },
          additionalProperties: false,
        },
        visual: {
          type: 'object',
          description: 'Visual metadata for viewport-based lookup.',
          properties: {
            rect: { type: 'object', description: 'Bounding box {x, y, w, h, width, height}.', additionalProperties: true },
            region: { type: 'string', description: 'Page region, e.g. "top-left", "center", "bottom-right".' },
          },
          additionalProperties: false,
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'delete_element_target',
    description: 'Delete a previously saved element target. Use get_element_targets to list available targets and their ids.',
    inputSchema: {
      type: 'object',
      properties: {
        targetId: { type: 'string', description: 'The id of the target to delete.' },
        targetName: { type: 'string', description: 'The name of the target to delete. Used as fallback if targetId is not provided.' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'get_console_logs',
    description: 'List recent console messages from the current DevTailor browser tab. Inspired by Chrome DevTools MCP list_console_messages: supports type filters, pagination, and optional preserved messages from recent reloads.',
    inputSchema: {
      type: 'object',
      properties: {
        includePreservedMessages: { type: 'boolean', description: 'Include messages preserved from recent reloads in this tab. Defaults to false.' },
        pageIdx: { type: 'number', description: 'Zero-based page index. Defaults to 0.' },
        pageSize: { type: 'number', description: 'Maximum messages to return. Defaults to 30, capped in the browser.' },
        limit: { type: 'number', description: 'Backward-compatible alias for pageSize.' },
        level: { type: 'string', enum: ['error', 'warn', 'log', 'info', 'debug', 'verbose'], description: 'Backward-compatible single-level filter.' },
        types: {
          type: 'array',
          items: { type: 'string', enum: ['log', 'debug', 'info', 'error', 'warn', 'assert', 'trace', 'verbose'] },
          description: 'Filter messages by console type or severity.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_console_message',
    description: 'Get the detailed console message for a msgid returned by get_console_logs.',
    inputSchema: {
      type: 'object',
      properties: {
        msgid: { type: 'number', description: 'The msgid returned by get_console_logs.' },
      },
      required: ['msgid'],
      additionalProperties: false,
    },
  },
  {
    name: 'reload_page',
    description: 'Schedule a reload of the current DevTailor browser tab and return immediately. After reload, reconnect and inspect the page again.',
    inputSchema: {
      type: 'object',
      properties: {
        delayMs: { type: 'number', description: 'Delay before location.reload(). Defaults to 80ms, capped at 1000ms.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'click_page',
    description: 'Click the current DevTailor browser tab by selector, markId, visible text, locator fields, elementId, or viewport point. elementId is short-lived and is fingerprint-checked before use.',
    inputSchema: {
      type: 'object',
      properties: {
        elementId: { type: 'string', description: 'Short-lived element id from a recent get_page_snapshot. Fingerprint-checked before use.' },
        targetId: { type: 'string', description: 'Saved element target id from get_element_targets.' },
        targetName: { type: 'string', description: 'Saved element target name from get_element_targets.' },
        selector: { type: 'string', description: 'CSS selector to locate the element.' },
        markId: { type: 'string', description: 'DevTailor mark id from a user-created element mark.' },
        text: { type: 'string', description: 'Visible text content to match an interactive element for clicking.' },
        role: { type: 'string', description: 'Optional role such as button, textbox, checkbox, link, tab.' },
        label: { type: 'string', description: 'Accessible label, placeholder, title, name, or associated label text.' },
        testId: { type: 'string', description: 'data-testid/data-test/data-cy value.' },
        nearText: { type: 'string', description: 'Text that should appear in the same nearby container as the target.' },
        index: { type: 'number', description: 'Zero-based index when a locator matches multiple elements.' },
        exact: { type: 'boolean', description: 'Require exact text/label matching when true.' },
        point: {
          type: 'object',
          description: 'Viewport coordinate to click directly, bypassing element lookup.',
          properties: { x: { type: 'number' }, y: { type: 'number' } },
          required: ['x', 'y'],
          additionalProperties: false,
        },
        grid: { type: 'string', description: 'Grid coordinate from a grid screenshot, for example C5.' },
        gridSize: { type: 'number', description: 'Grid cell size used by the grid screenshot. Defaults to 80.' },
        actionTimeoutMs: { type: 'number', description: 'Maximum time to wait for the target to become visible, stable, enabled, and hit-testable. Defaults to 3000ms.' },
        settleAfterMs: { type: 'number', description: 'How long to observe URL/focus/text/DOM changes after dispatching the click. Defaults to 120ms.' },
        waitAfterMs: { type: 'number', description: 'Milliseconds to wait after the action completes before returning. Useful for allowing animations or async effects to settle.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'type_text',
    description: 'Set or append text in the current DevTailor browser tab while preserving keyboard-oriented behavior such as submitKey. Defaults to replacing the field value. The text field is the value to write, not a locator; identify the target with label, role, testId, nearText, selector, elementId, targetId, or targetName. Use fill_text for stable form filling.',
    inputSchema: {
      type: 'object',
      properties: {
        elementId: { type: 'string', description: 'Short-lived element id from a recent get_page_snapshot. Fingerprint-checked before use.' },
        targetId: { type: 'string', description: 'Saved element target id from get_element_targets.' },
        targetName: { type: 'string', description: 'Saved element target name from get_element_targets.' },
        selector: { type: 'string', description: 'CSS selector to locate the input element.' },
        markId: { type: 'string', description: 'DevTailor mark id from a user-created element mark.' },
        role: { type: 'string', description: 'Optional ARIA role such as textbox, combobox, searchbox.' },
        label: { type: 'string', description: 'Accessible label, placeholder, title, name, or associated label text.' },
        testId: { type: 'string', description: 'data-testid/data-test/data-cy value.' },
        nearText: { type: 'string', description: 'Text that should appear in the same nearby container as the target.' },
        index: { type: 'number', description: 'Zero-based index when a locator matches multiple elements.' },
        exact: { type: 'boolean', description: 'Require exact text/label matching when true.' },
        point: {
          type: 'object',
          description: 'Viewport coordinate to locate the input element by point-click.',
          properties: { x: { type: 'number' }, y: { type: 'number' } },
          required: ['x', 'y'],
          additionalProperties: false,
        },
        grid: { type: 'string', description: 'Grid coordinate from a grid screenshot, for example C5.' },
        gridSize: { type: 'number', description: 'Grid cell size used by the grid screenshot. Defaults to 80.' },
        text: { type: 'string', description: 'The text value to type into the input field. This is not used as a locator.' },
        mode: { type: 'string', enum: ['replace', 'append'], description: 'replace sets the field value. append adds text after the existing value. Defaults to replace.' },
        submitKey: { type: 'string', enum: ['Enter', 'Tab'], description: 'Key to dispatch after typing, e.g. Enter to submit a form.' },
        blurAfter: { type: 'boolean', description: 'Blur the edited element after input. Useful for triggering validation. Defaults to false.' },
        waitAfterMs: { type: 'number', description: 'Milliseconds to wait after the action completes before returning. Useful for allowing animations or async effects to settle.' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'fill_text',
    description: 'Stably fill or replace text in an input, textarea, contenteditable, or role=textbox element. The text field is the value to write, not a locator; identify the target with label, role, testId, nearText, selector, elementId, targetId, or targetName. Prefer this for form setup; use type_text only when testing keyboard behavior.',
    inputSchema: {
      type: 'object',
      properties: {
        elementId: { type: 'string', description: 'Short-lived element id from a recent get_page_snapshot. Fingerprint-checked before use.' },
        targetId: { type: 'string', description: 'Saved element target id from get_element_targets.' },
        targetName: { type: 'string', description: 'Saved element target name from get_element_targets.' },
        selector: { type: 'string', description: 'CSS selector to locate the input element.' },
        markId: { type: 'string', description: 'DevTailor mark id from a user-created element mark.' },
        text: { type: 'string', description: 'The text value to fill into the input field. This is not used as a locator.' },
        role: { type: 'string', description: 'Optional ARIA role such as textbox, combobox, searchbox.' },
        label: { type: 'string', description: 'Accessible label, placeholder, title, name, or associated label text.' },
        testId: { type: 'string', description: 'data-testid/data-test/data-cy value.' },
        nearText: { type: 'string', description: 'Text that should appear in the same nearby container as the target.' },
        index: { type: 'number', description: 'Zero-based index when a locator matches multiple elements.' },
        exact: { type: 'boolean', description: 'Require exact text/label matching when true.' },
        point: {
          type: 'object',
          description: 'Viewport coordinate to locate the input element by point-click.',
          properties: { x: { type: 'number' }, y: { type: 'number' } },
          required: ['x', 'y'],
          additionalProperties: false,
        },
        grid: { type: 'string', description: 'Grid coordinate from a grid screenshot, for example C5.' },
        gridSize: { type: 'number', description: 'Grid cell size used by the grid screenshot. Defaults to 80.' },
        mode: { type: 'string', enum: ['replace', 'append'], description: 'Defaults to replace.' },
        blurAfter: { type: 'boolean', description: 'Blur after filling. Defaults to true.' },
        force: { type: 'boolean', description: 'As a last resort, set textContent on role=textbox-like elements.' },
        waitAfterMs: { type: 'number', description: 'Milliseconds to wait after the action completes before returning. Useful for allowing animations or async effects to settle.' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'press_key',
    description: 'Press a key or key combination on the current focused element in the current DevTailor browser tab. Useful for Enter, Tab, Escape, or modifier shortcuts.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Key or combination, for example Enter, Tab, Escape, Control+A, Meta+K.' },
        targetId: { type: 'string', description: 'Saved element target id from get_element_targets. Focuses the target before pressing.' },
        targetName: { type: 'string', description: 'Saved element target name from get_element_targets. Focuses the target before pressing.' },
        selector: { type: 'string', description: 'Optional selector to focus before pressing the key.' },
        elementId: { type: 'string', description: 'Short-lived element id from a recent get_page_snapshot. Fingerprint-checked before use.' },
        point: {
          type: 'object',
          description: 'Viewport coordinate to focus the target element before pressing the key.',
          properties: { x: { type: 'number' }, y: { type: 'number' } },
          required: ['x', 'y'],
          additionalProperties: false,
        },
        grid: { type: 'string', description: 'Grid coordinate from a grid screenshot, for example C5. Focuses the element at that cell before pressing.' },
        gridSize: { type: 'number', description: 'Grid cell size used by the grid screenshot. Defaults to 80.' },
        text: { type: 'string', description: 'Visible text to match an element to focus before pressing the key.' },
        role: { type: 'string', description: 'Optional ARIA role to narrow the target element.' },
        label: { type: 'string', description: 'Accessible label to narrow the target element.' },
        testId: { type: 'string', description: 'data-testid/data-test/data-cy value.' },
        nearText: { type: 'string', description: 'Text that should appear in the same nearby container as the target.' },
        index: { type: 'number', description: 'Zero-based index when a locator matches multiple elements.' },
        exact: { type: 'boolean', description: 'Require exact text/label matching when true.' },
        waitAfterMs: { type: 'number', description: 'Milliseconds to wait after the action completes before returning. Useful for allowing animations or async effects to settle.' },
      },
      required: ['key'],
      additionalProperties: false,
    },
  },
  {
    name: 'clear_state',
    description: 'Clear transient page interaction state in the current DevTailor browser tab: active-element focus, input/text selection, hover/pointer residue, and optionally stuck menus/popovers via Escape. Useful after typing, selecting text, hover, long-press, or temporary UI states that should be reset before the next action.',
    inputSchema: {
      type: 'object',
      properties: {
        pressEscape: { type: 'boolean', description: 'Also dispatch Escape after clearing state. Defaults to false.' },
        clearSelection: { type: 'boolean', description: 'Clear document text selection and input/textarea selection. Defaults to true.' },
        waitAfterMs: { type: 'number', description: 'Milliseconds to wait after the action completes before returning. Useful for allowing animations or async effects to settle.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'wait_for_selector',
    description: 'Wait until a selector exists and is visible in the current DevTailor browser tab.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector to wait for.' },
        timeoutMs: { type: 'number', description: 'Maximum time to wait. Defaults to 5000ms.' },
      },
      required: ['selector'],
      additionalProperties: false,
    },
  },
  {
    name: 'wait_for_text',
    description: 'Wait until visible page text contains the given text in the current DevTailor browser tab.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to wait for in the page.' },
        selector: { type: 'string', description: 'Optional CSS selector to scope the text search.' },
        timeoutMs: { type: 'number', description: 'Maximum time to wait. Defaults to 5000ms.' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_actions',
    description: 'Run a temporary batch of page actions and assertions in the current DevTailor tab. click/type/fill/assert_element steps must include an explicit locator such as selector, elementId, markId, text, role, label, testId, nearText, or point. This sits between single-step tools and a full E2E framework: actions are generated for the current task, executed once, and not saved as project files. If one step fails, that action stops and the next action continues.',
    inputSchema: {
      type: 'object',
      properties: {
        actions: {
          type: 'array',
          description: 'Ordered list of actions to execute. Each action contains a label and a list of steps.',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'Human-readable action label.' },
              steps: {
                type: 'array',
                description: 'Ordered steps within this action. Each step is a single operation.',
                items: {
                  type: 'object',
                  properties: {
                    type: {
                      type: 'string',
                      enum: ['click', 'type', 'fill', 'press_key', 'clear_state', 'reload', 'wait', 'wait_for_selector', 'wait_for_text', 'screenshot', 'assert_text', 'assert_url', 'assert_element'],
                      description: 'Step type. click/type/fill/assert_element require a locator.',
                    },
                    elementId: { type: 'string', description: 'Short-lived element id from a recent get_page_snapshot.' },
                    targetId: { type: 'string', description: 'Saved element target id from get_element_targets.' },
                    targetName: { type: 'string', description: 'Saved element target name from get_element_targets.' },
                    selector: { type: 'string', description: 'CSS selector to locate the element.' },
                    text: { type: 'string', description: 'For click/assert_element: visible text locator. For type/fill: text value to write, not a locator. For assert_text/wait_for_text: expected text.' },
                    role: { type: 'string', description: 'Optional ARIA role to narrow the target element.' },
                    label: { type: 'string', description: 'Accessible label to narrow the target element.' },
                    testId: { type: 'string', description: 'data-testid/data-test/data-cy value.' },
                    nearText: { type: 'string', description: 'Text that should appear in the same nearby container as the target.' },
                    index: { type: 'number', description: 'Zero-based index when a locator matches multiple elements.' },
                    exact: { type: 'boolean', description: 'Require exact text/label matching when true.' },
                    point: {
                      type: 'object',
                      description: 'Viewport coordinate to locate the target element by point-click.',
                      properties: { x: { type: 'number' }, y: { type: 'number' } },
                      required: ['x', 'y'],
                      additionalProperties: false,
                    },
                    grid: { type: 'string', description: 'Grid coordinate from a grid screenshot, for example C5.' },
                    gridSize: { type: 'number', description: 'Grid cell size used by the grid screenshot. Defaults to 80.' },
                    mode: { type: 'string', enum: ['replace', 'append'], description: 'For type/fill steps: replace sets the field value, append adds to existing. Defaults to replace.' },
                    ms: { type: 'number', description: 'For wait steps: milliseconds to sleep.' },
                    pattern: { type: 'string', description: 'For assert_url steps: URL substring or regex pattern to match.' },
                    exists: { type: 'boolean', description: 'For assert_element steps: true to assert element exists, false to assert it does not. Defaults to true.' },
                    submitKey: { type: 'string', enum: ['Enter', 'Tab'], description: 'For type steps: key to dispatch after typing.' },
                    blurAfter: { type: 'boolean', description: 'For type/fill steps: blur the element after input. Defaults to false for type, true for fill.' },
                    force: { type: 'boolean', description: 'For fill steps: force textContent as last resort.' },
                    key: { type: 'string', description: 'For press_key steps: key or combination to press, e.g. Enter, Control+A.' },
                    pressEscape: { type: 'boolean', description: 'For clear_state steps: also dispatch Escape.' },
                    clearSelection: { type: 'boolean', description: 'For clear_state steps: clear text selection. Defaults to true.' },
                    timeoutMs: { type: 'number', description: 'For wait_for_selector/wait_for_text/assert_element steps: maximum wait time.' },
                    actionTimeoutMs: { type: 'number', description: 'For click steps: maximum time to wait for target to become actionable.' },
                    settleAfterMs: { type: 'number', description: 'For click steps: time to observe DOM changes after click.' },
                    waitAfterMs: { type: 'number', description: 'Milliseconds to wait after the step completes before continuing.' },
                  },
                  required: ['type'],
                  additionalProperties: false,
                },
              },
            },
            required: ['label', 'steps'],
            additionalProperties: false,
          },
        },
        stepTimeoutMs: { type: 'number', description: 'Maximum time for one step. Defaults to 5000ms.' },
      },
      required: ['actions'],
      additionalProperties: false,
    },
  },
  {
    name: 'request_user_assistance',
    description: 'Pause the browser task and show a DevTailor dialog asking the user to manually coordinate the current page, then continue after the user clicks done. Use this when browser tools cannot restore or verify state after a few clear attempts.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Specific instruction for the user, such as "Please log in and return to the dashboard, then click done".' },
        timeoutMs: { type: 'number', description: 'How long to wait for user confirmation. Defaults to 300000 ms.' },
      },
      required: ['message'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_js',
    description: 'Evaluate a JavaScript function inside the current DevTailor browser tab. Returns the response as JSON, so returned values have to be JSON-serializable. Use this to read internal state (localStorage, sessionStorage, Redux/Vuex store, window globals), check runtime computed styles, or wait for async conditions that are not visible in the DOM.',
    inputSchema: {
      type: 'object',
      properties: {
        function: {
          type: 'string',
          description: 'A JavaScript function declaration to be executed in the page context. Example without arguments: `() => { return document.title }` or `async () => { return await fetch("example.com") }`. Example with arguments: `(el) => { return el.innerText; }`',
        },
        args: {
          type: 'array',
          items: {},
          description: 'Optional JSON-serializable arguments to pass to the function.',
        },
        filePath: {
          type: 'string',
          description: 'The absolute or relative path to a file to save the script output to. If omitted, the output is returned inline.',
        },
        dialogAction: {
          type: 'string',
          description: 'Handle dialogs while execution. "accept", "dismiss", or string for response of window.prompt. Defaults to accept.',
        },
        timeout: {
          type: 'number',
          description: 'Maximum execution time in milliseconds. Defaults to 30000.',
        },
        world: {
          type: 'string',
          enum: ['MAIN', 'ISOLATED'],
          description: 'Chrome execution world. MAIN can access page globals but may be affected by page CSP unsafe-eval. ISOLATED is more reliable for DOM/localStorage but cannot access page JS globals. Defaults to MAIN.',
        },
      },
      required: ['function'],
      additionalProperties: false,
    },
  },
];

export class BrowserMCPServer {
  constructor(private router: BrowserActionRouter) {}

  async handle(req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    const requests = Array.isArray(body) ? body : [body];
    const responses = [];
    for (const request of requests) {
      const response = await this.handleRpc(request as JsonRpcRequest);
      if (response) responses.push(response);
    }

    if (responses.length === 0) {
      res.writeHead(202, {
        'Mcp-Session-Id': 'devtailor-browser',
      });
      res.end();
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Mcp-Session-Id': 'devtailor-browser',
    });
    if (Array.isArray(body)) {
      res.end(JSON.stringify(responses));
    } else {
      res.end(JSON.stringify(responses[0] ?? null));
    }
  }

  private async handleRpc(request: JsonRpcRequest): Promise<unknown | null> {
    const id = request.id ?? null;
    const method = request.method || '';

    if (!('id' in request)) {
      return null;
    }

    try {
      switch (method) {
        case 'initialize':
          return this.result(id, {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'devtailor-browser', version: '0.1.0' },
          });
        case 'ping':
          return this.result(id, {});
        case 'tools/list':
          return this.result(id, { tools: TOOL_SCHEMAS });
        case 'tools/call':
          return this.result(id, await this.callTool(request.params || {}));
        default:
          return this.error(id, -32601, `Method not found: ${method}`);
      }
    } catch (err: any) {
      return this.error(id, -32000, err.message || 'Browser MCP error');
    }
  }

  private async callTool(params: { name?: string; arguments?: Record<string, unknown> }): Promise<unknown> {
    const name = params.name as BrowserActionName;
    if (!TOOL_SCHEMAS.some(tool => tool.name === name)) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Unknown browser tool: ${params.name}` }],
      };
    }

    const actionResult = await this.router.run(name, params.arguments || {});
    if (!actionResult.ok) {
      const payload = actionResult.error?.detail
        ? {
            error: actionResult.error.message || 'Browser action failed',
            code: actionResult.error.code,
            detail: actionResult.error.detail,
          }
        : null;
      return {
        isError: true,
        content: [{
          type: 'text',
          text: payload
            ? JSON.stringify(payload, null, 2)
            : actionResult.error?.message || 'Browser action failed',
        }],
      };
    }

    if (name === 'take_visible_screenshot') {
      const image = actionResult.result as { data?: string; mimeType?: string } | undefined;
      if (image?.data) {
        const data = image.data.includes(',') ? image.data.split(',').pop() || image.data : image.data;
        return {
          content: [{ type: 'image', data, mimeType: image.mimeType || 'image/png' }],
        };
      }
    }

    const result = name === 'run_actions'
      ? this.externalizeRunActionScreenshots(actionResult.result)
      : actionResult.result;

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result ?? {}, null, 2),
      }],
    };
  }

  private externalizeRunActionScreenshots(result: unknown): unknown {
    if (!result || typeof result !== 'object') return result;
    const root = result as any;
    if (!Array.isArray(root.results)) return result;

    const dir = join(tmpdir(), 'devtailor-browser-screenshots');
    mkdirSync(dir, { recursive: true });

    root.results = root.results.map((action: any) => {
      if (!Array.isArray(action?.screenshots)) return action;
      return {
        ...action,
        screenshots: action.screenshots.map((shot: any, index: number) => {
          if (!shot?.data || typeof shot.data !== 'string') return shot;
          const mimeType = typeof shot.mimeType === 'string' ? shot.mimeType : 'image/png';
          const ext = mimeType.includes('jpeg') || mimeType.includes('jpg') ? 'jpg' : 'png';
          const raw = shot.data.includes(',') ? shot.data.split(',').pop() || shot.data : shot.data;
          const filePath = join(dir, `${Date.now()}-${randomUUID()}-${index}.${ext}`);
          writeFileSync(filePath, Buffer.from(raw, 'base64'));
          const { data, ...rest } = shot;
          return {
            ...rest,
            mimeType,
            filePath,
            dataOmitted: true,
          };
        }),
      };
    });

    return root;
  }

  private result(id: JsonRpcId, result: unknown): unknown {
    return { jsonrpc: '2.0', id, result };
  }

  private error(id: JsonRpcId, code: number, message: string): unknown {
    return { jsonrpc: '2.0', id, error: { code, message } };
  }
}
