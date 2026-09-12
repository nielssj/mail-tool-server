import type { Logger } from 'pino';

/**
 * Flushes the logger before exiting. `createLogger` writes synchronously to
 * stdout in production, so a `fatal` log immediately followed by
 * `process.exit` is safe there -- but under the dev/test `pino-pretty`
 * transport (a worker thread) an immediate exit can truncate the line, so
 * always route through the transport's own flush instead of assuming the
 * synchronous path.
 */
const flushAndExit = (logger: Logger, code: number): void => {
  logger.flush(() => process.exit(code));
};

/**
 * Registers last-resort handlers for `uncaughtException` and
 * `unhandledRejection` -- logging only, exit semantics unchanged. Node's own
 * default for either is to print to stderr and exit `1`; this only changes
 * what lands in Loki (a structured `fatal` JSON line instead of a raw
 * stderr dump) and does not turn either into a keep-running handler: the
 * last thing each handler does is the same `process.exit(1)` Node would
 * have performed itself.
 */
export const installFatalErrorHandlers = (logger: Logger): void => {
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception');
    flushAndExit(logger, 1);
  });

  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    logger.fatal({ err }, 'Unhandled promise rejection');
    flushAndExit(logger, 1);
  });
};
