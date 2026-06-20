import { RuntimeToolDefinition } from './runtime';

export type WorkspaceToolName =
  | 'bash'
  | 'read_file'
  | 'write_file'
  | 'edit_file'
  | 'grep_files'
  | 'glob_files'
  | 'list_directory';

export interface WorkspaceToolDefinition extends RuntimeToolDefinition {
  name: WorkspaceToolName;
}

const definitions: Record<WorkspaceToolName, WorkspaceToolDefinition> = {
  bash: {
    name: 'bash',
    description: [
      'Execute a bash command in the project workspace. Use this for shell semantics: package managers, build/test runners, git, pipes, env, and multi-step commands.',
      'Prefer dedicated tools when they fit: read_file instead of cat/head/tail, edit_file instead of sed/perl in-place edits, write_file instead of shell redirection, glob_files instead of find, grep_files instead of grep/rg.',
      'Output includes stdout/stderr plus an output field with combined text. Failed commands append "Command failed with exit code: N". Each call runs in a fresh shell; cwd changes do not persist between calls.',
      'For related commands, combine them with &&, ;, ||, pipes, or shell control flow in one call.',
    ].join('\n\n'),
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute.' },
        cwd: {
          type: 'string',
          description:
            'Optional working directory. Relative paths resolve from the workspace root.',
        },
        timeout: {
          type: 'number',
          description: 'Optional timeout in seconds. Defaults to 60, max 300.',
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
  read_file: {
    name: 'read_file',
    description: [
      'Read a UTF-8 text file from the project workspace with line numbers. Use this directly when you know the file path; do not pre-check with list_directory or glob_files.',
      'Output format is "<line-number>\\t<content>" followed by a <system> status block. The status block includes total lines, truncation notes, line-ending notes, and an Anchor value for edit_file.',
      'Use line_offset and n_lines to page larger files. Negative line_offset reads from the end of the file.',
    ].join('\n\n'),
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, relative to workspace or absolute inside it.' },
        line_offset: {
          type: 'number',
          description: '1-based start line. Negative values read from the end.',
        },
        n_lines: {
          type: 'number',
          description: 'Number of lines to read. Defaults to 1000, max 1000.',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  write_file: {
    name: 'write_file',
    description:
      'Create, overwrite, or append to a UTF-8 text file in the project workspace. Parent directories must already exist.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, relative to workspace or absolute inside it.' },
        content: { type: 'string', description: 'Exact content to write.' },
        mode: {
          type: 'string',
          enum: ['overwrite', 'append'],
          description: 'Defaults to overwrite.',
        },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  edit_file: {
    name: 'edit_file',
    description: [
      'Edit a text file by exact string replacement against the text view returned by read_file. Omit the line-number prefix and tab from old_string.',
      'By default old_string must occur exactly once. If it is not unique, include more surrounding context or set replace_all only when every occurrence should change.',
      'Pass the latest read_file Anchor as anchor when available; edit_file will fail if the file changed since that read. CRLF files are displayed with LF and written back as CRLF.',
    ].join('\n\n'),
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, relative to workspace or absolute inside it.' },
        old_string: { type: 'string', description: 'Exact text to replace.' },
        new_string: { type: 'string', description: 'Replacement text.' },
        replace_all: {
          type: 'boolean',
          description: 'Replace every occurrence instead of requiring a unique occurrence.',
        },
        anchor: {
          type: 'string',
          description: 'Optional anchor from the latest read_file result; edit fails if file changed.',
        },
      },
      required: ['path', 'old_string', 'new_string'],
      additionalProperties: false,
    },
  },
  grep_files: {
    name: 'grep_files',
    description:
      'Search text files in the project workspace using a JavaScript regular expression. Supports content/files/count modes, glob filtering, case-insensitive search, context lines (-A/-B/-C), multiline matching, and offset + head_limit pagination.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression pattern.' },
        path: {
          type: 'string',
          description: 'Optional file or directory to search. Defaults to workspace root.',
        },
        glob: {
          type: 'string',
          description: 'Optional glob filter, such as src/**/*.ts.',
        },
        output_mode: {
          type: 'string',
          enum: ['content', 'files_with_matches', 'count_matches'],
          description: 'Defaults to files_with_matches.',
        },
        '-i': { type: 'boolean', description: 'Case-insensitive search.' },
        '-n': { type: 'boolean', description: 'Prefix content results with line numbers. Defaults to true.' },
        head_limit: {
          type: 'number',
          description: 'Maximum result lines or files. Defaults to 250. Use 0 for unlimited.',
        },
        offset: {
          type: 'number',
          description: 'Number of leading result lines or files to skip before applying head_limit.',
        },
        '-A': { type: 'number', description: 'Content mode: lines of trailing context after each match.' },
        '-B': { type: 'number', description: 'Content mode: lines of leading context before each match.' },
        '-C': { type: 'number', description: 'Content mode: lines of leading and trailing context.' },
        multiline: {
          type: 'boolean',
          description: 'Allow the regular expression to match across newlines.',
        },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  glob_files: {
    name: 'glob_files',
    description:
      'Find files or directories in the project workspace matching a glob pattern. Results are sorted by modification time, newest first, and include relative paths for read_file/edit_file.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern, for example src/**/*.tsx.' },
        path: {
          type: 'string',
          description: 'Optional directory to search. Defaults to workspace root.',
        },
        include_dirs: {
          type: 'boolean',
          description: 'Whether to include directories. Defaults to true.',
        },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  list_directory: {
    name: 'list_directory',
    description:
      'List a directory in the project workspace. Returns a compact tree suitable for project navigation.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory path. Defaults to workspace root.',
        },
        depth: {
          type: 'number',
          description: 'Tree depth. Defaults to 2, max 4.',
        },
      },
      additionalProperties: false,
    },
  },
};

export function createWorkspaceToolDefinitions(): WorkspaceToolDefinition[] {
  return Object.values(definitions);
}

export function isWorkspaceToolName(name: string): name is WorkspaceToolName {
  return Object.prototype.hasOwnProperty.call(definitions, name);
}
