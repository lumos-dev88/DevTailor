/**
 * Runtime core — re-exports the lightweight type layer + generate loop.
 */

export type {
  MessageRole,
  ContentPart,
  TextContentPart,
  ImageContentPart,
  ToolResultContentPart,
  RuntimeToolCall,
  RuntimeMessage,
} from './message';

export type {
  RuntimeToolDefinition,
  RuntimeToolExecutor,
  RuntimeToolExecutionResult,
} from './tool';

export type {
  ChatProvider,
  StreamedMessagePart,
  TextDeltaPart,
  ToolCallPart,
  DonePart,
  ErrorPart,
  FinishReason,
} from './provider';

export type { TokenUsage } from './usage';
export { zeroUsage, addTokenUsage } from './usage';

export type {
  GenerateOptions,
  GenerateResult,
  GenerateCallbacks,
} from './generate';
export { generate } from './generate';

export { isContextOverflow, ERROR_CONTEXT_OVERFLOW } from './errors';

export { OpenAICompatibleProvider } from './openai-compatible-provider';
export type { OpenAICompatibleProviderOptions } from './openai-compatible-provider';
