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

  if (options.level !== 'silent' && (env === 'development' || env === 'test')) {
    options.transport = {
      target: 'pino-pretty',
      options: {
        colorize: false,
        translateTime: 'SYS:standard'
      }
    };
  }

  return destination ? pino(options, destination) : pino(options);
};
