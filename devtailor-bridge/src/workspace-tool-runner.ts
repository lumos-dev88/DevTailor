import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { WorkspaceToolName } from './workspace-tool-definitions';

export interface WorkspaceToolResult {
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

export type WorkspaceToolRunner = (
  tool: WorkspaceToolName,
  params?: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<WorkspaceToolResult>;

interface DirEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  mtimeMs: number;
}

const MAX_READ_LINES = 1000;
const MAX_LINE_LENGTH = 2000;
const MAX_READ_BYTES = 100 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
const MAX_COMMAND_TIMEOUT_MS = 300_000;
const DEFAULT_HEAD_LIMIT = 250;
const SKIP_DIRS = new Set([
  '.git',
  '.svn',
  '.hg',
  '.devtailor',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.nuxt',
  'coverage',
]);

export class WorkspaceToolService {
  readonly workspaceDir: string;

  constructor(workspaceDir: string) {
    this.workspaceDir = path.resolve(workspaceDir);
  }

  async run(
    tool: WorkspaceToolName,
    params: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<WorkspaceToolResult> {
    try {
      switch (tool) {
        case 'bash':
          return { ok: true, result: await this.runBash(params, signal) };
        case 'read_file':
          return { ok: true, result: await this.readFile(params) };
        case 'write_file':
          return { ok: true, result: await this.writeFile(params) };
        case 'edit_file':
          return { ok: true, result: await this.editFile(params) };
        case 'grep_files':
          return { ok: true, result: await this.grepFiles(params) };
        case 'glob_files':
          return { ok: true, result: await this.globFiles(params) };
        case 'list_directory':
          return { ok: true, result: await this.listDirectory(params) };
      }
    } catch (error) {
      return {
        ok: false,
        error: {
          code: error instanceof WorkspaceToolError ? error.code : 'WORKSPACE_TOOL_ERROR',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  private async runBash(
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const command = requireString(params, 'command');
    if (!command.trim()) throw new WorkspaceToolError('INVALID_INPUT', 'command cannot be empty');
    const cwd = params.cwd === undefined
      ? this.workspaceDir
      : this.resolveInsideWorkspace(requireString(params, 'cwd'));
    const timeout = normalizeTimeout(params.timeout);

    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new WorkspaceToolError('ABORTED', 'Command aborted before start'));
        return;
      }

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let killed = false;

      const child = spawn('/bin/bash', ['-lc', command], {
        cwd,
        env: {
          ...process.env,
          NO_COLOR: '1',
          TERM: 'dumb',
          GIT_TERMINAL_PROMPT: process.env.GIT_TERMINAL_PROMPT ?? '0',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const kill = () => {
        if (killed) return;
        killed = true;
        child.kill('SIGTERM');
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }, 5000).unref();
      };

      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, timeout);

      const onAbort = () => kill();
      signal?.addEventListener('abort', onAbort);

      child.stdout.on('data', chunk => {
        stdout = appendBounded(stdout, chunk.toString('utf8'));
      });
      child.stderr.on('data', chunk => {
        stderr = appendBounded(stderr, chunk.toString('utf8'));
      });
      child.on('error', error => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(error);
      });
      child.on('close', (exitCode, signalCode) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        const failed = (exitCode ?? 0) !== 0 || timedOut || signalCode !== null;
        let output = joinCommandOutput(stdout, stderr);
        if (timedOut) {
          output = appendLine(output, `Command killed by timeout (${timeout / 1000}s)`);
        } else if (failed) {
          output = appendLine(output, `Command failed with exit code: ${exitCode ?? 'signal ' + signalCode}`);
        }
        resolve({
          command,
          cwd,
          exitCode: exitCode ?? null,
          signal: signalCode ?? null,
          timedOut,
          stdout,
          stderr,
          output,
        });
      });
    });
  }

  private async readFile(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const filePath = this.resolveInsideWorkspace(requireString(params, 'path'));
    const stat = await fs.stat(filePath).catch(error => {
      throw fsError(error, `Cannot stat ${filePath}`);
    });
    if (!stat.isFile()) throw new WorkspaceToolError('NOT_FILE', `${filePath} is not a file`);
    const raw = await fs.readFile(filePath, 'utf8').catch(error => {
      throw fsError(error, `Cannot read ${filePath}`);
    });
    if (raw.includes('\u0000')) {
      throw new WorkspaceToolError('BINARY_FILE', `${filePath} appears to be binary`);
    }

    const model = toModelTextView(raw);
    const lines = splitModelLines(model.text);
    const requested = numberParam(params.n_lines, MAX_READ_LINES);
    const limit = Math.min(Math.max(1, requested), MAX_READ_LINES);
    const lineOffset = numberParam(params.line_offset, 1);
    const startIndex = lineOffset < 0
      ? Math.max(0, lines.length + lineOffset)
      : Math.max(0, lineOffset - 1);
    const selected: string[] = lines.slice(startIndex, startIndex + limit);
    let bytes = 0;
    let maxBytesReached = false;
    const truncatedLineNumbers: number[] = [];
    const rendered = selected.map((line: string, index: number) => {
      const lineNo = startIndex + index + 1;
      const displayLine = line.length > MAX_LINE_LENGTH
        ? line.slice(0, MAX_LINE_LENGTH - 3) + '...'
        : line;
      if (displayLine !== line) truncatedLineNumbers.push(lineNo);
      const renderedLine = `${lineNo}\t${model.lineEndingStyle === 'mixed' ? makeCarriageReturnsVisible(displayLine) : displayLine}`;
      const nextBytes = Buffer.byteLength((bytes === 0 ? '' : '\n') + renderedLine, 'utf8');
      if (bytes + nextBytes > MAX_READ_BYTES) {
        maxBytesReached = true;
        return null;
      }
      bytes += nextBytes;
      return renderedLine;
    }).filter((line: string | null): line is string => line !== null);
    const maxLinesReached = startIndex + rendered.length < lines.length && rendered.length >= limit;
    const anchor = computeAnchor(model.text);
    const status = readStatus({
      renderedLines: rendered.length,
      startLine: rendered.length > 0 ? startIndex + 1 : 0,
      totalLines: lines.length,
      requestedLines: requested,
      maxLinesReached,
      maxBytesReached,
      truncatedLineNumbers,
      lineEndingStyle: model.lineEndingStyle,
      anchor,
    });

    return {
      path: filePath,
      relativePath: this.relative(filePath),
      lineCount: lines.length,
      startLine: startIndex + 1,
      content: rendered.length > 0 ? `${rendered.join('\n')}\n<system>${status}</system>` : `<system>${status}</system>`,
      anchor,
      lineEndingStyle: model.lineEndingStyle,
      truncated: maxLinesReached || maxBytesReached || truncatedLineNumbers.length > 0,
    };
  }

  private async writeFile(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const filePath = this.resolveInsideWorkspace(requireString(params, 'path'));
    const content = requireString(params, 'content');
    const mode = params.mode === 'append' ? 'append' : 'overwrite';
    const parent = path.dirname(filePath);
    const parentStat = await fs.stat(parent).catch(error => {
      throw fsError(error, `Parent directory does not exist: ${parent}`);
    });
    if (!parentStat.isDirectory()) {
      throw new WorkspaceToolError('NOT_DIRECTORY', `Parent path is not a directory: ${parent}`);
    }
    if (mode === 'append') {
      await fs.appendFile(filePath, content, 'utf8');
    } else {
      await fs.writeFile(filePath, content, 'utf8');
    }
    return {
      path: filePath,
      relativePath: this.relative(filePath),
      mode,
      bytesWritten: Buffer.byteLength(content, 'utf8'),
    };
  }

  private async editFile(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const filePath = this.resolveInsideWorkspace(requireString(params, 'path'));
    const oldString = requireString(params, 'old_string');
    const newString = requireString(params, 'new_string');
    const replaceAll = params.replace_all === true;
    if (oldString.length === 0) {
      throw new WorkspaceToolError('INVALID_INPUT', 'old_string cannot be empty');
    }
    if (oldString === newString) {
      throw new WorkspaceToolError('NOOP', 'old_string and new_string are identical');
    }
    const raw = await fs.readFile(filePath, 'utf8').catch(error => {
      throw fsError(error, `Cannot read ${filePath}`);
    });
    const model = toModelTextView(raw);
    const content = model.text;
    const anchor = typeof params.anchor === 'string' ? params.anchor : undefined;
    if (anchor && computeAnchor(content) !== anchor) {
      throw new WorkspaceToolError(
        'ANCHOR_MISMATCH',
        `File has changed since last read. Re-read ${this.relative(filePath)} and retry.`,
      );
    }
    const count = countOccurrences(content, oldString);
    if (count === 0) {
      throw new WorkspaceToolError('NOT_FOUND', `old_string not found in ${this.relative(filePath)}`);
    }
    if (!replaceAll && count > 1) {
      throw new WorkspaceToolError(
        'NOT_UNIQUE',
        `old_string is not unique in ${this.relative(filePath)} (${count} occurrences)`,
      );
    }
    const next = replaceAll
      ? content.split(oldString).join(newString)
      : content.replace(oldString, newString);
    await fs.writeFile(filePath, materializeModelText(next, model.lineEndingStyle), 'utf8');
    return {
      path: filePath,
      relativePath: this.relative(filePath),
      replacements: replaceAll ? count : 1,
      anchor: computeAnchor(next),
    };
  }

  private async grepFiles(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const pattern = requireString(params, 'pattern');
    const searchRoot = params.path === undefined
      ? this.workspaceDir
      : this.resolveInsideWorkspace(requireString(params, 'path'));
    const stat = await fs.stat(searchRoot).catch(error => {
      throw fsError(error, `Cannot stat ${searchRoot}`);
    });
    const outputMode = stringEnum(params.output_mode, ['content', 'files_with_matches', 'count_matches'], 'files_with_matches');
    const headLimit = Math.max(0, numberParam(params.head_limit, DEFAULT_HEAD_LIMIT));
    const flags = `${params['-i'] === true ? 'i' : ''}${params.multiline === true ? 's' : ''}`;
    const regexp = new RegExp(pattern, flags);
    const glob = typeof params.glob === 'string' ? params.glob : undefined;
    const files = stat.isFile() ? [searchRoot] : await this.walkFiles(searchRoot);
    const matchedFiles = new Set<string>();
    const contentLines: string[] = [];
    let matchCount = 0;
    const before = contextBefore(params);
    const after = contextAfter(params);

    for (const file of files) {
      if (glob && !globMatch(this.relative(file), glob)) continue;
      let text: string;
      try {
        text = await fs.readFile(file, 'utf8');
      } catch {
        continue;
      }
      if (text.includes('\u0000')) continue;
      const lines = splitModelLines(toModelTextView(text).text);
      let fileMatched = false;
      if (params.multiline === true) {
        regexp.lastIndex = 0;
        if (regexp.test(lines.join('\n'))) {
          fileMatched = true;
          matchCount++;
          if (outputMode === 'content') contentLines.push(`${this.relative(file)}:multiline match`);
        }
      } else for (let i = 0; i < lines.length; i++) {
        regexp.lastIndex = 0;
        if (!regexp.test(lines[i])) continue;
        fileMatched = true;
        matchCount++;
        if (outputMode === 'content') {
          const start = Math.max(0, i - before);
          const end = Math.min(lines.length - 1, i + after);
          for (let lineIndex = start; lineIndex <= end; lineIndex++) {
            const separator = lineIndex === i ? ':' : '-';
            const lineNumber = params['-n'] === false ? '' : `${lineIndex + 1}${separator}`;
            contentLines.push(`${this.relative(file)}:${lineNumber}${lines[lineIndex]}`);
          }
          if (headLimit > 0 && contentLines.length >= headLimit) break;
        }
      }
      if (fileMatched) matchedFiles.add(this.relative(file));
      if (headLimit > 0) {
        if (outputMode === 'content' && contentLines.length >= headLimit) break;
        if (outputMode === 'files_with_matches' && matchedFiles.size >= headLimit) break;
      }
    }

    const offset = Math.max(0, numberParam(params.offset, 0));
    const filenames = [...matchedFiles];
    const pagedFilenames = headLimit > 0
      ? filenames.slice(offset, offset + headLimit)
      : filenames.slice(offset);
    const pagedContent = headLimit > 0
      ? contentLines.slice(offset, offset + headLimit)
      : contentLines.slice(offset);
    const totalVisible = outputMode === 'content' ? contentLines.length : filenames.length;
    const nextOffset = headLimit > 0 && offset + headLimit < totalVisible
      ? offset + headLimit
      : null;
    return {
      mode: outputMode,
      numFiles: outputMode === 'files_with_matches' ? pagedFilenames.length : filenames.length,
      filenames: outputMode === 'files_with_matches' ? pagedFilenames : filenames,
      numMatches: matchCount,
      content: outputMode === 'content' ? pagedContent.join('\n') : undefined,
      appliedLimit: headLimit,
      offset,
      nextOffset,
      message: nextOffset === null
        ? undefined
        : `Results truncated to ${headLimit} lines (total: ${totalVisible}). Use offset=${nextOffset} to see more.`,
    };
  }

  private async globFiles(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const pattern = requireString(params, 'pattern');
    const root = params.path === undefined
      ? this.workspaceDir
      : this.resolveInsideWorkspace(requireString(params, 'path'));
    const includeDirs = params.include_dirs !== false;
    const files = await this.walkEntries(root);
    const matches = files
      .filter(entry => includeDirs || !entry.isDirectory)
      .filter(entry => globMatch(this.relative(entry.path), pattern))
      .sort((a, b) => b.mtimeMs - a.mtimeMs || this.relative(a.path).localeCompare(this.relative(b.path)))
      .slice(0, 1000)
      .map(entry => ({
        path: entry.path,
        relativePath: this.relative(entry.path),
        isDirectory: entry.isDirectory,
      }));
    return {
      pattern,
      root,
      matches,
      truncated: matches.length >= 1000,
    };
  }

  private async listDirectory(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const dir = params.path === undefined
      ? this.workspaceDir
      : this.resolveInsideWorkspace(requireString(params, 'path'));
    const depth = Math.min(Math.max(1, numberParam(params.depth, 2)), 4);
    const stat = await fs.stat(dir).catch(error => {
      throw fsError(error, `Cannot stat ${dir}`);
    });
    if (!stat.isDirectory()) throw new WorkspaceToolError('NOT_DIRECTORY', `${dir} is not a directory`);
    const lines = await this.renderTree(dir, depth);
    return {
      path: dir,
      relativePath: this.relative(dir),
      tree: lines.join('\n') || '(empty directory)',
    };
  }

  private resolveInsideWorkspace(input: string): string {
    if (!input.trim()) throw new WorkspaceToolError('INVALID_PATH', 'path cannot be empty');
    const resolved = path.resolve(this.workspaceDir, input);
    const rel = path.relative(this.workspaceDir, resolved);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return resolved;
    throw new WorkspaceToolError(
      'PATH_OUTSIDE_WORKSPACE',
      `${input} resolves outside workspace ${this.workspaceDir}`,
    );
  }

  private relative(filePath: string): string {
    const rel = path.relative(this.workspaceDir, filePath);
    return rel || '.';
  }

  private async walkFiles(root: string): Promise<string[]> {
    const entries = await this.walkEntries(root);
    return entries.filter(entry => !entry.isDirectory).map(entry => entry.path);
  }

  private async walkEntries(root: string): Promise<DirEntry[]> {
    const results: DirEntry[] = [];
    const visit = async (dir: string) => {
      let entries: string[];
      try {
        entries = await fs.readdir(dir);
      } catch {
        return;
      }
      entries.sort((a, b) => a.localeCompare(b));
      for (const name of entries) {
        if (SKIP_DIRS.has(name)) continue;
        const full = path.join(dir, name);
        let stat;
        try {
          stat = await fs.stat(full);
        } catch {
          continue;
        }
        const isDirectory = stat.isDirectory();
        results.push({ name, path: full, isDirectory, mtimeMs: stat.mtimeMs });
        if (isDirectory) await visit(full);
        if (results.length > 10_000) return;
      }
    };
    const stat = await fs.stat(root).catch(error => {
      throw fsError(error, `Cannot stat ${root}`);
    });
    if (stat.isDirectory()) await visit(root);
    else results.push({ name: path.basename(root), path: root, isDirectory: false, mtimeMs: stat.mtimeMs });
    return results;
  }

  private async renderTree(dir: string, depth: number, prefix = ''): Promise<string[]> {
    const names = (await fs.readdir(dir).catch(() => []))
      .filter(name => !SKIP_DIRS.has(name))
      .sort((a, b) => a.localeCompare(b))
      .slice(0, 50);
    const lines: string[] = [];
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      const full = path.join(dir, name);
      let stat;
      try {
        stat = await fs.stat(full);
      } catch {
        continue;
      }
      const isLast = i === names.length - 1;
      const connector = isLast ? '└── ' : '├── ';
      const isDirectory = stat.isDirectory();
      lines.push(`${prefix}${connector}${name}${isDirectory ? '/' : ''}`);
      if (isDirectory && depth > 1) {
        lines.push(...await this.renderTree(full, depth - 1, `${prefix}${isLast ? '    ' : '│   '}`));
      }
    }
    return lines;
  }
}

class WorkspaceToolError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'WorkspaceToolError';
  }
}

function requireString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== 'string') {
    throw new WorkspaceToolError('INVALID_INPUT', `${key} must be a string`);
  }
  return value;
}

function numberParam(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function normalizeTimeout(value: unknown): number {
  const seconds = numberParam(value, DEFAULT_COMMAND_TIMEOUT_MS / 1000);
  return Math.min(Math.max(1, seconds) * 1000, MAX_COMMAND_TIMEOUT_MS);
}

function stringEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && allowed.includes(value as T) ? value as T : fallback;
}

function countOccurrences(content: string, needle: string): number {
  let count = 0;
  let index = 0;
  while (index < content.length) {
    const found = content.indexOf(needle, index);
    if (found === -1) break;
    count++;
    index = found + needle.length;
  }
  return count;
}

function appendBounded(current: string, next: string): string {
  const combined = current + next;
  if (Buffer.byteLength(combined, 'utf8') <= MAX_OUTPUT_BYTES) return combined;
  return combined.slice(0, MAX_OUTPUT_BYTES) + '\n[output truncated]\n';
}

function fsError(error: unknown, fallback: string): WorkspaceToolError {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : 'FS_ERROR';
  const message = error instanceof Error ? error.message : fallback;
  return new WorkspaceToolError(code, message);
}

function globMatch(candidate: string, pattern: string): boolean {
  const normalizedCandidate = candidate.split(path.sep).join('/');
  const normalizedPattern = pattern.split(path.sep).join('/');
  const regex = new RegExp(`^${globToRegex(normalizedPattern)}$`);
  return regex.test(normalizedCandidate);
}

function globToRegex(pattern: string): string {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    const next = pattern[i + 1];
    const afterNext = pattern[i + 2];
    if (char === '*' && next === '*' && afterNext === '/') {
      out += '(?:.*/)?';
      i += 2;
    } else if (char === '*' && next === '*') {
      out += '.*';
      i++;
    } else if (char === '*') {
      out += '[^/]*';
    } else if (char === '?') {
      out += '[^/]';
    } else {
      out += escapeRegex(char);
    }
  }
  return out;
}

function escapeRegex(char: string): string {
  return /[\\^$+?.()|[\]{}]/.test(char) ? `\\${char}` : char;
}

type LineEndingStyle = 'lf' | 'crlf' | 'mixed';

interface ModelTextView {
  text: string;
  lineEndingStyle: LineEndingStyle;
}

interface ReadStatusInput {
  renderedLines: number;
  startLine: number;
  totalLines: number;
  requestedLines: number;
  maxLinesReached: boolean;
  maxBytesReached: boolean;
  truncatedLineNumbers: number[];
  lineEndingStyle: LineEndingStyle;
  anchor: string;
}

function toModelTextView(raw: string): ModelTextView {
  const hasCrLf = raw.includes('\r\n');
  const withoutCrLf = raw.replace(/\r\n/g, '\n');
  const hasLoneCr = withoutCrLf.includes('\r');
  const lineEndingStyle: LineEndingStyle = hasLoneCr
    ? 'mixed'
    : hasCrLf
      ? 'crlf'
      : 'lf';
  return {
    text: withoutCrLf,
    lineEndingStyle,
  };
}

function materializeModelText(text: string, lineEndingStyle: LineEndingStyle): string {
  if (lineEndingStyle === 'crlf') return text.replace(/\n/g, '\r\n');
  return text;
}

function splitModelLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function makeCarriageReturnsVisible(text: string): string {
  return text.replace(/\r/g, '\\r');
}

function computeAnchor(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function readStatus(input: ReadStatusInput): string {
  const parts = input.renderedLines > 0
    ? [`${input.renderedLines} ${input.renderedLines === 1 ? 'line' : 'lines'} read from file starting from line ${input.startLine}.`]
    : ['No lines read from file.'];
  parts.push(`Total lines in file: ${input.totalLines}.`);
  if (input.maxLinesReached) parts.push(`Max ${MAX_READ_LINES} lines reached.`);
  else if (input.maxBytesReached) parts.push(`Max ${MAX_READ_BYTES} bytes reached.`);
  else if (input.renderedLines < input.requestedLines) parts.push('End of file reached.');
  if (input.truncatedLineNumbers.length > 0) {
    parts.push(`Lines [${input.truncatedLineNumbers.join(', ')}] were truncated.`);
  }
  if (input.lineEndingStyle === 'mixed') {
    parts.push('Mixed or lone carriage-return line endings are shown as \\r. Use exact \\r escapes in edit_file.old_string for those lines.');
  } else if (input.lineEndingStyle === 'crlf') {
    parts.push('CRLF file displayed with LF line endings; edit_file preserves CRLF on write-back.');
  }
  parts.push(`Anchor: ${input.anchor}`);
  return parts.join(' ');
}

function joinCommandOutput(stdout: string, stderr: string): string {
  if (stdout && stderr) return `${stdout}${stdout.endsWith('\n') ? '' : '\n'}${stderr}`;
  return stdout || stderr;
}

function appendLine(text: string, line: string): string {
  if (!text) return line;
  return `${text}${text.endsWith('\n') ? '' : '\n'}${line}`;
}

function contextBefore(params: Record<string, unknown>): number {
  const around = numberParam(params['-C'], -1);
  if (around >= 0) return around;
  return Math.max(0, numberParam(params['-B'], 0));
}

function contextAfter(params: Record<string, unknown>): number {
  const around = numberParam(params['-C'], -1);
  if (around >= 0) return around;
  return Math.max(0, numberParam(params['-A'], 0));
}
