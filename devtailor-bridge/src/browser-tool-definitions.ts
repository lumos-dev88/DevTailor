/**
 * Browser Tool Definitions
 *
 * Pure data mapping from BrowserActionName → AI-runtime tool schema.
 * No network, no side-effects, no model integration.
 *
 * Each definition follows a subset of the OpenAI function/tool schema:
 *   { name, description, parameters: JSONSchema }
 */

import { BrowserActionName } from './browser-action-types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BrowserToolDefinition {
  /** Tool name — must match a BrowserActionName exactly. */
  name: BrowserActionName;
  /** Human-readable description suitable for LLM consumption. */
  description: string;
  /** JSON Schema object for the tool's parameters. */
  parameters: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Shared parameter fragments (reused across tools)
// ---------------------------------------------------------------------------

const LOCATOR_PROPERTIES: Record<string, unknown> = {
  targetId:    { type: 'string', description: 'Saved element target ID.' },
  targetName:  { type: 'string', description: 'Saved element target name.' },
  elementId:   { type: 'string', description: 'Ephemeral element ID from get_page_snapshot.' },
  selector:    { type: 'string', description: 'CSS selector.' },
  text:        { type: 'string', description: 'Visible text to match.' },
  role:        { type: 'string', description: 'ARIA role (e.g. "button", "textbox").' },
  label:       { type: 'string', description: 'Accessible label / aria-label.' },
  testId:      { type: 'string', description: 'data-testid attribute value.' },
  nearText:    { type: 'string', description: 'Visible text near the target element.' },
};

const LOCATOR_DESCRIPTION =
  'Identify the target element using one or more of: targetId, targetName, elementId, selector, text, role, label, testId, nearText.';

// ---------------------------------------------------------------------------
// Per-action definitions
// ---------------------------------------------------------------------------

const DEFINITIONS: Record<BrowserActionName, BrowserToolDefinition> = {
  get_page_snapshot: {
    name: 'get_page_snapshot',
    description:
      'Get a prioritized page summary (not a full DOM dump). Returns visible interactive element summaries with stable-ish elementIds, locator recipes, roles, labels, testIds, text, rects, and console counts. Scans the document, open shadow roots, and same-origin iframes when accessible.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },

  get_console_logs: {
    name: 'get_console_logs',
    description:
      'Read recent console messages. Use { types: ["error", "warn"] } after reloads or failed interactions.',
    parameters: {
      type: 'object',
      properties: {
        types: {
          type: 'array',
          items: { type: 'string', enum: ['log', 'warn', 'error', 'info', 'debug'] },
          description: 'Filter by console message type. Omit to include all.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of messages to return. Default varies.',
        },
      },
      additionalProperties: false,
    },
  },

  get_console_message: {
    name: 'get_console_message',
    description:
      'Get a single console message by index. Useful for retrieving stack traces or full arguments after a get_console_logs listing.',
    parameters: {
      type: 'object',
      properties: {
        index: { type: 'number', description: 'Zero-based index of the console message.' },
      },
      required: ['index'],
      additionalProperties: false,
    },
  },

  get_element_targets: {
    name: 'get_element_targets',
    description:
      'List all reusable element targets saved by the user or previous agent work. Prefer targetId/targetName when a saved control matches the task.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },

  save_element_target: {
    name: 'save_element_target',
    description:
      'Save a stable reusable target for an important control that will likely be used again. Provide a name and at least one locator.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Human-readable name for this target.' },
        selector: { type: 'string', description: 'CSS selector.' },
        xpath: { type: 'string', description: 'XPath expression.' },
        locatorRecipes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Locator recipe strings from get_page_snapshot.',
        },
        ...LOCATOR_PROPERTIES,
      },
      required: ['name'],
      additionalProperties: false,
    },
  },

  delete_element_target: {
    name: 'delete_element_target',
    description: 'Delete a previously saved element target by targetId or targetName.',
    parameters: {
      type: 'object',
      properties: {
        targetId: { type: 'string', description: 'ID of the target to delete.' },
        targetName: { type: 'string', description: 'Name of the target to delete.' },
      },
      additionalProperties: false,
    },
  },

  reload_page: {
    name: 'reload_page',
    description: 'Reload the current page.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },

  click_page: {
    name: 'click_page',
    description:
      'Click an element. Supports multiple locator strategies including targetId, elementId, selector, text, role/label/testId/nearText locator, point, or grid coordinate. Checks visibility, stability, disabled state, and hit-test coverage before dispatching.',
    parameters: {
      type: 'object',
      properties: {
        ...LOCATOR_PROPERTIES,
        point: {
          type: 'object',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
          },
          required: ['x', 'y'],
          description: 'Absolute viewport coordinate to click.',
        },
        grid: {
          type: 'object',
          properties: {
            col: { type: 'number' },
            row: { type: 'number' },
          },
          required: ['col', 'row'],
          description: 'Grid cell coordinate (requires take_visible_screenshot with grid:true first).',
        },
      },
      additionalProperties: false,
    },
  },

  fill_text: {
    name: 'fill_text',
    description:
      'Stably fill or replace text in inputs, textareas, or contenteditable fields. The `text` parameter is the value to write, not a locator; combine it with a locator to identify the field.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The text value to write into the field.' },
        ...LOCATOR_PROPERTIES,
      },
      required: ['text'],
      additionalProperties: false,
    },
  },

  type_text: {
    name: 'type_text',
    description:
      'Set text when keyboard behavior such as submitKey matters. Not true per-character native input; it sets value/text and dispatches input/change plus optional submit key events. The `text` parameter is the value to write, not a locator.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The text value to write.' },
        submitKey: {
          type: 'string',
          enum: ['Enter', 'Tab'],
          description: 'Optional key to press after setting the value.',
        },
        ...LOCATOR_PROPERTIES,
      },
      required: ['text'],
      additionalProperties: false,
    },
  },

  press_key: {
    name: 'press_key',
    description:
      'Press Enter, Tab, Escape, or a keyboard shortcut on the focused element.',
    parameters: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description:
            'Key name: "Enter", "Tab", "Escape", or a shortcut like "Control+a".',
        },
      },
      required: ['key'],
      additionalProperties: false,
    },
  },

  clear_state: {
    name: 'clear_state',
    description:
      'Clear transient page interaction state including active-element focus, document/input text selection, hover or pointer residue, and optionally stuck menus/popovers via Escape.',
    parameters: {
      type: 'object',
      properties: {
        dismissPopovers: {
          type: 'boolean',
          description: 'If true, also press Escape to dismiss stuck menus/popovers. Default true.',
        },
      },
      additionalProperties: false,
    },
  },

  wait_for_selector: {
    name: 'wait_for_selector',
    description: 'Wait for a CSS selector to appear in the DOM. Useful for dialogs, menus, or delayed validation messages.',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector to wait for.' },
        timeoutMs: {
          type: 'number',
          description: 'Maximum wait time in ms. Default 15000. Capped at 60000.',
        },
      },
      required: ['selector'],
      additionalProperties: false,
    },
  },

  wait_for_text: {
    name: 'wait_for_text',
    description: 'Wait for visible text to appear on the page. Useful for delayed validation messages or status updates.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Visible text to wait for.' },
        timeoutMs: {
          type: 'number',
          description: 'Maximum wait time in ms. Default 15000. Capped at 60000.',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },

  run_actions: {
    name: 'run_actions',
    description:
      'Orchestration tool for labeled batches of click/type/fill/press/wait/assert/screenshot steps. Does not save test files. If one step fails the current action stops but later actions still run.',
    parameters: {
      type: 'object',
      properties: {
        actions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              label: {
                type: 'string',
                description: 'Optional label for this batch of steps.',
              },
              steps: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    type: {
                      type: 'string',
                      enum: [
                        'click',
                        'fill',
                        'type',
                        'press_key',
                        'clear_state',
                        'wait',
                        'wait_for_selector',
                        'wait_for_text',
                        'screenshot',
                        'assert_text',
                        'assert_url',
                        'assert_element',
                        'reload',
                      ],
                      description: 'Step type.',
                    },
                    ...LOCATOR_PROPERTIES,
                    selector: LOCATOR_PROPERTIES.selector,
                    text: { type: 'string', description: 'Text value, visible text, or assertion text depending on step type.' },
                    key: { type: 'string', description: 'Key for press_key steps.' },
                    submitKey: { type: 'string', enum: ['Enter', 'Tab'], description: 'Optional submit key for type steps.' },
                    point: {
                      type: 'object',
                      properties: {
                        x: { type: 'number' },
                        y: { type: 'number' },
                      },
                      required: ['x', 'y'],
                      description: 'Absolute viewport coordinate for click/assert targeting.',
                    },
                    index: { type: 'number', description: 'Optional match index when multiple elements match.' },
                    exact: { type: 'boolean', description: 'Whether text/label matching should be exact.' },
                    mode: { type: 'string', enum: ['replace', 'append'], description: 'Typing/fill mode.' },
                    blurAfter: { type: 'boolean', description: 'Whether fill/type should blur after editing.' },
                    ms: { type: 'number', description: 'Milliseconds to wait for wait steps.' },
                    timeoutMs: { type: 'number', description: 'Timeout for wait/assert steps.' },
                    waitAfterMs: { type: 'number', description: 'Delay after this step.' },
                    grid: {
                      anyOf: [
                        { type: 'boolean' },
                        { type: 'string' },
                        {
                          type: 'object',
                          properties: {
                            col: { type: 'number' },
                            row: { type: 'number' },
                          },
                          required: ['col', 'row'],
                        },
                      ],
                      description: 'Grid target or whether a screenshot step should include a grid overlay.',
                    },
                    gridSize: { type: 'number', description: 'Grid cell size for grid targeting or screenshot overlays.' },
                    gridLabels: { type: 'boolean', description: 'Whether screenshot grid labels should be drawn.' },
                    hideDevTailor: { type: 'boolean', description: 'Whether screenshot should hide DevTailor UI. Default true.' },
                    pattern: { type: 'string', description: 'URL pattern for assert_url steps.' },
                    pressEscape: { type: 'boolean', description: 'Whether clear_state should press Escape.' },
                    clearSelection: { type: 'boolean', description: 'Whether clear_state should clear current selection.' },
                    expected: { type: 'string', description: 'Expected value for assertion steps.' },
                    exists: { type: 'boolean', description: 'For assert_element: whether the element should exist and be visible. Default true.' },
                  },
                  required: ['type'],
                  additionalProperties: false,
                },
                description: 'Ordered steps. Step params are flat on each step object.',
              },
            },
            required: ['steps'],
            additionalProperties: false,
          },
          description: 'Ordered list of action batches.',
        },
        stepTimeoutMs: {
          type: 'number',
          description: 'Per-step timeout in ms. Default 5000. Range 500–30000.',
        },
      },
      required: ['actions'],
      additionalProperties: false,
    },
  },
  request_user_assistance: {
    name: 'request_user_assistance',
    description:
      'Show an in-page dialog asking the user to perform a manual action. Useful when automation cannot accomplish a step.',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Message to display to the user.' },
        timeoutMs: {
          type: 'number',
          description: 'Dialog timeout in ms. Default 300000 (5 min). Max 600000.',
        },
      },
      required: ['message'],
      additionalProperties: false,
    },
  },

  run_js: {
    name: 'run_js',
    description:
      'Diagnostic fallback. Execute a JS function in the page MAIN world and return a JSON-serializable result. Use for tricky DOM, portal, or internal state checks (Redux/Vuex, localStorage, computed styles). Do not use for ordinary clicks or typing.',
    parameters: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description:
            'A JS function body (arrow or function). It is executed via `new Function()` in the page. Must return a JSON-serializable value.',
        },
        timeout: {
          type: 'number',
          description: 'Execution timeout in ms. Default 30000. Max 120000.',
        },
      },
      required: ['code'],
      additionalProperties: false,
    },
  },

  take_visible_screenshot: {
    name: 'take_visible_screenshot',
    description:
      'Capture the current viewport as a base64 image. Use grid:true only when visual grid coordinates would help target a hard-to-locate element.',
    parameters: {
      type: 'object',
      properties: {
        grid: {
          type: 'boolean',
          description: 'If true, overlay a labeled grid on the screenshot for coordinate-based targeting.',
        },
      },
      additionalProperties: false,
    },
  },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return a fresh array of tool definitions for all registered BrowserActionName values.
 * Order matches BrowserActionName union declaration.
 */
export function createBrowserToolDefinitions(): BrowserToolDefinition[] {
  return Object.values(DEFINITIONS);
}

/**
 * Look up a single tool definition by name.
 * Returns undefined for names that are not a valid BrowserActionName.
 */
export function getBrowserToolDefinition(
  name: string,
): BrowserToolDefinition | undefined {
  return DEFINITIONS[name as BrowserActionName];
}

/**
 * Type-guard / lookup: returns true if the string matches a known browser tool name.
 */
export function isBrowserToolName(name: string): name is BrowserActionName {
  return name in DEFINITIONS;
}
