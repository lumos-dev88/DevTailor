/**
 * claude-plugin/hooks: the Claude Code hook that reports "what Claude is doing"
 * to the local DevTailor Bridge.
 *
 * The hook script is shipped as a single CommonJS file with no dependencies, so
 * these tests drive it exactly as Claude Code does: spawn `node report.cjs`,
 * write the hook JSON on stdin, and observe what reaches a fake /agent-status
 * server. Nothing here imports devtailor-bridge/src.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const REPORT = join(__dirname, '..', '..', 'claude-plugin', 'hooks', 'report.cjs');
const HOOKS_JSON = join(__dirname, '..', '..', 'claude-plugin', 'hooks', 'hooks.json');
const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

interface Captured {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function startServer(
  handler?: (req: Captured, res: ServerResponse) => void,
): Promise<{ server: Server; port: number; requests: Captured[]; setHandler: (h: (req: Captured, res: ServerResponse) => void) => void }> {
  const requests: Captured[] = [];
  let current = handler ?? defaultHandler;
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const captured: Captured = { method: req.method || '', url: req.url || '', headers: req.headers, body };
      requests.push(captured);
      current(captured, res);
    });
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no port'));
      resolve({ server, port: address.port, requests, setHandler: h => { current = h; } });
    });
  });
}

function defaultHandler(_req: Captured, res: ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end('{"ok":true}');
}

function runHook(payload: unknown, env: Record<string, string>): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [REPORT], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.on('error', () => {});
    child.stdin.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  });
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function makeProject(token: string | null): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'devtailor-hook-'));
  if (token !== null) {
    await mkdir(join(dir, '.devtailor'), { recursive: true });
    await writeFile(join(dir, '.devtailor', 'agent-hook-token'), `${token}\n`, { mode: 0o600 });
  }
  return dir;
}

describe('claude-plugin/hooks/report.cjs', () => {
  let port: number;
  let server: Server;
  let requests: Captured[];
  let setHandler: (h: (req: Captured, res: ServerResponse) => void) => void;
  let projectDir: string;
  const dirs: string[] = [];

  const env = () => ({ CLAUDE_PROJECT_DIR: projectDir, DEVTAILOR_PORT: String(port) });
  const payload = (extra: Record<string, unknown>) => ({
    session_id: 'sess-1',
    transcript_path: '/tmp/transcript.jsonl',
    cwd: projectDir,
    ...extra,
  });
  const lastBody = () => {
    assert.ok(requests.length > 0, 'no request reached /agent-status');
    return JSON.parse(requests[requests.length - 1].body);
  };

  before(async () => {
    const started = await startServer();
    server = started.server;
    port = started.port;
    requests = started.requests;
    setHandler = started.setHandler;
    projectDir = await makeProject(TOKEN);
    dirs.push(projectDir);
  });

  after(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('posts to /agent-status with the bearer token and no Origin', async () => {
    requests.length = 0;
    const run = await runHook(payload({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'npm run build' },
      tool_use_id: 'toolu_01',
    }), env());

    assert.strictEqual(run.code, 0);
    assert.strictEqual(run.stdout, '');
    assert.strictEqual(run.stderr, '');
    assert.strictEqual(requests.length, 1);
    const req = requests[0];
    assert.strictEqual(req.method, 'POST');
    assert.strictEqual(req.url, '/agent-status');
    assert.strictEqual(req.headers.authorization, `Bearer ${TOKEN}`);
    assert.strictEqual(req.headers.origin, undefined);
    assert.match(String(req.headers['content-type']), /^application\/json/);
    assert.deepStrictEqual(JSON.parse(req.body), {
      event: 'PreToolUse',
      toolName: 'Bash',
      label: 'Bash: npm run build',
      toolUseId: 'toolu_01',
    });
  });

  it('redacts secrets in Bash commands and clips them to 60 characters', async () => {
    requests.length = 0;
    const run = await runHook(payload({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: {
        command: 'curl -H "Authorization: Bearer abc123" https://x.test/?api_key=deadbeefdeadbeef\nsecond line\nthird',
      },
    }), env());
    assert.strictEqual(run.code, 0);
    const label = lastBody().label as string;
    assert.match(label, /^Bash: /);
    assert.ok(!label.includes('abc123'), label);
    assert.ok(!label.includes('deadbeefdeadbeef'), label);
    assert.ok(!label.includes('second line'), 'only the first line is reported');
    assert.ok(!/[\n\r\u0000-\u001f]/.test(label), `control characters left in label: ${JSON.stringify(label)}`);
    assert.ok(label.length <= 'Bash: '.length + 60, label);
  });

  it('redacts sk- style keys and honours the 60-character cap', async () => {
    requests.length = 0;
    await runHook(payload({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: `echo sk-abcdefgh12345678 ${'x'.repeat(200)}` },
    }), env());
    const label = lastBody().label as string;
    assert.ok(!label.includes('sk-abcdefgh12345678'), label);
    assert.match(label, /^Bash: echo \*\*\* /);
    assert.strictEqual(Array.from(label).length, 'Bash: '.length + 60);
  });

  it('uses the basename of the file for Read/Write/Edit', async () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['Read', { file_path: '/Users/someone/project/src/index.ts' }, 'Read index.ts'],
      ['Write', { file_path: '/tmp/a/b/styles.css', content: 'body{}' }, 'Write styles.css'],
      ['Edit', { file_path: '/tmp/pkg/App.tsx', old_string: 'a', new_string: 'b' }, 'Edit App.tsx'],
      ['MultiEdit', { file_path: '/tmp/pkg/App.tsx', edits: [] }, 'MultiEdit App.tsx'],
      ['NotebookEdit', { notebook_path: '/tmp/nb/analysis.ipynb' }, 'NotebookEdit analysis.ipynb'],
    ];
    for (const [toolName, tool_input, expected] of cases) {
      requests.length = 0;
      const run = await runHook(payload({ hook_event_name: 'PreToolUse', tool_name: toolName, tool_input }), env());
      assert.strictEqual(run.code, 0);
      assert.strictEqual(lastBody().label, expected);
      assert.strictEqual(lastBody().toolName, toolName);
    }
  });

  it('reports the pattern (max 40 chars) for Grep/Glob and no other arguments', async () => {
    requests.length = 0;
    await runHook(payload({
      hook_event_name: 'PreToolUse',
      tool_name: 'Grep',
      tool_input: { pattern: 'TODO|FIXME', path: '/Users/someone/private' },
    }), env());
    assert.strictEqual(lastBody().label, 'Grep TODO|FIXME');

    requests.length = 0;
    await runHook(payload({
      hook_event_name: 'PreToolUse',
      tool_name: 'Glob',
      tool_input: { pattern: `${'a'.repeat(80)}`, path: '/Users/someone/private' },
    }), env());
    const label = lastBody().label as string;
    assert.strictEqual(label, `Glob ${'a'.repeat(40)}`);
    assert.ok(!requests[0].body.includes('/Users/someone/private'), 'path must not be reported');
  });

  it('reports a host for WebFetch and a query prefix for WebSearch', async () => {
    requests.length = 0;
    await runHook(payload({
      hook_event_name: 'PreToolUse',
      tool_name: 'WebFetch',
      tool_input: { url: 'https://docs.example.com/a/b?q=1', prompt: 'summarise' },
    }), env());
    assert.strictEqual(lastBody().label, 'WebFetch docs.example.com');

    requests.length = 0;
    await runHook(payload({
      hook_event_name: 'PreToolUse',
      tool_name: 'WebSearch',
      tool_input: { query: 'claude code hooks async' },
    }), env());
    assert.strictEqual(lastBody().label, 'WebSearch claude code hooks async');
  });

  it('prefixes subagent calls with 子代理 and clips the description', async () => {
    requests.length = 0;
    await runHook(payload({
      hook_event_name: 'PreToolUse',
      tool_name: 'Task',
      tool_input: { description: 'Explore the persistence layer', prompt: 'long prompt' },
    }), env());
    assert.strictEqual(lastBody().label, '子代理: Explore the persistence layer');

    requests.length = 0;
    await runHook(payload({
      hook_event_name: 'PreToolUse',
      tool_name: 'Agent',
      tool_input: { description: 'd'.repeat(100) },
    }), env());
    assert.strictEqual(lastBody().label, `子代理: ${'d'.repeat(40)}`);
  });

  it('strips the mcp__<server>__ prefix and never leaks MCP arguments', async () => {
    requests.length = 0;
    await runHook(payload({
      hook_event_name: 'PreToolUse',
      tool_name: 'mcp__devtailor__run_js',
      tool_input: { code: 'document.cookie', secret: 'do-not-report' },
    }), env());
    const body = lastBody();
    assert.strictEqual(body.toolName, 'mcp__devtailor__run_js');
    assert.strictEqual(body.label, 'run_js');
    assert.ok(!requests[0].body.includes('document.cookie'), requests[0].body);
    assert.ok(!requests[0].body.includes('do-not-report'), requests[0].body);
  });

  it('always uses the fixed label for Notification and never the message text', async () => {
    requests.length = 0;
    const run = await runHook(payload({
      hook_event_name: 'Notification',
      message: 'Claude needs your permission to use Bash',
    }), env());
    assert.strictEqual(run.code, 0);
    assert.strictEqual(lastBody().event, 'Notification');
    assert.strictEqual(lastBody().label, '等待你的确认');
    assert.ok(!requests[0].body.includes('needs your permission'));
  });

  it('reports Stop / SubagentStop / UserPromptSubmit / PostToolUse and unknown tools by name', async () => {
    for (const event of ['UserPromptSubmit', 'Stop', 'SubagentStop']) {
      requests.length = 0;
      const run = await runHook(payload({ hook_event_name: event, prompt: 'do the thing' }), env());
      assert.strictEqual(run.code, 0);
      assert.strictEqual(lastBody().event, event);
      assert.strictEqual(lastBody().toolName, undefined);
    }

    requests.length = 0;
    await runHook(payload({
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash',
      tool_input: { command: 'false' },
      tool_use_id: 'toolu_02',
      error: 'exit code 1',
    }), env());
    assert.strictEqual(lastBody().event, 'PostToolUseFailure');
    assert.strictEqual(lastBody().label, 'Bash: false');

    requests.length = 0;
    await runHook(payload({ hook_event_name: 'PreToolUse', tool_name: 'TodoWrite', tool_input: { todos: [] } }), env());
    assert.strictEqual(lastBody().label, 'TodoWrite');
  });

  it('falls back to payload.cwd when CLAUDE_PROJECT_DIR is unset', async () => {
    const dir = await makeProject(TOKEN);
    dirs.push(dir);
    requests.length = 0;
    const run = await runHook({ hook_event_name: 'Stop', cwd: dir }, { CLAUDE_PROJECT_DIR: '', DEVTAILOR_PORT: String(port) });
    assert.strictEqual(run.code, 0);
    assert.strictEqual(requests.length, 1);
    assert.strictEqual(lastBody().event, 'Stop');
  });

  it('stays silent when the token file is missing', async () => {
    const dir = await makeProject(null);
    dirs.push(dir);
    requests.length = 0;
    const run = await runHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } },
      { CLAUDE_PROJECT_DIR: dir, DEVTAILOR_PORT: String(port) });
    assert.strictEqual(run.code, 0);
    assert.strictEqual(run.stdout, '');
    assert.strictEqual(run.stderr, '');
    await sleep(150);
    assert.strictEqual(requests.length, 0);
  });

  it('exits 0 with empty output on 401', async () => {
    setHandler((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end('{"ok":false}');
    });
    try {
      requests.length = 0;
      const run = await runHook(payload({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }), env());
      assert.strictEqual(run.code, 0);
      assert.strictEqual(run.stdout, '');
      assert.strictEqual(run.stderr, '');
    } finally {
      setHandler(defaultHandler);
    }
  });

  it('exits 0 with empty output when the server hangs (1.5s timeout)', async () => {
    setHandler(() => { /* never respond */ });
    try {
      const started = Date.now();
      const run = await runHook(payload({ hook_event_name: 'Stop' }), env());
      const elapsed = Date.now() - started;
      assert.strictEqual(run.code, 0);
      assert.strictEqual(run.stdout, '');
      assert.strictEqual(run.stderr, '');
      assert.ok(elapsed < 5000, `hook took ${elapsed}ms`);
    } finally {
      setHandler(defaultHandler);
    }
  });

  it('exits 0 with empty output when the connection is refused', async () => {
    const closed = await startServer();
    const deadPort = closed.port;
    await new Promise<void>(resolve => closed.server.close(() => resolve()));
    const run = await runHook(payload({ hook_event_name: 'Stop' }), {
      CLAUDE_PROJECT_DIR: projectDir,
      DEVTAILOR_PORT: String(deadPort),
    });
    assert.strictEqual(run.code, 0);
    assert.strictEqual(run.stdout, '');
    assert.strictEqual(run.stderr, '');
  });

  it('exits 0 with empty output on invalid stdin and never prints the token', async () => {
    const run = await runHook('not json at all', env());
    assert.strictEqual(run.code, 0);
    assert.strictEqual(run.stdout, '');
    assert.strictEqual(run.stderr, '');
    assert.ok(!run.stdout.includes(TOKEN) && !run.stderr.includes(TOKEN));
  });
});

describe('claude-plugin/hooks/hooks.json', () => {
  const EVENTS = [
    'PreToolUse',
    'PostToolUse',
    'PostToolUseFailure',
    'UserPromptSubmit',
    'Notification',
    'Stop',
    'SubagentStop',
  ];
  const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure']);

  let config: any;
  before(async () => {
    config = JSON.parse(await readFile(HOOKS_JSON, 'utf8'));
  });

  it('registers exactly the seven required events', () => {
    assert.ok(config.hooks && typeof config.hooks === 'object');
    assert.deepStrictEqual(Object.keys(config.hooks).sort(), [...EVENTS].sort());
  });

  it('runs report.cjs for every event with a 2s timeout', () => {
    for (const event of EVENTS) {
      const entries = config.hooks[event];
      assert.ok(Array.isArray(entries) && entries.length > 0, `${event} has no matcher entries`);
      const commands = entries.flatMap((entry: any) => entry.hooks ?? []);
      assert.ok(commands.length > 0, `${event} has no hooks`);
      for (const hook of commands) {
        assert.strictEqual(hook.type, 'command', `${event} hook type`);
        assert.strictEqual(hook.command, 'node "${CLAUDE_PLUGIN_ROOT}/hooks/report.cjs"', `${event} command`);
        assert.strictEqual(hook.timeout, 2, `${event} timeout`);
      }
    }
  });

  it('uses matcher "*" for the tool events only', () => {
    for (const event of EVENTS) {
      const entries = config.hooks[event];
      if (TOOL_EVENTS.has(event)) {
        for (const entry of entries) assert.strictEqual(entry.matcher, '*', `${event} matcher`);
      }
    }
  });

  it('points at a hooks.json next to a report.cjs that exists', async () => {
    assert.strictEqual(dirname(HOOKS_JSON), dirname(REPORT));
    assert.ok((await readFile(REPORT, 'utf8')).length > 0);
  });
});
