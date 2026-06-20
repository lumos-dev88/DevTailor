/**
 * Token usage tracking — small pure helper.
 */

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * Create an empty (zero) usage snapshot.
 */
export function zeroUsage(): TokenUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

/**
 * Accumulate two usage snapshots (mutates nothing).
 */
export function addTokenUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}
