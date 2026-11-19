/**
 * Design spec documents (DESIGN.md). Files live under
 * `<projectDir>/.devtailor/design/<id>.md`; metadata is kept in the settings
 * table (`design_docs`). The id is always server-generated (uuid) and
 * validated before touching the filesystem, so client-supplied names can never
 * reach a path. Enabled files are handed to the agent as absolute paths only.
 */

import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, realpathSync, unlinkSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { BridgeError } from './errors';

export const DESIGN_DOCS_SETTING_KEY = 'design_docs';
export const MAX_DESIGN_DOC_BYTES = 256 * 1024;
export const MAX_DESIGN_DOCS = 10;
const MAX_NAME_LENGTH = 120;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface DesignDocMeta {
  id: string;
  name: string;
  enabled: boolean;
  size: number;
  updatedAt: number;
  /** When the doc was last enabled; defines the merge order (later wins). */
  enabledAt?: number;
}

export interface DesignDocsStorage {
  load(): DesignDocMeta[] | null;
  save(docs: DesignDocMeta[]): void;
}

export class DesignDocs {
  constructor(
    private readonly projectDir: string,
    private readonly storage: () => DesignDocsStorage | null,
  ) {}

  private get dir(): string {
    let root = resolve(this.projectDir);
    try { root = realpathSync(root); } catch { /* keep resolved path */ }
    return join(root, '.devtailor', 'design');
  }

  private fileOf(id: string): string {
    if (!ID_PATTERN.test(id)) throw new BridgeError(400, 'invalid_design_doc_id', 'Invalid design doc id');
    return join(this.dir, `${id}.md`);
  }

  private store(): DesignDocsStorage {
    const s = this.storage();
    if (!s) throw new BridgeError(503, 'store_unavailable', 'Design docs need a bridge data directory');
    return s;
  }

  private read(): DesignDocMeta[] {
    const raw = this.storage()?.load();
    if (!Array.isArray(raw)) return [];
    return raw.filter(d => d && typeof d.id === 'string' && ID_PATTERN.test(d.id));
  }

  list(): DesignDocMeta[] {
    return this.read();
  }

  add(name: unknown, content: unknown): DesignDocMeta {
    const store = this.store();
    if (typeof content !== 'string' || !content.trim()) {
      throw new BridgeError(400, 'invalid_design_doc', 'content must be a non-empty string');
    }
    // eslint-disable-next-line no-control-regex
    if (content.includes('\0') || content.includes('�')) {
      throw new BridgeError(400, 'invalid_design_doc', 'content must be UTF-8 text');
    }
    const size = Buffer.byteLength(content, 'utf8');
    if (size > MAX_DESIGN_DOC_BYTES) {
      throw new BridgeError(413, 'design_doc_too_large', `Design doc exceeds ${MAX_DESIGN_DOC_BYTES / 1024}KB`);
    }
    // eslint-disable-next-line no-control-regex
    const cleanName = (typeof name === 'string' ? name : '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
    if (!cleanName) throw new BridgeError(400, 'invalid_design_doc', 'name must be a non-empty string');
    const docs = this.read();
    if (docs.length >= MAX_DESIGN_DOCS) {
      throw new BridgeError(409, 'design_doc_limit', `At most ${MAX_DESIGN_DOCS} design docs are allowed`);
    }
    const id = randomUUID();
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.fileOf(id), content, 'utf8');
    const now = Date.now();
    const meta: DesignDocMeta = { id, name: cleanName, enabled: true, size, updatedAt: now, enabledAt: now };
    store.save([...docs, meta]);
    return meta;
  }

  toggle(id: unknown, enabled: unknown): DesignDocMeta {
    if (typeof id !== 'string') throw new BridgeError(400, 'invalid_design_doc_id', 'Missing id');
    if (typeof enabled !== 'boolean') throw new BridgeError(400, 'invalid_design_doc', 'enabled must be a boolean');
    this.fileOf(id);
    const store = this.store();
    const docs = this.read();
    const doc = docs.find(d => d.id === id);
    if (!doc) throw new BridgeError(404, 'design_doc_not_found', 'Design doc not found');
    if (enabled && !doc.enabled) doc.enabledAt = Date.now();
    doc.enabled = enabled;
    store.save(docs);
    return doc;
  }

  remove(id: unknown): void {
    if (typeof id !== 'string') throw new BridgeError(400, 'invalid_design_doc_id', 'Missing id');
    const file = this.fileOf(id);
    const store = this.store();
    const docs = this.read();
    if (!docs.some(d => d.id === id)) throw new BridgeError(404, 'design_doc_not_found', 'Design doc not found');
    store.save(docs.filter(d => d.id !== id));
    try { unlinkSync(file); } catch { /* already gone */ }
  }

  /** Absolute paths of enabled docs, in enable order (later entries win). */
  enabledPaths(): string[] {
    return this.read()
      .map((d, i) => ({ d, i }))
      .filter(({ d }) => d.enabled)
      .sort((a, b) => (a.d.enabledAt ?? a.d.updatedAt) - (b.d.enabledAt ?? b.d.updatedAt) || a.i - b.i)
      .map(({ d }) => this.fileOf(d.id))
      .filter(p => existsSync(p));
  }
}
