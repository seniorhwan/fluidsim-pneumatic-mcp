import fs from 'node:fs';
import path from 'node:path';
import {
  getSheetDimensions,
  type CircuitDocument,
  type CircuitNet,
  type CircuitPatchOp,
  type ComponentNode,
  type FluidSimFlippedCode,
  type MirrorMode,
  type PortRef,
  type PortTerminatorType,
  type SheetDomain,
  type SheetSizePreset,
} from '../../contracts/circuit';
import { EngineeringError } from '../../contracts/errors';
import type { McpToolContext } from './context';
import { loadCircuitFromWorkspace, saveCircuitWithPostcondition } from './context';
import { applyCircuitPatch } from '../../authoring/patchEngine';
import { autoLayoutCircuit } from '../../authoring/layoutRouter';
import {
  generateCircuitFromSpec,
  type CircuitSpecRequest,
} from '../../authoring/specGenerator';
import { verifyCircuitSequence } from '../../simulator/sequenceVerifier';
import { validateCircuitStatic } from '../../simulator/validator';
import { renderCircuitToSvg } from '../../codec/ctSvgRenderer';

interface ParamEntryInput {
  key: string;
  valueString?: string;
  valueNumber?: number;
  valueBoolean?: boolean;
}

interface PortTerminatorEntryInput {
  port: string;
  terminator: PortTerminatorType;
}

function parseParamsBag(input?: {
  params?: Record<string, unknown>;
  paramsJson?: string;
  paramsList?: ParamEntryInput[];
}): Record<string, number | string | boolean> {
  const result: Record<string, number | string | boolean> = {};

  if (input?.params && typeof input.params === 'object' && !Array.isArray(input.params)) {
    for (const [k, v] of Object.entries(input.params)) {
      if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') {
        result[k] = v;
      }
    }
  }

  if (input?.paramsJson) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.paramsJson);
    } catch (err) {
      throw new EngineeringError({
        category: 'InvalidTopology',
        code: 'INVALID_PARAMS_JSON',
        message: `paramsJson is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        offendingIds: [],
        suggestedFix: 'Pass a valid JSON object string, e.g. \'{"strokeMm":100,"normallyOpen":true}\'.',
      });
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new EngineeringError({
        category: 'InvalidTopology',
        code: 'INVALID_PARAMS_JSON',
        message: 'paramsJson must decode to a JSON object.',
        offendingIds: [],
        suggestedFix: 'Pass a JSON object string such as \'{"openingPct":40}\'.',
      });
    }
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') {
        result[k] = v;
      }
    }
  }

  if (input?.paramsList) {
    for (const entry of input.paramsList) {
      if (entry.valueNumber !== undefined) result[entry.key] = entry.valueNumber;
      else if (entry.valueBoolean !== undefined) result[entry.key] = entry.valueBoolean;
      else if (entry.valueString !== undefined) result[entry.key] = entry.valueString;
    }
  }

  return result;
}

function normalizePortTerminatorValue(raw: string): PortTerminatorType {
  if (raw === 'silencer') return 'exhaust_silencer';
  if (raw === 'plug') return 'blind_plug';
  return raw as PortTerminatorType;
}

function parsePortTerminatorsBag(input?: {
  portTerminators?: Record<string, unknown> | PortTerminatorEntryInput[];
  portTerminatorsJson?: string;
  portTerminatorsList?: PortTerminatorEntryInput[];
}): Record<string, PortTerminatorType> | undefined {
  const result: Record<string, PortTerminatorType> = {};
  let hasAny = false;

  if (Array.isArray(input?.portTerminators)) {
    for (const entry of input.portTerminators) {
      if (entry && typeof entry.port === 'string' && typeof entry.terminator === 'string') {
        result[entry.port] = normalizePortTerminatorValue(entry.terminator);
        hasAny = true;
      }
    }
  } else if (input?.portTerminators && typeof input.portTerminators === 'object') {
    for (const [k, v] of Object.entries(input.portTerminators)) {
      if (typeof v === 'string') {
        result[k] = normalizePortTerminatorValue(v);
        hasAny = true;
      }
    }
  }

  if (input?.portTerminatorsJson) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.portTerminatorsJson);
    } catch (err) {
      throw new EngineeringError({
        category: 'InvalidTopology',
        code: 'INVALID_PORT_TERMINATORS_JSON',
        message: `portTerminatorsJson is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        offendingIds: [],
        suggestedFix: 'Pass a valid JSON object string, e.g. \'{"3":"exhaust_silencer","5":"exhaust_silencer"}\'.',
      });
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new EngineeringError({
        category: 'InvalidTopology',
        code: 'INVALID_PORT_TERMINATORS_JSON',
        message: 'portTerminatorsJson must decode to a JSON object.',
        offendingIds: [],
        suggestedFix: 'Pass a JSON object string mapping port names to exhaust_silencer/blind_plug/open.',
      });
    }
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') {
        result[k] = normalizePortTerminatorValue(v);
        hasAny = true;
      }
    }
  }

  if (input?.portTerminatorsList) {
    for (const entry of input.portTerminatorsList) {
      result[entry.port] = normalizePortTerminatorValue(entry.terminator);
      hasAny = true;
    }
  }

  return hasAny ? result : undefined;
}

export interface FlatComponentNodeInput {
  id: string;
  type: string;
  label?: string;
  sectionLabel?: string;
  group?: string;
  rotationDeg?: number;
  mirror?: MirrorMode;
  flipped?: number;
  params?: Record<string, unknown>;
  paramsJson?: string;
  paramsList?: ParamEntryInput[];
  portTerminators?: Record<string, unknown> | PortTerminatorEntryInput[];
  portTerminatorsJson?: string;
  portTerminatorsList?: PortTerminatorEntryInput[];
  leftActuation?: ComponentNode['leftActuation'];
  rightActuation?: ComponentNode['rightActuation'];
  distanceRule?: ComponentNode['distanceRule'];
}

export interface FlatPatchOpInput {
  op:
    | 'add_component'
    | 'update_component'
    | 'remove_component'
    | 'connect'
    | 'disconnect'
    | 'set_distance_rule'
    | 'set_label'
    | 'set_port_terminator'
    | 'set_net'
    | 'remove_net';
  component?: FlatComponentNodeInput;
  id?: string;
  patch?: {
    label?: string;
    sectionLabel?: string;
    group?: string;
    rotationDeg?: number;
    mirror?: MirrorMode;
    flipped?: number;
    params?: Record<string, unknown>;
    paramsJson?: string;
    paramsList?: ParamEntryInput[];
    portTerminators?: Record<string, unknown> | PortTerminatorEntryInput[];
    portTerminatorsJson?: string;
    portTerminatorsList?: PortTerminatorEntryInput[];
    leftActuation?: ComponentNode['leftActuation'];
    rightActuation?: ComponentNode['rightActuation'];
    distanceRule?: ComponentNode['distanceRule'];
  };
  removeConnectedEdges?: boolean;
  from?: PortRef;
  to?: PortRef;
  edgeId?: string;
  componentId?: string;
  markers?: ComponentNode['distanceRule'];
  label?: string;
  side?: 'component' | 'leftActuation' | 'rightActuation';
  port?: string;
  terminator?: PortTerminatorType | 'none';
  net?: CircuitNet;
  netId?: string;
}

function normalizeComponentInput(raw: FlatComponentNodeInput): ComponentNode {
  const terminators = parsePortTerminatorsBag(raw);
  return {
    id: raw.id,
    type: raw.type,
    ...(raw.label !== undefined ? { label: raw.label } : {}),
    ...(raw.sectionLabel !== undefined ? { sectionLabel: raw.sectionLabel } : {}),
    ...(raw.group !== undefined ? { group: raw.group } : {}),
    ...(raw.rotationDeg !== undefined ? { rotationDeg: raw.rotationDeg as 0 | 90 | 180 | 270 } : {}),
    ...(raw.mirror !== undefined ? { mirror: raw.mirror } : {}),
    ...(raw.flipped !== undefined ? { flipped: raw.flipped as FluidSimFlippedCode } : {}),
    params: parseParamsBag(raw),
    ...(terminators ? { portTerminators: terminators } : {}),
    ...(raw.leftActuation !== undefined ? { leftActuation: raw.leftActuation } : {}),
    ...(raw.rightActuation !== undefined ? { rightActuation: raw.rightActuation } : {}),
    ...(raw.distanceRule !== undefined ? { distanceRule: raw.distanceRule } : {}),
  };
}

function normalizePatchOperations(rawOps: readonly FlatPatchOpInput[]): CircuitPatchOp[] {
  return rawOps.map((raw, idx): CircuitPatchOp => {
    switch (raw.op) {
      case 'add_component': {
        if (!raw.component) {
          throw new EngineeringError({
            category: 'InvalidTopology',
            code: 'PATCH_MISSING_FIELD',
            message: `Patch op[${idx}] (add_component) requires a "component" object.`,
            offendingIds: [],
            suggestedFix: 'Include component: { id, type, label?, paramsJson? }.',
          });
        }
        return {
          op: 'add_component',
          component: normalizeComponentInput(raw.component),
        };
      }
      case 'update_component': {
        if (!raw.id || !raw.patch) {
          throw new EngineeringError({
            category: 'InvalidTopology',
            code: 'PATCH_MISSING_FIELD',
            message: `Patch op[${idx}] (update_component) requires "id" and "patch".`,
            offendingIds: raw.id ? [raw.id] : [],
            suggestedFix: 'Pass id and patch: { label?, rotationDeg?, mirror?, sectionLabel?, group?, paramsJson?, portTerminatorsJson? }.',
          });
        }
        const mergedParams = parseParamsBag(raw.patch);
        const hasParams =
          raw.patch.params !== undefined ||
          raw.patch.paramsJson !== undefined ||
          raw.patch.paramsList !== undefined;
        const terminators = parsePortTerminatorsBag(raw.patch);
        return {
          op: 'update_component',
          id: raw.id,
          patch: {
            ...(raw.patch.label !== undefined ? { label: raw.patch.label } : {}),
            ...(raw.patch.sectionLabel !== undefined ? { sectionLabel: raw.patch.sectionLabel } : {}),
            ...(raw.patch.group !== undefined ? { group: raw.patch.group } : {}),
            ...(raw.patch.rotationDeg !== undefined
              ? { rotationDeg: raw.patch.rotationDeg as 0 | 90 | 180 | 270 }
              : {}),
            ...(raw.patch.mirror !== undefined ? { mirror: raw.patch.mirror } : {}),
            ...(raw.patch.flipped !== undefined ? { flipped: raw.patch.flipped as FluidSimFlippedCode } : {}),
            ...(hasParams ? { params: mergedParams } : {}),
            ...(terminators ? { portTerminators: terminators } : {}),
            ...(raw.patch.leftActuation !== undefined ? { leftActuation: raw.patch.leftActuation } : {}),
            ...(raw.patch.rightActuation !== undefined ? { rightActuation: raw.patch.rightActuation } : {}),
            ...(raw.patch.distanceRule !== undefined ? { distanceRule: raw.patch.distanceRule } : {}),
          },
        };
      }
      case 'remove_component': {
        if (!raw.id) {
          throw new EngineeringError({
            category: 'InvalidTopology',
            code: 'PATCH_MISSING_FIELD',
            message: `Patch op[${idx}] (remove_component) requires "id".`,
            offendingIds: [],
            suggestedFix: 'Pass id of the component to remove.',
          });
        }
        return {
          op: 'remove_component',
          id: raw.id,
          removeConnectedEdges: raw.removeConnectedEdges,
        };
      }
      case 'connect': {
        if (!raw.from || !raw.to) {
          throw new EngineeringError({
            category: 'InvalidTopology',
            code: 'PATCH_MISSING_FIELD',
            message: `Patch op[${idx}] (connect) requires "from" and "to" port references.`,
            offendingIds: [],
            suggestedFix: 'Pass from: { componentId, port } and to: { componentId, port }.',
          });
        }
        return {
          op: 'connect',
          id: raw.id,
          from: raw.from,
          to: raw.to,
        };
      }
      case 'disconnect': {
        return {
          op: 'disconnect',
          edgeId: raw.edgeId,
          from: raw.from,
          to: raw.to,
        };
      }
      case 'set_distance_rule': {
        if (!raw.componentId || !raw.markers) {
          throw new EngineeringError({
            category: 'InvalidTopology',
            code: 'PATCH_MISSING_FIELD',
            message: `Patch op[${idx}] (set_distance_rule) requires "componentId" and "markers".`,
            offendingIds: raw.componentId ? [raw.componentId] : [],
            suggestedFix: 'Pass componentId and markers: [{ label, positionMm }].',
          });
        }
        return {
          op: 'set_distance_rule',
          componentId: raw.componentId,
          markers: raw.markers,
        };
      }
      case 'set_label': {
        if (!raw.componentId || !raw.label) {
          throw new EngineeringError({
            category: 'InvalidTopology',
            code: 'PATCH_MISSING_FIELD',
            message: `Patch op[${idx}] (set_label) requires "componentId" and "label".`,
            offendingIds: raw.componentId ? [raw.componentId] : [],
            suggestedFix: 'Pass componentId and label.',
          });
        }
        return {
          op: 'set_label',
          componentId: raw.componentId,
          label: raw.label,
          side: raw.side,
        };
      }
      case 'set_port_terminator': {
        if (!raw.componentId || !raw.port || !raw.terminator) {
          throw new EngineeringError({
            category: 'InvalidTopology',
            code: 'PATCH_MISSING_FIELD',
            message: `Patch op[${idx}] (set_port_terminator) requires "componentId", "port", and "terminator".`,
            offendingIds: raw.componentId ? [raw.componentId] : [],
            suggestedFix: 'Pass componentId, port, and terminator ("exhaust_silencer" | "blind_plug" | "none").',
          });
        }
        return {
          op: 'set_port_terminator',
          componentId: raw.componentId,
          port: raw.port,
          terminator: raw.terminator,
        };
      }
      case 'set_net': {
        if (!raw.net) {
          throw new EngineeringError({
            category: 'InvalidTopology',
            code: 'PATCH_MISSING_FIELD',
            message: `Patch op[${idx}] (set_net) requires a "net" object.`,
            offendingIds: [],
            suggestedFix: 'Pass net: { id, domain, endpoints: [{ componentId, port }, ...] }.',
          });
        }
        return {
          op: 'set_net',
          net: raw.net,
        };
      }
      case 'remove_net': {
        if (!raw.netId) {
          throw new EngineeringError({
            category: 'InvalidTopology',
            code: 'PATCH_MISSING_FIELD',
            message: `Patch op[${idx}] (remove_net) requires "netId".`,
            offendingIds: [],
            suggestedFix: 'Pass netId of the net to remove.',
          });
        }
        return {
          op: 'remove_net',
          netId: raw.netId,
        };
      }
    }
  });
}

function buildTemplateDocument(
  template: 'blank' | 'pneumatic_basic' | 'electro_pneumatic_24v',
  options?: {
    title?: string;
    sheetSize?: SheetSizePreset;
    sheetDomain?: SheetDomain;
    allowExternalElectricalSheet?: boolean;
  },
): CircuitDocument {
  const now = new Date().toISOString();
  const sheetSize: SheetSizePreset = options?.sheetSize ?? 'DIN_A4_LANDSCAPE';
  const dims = getSheetDimensions(sheetSize);
  const sheetDomain: SheetDomain =
    options?.sheetDomain ??
    (template === 'electro_pneumatic_24v' ? 'electro-pneumatic' : 'pneumatic-only');
  const allowExternalElectricalSheet =
    options?.allowExternalElectricalSheet ?? sheetDomain === 'pneumatic-only';

  const baseMeta: CircuitDocument['metadata'] = {
    title:
      options?.title ??
      (template === 'blank'
        ? 'Blank FluidSIM 4.5 Circuit'
        : template === 'pneumatic_basic'
          ? 'Basic Pneumatic Template'
          : 'Electro-Pneumatic 24V Template'),
    fluidsimVersion: '4.5',
    format: 'fsim-ir-json',
    sheetSize,
    sheetDomain,
    ...(allowExternalElectricalSheet ? { allowExternalElectricalSheet: true } : {}),
    sheetWidthMm: dims.sheetWidthMm,
    sheetHeightMm: dims.sheetHeightMm,
    createdAt: now,
    updatedAt: now,
  };

  if (template === 'blank') {
    return {
      schemaVersion: '1.0',
      metadata: baseMeta,
      components: [],
      connections: [],
    };
  }

  if (template === 'pneumatic_basic') {
    // Terminating MANIFOLD_1.3 with a blind_plug keeps MANIFOLD_1.2 free for patching
    // while keeping PTriconnection strictly 3-gate F9-compliant and 0 errors/warnings.
    return autoLayoutCircuit({
      schemaVersion: '1.0',
      metadata: baseMeta,
      components: [
        { id: 'SRC_1', type: 'air_source', label: 'P1', params: { pressureBar: 6.0, maxFlowLMin: 1000 } },
        { id: 'FRL_1', type: 'air_service_unit', label: 'FRL1', params: { nominalPressureBar: 6.0 } },
        { id: 'MANIFOLD_1', type: 'pneumatic_junction', params: {} },
        { id: 'PLUG_1', type: 'blind_plug', params: {} },
      ],
      connections: [
        { id: 'E1', from: { componentId: 'SRC_1', port: '1' }, to: { componentId: 'FRL_1', port: '1' }, domain: 'pneumatic' },
        { id: 'E2', from: { componentId: 'FRL_1', port: '2' }, to: { componentId: 'MANIFOLD_1', port: '1' }, domain: 'pneumatic' },
        { id: 'E3', from: { componentId: 'MANIFOLD_1', port: '3' }, to: { componentId: 'PLUG_1', port: '1' }, domain: 'pneumatic' },
      ],
    });
  }

  return autoLayoutCircuit({
    schemaVersion: '1.0',
    metadata: baseMeta,
    components: [
      { id: 'SRC_1', type: 'air_source', label: 'P1', params: { pressureBar: 6.0, maxFlowLMin: 1000 } },
      { id: 'FRL_1', type: 'air_service_unit', label: 'FRL1', params: { nominalPressureBar: 6.0 } },
      { id: 'MANIFOLD_1', type: 'pneumatic_junction', params: {} },
      { id: 'PLUG_1', type: 'blind_plug', params: {} },
      { id: 'PWR_24V', type: 'power_24v', label: '+24V', params: { voltageV: 24 } },
      { id: 'PWR_0V', type: 'power_0v', label: '0V', params: {} },
    ],
    connections: [
      { id: 'E1', from: { componentId: 'SRC_1', port: '1' }, to: { componentId: 'FRL_1', port: '1' }, domain: 'pneumatic' },
      { id: 'E2', from: { componentId: 'FRL_1', port: '2' }, to: { componentId: 'MANIFOLD_1', port: '1' }, domain: 'pneumatic' },
      { id: 'E3', from: { componentId: 'MANIFOLD_1', port: '3' }, to: { componentId: 'PLUG_1', port: '1' }, domain: 'pneumatic' },
    ],
  });
}

export function handleProjectCreate(
  ctx: McpToolContext,
  args: {
    projectDir?: string;
    name: string;
    description?: string;
    sheetSize?: SheetSizePreset;
    author?: string;
    starterCircuit?: 'none' | 'blank' | 'pneumatic_basic' | 'electro_pneumatic_24v';
    starterFileName?: string;
    sheetDomain?: SheetDomain;
    overwrite?: boolean;
  },
) {
  ctx.guard.ensureRootExists({ createIfMissing: true });
  const requestedDir = args.projectDir ?? '.';
  const projectDirAbs = ctx.guard.resolveProjectDir(requestedDir);
  const projectRelRaw = ctx.guard.toRelativePath(projectDirAbs);
  const projectRel = projectRelRaw || '.';

  const manifestRel = projectRel === '.' ? 'fluidsim-project.json' : path.posix.join(projectRel, 'fluidsim-project.json');
  const readmeRel = projectRel === '.' ? 'README.md' : path.posix.join(projectRel, 'README.md');
  const manifestAbs = ctx.guard.resolveProjectDir(manifestRel);

  if (fs.existsSync(manifestAbs) && !args.overwrite) {
    throw new EngineeringError({
      category: 'AccessDenied',
      code: 'FILE_ALREADY_EXISTS',
      message: `Project manifest "${manifestRel}" already exists and overwrite=false.`,
      offendingIds: [manifestRel],
      suggestedFix: 'Pass overwrite=true or choose a new projectDir.',
    });
  }

  const circuitsDirAbs = path.join(projectDirAbs, 'circuits');
  fs.mkdirSync(circuitsDirAbs, { recursive: true });

  const sheetSize: SheetSizePreset = args.sheetSize ?? 'DIN_A3_LANDSCAPE';
  const starterTemplate = args.starterCircuit ?? 'pneumatic_basic';
  const starterFileName = args.starterFileName ?? 'main.ct';
  const now = new Date().toISOString();

  let starterCircuitPath: string | null = null;
  let starterValidation:
    | { valid: boolean; errorCount: number; warningCount: number }
    | undefined;

  if (starterTemplate !== 'none') {
    const circuitRel =
      projectRel === '.'
        ? path.posix.join('circuits', starterFileName)
        : path.posix.join(projectRel, 'circuits', starterFileName);
    const createdCircuit = handleCircuitCreate(ctx, {
      path: circuitRel,
      template: starterTemplate,
      title: args.name,
      sheetSize,
      sheetDomain: args.sheetDomain,
      overwrite: Boolean(args.overwrite),
    });
    starterCircuitPath = createdCircuit.path;
    starterValidation = createdCircuit.validation;
  }

  const manifest = {
    schemaVersion: '1.0',
    fluidsimVersion: '4.5',
    name: args.name,
    ...(args.description ? { description: args.description } : {}),
    ...(args.author ? { author: args.author } : {}),
    sheetSize,
    circuitsDir: 'circuits',
    ...(starterCircuitPath ? { starterCircuit: starterCircuitPath } : {}),
    createdAt: now,
    updatedAt: now,
  };
  const writtenManifest = ctx.guard.writeProjectMetaFileAtomic(
    manifestRel,
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  const readmeContent = [
    `# ${args.name}`,
    '',
    ...(args.description ? [args.description, ''] : []),
    `- **Target Runtime:** Festo FluidSIM Pneumatics 4.5`,
    `- **Default Sheet Size:** ${sheetSize}`,
    ...(args.author ? [`- **Author:** ${args.author}`] : []),
    `- **Circuits Directory:** \`circuits/\``,
    ...(starterCircuitPath ? [`- **Starter Circuit:** \`${starterCircuitPath}\``] : []),
    '',
  ].join('\n');
  const writtenReadme = ctx.guard.writeProjectMetaFileAtomic(readmeRel, readmeContent);

  return {
    projectDir: projectRel,
    manifestPath: writtenManifest.relativePath,
    readmePath: writtenReadme.relativePath,
    starterCircuitPath,
    ...(starterValidation ? { validation: starterValidation } : {}),
    created: true,
  };
}

export function handleCircuitCreate(
  ctx: McpToolContext,
  args: {
    path: string;
    template?: 'blank' | 'pneumatic_basic' | 'electro_pneumatic_24v';
    title?: string;
    sheetSize?: SheetSizePreset;
    sheetDomain?: SheetDomain;
    allowExternalElectricalSheet?: boolean;
    overwrite?: boolean;
  },
) {
  ctx.guard.ensureRootExists({ createIfMissing: true });
  const abs = ctx.guard.resolveCircuitPath(args.path);
  if (fs.existsSync(abs) && !args.overwrite) {
    throw new EngineeringError({
      category: 'AccessDenied',
      code: 'FILE_ALREADY_EXISTS',
      message: `Circuit file "${args.path}" already exists and overwrite=false.`,
      offendingIds: [args.path],
      suggestedFix: 'Pass overwrite=true or choose a new filename.',
    });
  }

  const doc = buildTemplateDocument(args.template ?? 'blank', {
    title: args.title,
    sheetSize: args.sheetSize,
    sheetDomain: args.sheetDomain,
    allowExternalElectricalSheet: args.allowExternalElectricalSheet,
  });
  const saved = saveCircuitWithPostcondition(ctx, args.path, doc);

  return {
    path: saved.relativePath,
    template: args.template ?? 'blank',
    sheetWidthMm: doc.metadata.sheetWidthMm,
    sheetHeightMm: doc.metadata.sheetHeightMm,
    componentCount: doc.components.length,
    connectionCount: doc.connections.length,
    postconditionPassed: saved.postcondition.passed,
    validation: {
      valid: saved.postcondition.validation.valid,
      errorCount: saved.postcondition.validation.errorCount,
      warningCount: saved.postcondition.validation.warningCount,
    },
  };
}

export function handleCircuitBuild(
  ctx: McpToolContext,
  args: {
    path: string;
    title: string;
    sheetSize?: SheetSizePreset;
    sheetDomain?: SheetDomain;
    allowExternalElectricalSheet?: boolean;
    components: FlatComponentNodeInput[];
    connections?: Array<{ id?: string; from: PortRef; to: PortRef }>;
    nets?: CircuitNet[];
    autoLayout?: boolean;
    overwrite?: boolean;
  },
) {
  ctx.guard.ensureRootExists({ createIfMissing: true });
  const abs = ctx.guard.resolveCircuitPath(args.path);
  if (fs.existsSync(abs) && args.overwrite === false) {
    throw new EngineeringError({
      category: 'AccessDenied',
      code: 'FILE_ALREADY_EXISTS',
      message: `Circuit file "${args.path}" already exists and overwrite=false.`,
      offendingIds: [args.path],
      suggestedFix: 'Pass overwrite=true or choose a new filename.',
    });
  }

  const baseDoc = buildTemplateDocument('blank', {
    title: args.title,
    sheetSize: args.sheetSize ?? 'DIN_A3_LANDSCAPE',
    sheetDomain: args.sheetDomain,
    allowExternalElectricalSheet: args.allowExternalElectricalSheet,
  });

  const ops: CircuitPatchOp[] = [];
  for (const rawComp of args.components) {
    ops.push({
      op: 'add_component',
      component: normalizeComponentInput(rawComp),
    });
  }
  for (const conn of args.connections ?? []) {
    ops.push({
      op: 'connect',
      ...(conn.id ? { id: conn.id } : {}),
      from: conn.from,
      to: conn.to,
    });
  }
  for (const net of args.nets ?? []) {
    ops.push({
      op: 'set_net',
      net,
    });
  }

  const patched = applyCircuitPatch(baseDoc, ops);
  const builtDoc =
    args.autoLayout === false
      ? patched.document
      : autoLayoutCircuit(patched.document, { incremental: false });

  const saved = saveCircuitWithPostcondition(ctx, args.path, builtDoc);
  const svgPreview = renderCircuitToSvg(saved.postcondition.reparsedDocument);

  return {
    path: saved.relativePath,
    title: builtDoc.metadata.title,
    sheetWidthMm: builtDoc.metadata.sheetWidthMm,
    sheetHeightMm: builtDoc.metadata.sheetHeightMm,
    componentCount: saved.postcondition.reparsedDocument.components.length,
    connectionCount: saved.postcondition.reparsedDocument.connections.length,
    postconditionPassed: saved.postcondition.passed,
    roundtripPassed: saved.postcondition.roundtripPassed,
    f9SolverOk: saved.postcondition.f9SolverOk,
    visualLayoutOk: saved.postcondition.visualLayoutOk,
    layoutDiagnostics: svgPreview.diagnostics,
    validation: saved.postcondition.validation,
  };
}

export function handleCircuitClone(
  ctx: McpToolContext,
  args: { sourcePath: string; targetPath: string; overwrite?: boolean; newTitle?: string },
) {
  const { document, relativePath: sourceRel } = loadCircuitFromWorkspace(ctx, args.sourcePath);
  const dstAbs = ctx.guard.resolveCircuitPath(args.targetPath);
  if (fs.existsSync(dstAbs) && !args.overwrite) {
    throw new EngineeringError({
      category: 'AccessDenied',
      code: 'FILE_ALREADY_EXISTS',
      message: `Destination circuit file "${args.targetPath}" already exists and overwrite=false.`,
      offendingIds: [args.targetPath],
      suggestedFix: 'Pass overwrite=true or choose a new destination filename.',
    });
  }
  const cloned: CircuitDocument = structuredClone(document);
  if (args.newTitle) {
    cloned.metadata.title = args.newTitle;
  }
  cloned.metadata.updatedAt = new Date().toISOString();
  const saved = saveCircuitWithPostcondition(ctx, args.targetPath, cloned);
  return {
    sourcePath: sourceRel,
    targetPath: saved.relativePath,
    title: cloned.metadata.title,
    componentCount: cloned.components.length,
    connectionCount: cloned.connections.length,
    postconditionPassed: saved.postcondition.passed,
  };
}

export function handleCircuitRename(
  ctx: McpToolContext,
  args: { fromPath: string; toPath: string; overwrite?: boolean },
) {
  const res = ctx.guard.renameCircuitFile(args.fromPath, args.toPath, {
    overwrite: args.overwrite,
  });
  return {
    fromPath: res.fromRelativePath,
    toPath: res.toRelativePath,
    renamed: true,
  };
}

export function handleCircuitDelete(ctx: McpToolContext, args: { path: string; confirm: boolean }) {
  if (args.confirm !== true) {
    throw new EngineeringError({
      category: 'AccessDenied',
      code: 'DELETE_CONFIRMATION_REQUIRED',
      message: `Deleting "${args.path}" requires confirm=true.`,
      offendingIds: [args.path],
      suggestedFix: 'Pass confirm: true to explicitly confirm deletion of the circuit file.',
    });
  }
  const res = ctx.guard.deleteCircuitFile(args.path);
  return {
    path: res.relativePath,
    deleted: true,
  };
}

export function handleCircuitApplyPatch(
  ctx: McpToolContext,
  args: { path: string; operations: FlatPatchOpInput[]; backup?: boolean; dryRun?: boolean },
) {
  const { document, relativePath } = loadCircuitFromWorkspace(ctx, args.path);
  const normalizedOps = normalizePatchOperations(args.operations);
  const patched = applyCircuitPatch(document, normalizedOps);

  if (args.dryRun) {
    const validation = validateCircuitStatic(patched.document);
    return {
      path: relativePath,
      dryRun: true,
      appliedOperations: patched.appliedCount,
      addedComponents: patched.addedComponents,
      updatedComponents: patched.updatedComponents,
      removedComponents: patched.removedComponents,
      addedConnections: patched.addedConnections,
      removedConnections: patched.removedConnections,
      postconditionPassed: validation.valid,
      validation,
    };
  }

  const saved = saveCircuitWithPostcondition(ctx, relativePath, patched.document, {
    backup: args.backup,
  });

  return {
    path: saved.relativePath,
    dryRun: false,
    appliedOperations: patched.appliedCount,
    addedComponents: patched.addedComponents,
    updatedComponents: patched.updatedComponents,
    removedComponents: patched.removedComponents,
    addedConnections: patched.addedConnections,
    removedConnections: patched.removedConnections,
    postconditionPassed: saved.postcondition.passed,
    validation: saved.postcondition.validation,
  };
}

export function handleCircuitGenerateFromSpec(
  ctx: McpToolContext,
  args: CircuitSpecRequest & { path: string; verifySequence?: boolean },
) {
  ctx.guard.ensureRootExists({ createIfMissing: true });
  const doc = generateCircuitFromSpec({
    title: args.title,
    sheetSize: args.sheetSize,
    actuators: args.actuators,
    sequence: args.sequence,
    controlMethod: args.controlMethod,
    startMode: args.startMode,
    includeEStop: args.includeEStop,
  });

  const saved = saveCircuitWithPostcondition(ctx, args.path, doc);
  const shouldVerify = args.verifySequence !== false;

  let sequenceVerification = undefined;
  if (shouldVerify) {
    const isContinuous = args.startMode === 'continuous';
    const perCycleMs = Math.max(2500, args.sequence.length * 1400);
    sequenceVerification = verifyCircuitSequence(saved.postcondition.reparsedDocument, {
      expectedSequence: args.sequence,
      inputs: [{ label: 'S1', action: 'press', atMs: 100, durationMs: 150 }],
      durationMs: Math.min(60_000, isContinuous ? perCycleMs * 2 + 1500 : Math.max(4000, perCycleMs)),
      stepMs: 10,
      ...(isContinuous ? { allowRepeatCycles: true, minCycles: 2 } : {}),
      ...(args.includeEStop && args.sequence.length >= 2
        ? {
            eStopCheck: {
              label: 'ESTOP',
              triggerAtMs: 250,
              expectNoFurtherMotionsAfterMs: 300,
            },
          }
        : {}),
    });
  }

  return {
    path: saved.relativePath,
    controlMethod: args.controlMethod,
    sheetWidthMm: doc.metadata.sheetWidthMm,
    sheetHeightMm: doc.metadata.sheetHeightMm,
    componentCount: doc.components.length,
    connectionCount: doc.connections.length,
    postconditionPassed: saved.postcondition.passed,
    validation: saved.postcondition.validation,
    ...(sequenceVerification ? { sequenceVerification } : {}),
  };
}

export function handleCircuitAutoLayout(ctx: McpToolContext, args: { path: string }) {
  const { document, relativePath } = loadCircuitFromWorkspace(ctx, args.path);
  const laidOut = autoLayoutCircuit(document, { incremental: false });
  const saved = saveCircuitWithPostcondition(ctx, relativePath, laidOut);

  return {
    path: saved.relativePath,
    sheetWidthMm: laidOut.metadata.sheetWidthMm,
    sheetHeightMm: laidOut.metadata.sheetHeightMm,
    componentCount: laidOut.components.length,
    routedConnections: laidOut.connections.length,
    postconditionPassed: saved.postcondition.passed,
  };
}
