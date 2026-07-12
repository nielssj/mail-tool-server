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

const VALID_OBJECT_STORAGE = {
  bucket: 'mail-tool-blobs',
  region: 'us-east-1',
  credentials: { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret-key' }
};

let tmpDir: string;
let tmpConfigPath: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `mail-tool-test-${process.pid}-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  tmpConfigPath = join(tmpDir, 'config.json');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.CONFIG_PATH;
});

const writeConfig = (data: unknown, path = tmpConfigPath) => {
  writeFileSync(path, JSON.stringify(data), 'utf-8');
};

describe('loadConfig', () => {
  it('parses a valid config correctly', () => {
    writeConfig({ accounts: [VALID_ACCOUNT] });
    const result = loadConfig(tmpConfigPath);
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0]!.id).toBe('test-account');
    expect(result.accounts[0]!.host).toBe('imap.example.com');
    expect(result.accounts[0]!.dispatchers).toHaveLength(1);
    expect(result.accounts[0]!.dispatchers[0]).toMatchObject({
      type: 'webhook',
      url: 'https://hooks.example.com/events'
    });
  });

  it('accepts an account with an empty dispatchers array', () => {
    writeConfig({ accounts: [{ ...VALID_ACCOUNT, dispatchers: [] }] });
    const result = loadConfig(tmpConfigPath);
    expect(result.accounts[0]!.dispatchers).toEqual([]);
  });

  it('accepts multiple accounts', () => {
    writeConfig({
      accounts: [VALID_ACCOUNT, { ...VALID_ACCOUNT, id: 'second-account' }]
    });
    const result = loadConfig(tmpConfigPath);
    expect(result.accounts).toHaveLength(2);
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
    writeConfig({ accounts: [withoutHost] });
    expect(() => loadConfig(tmpConfigPath)).toThrowError(ConfigLoadError);
    expect(() => loadConfig(tmpConfigPath)).toThrowError(
      /Config validation failed/
    );
  });

  it('throws for duplicate account ids', () => {
    writeConfig({ accounts: [VALID_ACCOUNT, { ...VALID_ACCOUNT }] });
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
    writeConfig({
      accounts: [
        {
          ...VALID_ACCOUNT,
          dispatchers: [{ type: 'unknown-type', url: 'https://example.com' }]
        }
      ]
    });
    expect(() => loadConfig(tmpConfigPath)).toThrowError(ConfigLoadError);
    expect(() => loadConfig(tmpConfigPath)).toThrowError(
      /Config validation failed/
    );
  });

  it('reads from the default CONFIG_PATH env var when set', () => {
    writeConfig({ accounts: [VALID_ACCOUNT] });
    process.env.CONFIG_PATH = tmpConfigPath;
    const result = loadConfig();
    expect(result.accounts[0]!.id).toBe('test-account');
  });

  it('reads from the provided path argument, ignoring CONFIG_PATH', () => {
    const altPath = join(tmpDir, 'alt-config.json');
    writeConfig({ accounts: [{ ...VALID_ACCOUNT, id: 'alt-account' }] }, altPath);
    process.env.CONFIG_PATH = tmpConfigPath; // not the alt path
    // alt path doesn't exist at tmpConfigPath, would fail if it tried to read it
    const result = loadConfig(altPath);
    expect(result.accounts[0]!.id).toBe('alt-account');
  });

  it('throws a clear error for invalid JSON', () => {
    writeFileSync(tmpConfigPath, 'not valid json', 'utf-8');
    expect(() => loadConfig(tmpConfigPath)).toThrowError(ConfigLoadError);
    expect(() => loadConfig(tmpConfigPath)).toThrowError(
      /not valid JSON/
    );
  });

  describe('objectStorage', () => {
    it('is undefined when omitted', () => {
      writeConfig({ accounts: [VALID_ACCOUNT] });
      const result = loadConfig(tmpConfigPath);
      expect(result.objectStorage).toBeUndefined();
    });

    it('parses a valid block and defaults urlTtlSeconds to 900', () => {
      writeConfig({ accounts: [VALID_ACCOUNT], objectStorage: VALID_OBJECT_STORAGE });
      const result = loadConfig(tmpConfigPath);
      expect(result.objectStorage).toMatchObject({
        bucket: 'mail-tool-blobs',
        region: 'us-east-1',
        urlTtlSeconds: 900
      });
    });

    it('accepts an explicit urlTtlSeconds and endpoint/forcePathStyle for S3-compatible endpoints', () => {
      writeConfig({
        accounts: [VALID_ACCOUNT],
        objectStorage: {
          ...VALID_OBJECT_STORAGE,
          endpoint: 'http://localhost:9000',
          forcePathStyle: true,
          urlTtlSeconds: 60
        }
      });
      const result = loadConfig(tmpConfigPath);
      expect(result.objectStorage).toMatchObject({
        endpoint: 'http://localhost:9000',
        forcePathStyle: true,
        urlTtlSeconds: 60
      });
    });

    it('throws when credentials are missing', () => {
      writeConfig({
        accounts: [VALID_ACCOUNT],
        objectStorage: { bucket: 'mail-tool-blobs' }
      });
      expect(() => loadConfig(tmpConfigPath)).toThrowError(ConfigLoadError);
      expect(() => loadConfig(tmpConfigPath)).toThrowError(
        /Config validation failed/
      );
    });
  });
});
