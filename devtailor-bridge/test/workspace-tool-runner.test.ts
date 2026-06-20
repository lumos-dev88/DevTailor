import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, utimes, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { WorkspaceToolService } from '../src/workspace-tool-runner';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'devtailor-workspace-'));
  await mkdir(join(dir, 'src'));
  await writeFile(join(dir, 'src', 'app.ts'), 'export const label = "Save";\n', 'utf8');
  return { dir, tools: new WorkspaceToolService(dir) };
}

describe('WorkspaceToolService', () => {
  it('reads files with line numbers and blocks paths outside the workspace', async () => {
    const { tools } = await fixture();
    const result = await tools.run('read_file', { path: 'src/app.ts' });
    assert.equal(result.ok, true);
    assert.match(JSON.stringify(result.result), /1\\texport const label/);

    const outside = await tools.run('read_file', { path: '../outside.txt' });
    assert.equal(outside.ok, false);
    assert.equal(outside.error?.code, 'PATH_OUTSIDE_WORKSPACE');
  });

  it('returns read anchors and preserves CRLF edits through the model text view', async () => {
    const { dir, tools } = await fixture();
    await writeFile(join(dir, 'src', 'crlf.ts'), 'const a = 1;\r\nconst b = 2;\r\n', 'utf8');

    const read = await tools.run('read_file', { path: 'src/crlf.ts' });
    assert.equal(read.ok, true);
    const readResult = read.result as { content: string; anchor: string };
    assert.match(readResult.content, /CRLF file displayed with LF line endings/);
    assert.match(readResult.content, /Anchor: /);

    const edit = await tools.run('edit_file', {
      path: 'src/crlf.ts',
      old_string: 'const b = 2;',
      new_string: 'const b = 3;',
      anchor: readResult.anchor,
    });
    assert.equal(edit.ok, true);
    assert.equal(await readFile(join(dir, 'src', 'crlf.ts'), 'utf8'), 'const a = 1;\r\nconst b = 3;\r\n');
  });

  it('rejects edits with a stale anchor', async () => {
    const { dir, tools } = await fixture();
    const read = await tools.run('read_file', { path: 'src/app.ts' });
    assert.equal(read.ok, true);
    const anchor = (read.result as { anchor: string }).anchor;
    await writeFile(join(dir, 'src', 'app.ts'), 'export const label = "Changed";\n', 'utf8');

    const edit = await tools.run('edit_file', {
      path: 'src/app.ts',
      old_string: 'Changed',
      new_string: 'Save',
      anchor,
    });
    assert.equal(edit.ok, false);
    assert.equal(edit.error?.code, 'ANCHOR_MISMATCH');
  });

  it('writes and edits files', async () => {
    const { dir, tools } = await fixture();
    const write = await tools.run('write_file', {
      path: 'src/new.ts',
      content: 'const value = 1;\n',
    });
    assert.equal(write.ok, true);
    assert.equal(await readFile(join(dir, 'src', 'new.ts'), 'utf8'), 'const value = 1;\n');

    const edit = await tools.run('edit_file', {
      path: 'src/new.ts',
      old_string: 'value = 1',
      new_string: 'value = 2',
    });
    assert.equal(edit.ok, true);
    assert.equal(await readFile(join(dir, 'src', 'new.ts'), 'utf8'), 'const value = 2;\n');
  });

  it('greps, globs, lists, and runs shell commands in the workspace', async () => {
    const { tools } = await fixture();
    const grep = await tools.run('grep_files', {
      pattern: 'Save',
      path: 'src',
      output_mode: 'content',
    });
    assert.equal(grep.ok, true);
    assert.match(JSON.stringify(grep.result), /src\/app.ts/);

    const glob = await tools.run('glob_files', { pattern: 'src/**/*.ts', include_dirs: false });
    assert.equal(glob.ok, true);
    assert.match(JSON.stringify(glob.result), /src\/app.ts/);

    const list = await tools.run('list_directory', { path: '.', depth: 2 });
    assert.equal(list.ok, true);
    assert.match(JSON.stringify(list.result), /app.ts/);

    const bash = await tools.run('bash', { command: 'pwd && ls src', timeout: 5 });
    assert.equal(bash.ok, true);
    assert.match(JSON.stringify(bash.result), /app.ts/);
  });

  it('supports grep context, offset pagination, and bash failure output', async () => {
    const { tools } = await fixture();
    const grep = await tools.run('grep_files', {
      pattern: 'label',
      path: 'src/app.ts',
      output_mode: 'content',
      '-C': 1,
      head_limit: 1,
      offset: 0,
    });
    assert.equal(grep.ok, true);
    const grepResult = grep.result as { content: string; nextOffset?: number | null; message?: string };
    assert.match(grepResult.content, /src\/app.ts:1:/);
    assert.equal(grepResult.nextOffset, null);

    const failed = await tools.run('bash', { command: 'echo out; echo err >&2; exit 7', timeout: 5 });
    assert.equal(failed.ok, true);
    const failedResult = failed.result as { output: string; exitCode: number };
    assert.equal(failedResult.exitCode, 7);
    assert.match(failedResult.output, /out/);
    assert.match(failedResult.output, /err/);
    assert.match(failedResult.output, /Command failed with exit code: 7/);
  });

  it('sorts glob results by mtime descending', async () => {
    const { dir, tools } = await fixture();
    const older = join(dir, 'src', 'older.ts');
    const newer = join(dir, 'src', 'newer.ts');
    await writeFile(older, 'old\n', 'utf8');
    await writeFile(newer, 'new\n', 'utf8');
    await utimes(older, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
    await utimes(newer, new Date('2021-01-01T00:00:00Z'), new Date('2021-01-01T00:00:00Z'));

    const glob = await tools.run('glob_files', { pattern: 'src/*er.ts', include_dirs: false });
    assert.equal(glob.ok, true);
    const matches = (glob.result as { matches: Array<{ relativePath: string }> }).matches;
    assert.equal(matches[0].relativePath, 'src/newer.ts');
  });
});
