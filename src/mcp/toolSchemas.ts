import { z } from 'zod';

const portRefSchema = z.object({
  componentId: z.string().min(1).describe('Component ID (e.g. "V_A", "CYL_A").'),
  port: z.string().min(1).describe('ISO 1219 or IEC port name (e.g. "1", "2", "4", "14", "A", "A1").'),
});

const distanceMarkerSchema = z.object({
  label: z.string().min(1).describe('Sensor marker label (e.g. "a0", "a1").'),
  positionMm: z.number().min(0).describe('Stroke position in mm.'),
  toleranceMm: z.number().positive().optional().describe('Detection window in mm (default 2).'),
});

const actuationSideSchema = z.object({
  type: z.enum([
    'none',
    'pushbutton',
    'detent',
    'roller',
    'idle_return_roller',
    'pneumatic_pilot',
    'solenoid',
    'spring',
  ]),
  label: z.string().optional().describe('Binding label for solenoid (Y1), roller (a1), or pushbutton (S1).'),
});

const componentNodeSchema = z.object({
  id: z.string().min(1).describe('Unique component ID.'),
  type: z.string().min(1).describe('Catalog componentType from catalog_search.'),
  label: z.string().optional().describe('Engineering label (A, K1, Y1, S1, a1).'),
  params: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).default({}),
  leftActuation: actuationSideSchema.optional(),
  rightActuation: actuationSideSchema.optional(),
  distanceRule: z.array(distanceMarkerSchema).optional(),
});

export const patchOpSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('add_component'),
    component: componentNodeSchema,
  }),
  z.object({
    op: z.literal('update_component'),
    id: z.string().min(1),
    patch: z.object({
      label: z.string().optional(),
      params: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).optional(),
      leftActuation: actuationSideSchema.optional(),
      rightActuation: actuationSideSchema.optional(),
      distanceRule: z.array(distanceMarkerSchema).optional(),
    }),
  }),
  z.object({
    op: z.literal('remove_component'),
    id: z.string().min(1),
    removeConnectedEdges: z.boolean().optional(),
  }),
  z.object({
    op: z.literal('connect'),
    id: z.string().optional(),
    from: portRefSchema,
    to: portRefSchema,
  }),
  z.object({
    op: z.literal('disconnect'),
    edgeId: z.string().optional(),
    from: portRefSchema.optional(),
    to: portRefSchema.optional(),
  }),
  z.object({
    op: z.literal('set_distance_rule'),
    componentId: z.string().min(1),
    markers: z.array(distanceMarkerSchema),
  }),
  z.object({
    op: z.literal('set_label'),
    componentId: z.string().min(1),
    label: z.string().min(1),
    side: z.enum(['component', 'leftActuation', 'rightActuation']).optional(),
  }),
]);

export const simInputEventSchema = z.object({
  label: z.string().min(1).describe('Input label (e.g. "S1", "S2", "ESTOP") or component ID.'),
  action: z.enum(['press', 'release', 'toggle', 'hold']),
  atMs: z.number().min(0).describe('Timestamp in ms.'),
  durationMs: z.number().positive().optional().describe('Press duration in ms (default 200).'),
});

// =========================================================================
// TOOL INPUT SHAPES (for McpServer.tool)
// =========================================================================

export const workspaceStatusInputShape = {
  cursor: z.string().optional().describe('Pagination cursor for circuit file listing.'),
  limit: z.number().int().min(1).max(200).optional().describe('Max files per page.'),
  maxBytes: z.number().int().min(512).max(262144).optional().describe('Payload byte budget.'),
};

export const catalogSearchInputShape = {
  query: z.string().optional().describe('Keyword search across type, displayName, description, and keywords.'),
  category: z
    .enum([
      'air_supply',
      'actuator',
      'directional_valve',
      'flow_pressure_logic',
      'electrical_power',
      'electrical_switch',
      'electrical_relay',
      'electrical_actuator',
    ])
    .optional(),
  domain: z.enum(['pneumatic', 'electrical', 'hybrid']).optional(),
  portCount: z.number().int().min(1).max(16).optional(),
  actuationType: z.string().optional().describe('Filter directional valves supporting actuation.'),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  maxBytes: z.number().int().min(512).max(262144).optional(),
};

export const fluidsimDoctorInputShape = {};

export const circuitInspectInputShape = {
  path: z.string().min(1).describe('Workspace-relative path to .fsim.json or .ct circuit file.'),
};

export const circuitExportNetlistInputShape = {
  path: z.string().min(1).describe('Workspace-relative circuit file path.'),
  format: z.enum(['json', 'compact-text']).default('compact-text').describe('Output format (compact-text saves tokens).'),
  maxBytes: z.number().int().min(512).max(262144).optional(),
};

export const circuitGetLabelMapInputShape = {
  path: z.string().min(1).describe('Workspace-relative circuit file path.'),
};

export const circuitQueryComponentsInputShape = {
  path: z.string().min(1).describe('Workspace-relative circuit file path.'),
  domain: z.enum(['pneumatic', 'electrical', 'hybrid']).optional(),
  category: z
    .enum([
      'air_supply',
      'actuator',
      'directional_valve',
      'flow_pressure_logic',
      'electrical_power',
      'electrical_switch',
      'electrical_relay',
      'electrical_actuator',
    ])
    .optional(),
  label: z.string().optional(),
  type: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(200).optional(),
  maxBytes: z.number().int().min(512).max(262144).optional(),
};

export const circuitCreateInputShape = {
  path: z.string().min(1).describe('Target relative file path inside workspace (e.g. "demo.fsim.json").'),
  template: z.enum(['blank', 'pneumatic_basic', 'electro_pneumatic_24v']).default('blank'),
  title: z.string().optional(),
  overwrite: z.boolean().default(false),
};

export const circuitApplyPatchInputShape = {
  path: z.string().min(1).describe('Workspace-relative circuit file path.'),
  operations: z.array(patchOpSchema).min(1).describe('Ordered transactional batch of patch operations.'),
  backup: z.boolean().optional().describe('Create .bak before overwriting.'),
  dryRun: z.boolean().optional().describe('If true, preflight + validate in memory without writing to disk.'),
};

export const circuitGenerateFromSpecInputShape = {
  path: z.string().min(1).describe('Target relative circuit file path inside workspace.'),
  title: z.string().optional(),
  actuators: z
    .array(
      z.object({
        label: z.string().min(1),
        type: z.enum(['double-acting', 'single-acting']).optional(),
        strokeMm: z.number().min(5).max(2000).optional(),
        throttles: z.boolean().optional(),
        throttleOpeningPct: z.number().min(1).max(100).optional(),
      }),
    )
    .min(1),
  sequence: z
    .array(z.string().min(2))
    .min(1)
    .describe('Target motion sequence, e.g. ["A+", "B+", "B-", "A-"], simultaneous "A+B+", or dwell "WAIT:500ms".'),
  controlMethod: z.enum([
    'direct',
    'pneumatic-cascade',
    'electro-pneumatic-step-chain',
    'electro-pneumatic-latch',
  ]),
  startMode: z.enum(['single-cycle', 'continuous']).default('single-cycle'),
  includeEStop: z.boolean().default(false),
  verifySequence: z.boolean().default(true).describe('Run static validation + sequence simulation immediately.'),
};

export const circuitAutoLayoutInputShape = {
  path: z.string().min(1).describe('Workspace-relative circuit file path.'),
};

export const circuitValidateInputShape = {
  path: z.string().min(1).describe('Workspace-relative circuit file path.'),
};

export const circuitSimulateInputShape = {
  path: z.string().min(1).describe('Workspace-relative circuit file path.'),
  inputs: z.array(simInputEventSchema).default([]),
  durationMs: z.number().min(50).max(60000).default(5000),
  stepMs: z.number().min(2).max(100).default(10),
  includeSamples: z.boolean().default(false),
  sampleIntervalMs: z.number().min(10).max(5000).optional(),
  sampleLimit: z.number().int().min(1).max(500).optional().describe('Max sampled snapshots returned when includeSamples=true.'),
  supplyPressureBar: z.number().min(0.5).max(12).optional(),
  cursor: z.string().optional().describe('Pagination cursor over event timeline.'),
  limit: z.number().int().min(1).max(500).optional().describe('Max timeline events returned.'),
  maxBytes: z.number().int().min(512).max(262144).optional(),
};

export const circuitVerifySequenceInputShape = {
  path: z.string().min(1).describe('Workspace-relative circuit file path.'),
  expectedSequence: z.array(z.string().min(2)).min(1),
  inputs: z.array(simInputEventSchema).min(1),
  durationMs: z.number().min(50).max(60000).optional(),
  stepMs: z.number().min(2).max(100).default(10),
  maxCycleMs: z.number().positive().optional(),
  allowRepeatCycles: z.boolean().optional().describe('Accept repeating copies of expectedSequence (for continuous mode).'),
  minCycles: z.number().int().min(1).max(20).optional().describe('Minimum repeating cycles required when allowRepeatCycles=true.'),
  eStopCheck: z
    .object({
      label: z.string().min(1),
      triggerAtMs: z.number().min(0),
      expectNoFurtherMotionsAfterMs: z.number().min(0).optional(),
    })
    .optional(),
};
