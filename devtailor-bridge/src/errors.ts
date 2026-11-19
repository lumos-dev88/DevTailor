/**
 * Bridge errors — errors that map 1:1 to an HTTP response.
 */

/** Error that maps 1:1 to an HTTP response. */
export class BridgeError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'BridgeError';
  }
}
