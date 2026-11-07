import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import { readdir } from 'node:fs/promises';
import { BrowserActionName } from '../src/browser-action-types';
import { createBrowserToolDefinitions } from '../src/browser-tool-definitions';
import { listBrowserMcpTools, NO_ACTIVE_TAB_HINT } from '../src/mcp-browser-tools';
import { imagesDir } from '../src/image-store';
import { WSServer } from '../src/ws-server';
import { makeRig, Rig, TINY_PNG_DATA_URL } from './channel-helpers';

const EXPECTED_ACTIONS: BrowserActionName[] = [
  'take_visible_screenshot', 'get_page_snapshot', 'get_console_logs', 'get_console_message',
  'get_element_targets', 'save_element_target', 'delete_element_target', 'reload_page',
  'click_page', 'type_text', 'fill_text', 'press_key', 'clear_state', 'wait_for_selector',
  'wait_for_text', 'run_actions', 'request_user_assistance', 'run_js',
];

describe('mcp browser tools', () => {
  let rig: Rig | null = null;
  afterEach(async () => {
    await rig?.cleanup();
    rig = null;
  });

  it('registers all 18 browser tools plus reply, with schemas taken from the definitions', async () => {
    rig = await makeRig();
    const { tools } = await rig.client.listTools();
    const names = tools.map(t => t.name).sort();
    assert.deepStrictEqual(names, [...EXPECTED_ACTIONS, 'reply'].sort());
    assert.strictEqual(tools.length, 19);

    const definitions = createBrowserToolDefinitions();
    assert.strictEqual(definitions.length, 18);
    for (const def of definitions) {
      const tool = tools.find(t => t.name === def.name)!;
      assert.strictEqual(tool.description, def.description);
      assert.deepStrictEqual(tool.inputSchema, def.parameters);
      assert.strictEqual(tool.inputSchema.type, 'object');
      assert.strictEqual((tool.inputSchema as any).additionalProperties, false, def.name);
    }
    assert.strictEqual(listBrowserMcpTools().length, 18);
    // Prefixes are added by Claude Code; descriptions must not hard-code them.
    assert.ok(!tools.some(t => String(t.description).includes('mcp__')));
  });

  it('keeps enums from the definitions', async () => {
    rig = await makeRig();
    const { tools } = await rig.client.listTools();
    const logs: any = tools.find(t => t.name === 'get_console_logs')!.inputSchema;
    assert.deepStrictEqual(logs.properties.types.items.enum, ['log', 'warn', 'error', 'info', 'debug']);
  });

  it('forwards arguments to the runner and wraps results as JSON text', async () => {
    const calls: Array<[string, unknown]> = [];
    rig = await makeRig({
      runBrowserAction: async (action, params) => {
        calls.push([action, params]);
        return { requestId: 'r1', ok: true, result: { clicked: true } };
      },
    });
    const res: any = await rig.client.callTool({ name: 'click_page', arguments: { selector: '#go' } });
    assert.deepStrictEqual(calls, [['click_page', { selector: '#go' }]]);
    assert.notStrictEqual(res.isError, true);
    assert.deepStrictEqual(JSON.parse(res.content[0].text), { ok: true, result: { clicked: true } });
  });

  it('turns NO_ACTIVE_TAB into an actionable isError result', async () => {
    rig = await makeRig({
      runBrowserAction: async () => ({
        requestId: '', ok: false, error: { code: 'NO_ACTIVE_TAB', message: 'No active DevTailor tab is connected' },
      }),
    });
    const res: any = await rig.client.callTool({ name: 'get_page_snapshot', arguments: {} });
    assert.strictEqual(res.isError, true);
    const body = JSON.parse(res.content[0].text);
    assert.strictEqual(body.ok, false);
    assert.strictEqual(body.error.code, 'NO_ACTIVE_TAB');
    assert.strictEqual(body.error.hint, NO_ACTIVE_TAB_HINT);
    assert.match(body.error.hint, /接管/);
  });

  it('marks other failures as isError without the takeover hint', async () => {
    rig = await makeRig({
      runBrowserAction: async () => ({
        requestId: 'r', ok: false, error: { code: 'ACTION_TIMEOUT', message: 'timed out' },
      }),
    });
    const res: any = await rig.client.callTool({ name: 'wait_for_text', arguments: { text: 'x' } });
    assert.strictEqual(res.isError, true);
    assert.strictEqual(JSON.parse(res.content[0].text).error.hint, undefined);
  });

  it('returns screenshots as image content and keeps a copy on disk', async () => {
    rig = await makeRig({
      runBrowserAction: async () => ({
        requestId: 'r', ok: true, result: { mimeType: 'image/png', data: TINY_PNG_DATA_URL },
      }),
    });
    const res: any = await rig.client.callTool({ name: 'take_visible_screenshot', arguments: {} });
    assert.strictEqual(res.content.length, 2);
    assert.strictEqual(res.content[1].type, 'image');
    assert.strictEqual(res.content[1].mimeType, 'image/png');
    assert.strictEqual(res.content[1].data, TINY_PNG_DATA_URL.split(',')[1]);
    const text = JSON.parse(res.content[0].text);
    assert.ok(!res.content[0].text.includes('base64'));
    const files = await readdir(imagesDir(rig.dir));
    assert.strictEqual(files.length, 1);
    assert.match(files[0], /^shot-\d+-1\.png$/);
    assert.ok(text.result.data.includes(files[0]));
  });

  it('extracts screenshots nested in run_actions results', async () => {
    rig = await makeRig({
      runBrowserAction: async () => ({
        requestId: 'r', ok: true,
        result: { results: [{ ok: true, type: 'screenshot', screenshot: { label: 'a', mimeType: 'image/png', data: TINY_PNG_DATA_URL } }] },
      }),
    });
    const res: any = await rig.client.callTool({ name: 'run_actions', arguments: { actions: [] } });
    assert.strictEqual(res.content.filter((c: any) => c.type === 'image').length, 1);
    assert.ok(!res.content[0].text.includes('iVBOR'));
  });

  it('handles the element library locally, without an active tab', async () => {
    const web = new WSServer(17899, process.cwd());
    rig = await makeRig({ runBrowserAction: (a, p) => web.runBrowserAction(a, p) });
    try {
      const saved: any = await rig.client.callTool({
        name: 'save_element_target', arguments: { name: 'submit', selector: '#submit' },
      });
      assert.notStrictEqual(saved.isError, true, saved.content[0].text);
      const savedBody = JSON.parse(saved.content[0].text);
      assert.strictEqual(savedBody.ok, true);

      const listed: any = await rig.client.callTool({ name: 'get_element_targets', arguments: {} });
      const targets = JSON.parse(listed.content[0].text).result.targets;
      assert.ok(targets.some((t: any) => t.name === 'submit'));

      const id = targets.find((t: any) => t.name === 'submit').id;
      const removed: any = await rig.client.callTool({ name: 'delete_element_target', arguments: { targetId: id } });
      assert.notStrictEqual(removed.isError, true, removed.content[0].text);

      // A remote action still reports NO_ACTIVE_TAB with the hint.
      const remote: any = await rig.client.callTool({ name: 'get_page_snapshot', arguments: {} });
      assert.strictEqual(remote.isError, true);
      assert.strictEqual(JSON.parse(remote.content[0].text).error.code, 'NO_ACTIVE_TAB');
    } finally {
      web.stop();
    }
  });
});
