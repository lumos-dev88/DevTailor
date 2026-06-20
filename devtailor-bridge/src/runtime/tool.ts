/**
 * Runtime tool types — definitions, executors, and results.
 *
 * No provider wiring; these are pure interfaces.
 */

// ── Tool definition ────────────────────────────────────────────────────

export interface RuntimeToolDefinition {
  /** Unique tool name. */
  name: string;
  /** Human-readable description. */
  description: string;
  /** JSON Schema for the tool's input parameters. */
  parameters: Record<string, unknown>;
}

// ── Execution result ───────────────────────────────────────────────────

export interface RuntimeToolExecutionResult {
  /** The tool call id this result corresponds to. */
  toolCallId: string;
  /** Textual output. */
  content: string;
  /** Whether the execution failed. */
  isError?: boolean;
}

// ── Executor function type ─────────────────────────────────────────────

/**
 * A function that executes a tool call and returns a result.
 * Implementations are injected at higher layers — this is only the contract.
 */
export type RuntimeToolExecutor = (
  name: string,
  args: string,
  toolCallId: string,
) => Promise<RuntimeToolExecutionResult>;
