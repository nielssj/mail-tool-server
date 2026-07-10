import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, ConfigLoadError } from '../src/utils/config/load.js';

const VALID_ACCOUNT = {
  id: 'test-account',
  host: 'imap.example.com',
  port: 993,
  secure: true,
  auth: { user: 'user@example.com', pass: 'secret' },
  watchMailboxes: ['INBOX'],
  dispatchers: [{ type: 'webhook', url: 'https://hooks.example.com/events' }]
};

let tmpDir: string;
let tmpConfigPath: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tmpDir = join(tmpdir(), `mail-tool-test-${process.pid}-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  tmpConfigPath = join(tmpDir, 'config.json');
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.CONFIG_PATH;
});

const writeConfig = (data: unknown, path = tmpConfigPath) => {
  writeFileSync(path, JSON.stringify(data), 'utf-8');
};

describe('loadConfig', () => {
  it('parses a valid config correctly', () => {
    writeConfig([VALID_ACCOUNT]);
    const result = loadConfig(tmpConfigPath);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('test-account');
    expect(result[0].host).toBe('imap.example.com');
    expect(result[0].dispatchers).toHaveLength(1);
    expect(result[0].dispatchers[0]).toMatchObject({
      type: 'webhook',
      url: 'https://hooks.example.com/events'
    });
  });

  it('accepts an account with an empty dispatchers array', () => {
    writeConfig([{ ...VALID_ACCOUNT, dispatchers: [] }]);
    const result = loadConfig(tmpConfigPath);
    expect(result[0].dispatchers).toEqual([]);
  });

  it('accepts multiple accounts', () => {
    writeConfig([
      VALID_ACCOUNT,
      { ...VALID_ACCOUNT, id: 'second-account' }
    ]);
    const result = loadConfig(tmpConfigPath);
    expect(result).toHaveLength(2);
  });

  it('throws a descriptive error for a missing required field', () => {
    const withoutHost = {
      id: VALID_ACCOUNT.id,
      port: VALID_ACCOUNT.port,
      secure: VALID_ACCOUNT.secure,
      auth: VALID_ACCOUNT.auth,
      watchMailboxes: VALID_ACCOUNT.watchMailboxes,
      dispatchers: VALID_ACCOUNT.dispatchers
    };
    writeConfig([withoutHost]);
    expect(() => loadConfig(tmpConfigPath)).toThrowError(ConfigLoadError);
    expect(() => loadConfig(tmpConfigPath)).toThrowError(
      /Config validation failed/
    );
  });

  it('throws for duplicate account ids', () => {
    writeConfig([VALID_ACCOUNT, { ...VALID_ACCOUNT }]);
    expect(() => loadConfig(tmpConfigPath)).toThrowError(ConfigLoadError);
    expect(() => loadConfig(tmpConfigPath)).toThrowError(
      /Duplicate account id/
    );
  });

  it('throws a clear error when the file is not found', () => {
    expect(() => loadConfig('/nonexistent/path/config.json')).toThrowError(
      ConfigLoadError
    );
    expect(() => loadConfig('/nonexistent/path/config.json')).toThrowError(
      /Failed to read config file/
    );
  });

  it('throws for an unknown dispatchers type', () => {
    writeConfig([
      {
        ...VALID_ACCOUNT,
        dispatchers: [{ type: 'unknown-type', url: 'https://example.com' }]
      }
    ]);
    expect(() => loadConfig(tmpConfigPath)).toThrowError(ConfigLoadError);
    expect(() => loadConfig(tmpConfigPath)).toThrowError(
      /Unknown dispatcher type: "unknown-type"/
    );
  });

  it('reads from the default ./config.json path when CONFIG_PATH is unset', () => {
    writeConfig([VALID_ACCOUNT]);
    process.chdir(tmpDir);
    const result = loadConfig();
    expect(result[0].id).toBe('test-account');
  });

  it('reads from CONFIG_PATH when set', () => {
    writeConfig([VALID_ACCOUNT]);
    process.env.CONFIG_PATH = tmpConfigPath;
    const result = loadConfig();
    expect(result[0].id).toBe('test-account');
  });

  it('reads from the provided path argument, ignoring CONFIG_PATH', () => {
    const altPath = join(tmpDir, 'alt-config.json');
    writeConfig([{ ...VALID_ACCOUNT, id: 'alt-account' }], altPath);
    process.env.CONFIG_PATH = tmpConfigPath; // not the alt path
    // alt path doesn't exist at tmpConfigPath, would fail if it tried to read it
    const result = loadConfig(altPath);
    expect(result[0].id).toBe('alt-account');
  });

  it('throws a clear error for invalid JSON', () => {
    writeFileSync(tmpConfigPath, 'not valid json', 'utf-8');
    expect(() => loadConfig(tmpConfigPath)).toThrowError(ConfigLoadError);
    expect(() => loadConfig(tmpConfigPath)).toThrowError(
      /not valid JSON/
    );
  });
});
