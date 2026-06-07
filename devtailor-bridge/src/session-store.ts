/**
 * Session Store — SQLite persistence for DisplaySession & DisplayMessage
 *
 * Uses sql.js (pure WASM, zero native compilation) for cross-platform
 * compatibility. The DB is persisted to disk as a single file.
 *
 * Schema:
 *   sessions:  id, client_id, agent_key, title, acp_session_id, created_at, updated_at
 *   messages:  id, session_id, role, type, content, timestamp, extra (JSON)
 *   images:    id, session_id, data_url, filename, created_at
 *   element_targets: id, name, page_pattern, payload_json, created_at, updated_at
 *
 * Images are saved to a separate `images/` folder; the DB only stores
 * the filename reference. The full data URL is reconstructed on load.
 */

import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync } from 'fs';
import { join } from 'path';

// ---------------------------------------------------------------------------
// Types (mirrors ws-server.ts internal types)
// ---------------------------------------------------------------------------

export interface StoredMessage {
  id: string;
  role: string;
  type: string;
  content: string;
  timestamp: number;
  [key: string]: unknown;
}

export interface StoredSession {
  id: string;
  clientId: string;
  agentKey?: string;
  title: string;
  acpSessionId: string | null;
  messages: StoredMessage[];
  createdAt: number;
  updatedAt: number;
}

export interface StoredElementTarget {
  id: string;
  name: string;
  description?: string;
  pagePattern?: string;
  pageUrl?: string;
  payload: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// SessionStore
// ---------------------------------------------------------------------------

export class SessionStore {
  private db!: SqlJsDatabase;
  private dbPath: string;
  private imagesDir: string;
  private dirty = false;
  static readonly DEFAULT_AGENT_KEY = 'claude';

  private constructor(dbPath: string, imagesDir: string) {
    this.dbPath = dbPath;
    this.imagesDir = imagesDir;
  }

  /** Async factory — loads WASM and opens/creates the DB */
  static async create(dataDir: string): Promise<SessionStore> {
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }
    const dbPath = join(dataDir, 'sessions.db');
    const imagesDir = join(dataDir, 'images');
    if (!existsSync(imagesDir)) {
      mkdirSync(imagesDir, { recursive: true });
    }

    const SQL = await initSqlJs();
    const store = new SessionStore(dbPath, imagesDir);

    // Load existing DB or create new
    if (existsSync(dbPath)) {
      const buf = readFileSync(dbPath);
      store.db = new SQL.Database(buf);
    } else {
      store.db = new SQL.Database();
    }

    store.schema();
    return store;
  }

  private schema(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        id            TEXT PRIMARY KEY,
        client_id     TEXT NOT NULL,
        agent_key     TEXT NOT NULL DEFAULT 'claude',
        title         TEXT NOT NULL DEFAULT '新会话',
        acp_session_id TEXT,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
      )
    `);
    this.ensureSessionAgentKeyColumn();
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_sessions_client_agent ON sessions(client_id, agent_key, updated_at)
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS messages (
        id         TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role       TEXT NOT NULL,
        type       TEXT NOT NULL,
        content    TEXT NOT NULL DEFAULT '',
        timestamp  INTEGER NOT NULL,
        extra      TEXT NOT NULL DEFAULT '{}'
      )
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, timestamp)
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS images (
        id         TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        filename   TEXT NOT NULL,
        data_url   TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_images_session ON images(session_id)
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS element_targets (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        description   TEXT NOT NULL DEFAULT '',
        page_pattern  TEXT NOT NULL DEFAULT '',
        page_url      TEXT NOT NULL DEFAULT '',
        payload_json  TEXT NOT NULL DEFAULT '{}',
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
      )
    `);
    this.ensureElementTargetsColumns();
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_element_targets_page ON element_targets(page_pattern, updated_at)
    `);
    this.flush();
  }

  private ensureSessionAgentKeyColumn(): void {
    const info = this.db.exec(`PRAGMA table_info(sessions)`);
    const columns = new Set((info[0]?.values || []).map(row => row[1] as string));
    if (!columns.has('agent_key')) {
      this.db.run(`ALTER TABLE sessions ADD COLUMN agent_key TEXT NOT NULL DEFAULT 'claude'`);
      this.markDirty();
    }
  }

  private ensureElementTargetsColumns(): void {
    const info = this.db.exec(`PRAGMA table_info(element_targets)`);
    const columns = new Set((info[0]?.values || []).map(row => row[1] as string));
    if (!columns.has('payload_json')) {
      this.db.run(`ALTER TABLE element_targets ADD COLUMN payload_json TEXT NOT NULL DEFAULT '{}'`);
      if (columns.has('payload')) {
        this.db.run(`UPDATE element_targets SET payload_json = COALESCE(payload, '{}') WHERE payload_json = '{}'`);
      }
      this.markDirty();
    }
    if (!columns.has('description')) {
      this.db.run(`ALTER TABLE element_targets ADD COLUMN description TEXT NOT NULL DEFAULT ''`);
      this.markDirty();
    }
    if (!columns.has('page_url')) {
      this.db.run(`ALTER TABLE element_targets ADD COLUMN page_url TEXT NOT NULL DEFAULT ''`);
      this.markDirty();
    }
  }

  /** Persist in-memory DB to disk */
  flush(): void {
    const data = this.db.export();
    const buffer = Buffer.from(data);
    writeFileSync(this.dbPath, buffer);
    this.dirty = false;
  }

  /** Mark dirty; call flush() later or rely on close() */
  private markDirty(): void {
    this.dirty = true;
  }

  // ---------------------------------------------------------------------------
  // Session CRUD
  // ---------------------------------------------------------------------------

  createSession(session: StoredSession): void {
    this.db.run(
      `INSERT INTO sessions (id, client_id, agent_key, title, acp_session_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        session.id,
        session.clientId,
        session.agentKey || SessionStore.DEFAULT_AGENT_KEY,
        session.title,
        session.acpSessionId,
        session.createdAt,
        session.updatedAt,
      ],
    );
    this.markDirty();
  }

  updateSession(session: StoredSession): void {
    this.db.run(
      `UPDATE sessions SET agent_key = ?, title = ?, acp_session_id = ?, updated_at = ? WHERE id = ?`,
      [
        session.agentKey || SessionStore.DEFAULT_AGENT_KEY,
        session.title,
        session.acpSessionId,
        session.updatedAt,
        session.id,
      ],
    );
    this.markDirty();
  }

  deleteSession(sessionId: string): void {
    // Delete image files first
    const images = this.queryImages(sessionId);
    for (const img of images) {
      try { unlinkSync(join(this.imagesDir, img.filename)); } catch {}
    }
    // Delete messages then session (sql.js doesn't enforce FK CASCADE)
    this.db.run(`DELETE FROM messages WHERE session_id = ?`, [sessionId]);
    this.db.run(`DELETE FROM images WHERE session_id = ?`, [sessionId]);
    this.db.run(`DELETE FROM sessions WHERE id = ?`, [sessionId]);
    this.markDirty();
  }

  // ---------------------------------------------------------------------------
  // Message operations
  // ---------------------------------------------------------------------------

  /** Insert a new message and update session timestamp */
  addMessage(sessionId: string, msg: StoredMessage): void {
    const extra: Record<string, unknown> = {};
    for (const key of Object.keys(msg)) {
      if (['id', 'role', 'type', 'content', 'timestamp'].includes(key)) continue;
      extra[key] = msg[key];
    }

    this.db.run(
      `INSERT INTO messages (id, session_id, role, type, content, timestamp, extra)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [msg.id, sessionId, msg.role, msg.type, msg.content, msg.timestamp, JSON.stringify(extra)],
    );
    this.db.run(
      `UPDATE sessions SET updated_at = ? WHERE id = ?`,
      [msg.timestamp, sessionId],
    );
    this.markDirty();
  }

  /** Update an existing message (e.g. stream append, tool update) */
  updateMessage(sessionId: string, msg: StoredMessage): void {
    const extra: Record<string, unknown> = {};
    for (const key of Object.keys(msg)) {
      if (['id', 'role', 'type', 'content', 'timestamp'].includes(key)) continue;
      extra[key] = msg[key];
    }

    this.db.run(
      `UPDATE messages SET content = ?, extra = ?, timestamp = ? WHERE id = ?`,
      [msg.content, JSON.stringify(extra), msg.timestamp, msg.id],
    );
    this.db.run(
      `UPDATE sessions SET updated_at = ? WHERE id = ?`,
      [msg.timestamp, sessionId],
    );
    this.markDirty();
  }

  /** Keep only the latest 80 messages per session */
  trimMessages(sessionId: string): void {
    this.db.run(`
      DELETE FROM messages WHERE session_id = ?
        AND id NOT IN (
          SELECT id FROM messages WHERE session_id = ?
          ORDER BY timestamp DESC LIMIT 80
        )
    `, [sessionId, sessionId]);
    this.markDirty();
  }

  // ---------------------------------------------------------------------------
  // Image operations
  // ---------------------------------------------------------------------------

  /** Save image data URL to file, store reference in DB */
  saveImage(sessionId: string, id: string, dataUrl: string): string {
    const filename = `${id}.dat`;
    const filePath = join(this.imagesDir, filename);
    writeFileSync(filePath, dataUrl, 'utf8');

    this.db.run(
      `INSERT INTO images (id, session_id, filename, data_url, created_at) VALUES (?, ?, ?, ?, ?)`,
      [id, sessionId, filename, dataUrl, Date.now()],
    );
    this.markDirty();
    return filename;
  }

  /** Get all image data URLs for a session */
  getImages(sessionId: string): Array<{ id: string; dataUrl: string }> {
    const results = this.db.exec(
      `SELECT id, data_url FROM images WHERE session_id = ? ORDER BY created_at ASC`,
      [sessionId],
    );
    if (!results.length || !results[0].values.length) return [];
    return results[0].values.map(row => ({
      id: row[0] as string,
      dataUrl: row[1] as string,
    }));
  }

  // ---------------------------------------------------------------------------
  // Element target operations
  // ---------------------------------------------------------------------------

  saveElementTarget(target: StoredElementTarget): void {
    this.db.run(
      `INSERT OR REPLACE INTO element_targets
        (id, name, description, page_pattern, page_url, payload_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        target.id,
        target.name,
        target.description || '',
        target.pagePattern || '',
        target.pageUrl || '',
        JSON.stringify(target.payload || {}),
        target.createdAt,
        target.updatedAt,
      ],
    );
    this.markDirty();
  }

  deleteElementTarget(targetId: string): void {
    this.db.run(`DELETE FROM element_targets WHERE id = ?`, [targetId]);
    this.markDirty();
  }

  listElementTargets(): StoredElementTarget[] {
    const results = this.db.exec(
      `SELECT id, name, description, page_pattern, page_url, payload_json, created_at, updated_at
       FROM element_targets ORDER BY updated_at DESC`,
    );
    if (!results.length || !results[0].values.length) return [];
    return results[0].values.map(row => {
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse((row[5] as string) || '{}');
      } catch {}
      return {
        id: row[0] as string,
        name: row[1] as string,
        description: row[2] as string,
        pagePattern: row[3] as string,
        pageUrl: row[4] as string,
        payload,
        createdAt: row[6] as number,
        updatedAt: row[7] as number,
      };
    });
  }

  private queryImages(sessionId: string): Array<{ id: string; filename: string }> {
    const results = this.db.exec(
      `SELECT id, filename FROM images WHERE session_id = ?`,
      [sessionId],
    );
    if (!results.length || !results[0].values.length) return [];
    return results[0].values.map(row => ({
      id: row[0] as string,
      filename: row[1] as string,
    }));
  }

  // ---------------------------------------------------------------------------
  // Query operations
  // ---------------------------------------------------------------------------

  /** List all sessions for a client (without messages) */
  listSessions(clientId: string, agentKey = SessionStore.DEFAULT_AGENT_KEY): StoredSession[] {
    const results = this.db.exec(
      `SELECT id, client_id, agent_key, title, acp_session_id, created_at, updated_at
       FROM sessions WHERE client_id = ? AND agent_key = ? ORDER BY updated_at DESC`,
      [clientId, agentKey],
    );
    if (!results.length || !results[0].values.length) return [];
    return results[0].values.map(row => ({
      id: row[0] as string,
      clientId: row[1] as string,
      agentKey: row[2] as string,
      title: row[3] as string,
      acpSessionId: row[4] as string | null,
      createdAt: row[5] as number,
      updatedAt: row[6] as number,
      messages: [],
    }));
  }

  /** List all sessions across all clients (without messages) */
  listAllSessions(agentKey = SessionStore.DEFAULT_AGENT_KEY): StoredSession[] {
    const results = this.db.exec(
      `SELECT id, client_id, agent_key, title, acp_session_id, created_at, updated_at
       FROM sessions WHERE agent_key = ? ORDER BY updated_at DESC`,
      [agentKey],
    );
    if (!results.length || !results[0].values.length) return [];
    return results[0].values.map(row => ({
      id: row[0] as string,
      clientId: row[1] as string,
      agentKey: row[2] as string,
      title: row[3] as string,
      acpSessionId: row[4] as string | null,
      createdAt: row[5] as number,
      updatedAt: row[6] as number,
      messages: [],
    }));
  }

  /** Get a single session with all messages */
  getSession(sessionId: string): StoredSession | null {
    const results = this.db.exec(
      `SELECT id, client_id, agent_key, title, acp_session_id, created_at, updated_at
       FROM sessions WHERE id = ?`,
      [sessionId],
    );
    if (!results.length || !results[0].values.length) return null;
    const row = results[0].values[0];

    const msgResults = this.db.exec(
      `SELECT id, role, type, content, timestamp, extra
       FROM messages WHERE session_id = ? ORDER BY timestamp ASC`,
      [sessionId],
    );

    const messages: StoredMessage[] = [];
    if (msgResults.length && msgResults[0].values.length) {
      for (const m of msgResults[0].values) {
        const msg: StoredMessage = {
          id: m[0] as string,
          role: m[1] as string,
          type: m[2] as string,
          content: m[3] as string,
          timestamp: m[4] as number,
        };
        try {
          const extra = JSON.parse((m[5] as string) || '{}');
          Object.assign(msg, extra);
        } catch {}
        messages.push(msg);
      }
    }

    return {
      id: row[0] as string,
      clientId: row[1] as string,
      agentKey: row[2] as string,
      title: row[3] as string,
      acpSessionId: row[4] as string | null,
      createdAt: row[5] as number,
      updatedAt: row[6] as number,
      messages,
    };
  }

  /** Load all sessions for a client into memory (used at startup) */
  loadAllSessions(clientId: string, agentKey = SessionStore.DEFAULT_AGENT_KEY): StoredSession[] {
    const sessions = this.listSessions(clientId, agentKey);
    for (const session of sessions) {
      const full = this.getSession(session.id);
      if (full) {
        session.messages = full.messages;
      }
    }
    return sessions;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  close(): void {
    if (this.dirty) this.flush();
    this.db.close();
  }
}
