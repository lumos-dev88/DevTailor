/**
 * Session Store — Unit Tests
 *
 * Tests SQLite persistence for DisplaySession & DisplayMessage.
 * Uses a temporary directory that is cleaned up after each test.
 *
 * Run: npx tsx --test test/session-store.test.ts
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import initSqlJs from 'sql.js';
import { SessionStore, StoredSession, StoredMessage } from '../src/session-store';

describe('SessionStore', () => {
  let store: SessionStore;
  let tmpDir: string;

  before(async () => {
    tmpDir = join(process.cwd(), '.test-tmp-session-store');
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
    store = await SessionStore.create(tmpDir);
  });

  after(() => {
    store.close();
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  // -------------------------------------------------------------------------
  // Schema initialization
  // -------------------------------------------------------------------------
  describe('schema', () => {
    it('should create sessions.db file', () => {
      assert.ok(existsSync(join(tmpDir, 'sessions.db')));
    });

    it('should create images directory', () => {
      assert.ok(existsSync(join(tmpDir, 'images')));
    });

    it('migrates legacy sessions without agent_key to claude', async () => {
      const legacyDir = join(process.cwd(), '.test-tmp-session-store-legacy');
      if (existsSync(legacyDir)) rmSync(legacyDir, { recursive: true });
      mkdirSync(legacyDir, { recursive: true });

      const SQL = await initSqlJs();
      const legacyDb = new SQL.Database();
      legacyDb.run(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          client_id TEXT NOT NULL,
          title TEXT NOT NULL DEFAULT '新会话',
          acp_session_id TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      legacyDb.run(`
        INSERT INTO sessions (id, client_id, title, acp_session_id, created_at, updated_at)
        VALUES ('dt_legacy', 'tab_legacy', 'Legacy', 'acp_legacy', 1, 2)
      `);
      writeFileSync(join(legacyDir, 'sessions.db'), Buffer.from(legacyDb.export()));
      legacyDb.close();

      const legacyStore = await SessionStore.create(legacyDir);
      const sessions = legacyStore.listSessions('tab_legacy', 'claude');
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0].id, 'dt_legacy');
      assert.equal(sessions[0].agentKey, 'claude');
      legacyStore.close();
      rmSync(legacyDir, { recursive: true });
    });

    it('migrates legacy element_targets without payload_json', async () => {
      const legacyDir = join(process.cwd(), '.test-tmp-session-store-element-targets-legacy');
      if (existsSync(legacyDir)) rmSync(legacyDir, { recursive: true });
      mkdirSync(legacyDir, { recursive: true });

      const SQL = await initSqlJs();
      const legacyDb = new SQL.Database();
      legacyDb.run(`
        CREATE TABLE element_targets (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          page_pattern TEXT NOT NULL DEFAULT '',
          payload TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      legacyDb.run(`
        INSERT INTO element_targets (id, name, page_pattern, payload, created_at, updated_at)
        VALUES ('target_legacy', 'Legacy Button', 'http://localhost:5173/', '{"selector":"button"}', 1, 2)
      `);
      writeFileSync(join(legacyDir, 'sessions.db'), Buffer.from(legacyDb.export()));
      legacyDb.close();

      const legacyStore = await SessionStore.create(legacyDir);
      const targets = legacyStore.listElementTargets();
      assert.equal(targets.length, 1);
      assert.equal(targets[0].id, 'target_legacy');
      assert.equal(targets[0].name, 'Legacy Button');
      assert.deepEqual(targets[0].payload, { selector: 'button' });
      legacyStore.close();
      rmSync(legacyDir, { recursive: true });
    });
  });

  // -------------------------------------------------------------------------
  // Session CRUD
  // -------------------------------------------------------------------------
  describe('session CRUD', () => {
    const session: StoredSession = {
      id: 'dt_test-001',
      clientId: 'tab_123',
      title: '测试会话',
      acpSessionId: 'acp_001',
      messages: [],
      createdAt: 1000000,
      updatedAt: 1000000,
    };

    it('createSession + getSession round-trip', () => {
      store.createSession(session);
      const loaded = store.getSession(session.id);
      assert.ok(loaded);
      assert.equal(loaded!.id, session.id);
      assert.equal(loaded!.clientId, session.clientId);
      assert.equal(loaded!.agentKey, 'claude');
      assert.equal(loaded!.title, session.title);
      assert.equal(loaded!.acpSessionId, session.acpSessionId);
      assert.equal(loaded!.createdAt, session.createdAt);
      assert.equal(loaded!.messages.length, 0);
    });

    it('updateSession changes title and acpSessionId', () => {
      const updated: StoredSession = {
        ...session,
        title: '更新后的标题',
        acpSessionId: 'acp_002',
        updatedAt: 2000000,
      };
      store.updateSession(updated);
      const loaded = store.getSession(session.id);
      assert.equal(loaded!.title, '更新后的标题');
      assert.equal(loaded!.acpSessionId, 'acp_002');
      assert.equal(loaded!.updatedAt, 2000000);
    });

    it('listSessions returns sessions sorted by updatedAt DESC', () => {
      const s2: StoredSession = {
        id: 'dt_test-002',
        clientId: 'tab_123',
        title: '较新的会话',
        acpSessionId: null,
        messages: [],
        createdAt: 3000000,
        updatedAt: 3000000,
      };
      store.createSession(s2);
      const list = store.listSessions('tab_123');
      assert.equal(list.length, 2);
      assert.equal(list[0].id, 'dt_test-002'); // newer first
      assert.equal(list[1].id, 'dt_test-001');
    });

    it('listSessions filters by agentKey', () => {
      store.createSession({
        id: 'dt_agent_gemini',
        clientId: 'tab_123',
        agentKey: 'gemini',
        title: 'Gemini 会话',
        acpSessionId: null,
        messages: [],
        createdAt: 3500000,
        updatedAt: 3500000,
      });

      const claudeList = store.listSessions('tab_123', 'claude');
      assert.ok(!claudeList.some(item => item.id === 'dt_agent_gemini'));

      const geminiList = store.listSessions('tab_123', 'gemini');
      assert.equal(geminiList.length, 1);
      assert.equal(geminiList[0].id, 'dt_agent_gemini');

      store.deleteSession('dt_agent_gemini');
    });

    it('deleteSession removes session and its messages', () => {
      // Add a message first
      const msg: StoredMessage = {
        id: 'msg_del_001',
        role: 'user',
        type: 'text',
        content: '待删除的消息',
        timestamp: 4000000,
      };
      store.addMessage('dt_test-001', msg);

      // Delete session
      store.deleteSession('dt_test-001');

      // Verify session is gone
      const loaded = store.getSession('dt_test-001');
      assert.equal(loaded, null);

      // Verify list no longer includes it
      const list = store.listSessions('tab_123');
      assert.equal(list.length, 1);
      assert.equal(list[0].id, 'dt_test-002');
    });
  });

  // -------------------------------------------------------------------------
  // Message operations
  // -------------------------------------------------------------------------
  describe('message operations', () => {
    const sessionId = 'dt_test-002';

    it('addMessage inserts and retrieves correctly', () => {
      const msg: StoredMessage = {
        id: 'msg_001',
        role: 'user',
        type: 'text',
        content: '你好世界',
        timestamp: 5000001,
      };
      store.addMessage(sessionId, msg);

      const session = store.getSession(sessionId);
      assert.equal(session!.messages.length, 1);
      assert.equal(session!.messages[0].id, 'msg_001');
      assert.equal(session!.messages[0].content, '你好世界');
    });

    it('addMessage preserves extra fields in JSON', () => {
      const msg: StoredMessage = {
        id: 'msg_002',
        role: 'assistant',
        type: 'tool',
        content: '',
        toolCallId: 'tool_001',
        title: 'Read File',
        kind: 'read',
        status: 'running',
        timestamp: 5000002,
      };
      store.addMessage(sessionId, msg);

      const session = store.getSession(sessionId);
      const loaded = session!.messages.find(m => m.id === 'msg_002');
      assert.ok(loaded);
      assert.equal(loaded!.toolCallId, 'tool_001');
      assert.equal(loaded!.title, 'Read File');
      assert.equal(loaded!.kind, 'read');
      assert.equal(loaded!.status, 'running');
    });

    it('updateMessage modifies content and extra fields', () => {
      const updated: StoredMessage = {
        id: 'msg_002',
        role: 'assistant',
        type: 'tool',
        content: 'file content here',
        status: 'completed',
        output: '42 lines',
        timestamp: 5000003,
      };
      store.updateMessage(sessionId, updated);

      const session = store.getSession(sessionId);
      const loaded = session!.messages.find(m => m.id === 'msg_002');
      assert.equal(loaded!.content, 'file content here');
      assert.equal(loaded!.status, 'completed');
      assert.equal(loaded!.output, '42 lines');
    });

    it('messages are ordered by timestamp ASC', () => {
      // msg_001 (5000001) should come before msg_002 (5000002)
      const session = store.getSession(sessionId);
      assert.equal(session!.messages[0].id, 'msg_001');
      assert.equal(session!.messages[1].id, 'msg_002');
    });

    it('trimMessages keeps only latest 80 messages', () => {
      // Create a session with 85 messages
      const trimSessionId = 'dt_test-trim';
      store.createSession({
        id: trimSessionId,
        clientId: 'tab_trim',
        title: 'Trim Test',
        acpSessionId: null,
        messages: [],
        createdAt: 6000000,
        updatedAt: 6000000,
      });

      for (let i = 0; i < 85; i++) {
        store.addMessage(trimSessionId, {
          id: `msg_trim_${String(i).padStart(3, '0')}`,
          role: i % 2 === 0 ? 'user' : 'assistant',
          type: 'text',
          content: `Message ${i}`,
          timestamp: 6000001 + i,
        });
      }

      // Trim to 80
      store.trimMessages(trimSessionId);

      const session = store.getSession(trimSessionId);
      assert.equal(session!.messages.length, 80);
      // First message should be msg_trim_005 (index 5, the 6th message)
      assert.equal(session!.messages[0].id, 'msg_trim_005');
      // Last message should be msg_trim_084 (index 84)
      assert.equal(session!.messages[79].id, 'msg_trim_084');

      // Cleanup
      store.deleteSession(trimSessionId);
    });

    it('addMessage updates session updatedAt', () => {
      const sessionBefore = store.getSession(sessionId);
      const tsBefore = sessionBefore!.updatedAt;

      store.addMessage(sessionId, {
        id: 'msg_ts_update',
        role: 'user',
        type: 'text',
        content: 'timestamp test',
        timestamp: 9999999,
      });

      const sessionAfter = store.getSession(sessionId);
      assert.equal(sessionAfter!.updatedAt, 9999999);
    });
  });

  // -------------------------------------------------------------------------
  // Image operations
  // -------------------------------------------------------------------------
  describe('image operations', () => {
    const sessionId = 'dt_test-002';

    it('saveImage writes file and stores reference', () => {
      const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
      const filename = store.saveImage(sessionId, 'img_001', dataUrl);

      // File should exist
      assert.ok(existsSync(join(tmpDir, 'images', filename)));
      // File content should match
      const content = readFileSync(join(tmpDir, 'images', filename), 'utf8');
      assert.equal(content, dataUrl);
    });

    it('getImages returns data URLs', () => {
      const images = store.getImages(sessionId);
      assert.equal(images.length, 1);
      assert.equal(images[0].id, 'img_001');
      assert.equal(images[0].dataUrl, 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==');
    });

    it('deleteSession cleans up image files', () => {
      store.deleteSession(sessionId);
      // Image file should be deleted
      const imagesDir = join(tmpDir, 'images');
      const files = readdirSync(imagesDir);
      assert.equal(files.length, 0);
    });
  });

  // -------------------------------------------------------------------------
  // loadAllSessions (startup restore)
  // -------------------------------------------------------------------------
  describe('loadAllSessions', () => {
    it('loads all sessions with messages for a clientId', () => {
      // Create fresh sessions
      store.createSession({
        id: 'dt_load_1',
        clientId: 'tab_load',
        title: '会话1',
        acpSessionId: null,
        messages: [],
        createdAt: 7000000,
        updatedAt: 7000000,
      });
      store.addMessage('dt_load_1', {
        id: 'msg_load_1',
        role: 'user',
        type: 'text',
        content: '消息1',
        timestamp: 7000001,
      });

      store.createSession({
        id: 'dt_load_2',
        clientId: 'tab_load',
        title: '会话2',
        acpSessionId: null,
        messages: [],
        createdAt: 7000010,
        updatedAt: 7000010,
      });
      store.addMessage('dt_load_2', {
        id: 'msg_load_2',
        role: 'assistant',
        type: 'stream',
        content: '回复2',
        timestamp: 7000011,
      });

      const sessions = store.loadAllSessions('tab_load');
      assert.equal(sessions.length, 2);
      // listSessions returns sorted by updatedAt DESC, so dt_load_2 comes first
      assert.equal(sessions[0].messages.length, 1);
      assert.equal(sessions[0].messages[0].content, '回复2');
      assert.equal(sessions[1].messages.length, 1);
      assert.equal(sessions[1].messages[0].content, '消息1');

      // Cleanup
      store.deleteSession('dt_load_1');
      store.deleteSession('dt_load_2');
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------
  describe('edge cases', () => {
    it('getSession returns null for non-existent session', () => {
      const result = store.getSession('non_existent');
      assert.equal(result, null);
    });

    it('updateMessage on non-existent message is a no-op (no throw)', () => {
      // Should not throw
      store.updateMessage('non_existent', {
        id: 'ghost_msg',
        role: 'user',
        type: 'text',
        content: 'ghost',
        timestamp: 1,
      });
    });

    it('deleteSession on non-existent session is a no-op (no throw)', () => {
      // Should not throw
      store.deleteSession('non_existent');
    });

    it('handles unicode content correctly', () => {
      store.createSession({
        id: 'dt_unicode',
        clientId: 'tab_unicode',
        title: '🧪 Unicode 测试 🎌',
        acpSessionId: null,
        messages: [],
        createdAt: 8000000,
        updatedAt: 8000000,
      });
      store.addMessage('dt_unicode', {
        id: 'msg_unicode',
        role: 'user',
        type: 'text',
        content: '你好世界 🌍 こんにちは 한국어',
        timestamp: 8000001,
      });

      const session = store.getSession('dt_unicode');
      assert.equal(session!.title, '🧪 Unicode 测试 🎌');
      assert.equal(session!.messages[0].content, '你好世界 🌍 こんにちは 한국어');

      store.deleteSession('dt_unicode');
    });

    it('handles large content (100KB text)', () => {
      store.createSession({
        id: 'dt_large',
        clientId: 'tab_large',
        title: '大内容测试',
        acpSessionId: null,
        messages: [],
        createdAt: 9000000,
        updatedAt: 9000000,
      });
      const bigContent = 'A'.repeat(100_000);
      store.addMessage('dt_large', {
        id: 'msg_large',
        role: 'assistant',
        type: 'stream',
        content: bigContent,
        timestamp: 9000001,
      });

      const session = store.getSession('dt_large');
      assert.equal(session!.messages[0].content.length, 100_000);

      store.deleteSession('dt_large');
    });
  });
});
