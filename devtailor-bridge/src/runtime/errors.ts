/**
 * Provider error classification — identifies specific error categories
 * from HTTP responses so downstream logic can react accordingly.
 */

// ── Error codes ────────────────────────────────────────────────────────

export const ERROR_CONTEXT_OVERFLOW = 'context_overflow';

// ── Context-overflow detection ─────────────────────────────────────────

const CONTEXT_OVERFLOW_PATTERNS = [
  /context.?length.?exceeded/i,
  /maximum\s+context\s+length/i,
  /token\s+limit/i,
  /context\s+length\s+exceeded/i,
  /context\s+window/i,
  /too\s+many\s+tokens/i,
  /request\s+too\s+large/i,
  /prompt\s+is\s+too\s+long/i,
];

/**
 * Returns `true` when `status` + `body` together indicate that the request
 * failed because the conversation exceeded the model's context window.
 *
 * Status 400 alone is ambiguous (could be a schema error), so the body
 * text is always inspected. 413 / 422 are also checked because some
 * providers surface context overflow through these codes.
 */
export function isContextOverflow(status: number, body: string): boolean {
  if (status === 413) return true;

  for (const pattern of CONTEXT_OVERFLOW_PATTERNS) {
    if (pattern.test(body)) return true;
  }

  return false;
}
