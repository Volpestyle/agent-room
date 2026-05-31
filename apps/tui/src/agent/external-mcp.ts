import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { DashboardConfig } from "../types.js";

const DEFAULT_MCP_TIMEOUT_MS = 30_000;

type ConfiguredMcpServer = NonNullable<DashboardConfig["mcp"]>["servers"][string];

export interface DashboardMcpToolSummary {
  server: string;
  name: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: unknown;
}

export interface DashboardMcpServerStatus {
  server: string;
  type: "stdio" | "streamable-http" | "sse";
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  description?: string;
  allowedTools?: string[];
  disabled?: boolean;
  error?: string;
  tools?: DashboardMcpToolSummary[];
}

interface ResolvedMcpServer {
  type: "stdio" | "streamable-http" | "sse";
  command?: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  url?: string;
  description?: string;
  allowedTools?: string[];
  disabled?: boolean;
}

export async function listDashboardMcpTools(
  config: DashboardConfig,
  input: { server?: string } = {},
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<DashboardMcpServerStatus[]> {
  const configs = resolveDashboardMcpServerConfigs(config, options);
  const selected =
    input.server === undefined ? Object.keys(configs) : [input.server];

  const statuses: DashboardMcpServerStatus[] = [];
  for (const server of selected) {
    const serverConfig = configs[server];
    if (serverConfig === undefined) {
      statuses.push({
        server,
        type: "stdio",
        error: `Unknown MCP server: ${server}`,
      });
      continue;
    }
    statuses.push(await listServerTools(server, serverConfig, options));
  }
  return statuses;
}

export async function callDashboardMcpTool(
  config: DashboardConfig,
  input: { server: string; tool: string; arguments?: unknown },
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<unknown> {
  const configs = resolveDashboardMcpServerConfigs(config, options);
  const serverConfig = configs[input.server];
  if (serverConfig === undefined) {
    throw new Error(`Unknown MCP server: ${input.server}`);
  }
  if (serverConfig.disabled === true) {
    throw new Error(`MCP server is disabled: ${input.server}`);
  }
  if (
    serverConfig.allowedTools !== undefined &&
    !serverConfig.allowedTools.includes(input.tool)
  ) {
    throw new Error(
      `Tool ${input.tool} is not allowed for MCP server ${input.server}.`,
    );
  }

  return await withMcpClient(input.server, serverConfig, options, async (client) => {
    return await client.callTool({
      name: input.tool,
      arguments: normalizeToolArguments(input.arguments),
    });
  });
}

function resolveDashboardMcpServerConfigs(
  config: DashboardConfig,
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Record<string, ResolvedMcpServer> {
  const cwd = options.cwd ?? config.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const servers = config.mcp?.servers ?? {};
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => [
      name,
      resolveServerConfig(server, cwd, env),
    ]),
  );
}

function resolveServerConfig(
  config: ConfiguredMcpServer,
  cwd: string,
  env: NodeJS.ProcessEnv,
): ResolvedMcpServer {
  const type = normalizeTransportKind(config.type);
  return {
    type,
    ...(config.command !== undefined ? { command: config.command } : {}),
    args: config.args ?? [],
    cwd: config.cwd !== undefined ? resolve(cwd, config.cwd) : cwd,
    env: definedEnv(env),
    ...(config.url !== undefined ? { url: config.url } : {}),
    ...(config.description !== undefined
      ? { description: config.description }
      : {}),
    ...(config.allowedTools !== undefined
      ? { allowedTools: config.allowedTools }
      : {}),
    ...(config.disabled !== undefined ? { disabled: config.disabled } : {}),
  };
}

function normalizeTransportKind(
  kind: ConfiguredMcpServer["type"],
): "stdio" | "streamable-http" | "sse" {
  if (kind === "stdio" || kind === "sse") return kind;
  return "streamable-http";
}

async function listServerTools(
  server: string,
  config: ResolvedMcpServer,
  options: { timeoutMs?: number },
): Promise<DashboardMcpServerStatus> {
  const statusBase = serverStatusBase(server, config);
  if (config.disabled === true) return statusBase;

  try {
    const tools = await withMcpClient(server, config, options, async (client) => {
      const result = await client.listTools();
      return result.tools
        .filter(
          (tool) =>
            config.allowedTools === undefined ||
            config.allowedTools.includes(tool.name),
        )
        .map((tool) => ({
          server,
          name: tool.name,
          ...(tool.description !== undefined
            ? { description: tool.description }
            : {}),
          ...(tool.inputSchema !== undefined
            ? { inputSchema: tool.inputSchema }
            : {}),
          ...(tool.outputSchema !== undefined
            ? { outputSchema: tool.outputSchema }
            : {}),
          ...(tool.annotations !== undefined
            ? { annotations: tool.annotations }
            : {}),
        }));
    });
    return { ...statusBase, tools };
  } catch (error) {
    return {
      ...statusBase,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function serverStatusBase(
  server: string,
  config: ResolvedMcpServer,
): DashboardMcpServerStatus {
  return {
    server,
    type: config.type,
    ...(config.command !== undefined ? { command: config.command } : {}),
    ...(config.args.length > 0 ? { args: config.args } : {}),
    ...(config.type === "stdio" ? { cwd: config.cwd } : {}),
    ...(config.url !== undefined ? { url: config.url } : {}),
    ...(config.description !== undefined
      ? { description: config.description }
      : {}),
    ...(config.allowedTools !== undefined
      ? { allowedTools: config.allowedTools }
      : {}),
    ...(config.disabled !== undefined ? { disabled: config.disabled } : {}),
  };
}

async function withMcpClient<T>(
  server: string,
  config: ResolvedMcpServer,
  options: { timeoutMs?: number },
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const transport = createTransport(config);
  const client = new Client({ name: "agentroom-dashboard", version: "0.1.0" });
  const timeoutMs = options.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;
  const timeout = new Promise<never>((_resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`MCP server ${server} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    timer.unref?.();
  });

  try {
    return await Promise.race([
      (async () => {
        await client.connect(transport);
        return await fn(client);
      })(),
      timeout,
    ]);
  } finally {
    await client.close().catch(() => undefined);
  }
}

function createTransport(config: ResolvedMcpServer): Transport {
  switch (config.type) {
    case "stdio":
      if (config.command === undefined) {
        throw new Error("stdio MCP server requires command");
      }
      return new StdioClientTransport({
        command: config.command,
        args: config.args,
        cwd: config.cwd,
        env: config.env,
        stderr: "pipe",
      });
    case "sse":
      if (config.url === undefined) throw new Error("SSE MCP server requires url");
      return new SSEClientTransport(new URL(config.url)) as unknown as Transport;
    case "streamable-http":
      if (config.url === undefined) throw new Error("HTTP MCP server requires url");
      return new StreamableHTTPClientTransport(
        new URL(config.url),
      ) as unknown as Transport;
  }
}

function normalizeToolArguments(args: unknown): Record<string, unknown> {
  if (args === undefined || args === null) return {};
  if (typeof args === "object" && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  throw new Error("mcp_call arguments must be a JSON object when provided.");
}

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}
