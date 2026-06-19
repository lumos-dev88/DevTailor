export interface AgentPreset {
  label: string;
  command: string;
  args: string[];
  description?: string;
  env?: Record<string, string>;
}

export interface ResolvedAgent {
  id?: string;
  label: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  source: 'preset' | 'raw';
}

export const BUILT_IN_AGENTS: Record<string, AgentPreset> = {
  copilot: {
    label: 'GitHub Copilot',
    command: 'npx',
    args: ['--yes', '@github/copilot', '--acp', '--yolo', '--enable-all-github-mcp-tools'],
    description: 'GitHub Copilot ACP',
  },
  claude: {
    label: 'Claude Code',
    command: 'claude-agent-acp',
    args: [],
    description: 'Claude Code ACP',
  },
  gemini: {
    label: 'Gemini CLI',
    command: 'npx',
    args: ['--yes', '@google/gemini-cli', '--experimental-acp'],
    description: 'Gemini CLI ACP',
  },
  qwen: {
    label: 'Qwen Code',
    command: 'npx',
    args: ['--yes', '@qwen-code/qwen-code', '--acp', '--experimental-skills'],
    description: 'Qwen Code ACP',
  },
  codex: {
    label: 'Codex CLI',
    command: 'npx',
    args: ['--yes', '@zed-industries/codex-acp'],
    description: 'Codex ACP adapter',
  },
  opencode: {
    label: 'OpenCode',
    command: 'npx',
    args: ['--yes', 'opencode-ai', 'acp'],
    description: 'OpenCode ACP',
  },
  kiro: {
    label: 'Kiro CLI',
    command: 'kiro-cli',
    args: ['acp'],
    description: 'Kiro CLI ACP',
  },
  kimi: {
    label: 'Kimi CLI',
    command: 'kimi',
    args: ['acp'],
    description: 'Kimi CLI ACP',
  },
};

export function parseAgentCommand(agent: string): { command: string; args: string[] } {
  const parts = agent.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) {
    throw new Error('Agent command cannot be empty');
  }
  return {
    command: parts[0],
    args: parts.slice(1),
  };
}

export function resolveAgent(agent: string): ResolvedAgent {
  const preset = BUILT_IN_AGENTS[agent];
  if (preset) {
    return {
      id: agent,
      label: preset.label,
      command: preset.command,
      args: [...preset.args],
      env: preset.env ? { ...preset.env } : undefined,
      source: 'preset',
    };
  }

  const parsed = parseAgentCommand(agent);
  return {
    label: agent,
    command: parsed.command,
    args: parsed.args,
    source: 'raw',
  };
}

export function listBuiltInAgents(): Array<{ id: string; preset: AgentPreset }> {
  return Object.entries(BUILT_IN_AGENTS)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, preset]) => ({ id, preset }));
}
