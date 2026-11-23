import { z } from 'zod';

const portRefSchema = z.object({
  componentId: z.string().min(1).describe('Component ID (e.g. "V_A", "CYL_A").'),
  port: z.string().min(1).describe('ISO 1219 or IEC port name (e.g. "1", "2", "4", "14", "A", "A1", "1v").'),
});

const distanceMarkerSchema = z.object({
  label: z.string().min(1).describe('Sensor marker label (e.g. "a0", "a1").'),
  positionMm: z.number().min(0).describe('Stroke position in mm (or angle in degrees for swivel_drive).'),
  toleranceMm: z.number().positive().optional().describe('Detection window in mm or deg (default 2).'),
});

const actuationSideSchema = z.object({
  type: z.enum([
    'none',
    'pushbutton',
    'detent',
    'roller',
    'idle_return_roller',
    'pneumatic_pilot',
    'pneumatic_spring',
    'solenoid',
    'spring',
  ]),
  label: z.string().optional().describe('Binding label for solenoid (Y1/-1M1), roller (a1), or pushbutton (S1).'),
  manualOverride: z.boolean().optional().describe('Composite actuation: manual override button alongside solenoid/pilot.'),
  internalPilot: z.boolean().optional().describe('Composite actuation: internally servo-piloted solenoid.'),
  springReturn: z.boolean().optional().describe('Composite actuation: combined mechanical spring + pneumatic_spring return.'),
});

/**
 * Typed parameter entry used to remain 100% compliant with Gemini/Google AI Studio
 * OpenAPI 3.0 tool schemas (zero `propertyNames`, zero `oneOf`/`anyOf`, zero union `type` arrays).
 */
const paramEntrySchema = z.object({
  key: z.string().min(1).describe('Parameter key from catalog_search (e.g. "strokeMm", "normallyOpen").'),
  valueString: z.string().optional().describe('String value if parameter is string/enum.'),
  valueNumber: z.number().optional().describe('Numeric value if parameter is number.'),
  valueBoolean: z.boolean().optional().describe('Boolean value if parameter is boolean.'),
});

const categoryEnumSchema = z.enum([
  'air_supply',
  'actuator',
  'directional_valve',
  'flow_pressure_logic',
  'vacuum',
  'measuring',
  'electrical_power',
  'electrical_switch',
  'electrical_relay',
  'electrical_actuator',
]);

const sheetSizeEnumSchema = z.enum([
  'DIN_A4_LANDSCAPE',
  'DIN_A4_PORTRAIT',
  'DIN_A3_LANDSCAPE',
]);

const sheetDomainEnumSchema = z.enum(['electro-pneumatic', 'pneumatic-only']);

const mirrorEnumSchema = z.enum(['none', 'horizontal', 'vertical', 'both']);
const portTerminatorEnumSchema = z.enum(['exhaust_silencer', 'blind_plug', 'none']);

const portTerminatorEntrySchema = z.object({
  port: z.string().min(1).describe('Port name (e.g. "3", "5", "4").'),
  terminator: z.enum(['exhaust_silencer', 'blind_plug']).describe('Inline FluidSIM port terminator: exhaust_silencer (EX3) or blind_plug (EX4).'),
});

const circuitNetSchema = z.object({
  id: z.string().min(1).describe('Unique net ID (e.g. "NET_SUPPLY_6BAR", "NET_EXH_BUS", "NET_24V").'),
  name: z.string().optional().describe('Optional display name for this net.'),
  domain: z.enum(['pneumatic', 'electrical']).default('pneumatic').describe('Net domain ("pneumatic" or "electrical").'),
  endpoints: z.array(portRefSchema).min(2).describe('All component ports joined on this net; lowered into clean 3-gate T-junction trees automatically.'),
  terminators: z.array(z.enum(['exhaust_silencer', 'blind_plug'])).optional().describe('Optional net-level terminators.'),
});

/**
 * Uses looseObject so callers using plain `params: { ... }` or `portTerminators: { ... }` remain compatible
 * at runtime while the published JSON Schema exposes only Gemini-compliant fields.
 */
const componentNodeSchema = z.looseObject({
  id: z.string().min(1).describe('Unique component ID.'),
  type: z.string().min(1).describe('Catalog componentType from catalog_search.'),
  label: z.string().optional().describe('Engineering label (A, K1, Y1, S1, a1, -1M1).'),
  sectionLabel: z.string().optional().describe('Optional schematic group/section heading above this branch (e.g. "Lifting Module", "Ejecting").'),
  group: z.string().optional().describe('Optional logical branch/column grouping tag for schematic layout.'),
  rotationDeg: z.number().int().optional().describe('Schematic orientation in degrees (CCW): 0, 90, 180, or 270.'),
  mirror: mirrorEnumSchema.optional().describe('D4 mirror reflection: none, horizontal (X), vertical (Y), or both (180-deg flip).'),
  flipped: z.number().int().min(0).max(3).optional().describe('FluidSIM 4.5 native FLIPPED bitmask (0=none, 1=H, 2=V, 3=both).'),
  paramsJson: z
    .string()
    .optional()
    .describe('Optional JSON object string of component parameters, e.g. \'{"strokeMm":100,"normallyOpen":true}\'.'),
  paramsList: z
    .array(paramEntrySchema)
    .optional()
    .describe('Optional typed key/value parameter entries.'),
  portTerminatorsJson: z
    .string()
    .optional()
    .describe('Optional JSON object string of inline port terminators, e.g. \'{"3":"silencer","5":"silencer"}\'.'),
  portTerminatorsList: z
    .array(portTerminatorEntrySchema)
    .optional()
    .describe('Optional typed list of inline port terminators (silencer / plug).'),
  leftActuation: actuationSideSchema.optional(),
  rightActuation: actuationSideSchema.optional(),
  distanceRule: z.array(distanceMarkerSchema).optional(),
});

const componentPatchFieldsSchema = z.looseObject({
  label: z.string().optional(),
  sectionLabel: z.string().optional(),
  group: z.string().optional(),
  rotationDeg: z.number().int().optional().describe('Schematic orientation in degrees (CCW): 0, 90, 180, or 270.'),
  mirror: mirrorEnumSchema.optional().describe('D4 mirror reflection: none, horizontal, vertical, or both.'),
  flipped: z.number().int().min(0).max(3).optional().describe('FluidSIM 4.5 native FLIPPED bitmask (0..3).'),
  paramsJson: z
    .string()
    .optional()
    .describe('Optional JSON object string of component parameters to merge.'),
  paramsList: z
    .array(paramEntrySchema)
    .optional()
    .describe('Optional typed key/value parameter entries to merge.'),
  portTerminatorsJson: z
    .string()
    .optional()
    .describe('Optional JSON object string of inline port terminators to merge.'),
  portTerminatorsList: z
    .array(portTerminatorEntrySchema)
    .optional()
    .describe('Optional typed list of inline port terminators to merge.'),
  leftActuation: actuationSideSchema.optional(),
  rightActuation: actuationSideSchema.optional(),
  distanceRule: z.array(distanceMarkerSchema).optional(),
});

/**
 * Flattened Gemini/OpenAPI-safe patch operation schema (no `oneOf`, `anyOf`, `const`, or `discriminatedUnion`).
 */
export const patchOpSchema = z.object({
  op: z
    .enum([
      'add_component',
      'update_component',
      'remove_component',
      'connect',
      'disconnect',
      'set_distance_rule',
      'set_label',
      'set_port_terminator',
      'set_net',
      'remove_net',
    ])
    .describe('Patch operation kind.'),
  component: componentNodeSchema.optional().describe('Required for op="add_component".'),
  id: z.string().min(1).optional().describe('Target component ID (update/remove) or optional edge ID (connect).'),
  patch: componentPatchFieldsSchema.optional().describe('Required for op="update_component".'),
  removeConnectedEdges: z.boolean().optional().describe('Used by op="remove_component" (default true).'),
  from: portRefSchema.optional().describe('Source port reference for op="connect" or op="disconnect".'),
  to: portRefSchema.optional().describe('Destination port reference for op="connect" or op="disconnect".'),
  edgeId: z.string().optional().describe('Edge ID for op="disconnect".'),
  componentId: z.string().min(1).optional().describe('Target component ID for op="set_distance_rule", "set_label", or "set_port_terminator".'),
  markers: z.array(distanceMarkerSchema).optional().describe('Required for op="set_distance_rule".'),
  label: z.string().min(1).optional().describe('Required for op="set_label".'),
  side: z
    .enum(['component', 'leftActuation', 'rightActuation'])
    .optional()
    .describe('Optional side selector for op="set_label".'),
  port: z.string().min(1).optional().describe('Target port name for op="set_port_terminator".'),
  terminator: portTerminatorEnumSchema.optional().describe('Terminator kind for op="set_port_terminator" ("exhaust_silencer" | "blind_plug" | "none").'),
  net: circuitNetSchema.optional().describe('Named net definition for op="set_net".'),
  netId: z.string().min(1).optional().describe('Net ID for op="remove_net".'),
});

export const simInputEventSchema = z.object({
  label: z.string().min(1).describe('Input label (e.g. "S1", "S2", "ESTOP", "-1M1") or component ID.'),
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
  category: categoryEnumSchema.optional(),
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
  category: categoryEnumSchema.optional(),
  label: z.string().optional(),
  type: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(200).optional(),
  maxBytes: z.number().int().min(512).max(262144).optional(),
};

export const circuitRenderSvgInputShape = {
  path: z.string().min(1).describe('Workspace-relative path to .fsim.json or .ct circuit file.'),
  includeSvg: z.boolean().default(true).describe('Include raw SVG markup (set false for compact diagnostics-only response).'),
  showGrid: z.boolean().default(false).describe('Overlay 10mm engineering grid lines on SVG preview.'),
  scalePxPerMm: z.number().min(1).max(10).default(3).describe('SVG viewport scale in pixels per millimeter.'),
  maxBytes: z.number().int().min(1024).max(262144).optional(),
};

export const projectCreateInputShape = {
  projectDir: z
    .string()
    .default('.')
    .describe('Relative project directory inside workspace (default ".").'),
  name: z.string().min(1).describe('Project name (e.g. "MPS Distributing Station").'),
  description: z.string().optional().describe('Optional project description.'),
  sheetSize: sheetSizeEnumSchema.default('DIN_A3_LANDSCAPE'),
  author: z.string().optional().describe('Optional author name.'),
  starterCircuit: z
    .enum(['none', 'blank', 'pneumatic_basic', 'electro_pneumatic_24v'])
    .default('pneumatic_basic')
    .describe('Optional starter circuit template created under <projectDir>/circuits/ (or "none").'),
  starterFileName: z
    .string()
    .default('main.ct')
    .describe('Filename for the starter circuit inside <projectDir>/circuits/ (default "main.ct").'),
  sheetDomain: sheetDomainEnumSchema.optional(),
  overwrite: z.boolean().default(false),
};

export const circuitCreateInputShape = {
  path: z.string().min(1).describe('Target relative file path inside workspace (e.g. "demo.fsim.json" or "station.ct").'),
  template: z.enum(['blank', 'pneumatic_basic', 'electro_pneumatic_24v']).default('blank'),
  title: z.string().optional(),
  sheetSize: sheetSizeEnumSchema.default('DIN_A4_LANDSCAPE').describe('Drawing sheet preset (DIN_A4_LANDSCAPE, DIN_A3_LANDSCAPE, etc.).'),
  sheetDomain: sheetDomainEnumSchema.optional().describe('Set to "pneumatic-only" to allow valve solenoids wired on a separate electrical sheet.'),
  allowExternalElectricalSheet: z.boolean().optional().describe('If true, skips UNBOUND_VALVE_SOLENOID checks for multi-sheet pneumatic schematics.'),
  overwrite: z.boolean().default(false),
};

export const circuitBuildInputShape = {
  path: z.string().min(1).describe('Target workspace-relative circuit file path (.ct or .fsim.json).'),
  title: z.string().min(1).describe('Circuit schematic title.'),
  sheetSize: sheetSizeEnumSchema.default('DIN_A3_LANDSCAPE').describe('Drawing sheet preset (DIN_A4_LANDSCAPE, DIN_A3_LANDSCAPE, etc.).'),
  sheetDomain: sheetDomainEnumSchema.optional().describe('Set "pneumatic-only" if solenoids are wired on an external electrical sheet.'),
  allowExternalElectricalSheet: z.boolean().optional(),
  components: z.array(componentNodeSchema).min(1).describe('Complete list of components (supports mirror, rotationDeg, sectionLabel, group, portTerminators).'),
  connections: z
    .array(
      z.object({
        id: z.string().optional(),
        from: portRefSchema,
        to: portRefSchema,
      }),
    )
    .optional()
    .describe('Optional point-to-point connections.'),
  nets: z
    .array(circuitNetSchema)
    .optional()
    .describe('Optional named multi-port nets (automatically lowered into clean 3-gate T-junction trees).'),
  autoLayout: z.boolean().default(true).describe('Automatically compute DIN ISO 1219 layout and channel-allocated orthogonal wires.'),
  overwrite: z.boolean().default(true).describe('Overwrite existing file at path (default true).'),
};

export const circuitCloneInputShape = {
  sourcePath: z.string().min(1).describe('Source workspace-relative circuit file path.'),
  targetPath: z.string().min(1).describe('Destination workspace-relative circuit file path (.ct or .fsim.json).'),
  overwrite: z.boolean().default(false),
  newTitle: z.string().optional().describe('Optional new title for the cloned circuit.'),
};

export const circuitRenameInputShape = {
  fromPath: z.string().min(1).describe('Current workspace-relative circuit file path.'),
  toPath: z.string().min(1).describe('New workspace-relative circuit file path.'),
  overwrite: z.boolean().default(false),
};

export const circuitDeleteInputShape = {
  path: z.string().min(1).describe('Workspace-relative circuit file path to delete.'),
  confirm: z.boolean().describe('Must be true to confirm deletion of the circuit file.'),
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
  sheetSize: sheetSizeEnumSchema.optional().describe('Drawing sheet preset (default DIN_A4_LANDSCAPE).'),
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
  allowExternalElectricalSheet: z
    .boolean()
    .optional()
    .describe('If true, skips UNBOUND_VALVE_SOLENOID checks for pneumatic-only schematic sheets.'),
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
