import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigSchema, type Config } from './schema.js';

const DEFAULT_CONFIG_PATH = './config.json';

export class ConfigLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigLoadError';
  }
}

export const loadConfig = (configPath?: string): Config => {
  const filePath = resolve(
    configPath ?? process.env.CONFIG_PATH ?? DEFAULT_CONFIG_PATH
  );

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (err) {
    throw new ConfigLoadError(
      `Failed to read config file at "${filePath}": ${(err as NodeJS.ErrnoException).message}`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigLoadError(
      `Config file at "${filePath}" is not valid JSON: ${(err as Error).message}`
    );
  }

  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new ConfigLoadError(
      `Config validation failed:\n${issues}`
    );
  }

  return result.data;
};
