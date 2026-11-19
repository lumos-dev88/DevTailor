import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WSServer } from '../src/ws-server';
import { ClaudeChannelHub, ClaudeChannelSession } from '../src/claude-channel-session';
import { buildPrompt } from '../src/prompt-builder';
import { MAX_DESIGN_DOC_BYTES, MAX_DESIGN_DOCS } from '../src/design-docs';
import { makeClient, sleep } from './helpers';

/**
 * Design docs rig: a plain WSServer whose agent session is the Claude Code
 * channel, so the review prompt that reaches Claude is observable.
 */
async function startRig(port: number) {
  const dir = await mkdtemp(join(tmpdir(), 'devtailor-design-'));
  const prompts: string[] = [];
  let server: WSServer | null = null;
  const hub = new ClaudeChannelHub({
    projectDir: dir,
    // Bound after construction, like src/mcp-main.ts does for the real bridge.
    getDesignDocPaths: () => server?.designDocPaths() ?? [],
    notify: async params => { prompts.push(params.content); },
  });
  hub.setReady(true);
  server = new WSServer(
    port,
    dir,
    join(dir, '.devtailor'),
    'claude',
    'Claude Code',
    () => new ClaudeChannelSession(hub),
  );
  await server.init();
  await server.start();
  const client = makeClient(port);

  return {
    dir,
    port,
    server,
    hub,
    client,
    prompts,
    /** Waits until at least `count` review prompts were handed to Claude; returns prompt #count-1. */
    async promptAt(count: number, timeoutMs = 5000): Promise<string> {
      const started = Date.now();
      while (prompts.length < count) {
        if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for review prompt #${count}`);
        await sleep(15);
      }
      return prompts[count - 1];
    },
    async review(clientId: string, userIntent: string) {
      return client.postJson('/review', {
        type: 'review',
        clientId,
        payload: { pageUrl: 'http://localhost:3000/', userIntent, items: [], screenshot: null },
      });
    },
    async cleanup() {
      hub.stop();
      await server?.shutdown();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

type Rig = Awaited<ReturnType<typeof startRig>>;

describe('design docs routes', () => {
  const rigs: Rig[] = [];
  const start = async () => {
    const rig = await startRig(18171 + rigs.length);
    rigs.push(rig);
    return rig;
  };
  afterEach(async () => {
    for (const rig of rigs.splice(0)) await rig.cleanup();
  });

  it('adds, lists, toggles and deletes docs; files live under .devtailor/design/<uuid>.md', async () => {
    const rig = await start();
    assert.deepStrictEqual((await rig.client.getJson('/design-docs')).body.docs, []);

    const a = await rig.client.postJson('/design-docs', { name: '../../evil.md', content: '# A\n主色 #123456' });
    assert.strictEqual(a.status, 200);
    const idA = a.body.doc.id;
    assert.match(idA, /^[0-9a-f-]{36}$/);
    assert.strictEqual(a.body.doc.enabled, true);
    assert.strictEqual(a.body.doc.size, Buffer.byteLength('# A\n主色 #123456'));
    const dir = join(realpathSync(rig.dir), '.devtailor', 'design');
    assert.deepStrictEqual(readdirSync(dir), [`${idA}.md`]);
    assert.strictEqual(readFileSync(join(dir, `${idA}.md`), 'utf8'), '# A\n主色 #123456');

    const b = await rig.client.postJson('/design-docs', { name: 'B', content: '# B' });
    const idB = b.body.doc.id;
    let list = (await rig.client.getJson('/design-docs')).body;
    assert.deepStrictEqual(list.enabledPaths, [join(dir, `${idA}.md`), join(dir, `${idB}.md`)]);

    // Re-enabling A moves it behind B (enable order, later wins).
    await rig.client.postJson('/design-docs/toggle', { id: idA, enabled: false });
    await sleep(5);
    const t = await rig.client.postJson('/design-docs/toggle', { id: idA, enabled: true });
    assert.strictEqual(t.status, 200);
    list = (await rig.client.getJson('/design-docs')).body;
    assert.deepStrictEqual(list.enabledPaths, [join(dir, `${idB}.md`), join(dir, `${idA}.md`)]);

    const del = await rig.client.postJson('/design-docs/delete', { id: idA });
    assert.strictEqual(del.status, 200);
    assert.ok(!existsSync(join(dir, `${idA}.md`)));
    assert.strictEqual((await rig.client.getJson('/design-docs')).body.docs.length, 1);
    assert.strictEqual((await rig.client.postJson('/design-docs/delete', { id: idA })).body.code, 'design_doc_not_found');
  });

  it('rejects traversal ids and invalid content', async () => {
    const rig = await start();
    for (const id of ['../../etc/passwd', '..', 'abc', '', 5]) {
      const r = await rig.client.postJson('/design-docs/delete', { id });
      assert.strictEqual(r.status, 400);
      const t = await rig.client.postJson('/design-docs/toggle', { id, enabled: true });
      assert.strictEqual(t.status, 400);
    }
    assert.strictEqual((await rig.client.postJson('/design-docs', { name: 'x', content: '' })).status, 400);
    assert.strictEqual((await rig.client.postJson('/design-docs', { name: '', content: 'x' })).status, 400);
    assert.strictEqual((await rig.client.postJson('/design-docs', { name: 'x', content: 'a\0b' })).status, 400);
    assert.strictEqual((await rig.client.postJson('/design-docs', { name: 'x', content: 'bad�' })).status, 400);
    const big = await rig.client.postJson('/design-docs', { name: 'x', content: 'a'.repeat(MAX_DESIGN_DOC_BYTES + 1) });
    assert.strictEqual(big.status, 413);
    assert.strictEqual(big.body.code, 'design_doc_too_large');
    assert.strictEqual((await rig.client.postJson('/design-docs/toggle', { id: 'x'.repeat(36), enabled: 'yes' })).status, 400);
  });

  it('caps the number of docs', async () => {
    const rig = await start();
    for (let i = 0; i < MAX_DESIGN_DOCS; i++) {
      assert.strictEqual((await rig.client.postJson('/design-docs', { name: `d${i}`, content: `# ${i}` })).status, 200);
    }
    const over = await rig.client.postJson('/design-docs', { name: 'extra', content: '# x' });
    assert.strictEqual(over.status, 409);
    assert.strictEqual(over.body.code, 'design_doc_limit');
  });

  it('puts enabled doc paths into the review prompt', async () => {
    const rig = await start();
    const stream = await rig.client.openSse('t');
    await stream.next();
    await rig.client.activate('t');

    const a = await rig.client.postJson('/design-docs', { name: 'A', content: '# A' });
    await rig.client.postJson('/new-session', { clientId: 't' });

    assert.strictEqual((await rig.review('t', 'first')).status, 202);
    const first = await rig.promptAt(1);
    assert.match(first, new RegExp(`## Design Spec\\n- .*${a.body.doc.id}\\.md`));
    rig.hub.handleReply({ text: 'ok', final: true });

    await rig.client.postJson('/design-docs/toggle', { id: a.body.doc.id, enabled: false });

    assert.strictEqual((await rig.review('t', 'second')).status, 202);
    const second = await rig.promptAt(2);
    assert.ok(!second.includes('## Design Spec'));
    rig.hub.handleReply({ text: 'ok', final: true });
    stream.close();
  });
});

describe('buildPrompt design spec section', () => {
  const payload = { pageUrl: 'http://x/', userIntent: 'hi', screenshot: null, items: [] };

  it('omits the section without enabled docs', () => {
    assert.ok(!buildPrompt(payload)[0].text.includes('## Design Spec'));
    assert.ok(!buildPrompt(payload, { designDocPaths: [] })[0].text.includes('## Design Spec'));
  });

  it('lists absolute paths in order at the end, without inlining content', () => {
    const text = buildPrompt(payload, { designDocPaths: ['/p/a.md', '/p/b.md'] })[0].text;
    const section = text.slice(text.indexOf('## Design Spec'));
    assert.ok(text.indexOf('## Design Spec') > text.indexOf('## Marked Elements'));
    assert.ok(section.indexOf('- /p/a.md') < section.indexOf('- /p/b.md'));
    assert.match(section, /Read these design spec files before making changes/);
    assert.match(section, /later file takes precedence/);
    assert.match(section, /keep the existing style/);
  });
});
