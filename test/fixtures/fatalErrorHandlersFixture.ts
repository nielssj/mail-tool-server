import { createLogger } from '../../src/utils/logger.js';
import { installFatalErrorHandlers } from '../../src/utils/fatalErrorHandlers.js';

// Run out-of-process (see test/server.test.ts) since exercising a real
// process.exit() would otherwise kill the test runner itself.
// Explicit level, independent of any inherited LOG_LEVEL (the unit test
// suite runs with LOG_LEVEL=silent, which would otherwise swallow the very
// fatal line this fixture exists to assert on).
const mode = process.argv[2];
const logger = createLogger({ env: 'production', level: 'fatal' });
installFatalErrorHandlers(logger);

if (mode === 'uncaughtException') {
  throw new Error('boom');
} else if (mode === 'unhandledRejection') {
  void Promise.reject(new Error('boom'));
} else {
  throw new Error(`unknown fixture mode: ${String(mode)}`);
}
