import type { CircuitDocument, CircuitPatchOp, ComponentNode, ConnectionEdge } from '../contracts/circuit';
import { getDefaultParams, getPortDefinition } from '../catalog/pneumatics45';
import { flippedCodeToMirror, mirrorToFlippedCode } from '../codec/ctTransform';
import { runWritePreflight } from './writePreflight';
import { autoLayoutCircuit } from './layoutRouter';

export interface PatchApplySummary {
  document: CircuitDocument;
  appliedCount: number;
  addedComponents: string[];
  updatedComponents: string[];
  removedComponents: string[];
  addedConnections: string[];
  removedConnections: string[];
}

function normalizeComponentNode(node: ComponentNode, explicitParams?: Record<string, number | string | boolean>): ComponentNode {
  const params = { ...node.params };
  let rotationDeg = node.rotationDeg ?? node.layout?.rotationDeg;
  if (params.rotationDeg !== undefined) {
    const rot = Number(params.rotationDeg);
    if (rot === 0 || rot === 90 || rot === 180 || rot === 270) {
      rotationDeg = rot;
    }
    delete params.rotationDeg;
  }

  let flipped = node.flipped;
  let mirror = node.mirror;
  if (mirror !== undefined && flipped === undefined) {
    flipped = mirrorToFlippedCode(mirror);
  } else if (flipped !== undefined && mirror === undefined) {
    mirror = flippedCodeToMirror(flipped);
  }

  if (node.type === 'valve_2_2' || node.type === 'valve_3_2') {
    if (explicitParams && typeof explicitParams.normallyOpen === 'boolean') {
      params.normallyOpen = explicitParams.normallyOpen;
      params.normalState = explicitParams.normallyOpen ? 'NO' : 'NC';
    } else if (explicitParams && typeof explicitParams.normalState === 'string') {
      params.normalState = explicitParams.normalState;
      params.normallyOpen = explicitParams.normalState === 'NO';
    } else if (typeof params.normallyOpen === 'boolean') {
      params.normalState = params.normallyOpen ? 'NO' : 'NC';
    } else if (typeof params.normalState === 'string') {
      params.normallyOpen = params.normalState === 'NO';
    }
  }

  return {
    ...node,
    rotationDeg,
    ...(mirror !== undefined ? { mirror } : {}),
    ...(flipped !== undefined ? { flipped } : {}),
    layout: node.layout
      ? {
          ...node.layout,
          rotationDeg: rotationDeg ?? node.layout.rotationDeg ?? 0,
        }
      : undefined,
    params,
  };
}

/**
 * Applies an ordered batch of patch operations transactionally in memory.
 * On any preflight or invariant failure, throws EngineeringError leaving the original document untouched.
 */
export function applyCircuitPatch(
  originalDoc: CircuitDocument,
  ops: readonly CircuitPatchOp[],
): PatchApplySummary {
  // 1. Strict preflight before mutating anything
  runWritePreflight(originalDoc, ops);

  // 2. Deep-clone document for transactional isolation
  const working: CircuitDocument = structuredClone(originalDoc);

  const addedComponents: string[] = [];
  const updatedComponents: string[] = [];
  const removedComponents: string[] = [];
  const addedConnections: string[] = [];
  const removedConnections: string[] = [];

  const nextEdgeId = (): string => {
    let seq = working.connections.length + 1;
    const existing = new Set(working.connections.map((e) => e.id));
    while (existing.has(`E${seq}`)) seq++;
    return `E${seq}`;
  };

  for (const op of ops) {
    switch (op.op) {
      case 'add_component': {
        const defaults = getDefaultParams(op.component.type);
        const node = normalizeComponentNode(
          {
            ...op.component,
            params: { ...defaults, ...(op.component.params ?? {}) },
          },
          op.component.params,
        );
        working.components.push(node);
        addedComponents.push(node.id);
        break;
      }

      case 'update_component': {
        const idx = working.components.findIndex((c) => c.id === op.id);
        if (idx >= 0) {
          const prev = working.components[idx];
          const nextMirror = op.patch.mirror ?? (op.patch.flipped !== undefined ? flippedCodeToMirror(op.patch.flipped) : prev.mirror);
          const nextFlipped = op.patch.flipped ?? (op.patch.mirror !== undefined ? mirrorToFlippedCode(op.patch.mirror) : prev.flipped);
          working.components[idx] = normalizeComponentNode(
            {
              ...prev,
              ...op.patch,
              ...(nextMirror !== undefined ? { mirror: nextMirror } : {}),
              ...(nextFlipped !== undefined ? { flipped: nextFlipped } : {}),
              params: { ...prev.params, ...(op.patch.params ?? {}) },
              ...(op.patch.portTerminators
                ? { portTerminators: { ...(prev.portTerminators ?? {}), ...op.patch.portTerminators } }
                : {}),
            },
            op.patch.params,
          );
          updatedComponents.push(op.id);
        }
        break;
      }

      case 'remove_component': {
        working.components = working.components.filter((c) => c.id !== op.id);
        removedComponents.push(op.id);
        if (op.removeConnectedEdges !== false) {
          const kept: ConnectionEdge[] = [];
          for (const e of working.connections) {
            if (e.from.componentId === op.id || e.to.componentId === op.id) {
              removedConnections.push(e.id);
            } else {
              kept.push(e);
            }
          }
          working.connections = kept;
        }
        break;
      }

      case 'connect': {
        const fromComp = working.components.find((c) => c.id === op.from.componentId)!;
        const fromPort = getPortDefinition(fromComp.type, op.from.port)!;
        const edgeId = op.id ?? nextEdgeId();
        working.connections.push({
          id: edgeId,
          from: { ...op.from },
          to: { ...op.to },
          domain: fromPort.domain,
        });
        addedConnections.push(edgeId);
        break;
      }

      case 'disconnect': {
        const kept: ConnectionEdge[] = [];
        for (const e of working.connections) {
          const matchById = op.edgeId !== undefined && e.id === op.edgeId;
          const matchByPorts =
            op.from !== undefined &&
            op.to !== undefined &&
            ((e.from.componentId === op.from.componentId &&
              e.from.port === op.from.port &&
              e.to.componentId === op.to.componentId &&
              e.to.port === op.to.port) ||
              (e.from.componentId === op.to.componentId &&
                e.from.port === op.to.port &&
                e.to.componentId === op.from.componentId &&
                e.to.port === op.from.port));

          if (matchById || matchByPorts) {
            removedConnections.push(e.id);
          } else {
            kept.push(e);
          }
        }
        working.connections = kept;
        break;
      }

      case 'set_distance_rule': {
        const comp = working.components.find((c) => c.id === op.componentId);
        if (comp) {
          comp.distanceRule = op.markers.map((m) => ({ ...m }));
          updatedComponents.push(op.componentId);
        }
        break;
      }

      case 'set_label': {
        const comp = working.components.find((c) => c.id === op.componentId);
        if (comp) {
          const side = op.side ?? 'component';
          if (side === 'leftActuation') {
            comp.leftActuation = { type: comp.leftActuation?.type ?? 'solenoid', label: op.label };
          } else if (side === 'rightActuation') {
            comp.rightActuation = { type: comp.rightActuation?.type ?? 'solenoid', label: op.label };
          } else {
            comp.label = op.label;
          }
          updatedComponents.push(op.componentId);
        }
        break;
      }

      case 'set_port_terminator': {
        const comp = working.components.find((c) => c.id === op.componentId);
        if (comp) {
          const nextTerms = { ...(comp.portTerminators ?? {}) };
          if (op.terminator === 'none') {
            delete nextTerms[op.port];
          } else {
            nextTerms[op.port] = op.terminator;
          }
          comp.portTerminators = Object.keys(nextTerms).length > 0 ? nextTerms : undefined;
          updatedComponents.push(op.componentId);
        }
        break;
      }

      case 'set_net': {
        const existingNets = [...(working.nets ?? [])];
        const idx = existingNets.findIndex((n) => n.id === op.net.id);
        const normalizedNet = {
          id: op.net.id,
          ...(op.net.name ? { name: op.net.name } : {}),
          domain: op.net.domain,
          endpoints: op.net.endpoints.map((p) => ({ ...p })),
          ...(op.net.terminators ? { terminators: [...op.net.terminators] } : {}),
        };
        if (idx >= 0) existingNets[idx] = normalizedNet;
        else existingNets.push(normalizedNet);
        working.nets = existingNets;
        break;
      }

      case 'remove_net': {
        if (working.nets) {
          working.nets = working.nets.filter((n) => n.id !== op.netId);
        }
        break;
      }
    }
  }

  working.metadata.updatedAt = new Date().toISOString();

  // 3. Auto-layout: full DIN ISO 1219 layout when populating a blank circuit, incremental when patching existing
  const laidOut = autoLayoutCircuit(working, { incremental: originalDoc.components.length > 0 });

  return {
    document: laidOut,
    appliedCount: ops.length,
    addedComponents,
    updatedComponents,
    removedComponents,
    addedConnections,
    removedConnections,
  };
}
