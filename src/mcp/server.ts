import crypto from 'node:crypto';
import type http from 'node:http';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { errResult, okResult } from '../contracts/errors';
import { assertPayloadBudget, DEFAULT_MAX_PAYLOAD_BYTES } from '../contracts/pagination';
import { enforceToolPolicy, TOOL_POLICIES } from '../safety/policyCatalog';
import type { AccessMode } from '../safety/accessMode';
import { WorkspaceGuard } from '../safety/workspaceGuard';
import type { McpToolContext } from './tools/context';
import {
  catalogSearchInputShape,
  circuitApplyPatchInputShape,
  circuitAutoLayoutInputShape,
  circuitCloneInputShape,
  circuitCreateInputShape,
  circuitDeleteInputShape,
  circuitExportNetlistInputShape,
  circuitGenerateFromSpecInputShape,
  circuitGetLabelMapInputShape,
  circuitInspectInputShape,
  circuitQueryComponentsInputShape,
  circuitRenameInputShape,
  circuitSimulateInputShape,
  circuitValidateInputShape,
  circuitVerifySequenceInputShape,
  fluidsimDoctorInputShape,
  projectCreateInputShape,
  workspaceStatusInputShape,
} from './toolSchemas';
import {
  handleCatalogSearch,
  handleFluidsimDoctor,
  handleWorkspaceStatus,
} from './tools/workspaceTools';
import {
  handleCircuitExportNetlist,
  handleCircuitGetLabelMap,
  handleCircuitInspect,
  handleCircuitQueryComponents,
} from './tools/readTools';
import {
  handleCircuitApplyPatch,
  handleCircuitAutoLayout,
  handleCircuitClone,
  handleCircuitCreate,
  handleCircuitDelete,
  handleCircuitGenerateFromSpec,
  handleCircuitRename,
  handleProjectCreate,
} from './tools/authorTools';
import {
  handleCircuitSimulate,
  handleCircuitValidate,
  handleCircuitVerifySequence,
} from './tools/verifyTools';

export const SERVER_NAME = 'fluidsim-pneumatics-mcp';
export const SERVER_VERSION = '0.2.0';

export interface CreateServerOptions {
  workspaceRoot: string;
  accessMode?: AccessMode;
  maxPayloadBytes?: number;
  createBackupOnOverwrite?: boolean;
  repoRoot?: string;
  initWorkspace?: boolean;
}

export interface StartHttpServerOptions extends CreateServerOptions {
  host?: string;
  port?: number;
}

/**
 * Recursively sanitizes JSON Schema emitted by Zod/MCP SDK so every tool definition
 * strictly conforms to Gemini / Google AI Studio / Antigravity OpenAPI 3.0 subset:
 * - Zero `$schema`, `additionalProperties`, `propertyNames`, `oneOf`, `anyOf`, `allOf`, `const`, `$defs`
 * - Zero union `type` arrays (e.g. `["string", "null"]` -> `"string"`)
 */
export function sanitizeGeminiJsonSchema(node: unknown): Record<string, unknown> {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    return { type: 'object', properties: {} };
  }
  const src = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [key, val] of Object.entries(src)) {
    if (
      key === '$schema' ||
      key === 'additionalProperties' ||
      key === 'propertyNames' ||
      key === 'oneOf' ||
      key === 'anyOf' ||
      key === 'allOf' ||
      key === '$defs' ||
      key === 'definitions' ||
      key === 'exclusiveMinimum' ||
      key === 'exclusiveMaximum' ||
      key === 'patternProperties'
    ) {
      continue;
    }

    if (key === 'const') {
      out.enum = [val];
      if (!out.type) {
        if (typeof val === 'string') out.type = 'string';
        else if (typeof val === 'number') out.type = 'number';
        else if (typeof val === 'boolean') out.type = 'boolean';
      }
      continue;
    }

    if (key === 'type') {
      if (Array.isArray(val)) {
        const primary = val.find((t) => t !== 'null') ?? 'string';
        out.type = primary;
      } else {
        out.type = val;
      }
      continue;
    }

    if (key === 'properties' && val && typeof val === 'object' && !Array.isArray(val)) {
      const cleanProps: Record<string, unknown> = {};
      for (const [pk, pv] of Object.entries(val as Record<string, unknown>)) {
        cleanProps[pk] = sanitizeGeminiJsonSchema(pv);
      }
      out.properties = cleanProps;
      continue;
    }

    if (key === 'items') {
      if (Array.isArray(val)) {
        out.items = sanitizeGeminiJsonSchema(val[0]);
      } else {
        out.items = sanitizeGeminiJsonSchema(val);
      }
      continue;
    }

    out[key] = val;
  }

  if (out.type === 'object' && !out.properties) {
    out.properties = {};
  }

  return out;
}

export function createFluidsimMcpServer(options: CreateServerOptions): {
  server: McpServer;
  context: McpToolContext;
} {
  const guard = new WorkspaceGuard({
    workspaceRoot: options.workspaceRoot,
    createBackupOnOverwrite: options.createBackupOnOverwrite ?? false,
  });

  const context: McpToolContext = {
    guard,
    accessMode: options.accessMode ?? 'read-only',
    maxPayloadBytes: options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
    serverVersion: SERVER_VERSION,
    repoRoot: options.repoRoot ?? process.cwd(),
  };

  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  const executeTool = <TArgs, TData>(
    toolName: string,
    args: TArgs,
    fn: (ctx: McpToolContext, a: TArgs) => TData,
  ) => {
    try {
      const policy = enforceToolPolicy(toolName, context.accessMode);
      const data = fn(context, args);
      const envelope = okResult(data);
      const budget = Math.min(context.maxPayloadBytes, policy.defaultMaxPayloadBytes);
      const requestedBudget =
        typeof (args as { maxBytes?: unknown })?.maxBytes === 'number'
          ? Math.min(context.maxPayloadBytes, Math.max(512, (args as { maxBytes: number }).maxBytes))
          : budget;
      assertPayloadBudget(envelope, requestedBudget, toolName);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(envelope) }],
      };
    } catch (err) {
      const failure = errResult(err);
      return {
        isError: true,
        content: [{ type: 'text' as const, text: JSON.stringify(failure) }],
      };
    }
  };

  // Group A: Workspace & Self-Diagnostics
  server.tool(
    'workspace_status',
    TOOL_POLICIES.workspace_status.description,
    workspaceStatusInputShape,
    async (args) => executeTool('workspace_status', args, handleWorkspaceStatus),
  );

  server.tool(
    'catalog_search',
    TOOL_POLICIES.catalog_search.description,
    catalogSearchInputShape,
    async (args) => executeTool('catalog_search', args, handleCatalogSearch),
  );

  server.tool(
    'fluidsim_doctor',
    TOOL_POLICIES.fluidsim_doctor.description,
    fluidsimDoctorInputShape,
    async () => executeTool('fluidsim_doctor', {}, (ctx) => handleFluidsimDoctor(ctx)),
  );

  // Group B: Semantic Inspection
  server.tool(
    'circuit_inspect',
    TOOL_POLICIES.circuit_inspect.description,
    circuitInspectInputShape,
    async (args) => executeTool('circuit_inspect', args, handleCircuitInspect),
  );

  server.tool(
    'circuit_export_netlist',
    TOOL_POLICIES.circuit_export_netlist.description,
    circuitExportNetlistInputShape,
    async (args) => executeTool('circuit_export_netlist', args, handleCircuitExportNetlist),
  );

  server.tool(
    'circuit_get_label_map',
    TOOL_POLICIES.circuit_get_label_map.description,
    circuitGetLabelMapInputShape,
    async (args) => executeTool('circuit_get_label_map', args, handleCircuitGetLabelMap),
  );

  server.tool(
    'circuit_query_components',
    TOOL_POLICIES.circuit_query_components.description,
    circuitQueryComponentsInputShape,
    async (args) => executeTool('circuit_query_components', args, handleCircuitQueryComponents),
  );

  // Group C: Headless Authoring & Project Lifecycle
  server.tool(
    'project_create',
    TOOL_POLICIES.project_create.description,
    projectCreateInputShape,
    async (args) => executeTool('project_create', args, handleProjectCreate),
  );

  server.tool(
    'circuit_create',
    TOOL_POLICIES.circuit_create.description,
    circuitCreateInputShape,
    async (args) => executeTool('circuit_create', args, handleCircuitCreate),
  );

  server.tool(
    'circuit_clone',
    TOOL_POLICIES.circuit_clone.description,
    circuitCloneInputShape,
    async (args) => executeTool('circuit_clone', args, handleCircuitClone),
  );

  server.tool(
    'circuit_rename',
    TOOL_POLICIES.circuit_rename.description,
    circuitRenameInputShape,
    async (args) => executeTool('circuit_rename', args, handleCircuitRename),
  );

  server.tool(
    'circuit_delete',
    TOOL_POLICIES.circuit_delete.description,
    circuitDeleteInputShape,
    async (args) => executeTool('circuit_delete', args, handleCircuitDelete),
  );

  server.tool(
    'circuit_apply_patch',
    TOOL_POLICIES.circuit_apply_patch.description,
    circuitApplyPatchInputShape,
    async (args) => executeTool('circuit_apply_patch', args, handleCircuitApplyPatch),
  );

  server.tool(
    'circuit_generate_from_spec',
    TOOL_POLICIES.circuit_generate_from_spec.description,
    circuitGenerateFromSpecInputShape,
    async (args) => executeTool('circuit_generate_from_spec', args, handleCircuitGenerateFromSpec),
  );

  server.tool(
    'circuit_auto_layout',
    TOOL_POLICIES.circuit_auto_layout.description,
    circuitAutoLayoutInputShape,
    async (args) => executeTool('circuit_auto_layout', args, handleCircuitAutoLayout),
  );

  // Group D: Verification & Headless Simulation
  server.tool(
    'circuit_validate',
    TOOL_POLICIES.circuit_validate.description,
    circuitValidateInputShape,
    async (args) => executeTool('circuit_validate', args, handleCircuitValidate),
  );

  server.tool(
    'circuit_simulate',
    TOOL_POLICIES.circuit_simulate.description,
    circuitSimulateInputShape,
    async (args) => executeTool('circuit_simulate', args, handleCircuitSimulate),
  );

  server.tool(
    'circuit_verify_sequence',
    TOOL_POLICIES.circuit_verify_sequence.description,
    circuitVerifySequenceInputShape,
    async (args) => executeTool('circuit_verify_sequence', args, handleCircuitVerifySequence),
  );

  // Wrap tools/list handler to strip non-Gemini JSON Schema keywords ($schema, additionalProperties, etc.)
  const internalHandlers = (
    server.server as unknown as {
      _requestHandlers?: Map<string, (req: unknown, extra: unknown) => Promise<unknown>>;
    }
  )._requestHandlers;
  const originalListTools = internalHandlers?.get('tools/list');
  if (originalListTools) {
    server.server.setRequestHandler(ListToolsRequestSchema, async (req, extra) => {
      const result = (await originalListTools(req, extra)) as {
        tools: Array<{ inputSchema?: Record<string, unknown>; [k: string]: unknown }>;
      };
      return {
        ...result,
        tools: result.tools.map((tool) => ({
          ...tool,
          ...(tool.inputSchema ? { inputSchema: sanitizeGeminiJsonSchema(tool.inputSchema) } : {}),
        })),
      };
    });
  }

  return { server, context };
}

export async function startStdioServer(options: CreateServerOptions): Promise<void> {
  const { server, context } = createFluidsimMcpServer(options);
  context.guard.ensureRootExists({
    createIfMissing: options.initWorkspace === true || context.accessMode === 'authoring',
  });

  const transport = new StdioServerTransport();
  // Strictly log diagnostics to stderr so stdout carries pure JSON-RPC frames
  process.stderr.write(
    `[${SERVER_NAME}] v${SERVER_VERSION} ready on stdio (workspace=${context.guard.root}, mode=${context.accessMode}, maxPayloadBytes=${context.maxPayloadBytes})\n`,
  );
  await server.connect(transport);
}

export async function startHttpServer(options: StartHttpServerOptions): Promise<{
  httpServer: http.Server;
  url: string;
  close: () => Promise<void>;
}> {
  const accessMode = options.accessMode ?? 'read-only';
  const guard = new WorkspaceGuard({
    workspaceRoot: options.workspaceRoot,
    createBackupOnOverwrite: options.createBackupOnOverwrite ?? false,
  });
  guard.ensureRootExists({
    createIfMissing: options.initWorkspace === true || accessMode === 'authoring',
  });

  const app = express();
  app.use(express.json({ limit: '4mb' }));

  const sessions = new Map<
    string,
    { server: McpServer; transport: StreamableHTTPServerTransport }
  >();

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      name: SERVER_NAME,
      version: SERVER_VERSION,
      transport: 'streamable-http',
      accessMode,
      workspaceRoot: guard.root,
      activeSessions: sessions.size,
    });
  });

  app.post('/mcp', async (req, res) => {
    try {
      const sessionIdHeader = req.headers['mcp-session-id'];
      const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;

      if (sessionId && sessions.has(sessionId)) {
        const entry = sessions.get(sessionId)!;
        await entry.transport.handleRequest(req, res, req.body);
        return;
      }

      if (!sessionId && isInitializeRequest(req.body)) {
        const { server } = createFluidsimMcpServer(options);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: (sid) => {
            sessions.set(sid, { server, transport });
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) {
            sessions.delete(transport.sessionId);
          }
          void server.close();
        };
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      }

      if (sessionId && !sessions.has(sessionId)) {
        res.status(404).json({
          jsonrpc: '2.0',
          error: { code: -32001, message: `Unknown MCP session ID: ${sessionId}` },
          id: null,
        });
        return;
      }

      // Stateless fallback for direct JSON-RPC POST without session header
      const { server } = createFluidsimMcpServer(options);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: err instanceof Error ? err.message : String(err),
          },
          id: null,
        });
      }
    }
  });

  app.get('/mcp', async (req, res) => {
    const sessionIdHeader = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;
    if (!sessionId || !sessions.has(sessionId)) {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Missing or invalid mcp-session-id header for GET /mcp SSE stream.' },
        id: null,
      });
      return;
    }
    const entry = sessions.get(sessionId)!;
    await entry.transport.handleRequest(req, res);
  });

  app.delete('/mcp', async (req, res) => {
    const sessionIdHeader = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;
    if (!sessionId || !sessions.has(sessionId)) {
      res.status(404).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Unknown mcp-session-id for DELETE /mcp.' },
        id: null,
      });
      return;
    }
    const entry = sessions.get(sessionId)!;
    await entry.transport.handleRequest(req, res);
    sessions.delete(sessionId);
    await entry.transport.close();
    await entry.server.close();
  });

  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 3000;

  const httpServer = await new Promise<http.Server>((resolve, reject) => {
    const srv = app.listen(port, host, () => resolve(srv));
    srv.on('error', reject);
  });

  const addr = httpServer.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  const url = `http://${host}:${actualPort}/mcp`;

  process.stderr.write(
    `[${SERVER_NAME}] v${SERVER_VERSION} ready on Streamable HTTP (${url}, workspace=${guard.root}, mode=${accessMode})\n`,
  );

  const close = async (): Promise<void> => {
    for (const entry of sessions.values()) {
      await entry.transport.close();
      await entry.server.close();
    }
    sessions.clear();
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()));
    });
  };

  return { httpServer, url, close };
}
