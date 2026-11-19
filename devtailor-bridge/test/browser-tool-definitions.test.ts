/**
 * Browser Tool Definitions — Unit Tests
 *
 * Run: npx tsx --test test/browser-tool-definitions.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createBrowserToolDefinitions,
  getBrowserToolDefinition,
  isBrowserToolName,
} from '../src/browser-tool-definitions';
import type { BrowserActionName } from '../src/browser-action-types';

// Complete list from browser-action-types.ts
const ALL_ACTIONS: BrowserActionName[] = [
  'take_visible_screenshot',
  'get_page_snapshot',
  'find_elements',
  'get_console_logs',
  'get_console_message',
  'get_element_targets',
  'save_element_target',
  'delete_element_target',
  'reload_page',
  'click_page',
  'type_text',
  'fill_text',
  'press_key',
  'clear_state',
  'wait_for_selector',
  'wait_for_text',
  'run_actions',
  'request_user_assistance',
  'run_js',
];

describe('createBrowserToolDefinitions', () => {
  it('returns exactly ALL_ACTIONS.length definitions', () => {
    const defs = createBrowserToolDefinitions();
    assert.equal(defs.length, ALL_ACTIONS.length);
  });

  it('covers every BrowserActionName without duplicates', () => {
    const defs = createBrowserToolDefinitions();
    const names = defs.map(d => d.name);
    const unique = new Set(names);
    assert.equal(unique.size, ALL_ACTIONS.length, 'duplicate or missing entries');
    for (const action of ALL_ACTIONS) {
      assert.ok(unique.has(action), `missing definition for: ${action}`);
    }
  });

  it('every definition has name, description, and parameters', () => {
    for (const def of createBrowserToolDefinitions()) {
      assert.ok(def.name, `name missing on ${JSON.stringify(def)}`);
      assert.ok(typeof def.description === 'string' && def.description.length > 10,
        `description too short for ${def.name}`);
      assert.ok(def.parameters && typeof def.parameters === 'object',
        `parameters missing for ${def.name}`);
      assert.equal(def.parameters.type, 'object',
        `parameters.type should be "object" for ${def.name}`);
    }
  });
});

describe('get_page_snapshot', () => {
  it('has no required params', () => {
    const def = getBrowserToolDefinition('get_page_snapshot')!;
    assert.ok(def);
    assert.equal(def.parameters.required, undefined);
  });

  it('exposes the page-side snapshot options', () => {
    const def = getBrowserToolDefinition('get_page_snapshot')!;
    const props = def.parameters.properties as Record<string, Record<string, unknown>>;
    assert.deepEqual(Object.keys(props).sort(), ['level', 'maxElements', 'roles', 'scope', 'selectors', 'viewportOnly']);
    assert.deepEqual(props.level.enum, ['interactive-only', 'summary']);
    assert.equal(props.maxElements.maximum, 200);
    assert.equal(props.scope.type, 'string');
    assert.equal(props.viewportOnly.type, 'boolean');
    assert.match(String(props.scope.description), /elementId|selector/);
    assert.match(String(props.viewportOnly.description), /viewport/i);
  });
});

describe('find_elements', () => {
  it('requires query and bounds maxResults', () => {
    const def = getBrowserToolDefinition('find_elements')!;
    assert.ok(def);
    assert.deepEqual(def.parameters.required, ['query']);
    const props = def.parameters.properties as Record<string, any>;
    assert.equal(props.query.type, 'string');
    assert.equal(props.role.type, 'string');
    assert.equal(props.maxResults.type, 'integer');
    assert.equal(props.maxResults.minimum, 1);
    assert.equal(props.maxResults.maximum, 50);
    assert.match(def.description, /click_page/);
    assert.match(def.description, /cheaper/i);
  });
});

describe('get_console_logs', () => {
  it('supports types and limit params', () => {
    const def = getBrowserToolDefinition('get_console_logs')!;
    const props = def.parameters.properties as Record<string, any>;
    assert.ok(props.types);
    assert.ok(props.types.items.enum.includes('error'));
    assert.ok(props.types.items.enum.includes('warn'));
    assert.ok(props.limit);
  });
});

describe('run_js', () => {
  it('requires code', () => {
    const def = getBrowserToolDefinition('run_js')!;
    assert.deepEqual(def.parameters.required, ['code']);
    const props = def.parameters.properties as Record<string, any>;
    assert.ok(props.code);
    assert.ok(props.timeout);
  });
});

describe('run_actions', () => {
  it('requires actions array with step batches matching the content runner', () => {
    const def = getBrowserToolDefinition('run_actions')!;
    assert.deepEqual(def.parameters.required, ['actions']);
    const props = def.parameters.properties as Record<string, any>;
    const actionProps = props.actions.items.properties;
    assert.ok(actionProps.steps);
    assert.deepEqual(props.actions.items.required, ['steps']);
    const stepProps = actionProps.steps.items.properties;
    assert.ok(Array.isArray(stepProps.type.enum));
    assert.ok(stepProps.type.enum.includes('press_key'));
    assert.ok(stepProps.type.enum.includes('wait_for_selector'));
    assert.ok(stepProps.type.enum.includes('assert_element'));
    assert.ok(stepProps.selector);
    assert.ok(stepProps.text);
    assert.ok(props.stepTimeoutMs);
  });
});

describe('click_page', () => {
  it('supports point and grid sub-params', () => {
    const def = getBrowserToolDefinition('click_page')!;
    const props = def.parameters.properties as Record<string, any>;
    assert.ok(props.point.properties.x);
    assert.ok(props.grid.properties.col);
    // No required params — any locator strategy can be used
    assert.equal(def.parameters.required, undefined);
  });
});

describe('fill_text', () => {
  it('requires text and supports locator props', () => {
    const def = getBrowserToolDefinition('fill_text')!;
    assert.deepEqual(def.parameters.required, ['text']);
    const props = def.parameters.properties as Record<string, any>;
    assert.ok(props.text);
    assert.ok(props.selector);
    assert.ok(props.targetId);
  });
});

describe('wait_for_selector', () => {
  it('requires selector, supports timeoutMs', () => {
    const def = getBrowserToolDefinition('wait_for_selector')!;
    assert.deepEqual(def.parameters.required, ['selector']);
    const props = def.parameters.properties as Record<string, any>;
    assert.ok(props.timeoutMs);
  });
});

describe('wait_for_text', () => {
  it('requires text, supports timeoutMs', () => {
    const def = getBrowserToolDefinition('wait_for_text')!;
    assert.deepEqual(def.parameters.required, ['text']);
    const props = def.parameters.properties as Record<string, any>;
    assert.ok(props.timeoutMs);
  });
});

describe('take_visible_screenshot', () => {
  it('has optional grid param', () => {
    const def = getBrowserToolDefinition('take_visible_screenshot')!;
    const props = def.parameters.properties as Record<string, any>;
    assert.ok(props.grid);
    assert.equal(props.grid.type, 'boolean');
    assert.equal(def.parameters.required, undefined);
  });
});

describe('get_element_targets', () => {
  it('has no required params', () => {
    const def = getBrowserToolDefinition('get_element_targets')!;
    assert.equal(def.parameters.required, undefined);
  });
});

describe('isBrowserToolName', () => {
  it('returns true for every BrowserActionName', () => {
    for (const name of ALL_ACTIONS) {
      assert.ok(isBrowserToolName(name), `should be true for ${name}`);
    }
  });

  it('returns false for unknown names', () => {
    assert.equal(isBrowserToolName('not_a_tool'), false);
    assert.equal(isBrowserToolName(''), false);
    assert.equal(isBrowserToolName('get_page_snapshot_extra'), false);
  });
});

describe('getBrowserToolDefinition', () => {
  it('returns the definition for every BrowserActionName', () => {
    for (const name of ALL_ACTIONS) {
      const def = getBrowserToolDefinition(name);
      assert.ok(def, `should return definition for ${name}`);
      assert.equal(def!.name, name);
    }
  });

  it('returns undefined for unknown names', () => {
    assert.equal(getBrowserToolDefinition('unknown_action'), undefined);
    assert.equal(getBrowserToolDefinition(''), undefined);
  });
});

describe('all definitions have additionalProperties:false', () => {
  it('every tool sets additionalProperties: false', () => {
    for (const def of createBrowserToolDefinitions()) {
      assert.equal(
        (def.parameters as any).additionalProperties,
        false,
        `${def.name} should have additionalProperties: false`,
      );
    }
  });
});
