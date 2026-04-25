import { spawn } from 'child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { promisify } from 'util';
import { exec } from 'child_process';

const execAsync = promisify(exec);

const JSONRPC_VERSION = '2.0';
const TEST_TIMEOUT_MS = 10000;

async function ensureBuild(distPath: string): Promise<void> {
  if (existsSync(distPath)) return;
  await execAsync('npm run build');
}

function createCodexStub(): string {
  const stubDir = mkdtempSync(path.join(tmpdir(), 'codex-mcp-life-'));
  const stubPath = path.join(stubDir, 'codex');
  const stubScript = `#!/bin/sh
printf "stub stdout\\n"
printf "thread id: th_lifecycle_123\\n" 1>&2
printf "session id: sess_lifecycle_123\\n" 1>&2
exit 0
`;
  writeFileSync(stubPath, stubScript, { mode: 0o755 });
  chmodSync(stubPath, 0o755);
  return stubDir;
}

describe('MCP server lifecycle', () => {
  jest.setTimeout(TEST_TIMEOUT_MS);

  let server: ReturnType<typeof spawn> | null = null;
  let stubDir: string | null = null;
  let buffer = '';
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  const pending = new Map<number, (payload: unknown) => void>();

  const sendRequest = (request: Record<string, unknown>) =>
    new Promise<unknown>((resolve, reject) => {
      if (!server?.stdin) {
        reject(new Error('Server stdin not available'));
        return;
      }

      const id = request.id as number;
      const timer = globalThis.setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for response ${id}`));
      }, TEST_TIMEOUT_MS);

      pending.set(id, (payload) => {
        globalThis.clearTimeout(timer);
        resolve(payload);
      });

      server.stdin.write(`${JSON.stringify(request)}\n`);
    });

  beforeAll(async () => {
    const distPath = path.join(process.cwd(), 'dist', 'index.js');
    await ensureBuild(distPath);
    stubDir = createCodexStub();

    server = spawn(process.execPath, [distPath], {
      env: {
        ...process.env,
        PATH: `${stubDir}${path.delimiter}${process.env.PATH}`,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    server.stdout?.setEncoding('utf8');
    server.stdout?.on('data', (chunk: string) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf('\n');

      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);

        if (line) {
          try {
            const payload = JSON.parse(line) as {
              id?: number;
              result?: unknown;
            };

            if (typeof payload.id === 'number') {
              const resolver = pending.get(payload.id);
              if (resolver) {
                resolver(payload.result ?? payload);
                pending.delete(payload.id);
              }
            }
          } catch {
            // Ignore non-JSON output
          }
        }

        newlineIndex = buffer.indexOf('\n');
      }
    });

    server.stderr?.on('data', () => {});
    server.on('exit', (code, signal) => {
      exitCode = code;
      exitSignal = signal;
    });
  });

  afterAll(async () => {
    if (server && exitCode === null && exitSignal === null) {
      server.kill();
      await new Promise((resolve) => server?.once('exit', resolve));
    }

    if (stubDir) {
      rmSync(stubDir, { recursive: true, force: true });
    }
  });

  test('stays alive across sequential codex tool calls', async () => {
    await sendRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      },
    });

    server?.stdin?.write(
      `${JSON.stringify({
        jsonrpc: JSONRPC_VERSION,
        method: 'notifications/initialized',
        params: {},
      })}\n`
    );

    await sendRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 2,
      method: 'tools/list',
      params: {},
    });

    const firstResponse = (await sendRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 3,
      method: 'tools/call',
      params: { name: 'codex', arguments: { prompt: 'echo hello' } },
    })) as {
      content: Array<{ text: string }>;
    };

    expect(firstResponse.content[0]?.text).toBe('stub stdout\n');
    expect({ exitCode, exitSignal }).toEqual({ exitCode: null, exitSignal: null });

    await new Promise((resolve) => globalThis.setTimeout(resolve, 250));
    expect({ exitCode, exitSignal }).toEqual({ exitCode: null, exitSignal: null });

    const secondResponse = (await sendRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 4,
      method: 'tools/call',
      params: { name: 'codex', arguments: { prompt: 'echo world' } },
    })) as {
      content: Array<{ text: string }>;
    };

    expect(secondResponse.content[0]?.text).toBe('stub stdout\n');
    expect({ exitCode, exitSignal }).toEqual({ exitCode: null, exitSignal: null });
  });
});
