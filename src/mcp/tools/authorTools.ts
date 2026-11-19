import fs from 'node:fs';
import type { CircuitDocument, CircuitPatchOp } from '../../contracts/circuit';
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

function buildTemplateDocument(
  template: 'blank' | 'pneumatic_basic' | 'electro_pneumatic_24v',
  title?: string,
): CircuitDocument {
  const now = new Date().toISOString();
  if (template === 'blank') {
    return {
      schemaVersion: '1.0',
      metadata: {
        title: title ?? 'Blank FluidSIM 4.5 Circuit',
        fluidsimVersion: '4.5',
        format: 'fsim-ir-json',
        sheetWidthMm: 297,
        sheetHeightMm: 210,
        createdAt: now,
        updatedAt: now,
      },
      components: [],
      connections: [],
    };
  }

  if (template === 'pneumatic_basic') {
    return autoLayoutCircuit({
      schemaVersion: '1.0',
      metadata: {
        title: title ?? 'Basic Pneumatic Template',
        fluidsimVersion: '4.5',
        format: 'fsim-ir-json',
        sheetWidthMm: 297,
        sheetHeightMm: 210,
        createdAt: now,
        updatedAt: now,
      },
      components: [
        { id: 'SRC_1', type: 'air_source', label: 'P1', params: { pressureBar: 6.0, maxFlowLMin: 1000 } },
        { id: 'FRL_1', type: 'air_service_unit', label: 'FRL1', params: { nominalPressureBar: 6.0 } },
        { id: 'MANIFOLD_1', type: 'pneumatic_junction', params: {} },
      ],
      connections: [
        { id: 'E1', from: { componentId: 'SRC_1', port: '1' }, to: { componentId: 'FRL_1', port: '1' }, domain: 'pneumatic' },
        { id: 'E2', from: { componentId: 'FRL_1', port: '2' }, to: { componentId: 'MANIFOLD_1', port: '1' }, domain: 'pneumatic' },
      ],
    });
  }

  return autoLayoutCircuit({
    schemaVersion: '1.0',
    metadata: {
      title: title ?? 'Electro-Pneumatic 24V Template',
      fluidsimVersion: '4.5',
      format: 'fsim-ir-json',
      sheetWidthMm: 297,
      sheetHeightMm: 210,
      createdAt: now,
      updatedAt: now,
    },
    components: [
      { id: 'SRC_1', type: 'air_source', label: 'P1', params: { pressureBar: 6.0, maxFlowLMin: 1000 } },
      { id: 'FRL_1', type: 'air_service_unit', label: 'FRL1', params: { nominalPressureBar: 6.0 } },
      { id: 'MANIFOLD_1', type: 'pneumatic_junction', params: {} },
      { id: 'PWR_24V', type: 'power_24v', label: '+24V', params: { voltageV: 24 } },
      { id: 'PWR_0V', type: 'power_0v', label: '0V', params: {} },
    ],
    connections: [
      { id: 'E1', from: { componentId: 'SRC_1', port: '1' }, to: { componentId: 'FRL_1', port: '1' }, domain: 'pneumatic' },
      { id: 'E2', from: { componentId: 'FRL_1', port: '2' }, to: { componentId: 'MANIFOLD_1', port: '1' }, domain: 'pneumatic' },
    ],
  });
}

export function handleCircuitCreate(
  ctx: McpToolContext,
  args: {
    path: string;
    template?: 'blank' | 'pneumatic_basic' | 'electro_pneumatic_24v';
    title?: string;
    overwrite?: boolean;
  },
) {
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

  const doc = buildTemplateDocument(args.template ?? 'blank', args.title);
  const saved = saveCircuitWithPostcondition(ctx, args.path, doc);

  return {
    path: saved.relativePath,
    template: args.template ?? 'blank',
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

export function handleCircuitApplyPatch(
  ctx: McpToolContext,
  args: { path: string; operations: CircuitPatchOp[]; backup?: boolean },
) {
  const { document, relativePath } = loadCircuitFromWorkspace(ctx, args.path);
  const patched = applyCircuitPatch(document, args.operations);
  const saved = saveCircuitWithPostcondition(ctx, relativePath, patched.document, {
    backup: args.backup,
  });

  return {
    path: saved.relativePath,
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
  const doc = generateCircuitFromSpec({
    title: args.title,
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
    const startAction = args.startMode === 'continuous' ? ('press' as const) : ('press' as const);
    sequenceVerification = verifyCircuitSequence(saved.postcondition.reparsedDocument, {
      expectedSequence: args.sequence,
      inputs: [{ label: 'S1', action: startAction, atMs: 100, durationMs: 150 }],
      durationMs: Math.max(4000, args.sequence.length * 1400),
      stepMs: 10,
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
