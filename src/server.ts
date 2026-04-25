import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import chalk from 'chalk';

import {
  type ServerConfig,
  type ToolName,
  type ToolResult,
  type ToolHandlerContext,
  type ProgressToken,
  TOOLS,
} from './types.js';
import { handleError } from './errors.js';
import { toolDefinitions } from './tools/definitions.js';
import { toolHandlers } from './tools/handlers.js';

export class CodexMcpServer {
  private readonly server: Server;
  private readonly config: ServerConfig;
  private callQueue: Promise<void> = Promise.resolve();
  private readonly toolTimeoutMs: number;

  constructor(config: ServerConfig) {
    this.config = config;
    this.toolTimeoutMs = this.getToolTimeoutMs();
    this.server = new Server(
      {
        name: config.name,
        version: config.version,
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers();
  }

  private setupHandlers(): void {
    // List tools handler
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return { tools: toolDefinitions };
    });

    // Call tool handler
    this.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const { name, arguments: args } = request.params;
      const progressToken = request.params._meta?.progressToken as ProgressToken | undefined;

      // Create progress sender that uses MCP notifications
      const createProgressContext = (): ToolHandlerContext => {
        let progressCount = 0;
        return {
          progressToken,
          sendProgress: async (message: string, progress?: number, total?: number) => {
            if (!progressToken) return;

            progressCount++;
            try {
              await extra.sendNotification({
                method: 'notifications/progress',
                params: {
                  progressToken,
                  progress: progress ?? progressCount,
                  total,
                  message,
                },
              });
            } catch (err) {
              // Log but don't fail the operation if progress notification fails
              console.error(chalk.yellow('Failed to send progress notification:'), err);
            }
          },
        };
      };

      try {
        const nextCall = this.callQueue.then(async () => {
          if (!this.isValidToolName(name)) {
            throw new Error(`Unknown tool: ${name}`);
          }

          const handler = toolHandlers[name];
          const context = createProgressContext();
          return await this.withTimeout(
            handler.execute(args, context),
            this.toolTimeoutMs
          );
        });

        this.callQueue = nextCall.then(
          () => undefined,
          () => undefined
        );

        return await nextCall;
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: handleError(error, `tool "${name}"`),
            },
          ],
          isError: true,
        };
      }
    });
  }

  private isValidToolName(name: string): name is ToolName {
    return Object.values(TOOLS).includes(name as ToolName);
  }

  private getToolTimeoutMs(): number {
    const rawTimeout = process.env.CODEX_TOOL_TIMEOUT_MS;
    if (!rawTimeout) {
      return 120_000;
    }

    const parsedTimeout = Number.parseInt(rawTimeout, 10);
    if (Number.isFinite(parsedTimeout) && parsedTimeout > 0) {
      return parsedTimeout;
    }

    return 120_000;
  }

  private async withTimeout<T>(
    operation: Promise<T>,
    timeoutMs: number
  ): Promise<T> {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    try {
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`Tool call timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      });

      return await Promise.race([operation, timeoutPromise]);
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error(chalk.green(`${this.config.name} started successfully`));
  }
}
