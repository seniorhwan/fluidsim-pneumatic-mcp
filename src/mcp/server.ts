import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
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
  circuitCreateInputShape,
  circuitExportNetlistInputShape,
  circuitGenerateFromSpecInputShape,
  circuitGetLabelMapInputShape,
  circuitInspectInputShape,
  circuitQueryComponentsInputShape,
  circuitSimulateInputShape,
  circuitValidateInputShape,
  circuitVerifySequenceInputShape,
  fluidsimDoctorInputShape,
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
  handleCircuitCreate,
  handleCircuitGenerateFromSpec,
} from './tools/authorTools';
import {
  handleCircuitSimulate,
  handleCircuitValidate,
  handleCircuitVerifySequence,
} from './tools/verifyTools';

export const SERVER_NAME = 'fluidsim-pneumatics-mcp';
export const SERVER_VERSION = '0.1.0';

export interface CreateServerOptions {
  workspaceRoot: string;
  accessMode?: AccessMode;
  maxPayloadBytes?: number;
  createBackupOnOverwrite?: boolean;
  repoRoot?: string;
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
      // Callers may tighten maxBytes per call, but never exceed the server-configured hard ceiling
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

  // Group C: Headless Authoring & Refactoring
  server.tool(
    'circuit_create',
    TOOL_POLICIES.circuit_create.description,
    circuitCreateInputShape,
    async (args) => executeTool('circuit_create', args, handleCircuitCreate),
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

  return { server, context };
}

export async function startStdioServer(options: CreateServerOptions): Promise<void> {
  const { server, context } = createFluidsimMcpServer(options);
  context.guard.ensureRootExists();

  const transport = new StdioServerTransport();
  // Strictly log diagnostics to stderr so stdout carries pure JSON-RPC frames
  process.stderr.write(
    `[${SERVER_NAME}] v${SERVER_VERSION} ready on stdio (workspace=${context.guard.root}, mode=${context.accessMode}, maxPayloadBytes=${context.maxPayloadBytes})\n`,
  );
  await server.connect(transport);
}
