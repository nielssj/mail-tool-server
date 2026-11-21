// The one place in src/ allowed to import the ImapFlow class itself
// (enforced by no-restricted-imports in eslint.config.mjs).
// eslint-disable-next-line @typescript-eslint/no-restricted-imports
import { ImapFlow, type ImapFlowOptions } from 'imapflow';

/**
 * ImapFlow with a permanent no-op `error` listener, attached in the
 * constructor so it covers the client's whole life. Use this, never the
 * bare ImapFlow class, wherever this codebase constructs an IMAP client.
 *
 * Why: ImapFlow can emit `error` on top of rejecting `connect()`.
 * If the server closes the socket mid-handshake (e.g. a BYE with "Too many
 * simultaneous connections for your account"), `close()` rejects the
 * connect promise with "Unexpected close", but the detached
 * `startSession()` chain keeps going, fails on its next step ("Already
 * logged out" / "Connection not available"), and -- with the connect
 * promise already settled -- reports that via `emit('error')`.
 * EventEmitter rethrows an `error` with no listener; because the emit
 * happens inside a `.catch()` callback, that surfaces as an unhandled
 * promise rejection and the fatal handler exits the process. A caller
 * whose own listener is attached only after a successful connect, or
 * removed in its connect-failure path, has nothing listening at that
 * moment.
 *
 * Callers still attach their own `error` listeners to react to errors on a
 * live client; EventEmitter calls every listener, so this sink changes
 * nothing for them. It only guarantees one listener is always present, so
 * a late error on a client that has already been given up on can never
 * crash the process.
 *
 * The underlying bug is in ImapFlow's `beginSession()`; once fixed
 * upstream (test/safeImapFlow.test.ts has a canary for it), this subclass
 * can be removed.
 */
export class SafeImapFlow extends ImapFlow {
  constructor(options: ImapFlowOptions) {
    super(options);
    this.on('error', () => undefined);
  }
}
