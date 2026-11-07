/**
 * Shared HTTP/SSE helpers for bridge tests. Every request carries an extension
 * Origin, like the real service worker does, so the request guard lets it pass.
 */

import http from 'node:http';

export const TEST_EXTENSION_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

export type SseStream = {
  next: () => Promise<Record<string, any>>;
  onMessage: (listener: (message: Record<string, any>) => void) => void;
  close: () => void;
};

export interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  json: () => any;
}

/** Low-level request through node:http so Host/Origin can be set freely. */
export function rawRequest(
  port: number,
  opts: { method?: string; path: string; headers?: Record<string, string | undefined>; body?: unknown },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(opts.headers || {})) {
      if (v !== undefined) headers[k] = v;
    }
    const payload = opts.body === undefined
      ? undefined
      : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    if (payload !== undefined) {
      headers['Content-Length'] = String(Buffer.byteLength(payload));
      headers['Content-Type'] ??= 'application/json';
    }
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: opts.method || 'GET',
      path: opts.path,
      headers,
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', c => { text += c; });
      res.on('end', () => resolve({
        status: res.statusCode || 0,
        headers: res.headers,
        text,
        json: () => JSON.parse(text),
      }));
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

export function makeClient(port: number, origin = TEST_EXTENSION_ORIGIN) {
  const baseUrl = `http://127.0.0.1:${port}`;
  const authHeaders = { Origin: origin };

  async function request(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
    const res = await rawRequest(port, { method, path, headers: authHeaders, body });
    return { status: res.status, body: res.json() };
  }

  const postJson = (path: string, body: unknown) => request('POST', path, body);
  const getJson = (path: string) => request('GET', path);
  const deleteJson = (path: string) => request('DELETE', path);
  const postRaw = async (path: string, body: unknown) => {
    const res = await rawRequest(port, { method: 'POST', path, headers: authHeaders, body });
    return { status: res.status, text: res.text };
  };
  const activate = (clientId: string) => postJson('/activate', { clientId, tabId: clientId });

  async function openSse(clientId: string): Promise<SseStream> {
    const req = http.get(`${baseUrl}/events?clientId=${encodeURIComponent(clientId)}`, { headers: authHeaders });
    const queue: Record<string, any>[] = [];
    const listeners: Array<(message: Record<string, any>) => void> = [];
    const waiters: Array<(message: Record<string, any>) => void> = [];
    let buffer = '';

    req.on('response', res => {
      res.setEncoding('utf8');
      res.on('data', chunk => {
        buffer += chunk;
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';
        for (const part of parts) {
          const line = part.split('\n').find(item => item.startsWith('data: '));
          if (!line) continue;
          const msg = JSON.parse(line.slice('data: '.length));
          for (const listener of listeners) listener(msg);
          const waiter = waiters.shift();
          if (waiter) waiter(msg);
          else queue.push(msg);
        }
      });
    });
    req.on('error', () => {});

    return {
      next: () => new Promise(resolve => {
        const msg = queue.shift();
        if (msg) resolve(msg);
        else waiters.push(resolve);
      }),
      onMessage: listener => listeners.push(listener),
      close: () => req.destroy(),
    };
  }

  function collectUntilDone(stream: SseStream, messages: Record<string, unknown>[]): Promise<void> {
    return waitForDoneCount(stream, messages, 1, 5000);
  }

  function waitForDoneCount(
    stream: SseStream,
    messages: Record<string, unknown>[],
    count: number,
    timeoutMs = 10000,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let doneCount = 0;
      const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${count} done/error events`)), timeoutMs);
      stream.onMessage((message) => {
        messages.push(message);
        if (message.type === 'done' || message.type === 'error') {
          doneCount++;
          if (doneCount >= count) {
            clearTimeout(timeout);
            resolve();
          }
        }
      });
    });
  }

  function respondToBrowserActions(stream: SseStream): void {
    stream.onMessage(async message => {
      if (message.type !== 'browser_action') return;
      const action = String(message.action || '');
      const requestId = String(message.requestId || '');
      if (!requestId) return;

      let result: unknown = { ok: true };
      if (action === 'get_page_snapshot') {
        result = {
          title: 'DevTailor Test Page',
          url: 'http://localhost:3000',
          elements: [
            { elementId: 'el_button', role: 'button', label: '保存', rect: { x: 10, y: 20, w: 80, h: 32 } },
          ],
        };
      } else if (action === 'get_console_logs') {
        result = { logs: [{ type: 'warn', text: 'layout shift warning' }] };
      }

      await postJson('/browser-action-result', { requestId, ok: true, result });
    });
  }

  return {
    baseUrl,
    postJson,
    postRaw,
    getJson,
    deleteJson,
    activate,
    openSse,
    collectUntilDone,
    waitForDoneCount,
    respondToBrowserActions,
  };
}

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
