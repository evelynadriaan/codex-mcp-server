import path from 'path';
import { readFileSync } from 'fs';

import { CodexToolSchema } from '../types.js';
import {
  SERVER_CONFIG,
  STARTUP_LOG_ENV_VAR,
  getServerVersion,
  isStartupLoggingEnabled,
} from '../runtime-config.js';

describe('runtime config', () => {
  test('uses package version for server config', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
      version: string;
    };

    expect(SERVER_CONFIG.name).toBe('codex-mcp-server');
    expect(SERVER_CONFIG.version).toBe(packageJson.version);
    expect(getServerVersion(path.join(process.cwd(), 'src', 'index.ts'))).toBe(
      packageJson.version
    );
  });

  test('startup logging is disabled by default', () => {
    expect(isStartupLoggingEnabled({})).toBe(false);
  });

  test('startup logging can be enabled via env var', () => {
    expect(isStartupLoggingEnabled({ [STARTUP_LOG_ENV_VAR]: '1' })).toBe(true);
    expect(isStartupLoggingEnabled({ [STARTUP_LOG_ENV_VAR]: 'true' })).toBe(
      true
    );
  });

  test('codex schema accepts a positive timeout override', () => {
    const parsedArgs = CodexToolSchema.parse({
      prompt: 'test prompt',
      timeoutMs: 250,
    });

    expect(parsedArgs).toEqual(expect.objectContaining({ timeoutMs: 250 }));
  });

  test('codex schema rejects invalid timeout overrides', () => {
    expect(() =>
      CodexToolSchema.parse({
        prompt: 'test prompt',
        timeoutMs: 0,
      })
    ).toThrow();

    expect(() =>
      CodexToolSchema.parse({
        prompt: 'test prompt',
        timeoutMs: -1,
      })
    ).toThrow();

    expect(() =>
      CodexToolSchema.parse({
        prompt: 'test prompt',
        timeoutMs: 12.5,
      })
    ).toThrow();
  });
});
