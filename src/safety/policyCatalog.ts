import type { AccessMode } from './accessMode';
import { assertCanMutate } from './accessMode';
import { EngineeringError } from '../contracts/errors';

export type ToolGroup = 'workspace' | 'read' | 'author' | 'verify';

export interface ToolPolicy {
  name: string;
  group: ToolGroup;
  mutatesDisk: boolean;
  requiresAuthoring: boolean;
  defaultMaxPayloadBytes: number;
  description: string;
}

export const TOOL_POLICIES: Readonly<Record<string, ToolPolicy>> = {
  // Group A: Workspace & Self-Diagnostics
  workspace_status: {
    name: 'workspace_status',
    group: 'workspace',
    mutatesDisk: false,
    requiresAuthoring: false,
    defaultMaxPayloadBytes: 32_768,
    description: 'Inspect workspace root, access mode, catalog count, and circuit file health.',
  },
  catalog_search: {
    name: 'catalog_search',
    group: 'workspace',
    mutatesDisk: false,
    requiresAuthoring: false,
    defaultMaxPayloadBytes: 32_768,
    description: 'Search FluidSIM 4.5 component schemas, ports, and valid parameter keys.',
  },
  fluidsim_doctor: {
    name: 'fluidsim_doctor',
    group: 'workspace',
    mutatesDisk: false,
    requiresAuthoring: false,
    defaultMaxPayloadBytes: 16_384,
    description: 'Run headless codec self-test, workspace permissions, and catalog integrity checks.',
  },

  // Group B: Semantic Inspection
  circuit_inspect: {
    name: 'circuit_inspect',
    group: 'read',
    mutatesDisk: false,
    requiresAuthoring: false,
    defaultMaxPayloadBytes: 24_576,
    description: 'Compact single-call overview of a circuit file with immediate validation counts.',
  },
  circuit_export_netlist: {
    name: 'circuit_export_netlist',
    group: 'read',
    mutatesDisk: false,
    requiresAuthoring: false,
    defaultMaxPayloadBytes: 32_768,
    description: 'Export LLM-optimized semantic netlist (json or compact-text) with zero geometry noise.',
  },
  circuit_get_label_map: {
    name: 'circuit_get_label_map',
    group: 'read',
    mutatesDisk: false,
    requiresAuthoring: false,
    defaultMaxPayloadBytes: 24_576,
    description: 'Cross-reference map of cylinders, distance rules, switches, relays, solenoids, and valve pilots.',
  },
  circuit_query_components: {
    name: 'circuit_query_components',
    group: 'read',
    mutatesDisk: false,
    requiresAuthoring: false,
    defaultMaxPayloadBytes: 32_768,
    description: 'Paginated filtered component lookup with full parameters and connected neighbors.',
  },
  circuit_render_svg: {
    name: 'circuit_render_svg',
    group: 'read',
    mutatesDisk: false,
    requiresAuthoring: false,
    defaultMaxPayloadBytes: 131_072,
    description: 'Render headless ISO 1219 SVG schematic preview and quantitative visual/F9 layout diagnostics.',
  },

  // Group C: Headless Authoring & Refactoring
  project_create: {
    name: 'project_create',
    group: 'author',
    mutatesDisk: true,
    requiresAuthoring: true,
    defaultMaxPayloadBytes: 16_384,
    description: 'Create a FluidSIM project folder inside the workspace with optional starter circuit.',
  },
  circuit_create: {
    name: 'circuit_create',
    group: 'author',
    mutatesDisk: true,
    requiresAuthoring: true,
    defaultMaxPayloadBytes: 16_384,
    description: 'Create a new circuit file from a standard template inside the workspace jail.',
  },
  circuit_build: {
    name: 'circuit_build',
    group: 'author',
    mutatesDisk: true,
    requiresAuthoring: true,
    defaultMaxPayloadBytes: 32_768,
    description: 'One-call Semantic IR v2 circuit builder with named nets, inline port terminators, D4 orientation, auto-layout, F9 verification, and SVG quality score.',
  },
  circuit_clone: {
    name: 'circuit_clone',
    group: 'author',
    mutatesDisk: true,
    requiresAuthoring: true,
    defaultMaxPayloadBytes: 16_384,
    description: 'Clone an existing circuit file to a new path (optionally converting between .fsim.json and .ct).',
  },
  circuit_rename: {
    name: 'circuit_rename',
    group: 'author',
    mutatesDisk: true,
    requiresAuthoring: true,
    defaultMaxPayloadBytes: 16_384,
    description: 'Rename or move a circuit file inside the workspace jail.',
  },
  circuit_delete: {
    name: 'circuit_delete',
    group: 'author',
    mutatesDisk: true,
    requiresAuthoring: true,
    defaultMaxPayloadBytes: 16_384,
    description: 'Delete a circuit file inside the workspace jail.',
  },
  circuit_apply_patch: {
    name: 'circuit_apply_patch',
    group: 'author',
    mutatesDisk: true,
    requiresAuthoring: true,
    defaultMaxPayloadBytes: 24_576,
    description: 'Transactional batch mutation with preflight, auto-layout, atomic write, and postcondition checks.',
  },
  circuit_generate_from_spec: {
    name: 'circuit_generate_from_spec',
    group: 'author',
    mutatesDisk: true,
    requiresAuthoring: true,
    defaultMaxPayloadBytes: 32_768,
    description: 'One-shot declarative generator for pneumatic/electro-pneumatic sequence circuits with verification.',
  },
  circuit_auto_layout: {
    name: 'circuit_auto_layout',
    group: 'author',
    mutatesDisk: true,
    requiresAuthoring: true,
    defaultMaxPayloadBytes: 16_384,
    description: 'Re-compute clean ISO 1219 pneumatic layers and 24V/0V ladder orthogonal routing.',
  },

  // Group D: Verification & Headless Simulation
  circuit_validate: {
    name: 'circuit_validate',
    group: 'verify',
    mutatesDisk: false,
    requiresAuthoring: false,
    defaultMaxPayloadBytes: 32_768,
    description: 'Run static pneumatic, electrical, label-binding, and opposing-pilot lint rules.',
  },
  circuit_simulate: {
    name: 'circuit_simulate',
    group: 'verify',
    mutatesDisk: false,
    requiresAuthoring: false,
    defaultMaxPayloadBytes: 32_768,
    description: 'Run deterministic coupled electrical + pneumatic discrete-time simulation.',
  },
  circuit_verify_sequence: {
    name: 'circuit_verify_sequence',
    group: 'verify',
    mutatesDisk: false,
    requiresAuthoring: false,
    defaultMaxPayloadBytes: 24_576,
    description: 'Execute scripted triggers and assert actuator sequence and optional E-stop compliance.',
  },
};

export function getToolPolicy(toolName: string): ToolPolicy {
  const policy = TOOL_POLICIES[toolName];
  if (!policy) {
    throw new EngineeringError({
      category: 'AccessDenied',
      code: 'UNKNOWN_TOOL_POLICY',
      message: `Tool "${toolName}" is not registered in the safety policy catalog.`,
      offendingIds: [toolName],
      suggestedFix: 'Invoke one of the documented fluidsim-pneumatics-mcp tools.',
    });
  }
  return policy;
}

export function enforceToolPolicy(toolName: string, mode: AccessMode): ToolPolicy {
  const policy = getToolPolicy(toolName);
  if (policy.requiresAuthoring) {
    assertCanMutate(mode, toolName);
  }
  return policy;
}
