import pino, { type DestinationStream, type Logger, type LoggerOptions } from 'pino';

export type LoggerConfig = {
  env?: string;
  level?: string;
};

export const createLogger = (
  config: LoggerConfig = {},
  destination?: DestinationStream
): Logger => {
  const env = config.env ?? process.env.NODE_ENV ?? 'development';
  const options: LoggerOptions = {
    level: config.level ?? process.env.LOG_LEVEL ?? 'info'
  };

  const usePrettyPrint =
    options.level !== 'silent' && (env === 'development' || env === 'test');

  if (usePrettyPrint) {
    // pino-pretty runs in a worker thread, so it can only target a file
    // descriptor/path, not an arbitrary JS stream instance — fd 2 (stderr)
    // is the one case callers in this codebase need (keeping stdout clear
    // for the MCP stdio transport), so that's the only override supported.
    options.transport = {
      target: 'pino-pretty',
      options: {
        colorize: false,
        translateTime: 'SYS:standard',
        destination: destination === process.stderr ? 2 : 1
      }
    };
    return pino(options);
  }

  return destination ? pino(options, destination) : pino(options);
};
