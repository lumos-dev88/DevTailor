/**
 * Logging helpers. The bridge process may run as an MCP stdio server, where
 * stdout is the protocol channel. Everything human-readable MUST go to stderr.
 * This is the only module in src/ allowed to touch process streams directly.
 */

import { format } from 'util';

export function log(...args: unknown[]): void {
  process.stderr.write(`${format(...args)}\n`);
}

export function logError(...args: unknown[]): void {
  log(...args);
}
