import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ClaudeChannelHub, ClaudeChannelSession, CANCEL_CONTENT, REPLY_TIMEOUT_MESSAGE } from '../src/claude-channel-session';
import { imagesDir, safeFileBase, saveImage } from '../src/image-store';
import { makeRig, recorder, Rig, REVIEW_PAYLOAD, sleep, TINY_PNG_DATA_URL } from './channel-helpers';

describe('ClaudeChannelSession', () => {
  let rig: Rig | null = null;
  afterEach(async () => {
    await rig?.cleanup();
    rig = null;
  });

  async function startTurn(r: Rig, cb = recorder(), payload: any = REVIEW_PAYLOAD) {
    const session = r.newSession();
    session.setCallbacks(cb);
    await session.start();
    const result = await session.sendReview(payload, { clientId: 'tab-1', displaySessionId: 'd1' });
    await sleep(10);
    const note = r.notifications[r.notifications.length - 1];
    return { session, cb, result, note, turnId: note.params.meta.turn_id };
  }

  it('declares channel + tools capabilities and exposes reply', async () => {
    rig = await makeRig();
    const caps: any = rig.client.getServerCapabilities();
    assert.deepStrictEqual(caps.experimental['claude/channel'], {});
    assert.ok(caps.tools);
    const { tools } = await rig.client.listTools();
    assert.strictEqual(tools.length, 19);
    assert.ok(tools.some(t => t.name === 'reply'));
    assert.match(rig.client.getInstructions() || '', /reply/);
  });

  it('sendReview pushes a channel notification with valid meta and returns pending immediately', async () => {
    rig = await makeRig();
    const { result, note } = await startTurn(rig);
    assert.strictEqual(result, 'pending');
    assert.strictEqual(note.method, 'notifications/claude/channel');
    for (const [key, value] of Object.entries(note.params.meta)) {
      assert.match(key, /^[A-Za-z0-9_]+$/);
      assert.strictEqual(typeof value, 'string');
    }
    assert.strictEqual(note.params.meta.kind, 'review');
    assert.match(note.params.meta.turn_id, /^[a-f0-9]{12}$/);
    assert.strictEqual(note.params.meta.page_url, 'http://localhost:3000/dashboard');
    assert.strictEqual(note.params.meta.client_id, 'tab-1');
    assert.strictEqual(note.params.meta.has_images, 'false');
    assert.ok(note.params.content.includes('http://localhost:3000/dashboard'));
    assert.ok(note.params.content.includes('把按钮改成红色'));
    assert.ok(note.params.content.includes('button.primary'));
    assert.ok(note.params.content.includes('src/SaveButton.tsx'));
  });

  it('reply streams segments with separators and final fires onDone exactly once', async () => {
    rig = await makeRig();
    const { cb, turnId } = await startTurn(rig);
    assert.deepStrictEqual(await rig.callReply({ turn_id: turnId, text: '第一段' }), { isError: false, text: 'sent' });
    await rig.callReply({ text: '第二段' }); // default turn
    const last = await rig.callReply({ turn_id: turnId, text: '结束', final: true });
    assert.deepStrictEqual(last, { isError: false, text: 'sent (final)' });
    assert.strictEqual(cb.streamed, '第一段\n\n第二段\n\n结束');
    assert.strictEqual(cb.events.filter(e => e[0] === 'done').length, 1);

    const again = await rig.callReply({ turn_id: turnId, text: '多余', final: true });
    assert.strictEqual(again.isError, true);
    assert.strictEqual(cb.events.filter(e => e[0] === 'done').length, 1);
    assert.strictEqual(cb.events.filter(e => e[0] === 'stream').length, 3);
  });

  it('final-only reply finishes the turn without streaming', async () => {
    rig = await makeRig();
    const { cb, turnId } = await startTurn(rig);
    const res = await rig.callReply({ turn_id: turnId, text: '', final: true });
    assert.strictEqual(res.isError, false);
    assert.deepStrictEqual(cb.events.map(e => e[0]), ['done']);
  });

  it('reply without an active turn returns an error result instead of throwing', async () => {
    rig = await makeRig();
    const none = await rig.callReply({ text: 'hi' });
    assert.strictEqual(none.isError, true);
    assert.match(none.text, /No browser request/);
    const unknown = await rig.callReply({ turn_id: 'deadbeef', text: 'hi' });
    assert.strictEqual(unknown.isError, true);
    assert.match(unknown.text, /not active/);
    const empty = await rig.callReply({});
    assert.strictEqual(empty.isError, true);
  });

  it('routes replies to the right turn when several are pending', async () => {
    rig = await makeRig();
    const first = await startTurn(rig);
    const second = await startTurn(rig);
    await rig.callReply({ turn_id: first.turnId, text: 'for first', final: true });
    assert.strictEqual(first.cb.streamed, 'for first');
    assert.strictEqual(second.cb.streamed, '');
    await rig.callReply({ text: 'for latest' });
    assert.strictEqual(second.cb.streamed, 'for latest');
  });

  it('reports an error and ends the turn when no final reply arrives in time', async () => {
    rig = await makeRig({ hub: { replyTimeoutMs: 60 } });
    const { cb, turnId } = await startTurn(rig);
    await sleep(150);
    assert.deepStrictEqual(cb.events.filter(e => e[0] === 'error'), [['error', REPLY_TIMEOUT_MESSAGE]]);
    const late = await rig.callReply({ turn_id: turnId, text: 'late' });
    assert.strictEqual(late.isError, true);
    assert.ok(!cb.events.some(e => e[0] === 'done'));
  });

  it('every reply re-arms the timeout', async () => {
    rig = await makeRig({ hub: { replyTimeoutMs: 120 } });
    const { cb, turnId } = await startTurn(rig);
    for (let i = 0; i < 4; i++) {
      await sleep(50);
      await rig.callReply({ turn_id: turnId, text: `p${i}` });
    }
    assert.ok(!cb.events.some(e => e[0] === 'error'));
    await rig.callReply({ turn_id: turnId, text: 'bye', final: true });
  });

  it('cancelCurrentTurn pushes a kind=cancel notification and drops later replies', async () => {
    rig = await makeRig();
    const { session, cb, turnId } = await startTurn(rig);
    assert.strictEqual(await session.cancelCurrentTurn(), true);
    await sleep(10);
    const note = rig.notifications[rig.notifications.length - 1];
    assert.strictEqual(note.params.meta.kind, 'cancel');
    assert.strictEqual(note.params.meta.turn_id, turnId);
    assert.strictEqual(note.params.content, CANCEL_CONTENT);
    const late = await rig.callReply({ turn_id: turnId, text: 'ignored', final: true });
    assert.strictEqual(late.isError, true);
    assert.deepStrictEqual(cb.events, []);
    assert.strictEqual(await session.cancelCurrentTurn(), false); // nothing left to cancel
  });

  it('stopping a session ends its pending turns with done', async () => {
    rig = await makeRig();
    const { session, cb } = await startTurn(rig);
    session.stop();
    assert.deepStrictEqual(cb.events, [['done', 'Session closed']]);
    assert.strictEqual(session.isReady, false);
  });

  it('start() fails while the MCP transport is not connected', async () => {
    rig = await makeRig();
    rig.hub.setReady(false);
    await assert.rejects(() => rig!.newSession().start(), /尚未连接/);
  });

  it('notification write failure calls onError and rejects', async () => {
    const hub = new ClaudeChannelHub({
      projectDir: process.cwd(),
      notify: async () => { throw new Error('pipe closed'); },
    });
    hub.setReady(true);
    const cb = recorder();
    const session = new ClaudeChannelSession(hub);
    session.setCallbacks(cb);
    await assert.rejects(() => session.sendReview(REVIEW_PAYLOAD), /pipe closed/);
    assert.strictEqual(cb.events.filter(e => e[0] === 'error').length, 1);
    assert.deepStrictEqual(hub.activeTurnIds(), []);
  });

  it('shows the no-response hint once, only when Claude shows no sign of life', async () => {
    rig = await makeRig({ hub: { noResponseHintMs: 40 } });
    const quiet = await startTurn(rig);
    await sleep(120);
    assert.strictEqual(quiet.cb.events.filter(e => e[0] === 'notice').length, 1);
    assert.match(String(quiet.cb.events.find(e => e[0] === 'notice')![1]), /dangerously-load-development-channels/);
    const second = await startTurn(rig);
    await sleep(120);
    assert.strictEqual(second.cb.events.filter(e => e[0] === 'notice').length, 0);
    await rig.callReply({ turn_id: quiet.turnId, text: 'x', final: true });
    await rig.callReply({ turn_id: second.turnId, text: 'x', final: true });
  });

  it('does not show the hint when Claude replied in time', async () => {
    rig = await makeRig({ hub: { noResponseHintMs: 60 } });
    const { cb, turnId } = await startTurn(rig);
    await rig.callReply({ turn_id: turnId, text: 'working' });
    await sleep(120);
    assert.strictEqual(cb.events.filter(e => e[0] === 'notice').length, 0);
    await rig.callReply({ turn_id: turnId, text: 'x', final: true });
  });

  describe('screenshots', () => {
    it('writes screenshots under .devtailor/images with controlled names and lists them', async () => {
      rig = await makeRig();
      const { note, turnId } = await startTurn(rig, recorder(), { ...REVIEW_PAYLOAD, screenshots: [TINY_PNG_DATA_URL] });
      const dir = imagesDir(rig.dir);
      const files = await readdir(dir);
      assert.deepStrictEqual(files, [`${turnId}-1.png`]);
      assert.match(files[0], /^[a-f0-9]{12}-\d+\.png$/);
      const file = join(dir, files[0]);
      assert.ok((await stat(file)).size > 0);
      assert.strictEqual((await readFile(file)).subarray(1, 4).toString(), 'PNG');
      assert.ok(note.params.content.includes(file));
      assert.ok(note.params.content.includes('Read tool'));
      assert.strictEqual(note.params.meta.has_images, 'true');
      assert.strictEqual(note.params.meta.image_count, '1');
      assert.strictEqual(note.params.meta.image_paths, file);
      await rig.callReply({ turn_id: turnId, text: 'x', final: true });
    });

    it('skips oversized and unsupported images and says so in the text', async () => {
      rig = await makeRig();
      const huge = `data:image/png;base64,${'A'.repeat(12 * 1024 * 1024)}`; // ~9MB decoded
      const { note, turnId } = await startTurn(rig, recorder(), {
        ...REVIEW_PAYLOAD,
        screenshots: [huge, 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', TINY_PNG_DATA_URL],
      });
      const files = await readdir(imagesDir(rig.dir));
      assert.deepStrictEqual(files, [`${turnId}-3.png`]);
      assert.match(note.params.content, /\(skipped\) screenshot 1: image exceeds 8MB limit/);
      assert.match(note.params.content, /\(skipped\) screenshot 2: unsupported image type/);
      assert.strictEqual(note.params.meta.image_count, '1');
      assert.ok(!note.params.content.includes('AAAAAAAAAA'));
      await rig.callReply({ turn_id: turnId, text: 'x', final: true });
    });

    it('never lets a file name escape the images directory', async () => {
      rig = await makeRig();
      assert.strictEqual(safeFileBase('../../etc/passwd'), '______etc_passwd');
      const saved = await saveImage(rig.dir, '../../evil', TINY_PNG_DATA_URL);
      assert.ok(saved.ok);
      if (saved.ok) assert.strictEqual(saved.path, join(imagesDir(rig.dir), '______evil.png'));
    });
  });
});
