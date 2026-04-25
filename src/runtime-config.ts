import { existsSync, readFileSync } from 'fs';
import path from 'path';

export const STARTUP_LOG_ENV_VAR = 'CODEX_MCP_DEBUG_STARTUP' as const;

function getPackageJsonPath(entryScriptPath = process.argv[1]): string {
  if (entryScriptPath) {
    const candidatePaths = [
      path.resolve(path.dirname(entryScriptPath), '../package.json'),
      path.resolve(path.dirname(entryScriptPath), 'package.json'),
    ];

    for (const candidatePath of candidatePaths) {
      if (existsSync(candidatePath)) {
        return candidatePath;
      }
    }
  }

  return path.resolve(process.cwd(), 'package.json');
}

export function getServerVersion(entryScriptPath = process.argv[1]): string {
  try {
    const packageJson = JSON.parse(
      readFileSync(getPackageJsonPath(entryScriptPath), 'utf8')
    ) as { version?: string };

    return packageJson.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const SERVER_CONFIG = {
  name: 'codex-mcp-server',
  version: getServerVersion(),
} as const;

export function isStartupLoggingEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  const rawValue = env[STARTUP_LOG_ENV_VAR];
  if (!rawValue) {
    return false;
  }

  return ['1', 'true', 'yes', 'on'].includes(rawValue.toLowerCase());
}
