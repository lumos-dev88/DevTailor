import type { AgentSessionFactory } from './ws-server';

export interface OpenAICompatibleModelConfig {
  provider: 'openai-compatible';
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
  maxSteps: number | null;
  updatedAt?: number;
}

export type ModelConfig = OpenAICompatibleModelConfig;

export interface RuntimeConfig {
  key: string;
  label: string;
  createSession?: AgentSessionFactory;
}

export function normalizeModelConfig(input: Partial<ModelConfig> | null | undefined): ModelConfig {
  const maxSteps = Number(input?.maxSteps);
  return {
    provider: 'openai-compatible',
    enabled: input?.enabled !== false,
    baseUrl: String(input?.baseUrl || '').trim().replace(/\/+$/, ''),
    apiKey: String(input?.apiKey || '').trim(),
    model: String(input?.model || '').trim(),
    maxSteps: Number.isFinite(maxSteps) && maxSteps > 0 ? Math.floor(maxSteps) : null,
    updatedAt: Number(input?.updatedAt) || Date.now(),
  };
}

export function isModelConfigComplete(config: ModelConfig | null | undefined): config is ModelConfig {
  return Boolean(config?.enabled && config.baseUrl && config.apiKey && config.model);
}
