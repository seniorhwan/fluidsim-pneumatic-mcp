import type { CircuitDocument, CircuitPatchOp, ComponentNode, DistanceRuleMarker } from '../contracts/circuit';
import { EngineeringError } from '../contracts/errors';
import { getCatalogComponent, getPortDefinition } from '../catalog/pneumatics45';
import type { CatalogComponentDef } from '../contracts/catalog';

function normalizePairKey(aId: string, aPort: string, bId: string, bPort: string): string {
  const lhs = `${aId}:${aPort}`;
  const rhs = `${bId}:${bPort}`;
  return lhs < rhs ? `${lhs}<->${rhs}` : `${rhs}<->${lhs}`;
}

function validateComponentParams(
  opIndex: number,
  compId: string,
  def: CatalogComponentDef,
  params: Record<string, number | string | boolean>,
): void {
  const specByName = new Map(def.parameters.map((p) => [p.key, p]));
  for (const [key, val] of Object.entries(params)) {
    const spec = specByName.get(key);
    if (!spec) continue; // Allow harmless extension/preserved params
    if (spec.type === 'number') {
      if (typeof val !== 'number' || !Number.isFinite(val)) {
        throw new EngineeringError({
          category: 'InvalidTopology',
          code: 'PREFLIGHT_INVALID_PARAM_TYPE',
          message: `Patch op[${opIndex}] sets numeric param "${key}" on "${compId}" (${def.type}) to non-number value ${JSON.stringify(val)}.`,
          offendingIds: [compId],
          suggestedFix: `Provide a finite number for "${key}"${spec.min !== undefined || spec.max !== undefined ? ` within [${spec.min ?? '-inf'}, ${spec.max ?? '+inf'}]` : ''}.`,
        });
      }
      if (spec.min !== undefined && val < spec.min) {
        throw new EngineeringError({
          category: 'InvalidTopology',
          code: 'PREFLIGHT_PARAM_OUT_OF_RANGE',
          message: `Patch op[${opIndex}] sets "${key}"=${val} on "${compId}" below minimum ${spec.min}.`,
          offendingIds: [compId],
          suggestedFix: `Increase "${key}" to at least ${spec.min}.`,
        });
      }
      if (spec.max !== undefined && val > spec.max) {
        throw new EngineeringError({
          category: 'InvalidTopology',
          code: 'PREFLIGHT_PARAM_OUT_OF_RANGE',
          message: `Patch op[${opIndex}] sets "${key}"=${val} on "${compId}" above maximum ${spec.max}.`,
          offendingIds: [compId],
          suggestedFix: `Reduce "${key}" to at most ${spec.max}.`,
        });
      }
    } else if (spec.type === 'boolean') {
      if (typeof val !== 'boolean') {
        throw new EngineeringError({
          category: 'InvalidTopology',
          code: 'PREFLIGHT_INVALID_PARAM_TYPE',
          message: `Patch op[${opIndex}] sets boolean param "${key}" on "${compId}" to non-boolean value ${JSON.stringify(val)}.`,
          offendingIds: [compId],
          suggestedFix: `Set "${key}" to true or false.`,
        });
      }
    } else if (spec.type === 'enum' && spec.enumValues) {
      if (typeof val !== 'string' || !spec.enumValues.includes(val)) {
        throw new EngineeringError({
          category: 'InvalidTopology',
          code: 'PREFLIGHT_INVALID_PARAM_ENUM',
          message: `Patch op[${opIndex}] sets enum param "${key}" on "${compId}" to invalid value "${String(val)}".`,
          offendingIds: [compId],
          suggestedFix: `Use one of the allowed values for "${key}": [${spec.enumValues.join(', ')}].`,
        });
      }
    }
  }
}

function validateDistanceRuleMarkers(
  opIndex: number,
  compId: string,
  strokeMm: number,
  markers: readonly DistanceRuleMarker[],
): void {
  const seenLabels = new Set<string>();
  for (const m of markers) {
    if (!m.label || m.label.trim().length === 0) {
      throw new EngineeringError({
        category: 'InvalidTopology',
        code: 'PREFLIGHT_EMPTY_MARKER_LABEL',
        message: `Patch op[${opIndex}] has a distanceRule marker with an empty label on "${compId}".`,
        offendingIds: [compId],
        suggestedFix: 'Give each distance-rule marker a unique non-empty label such as "a0" or "a1".',
      });
    }
    if (seenLabels.has(m.label)) {
      throw new EngineeringError({
        category: 'InvalidTopology',
        code: 'PREFLIGHT_DUPLICATE_MARKER_LABEL',
        message: `Patch op[${opIndex}] defines duplicate distanceRule marker "${m.label}" on "${compId}".`,
        offendingIds: [compId],
        suggestedFix: 'Remove or rename the duplicate marker label.',
      });
    }
    seenLabels.add(m.label);
    if (!Number.isFinite(m.positionMm) || m.positionMm < 0 || m.positionMm > strokeMm) {
      throw new EngineeringError({
        category: 'InvalidTopology',
        code: 'PREFLIGHT_MARKER_OUT_OF_STROKE',
        message: `Patch op[${opIndex}] places marker "${m.label}" at ${m.positionMm}mm on "${compId}" outside [0, ${strokeMm}]mm.`,
        offendingIds: [compId],
        suggestedFix: `Set positionMm within [0, ${strokeMm}]mm.`,
      });
    }
  }
}

/**
 * Pre-mutation checks executed before applying a patch batch to a circuit document.
 * Guarantees domain matching, valid port names, catalog membership, parameter bounds,
 * distance-rule bounds, duplicate-edge prevention, and ID uniqueness.
 */
export function runWritePreflight(doc: CircuitDocument, ops: readonly CircuitPatchOp[]): void {
  const simComps = new Map<string, ComponentNode>(doc.components.map((c) => [c.id, { ...c }]));
  const simEdgeIds = new Set<string>(doc.connections.map((e) => e.id));
  const simEdgesById = new Map<string, { from: { componentId: string; port: string }; to: { componentId: string; port: string } }>(
    doc.connections.map((e) => [e.id, { from: e.from, to: e.to }]),
  );
  const simEdgePairs = new Set<string>(
    doc.connections.map((e) => normalizePairKey(e.from.componentId, e.from.port, e.to.componentId, e.to.port)),
  );

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];

    switch (op.op) {
      case 'add_component': {
        const comp = op.component;
        if (!comp.id || comp.id.trim().length === 0) {
          throw new EngineeringError({
            category: 'InvalidTopology',
            code: 'PREFLIGHT_EMPTY_COMPONENT_ID',
            message: `Patch op[${i}] (add_component) has an empty component ID.`,
            offendingIds: [],
            suggestedFix: 'Provide a unique non-empty component ID such as "CYL_A" or "V1".',
          });
        }
        if (simComps.has(comp.id)) {
          throw new EngineeringError({
            category: 'InvalidTopology',
            code: 'PREFLIGHT_DUPLICATE_COMPONENT_ID',
            message: `Patch op[${i}] (add_component) cannot add "${comp.id}" because it already exists.`,
            offendingIds: [comp.id],
            suggestedFix: `Use a unique ID or use "update_component" to modify "${comp.id}".`,
          });
        }
        const def = getCatalogComponent(comp.type);
        if (!def) {
          throw new EngineeringError({
            category: 'InvalidTopology',
            code: 'PREFLIGHT_UNKNOWN_COMPONENT_TYPE',
            message: `Patch op[${i}] (add_component) references unknown catalog type "${comp.type}".`,
            offendingIds: [comp.id],
            suggestedFix: 'Call catalog_search to retrieve exact supported FluidSIM 4.5 componentType names.',
          });
        }
        if (comp.params) {
          validateComponentParams(i, comp.id, def, comp.params);
        }
        if (comp.distanceRule) {
          if (!def.supportsDistanceRule) {
            throw new EngineeringError({
              category: 'InvalidTopology',
              code: 'PREFLIGHT_UNSUPPORTED_DISTANCE_RULE',
              message: `Component "${comp.id}" (${comp.type}) does not support distanceRule markers.`,
              offendingIds: [comp.id],
              suggestedFix: 'Only attach distanceRule markers to cylinder_single_acting or cylinder_double_acting components.',
            });
          }
          const defaultStroke = comp.type === 'cylinder_single_acting' ? 50 : 100;
          const strokeMm = Number(comp.params?.strokeMm ?? defaultStroke);
          validateDistanceRuleMarkers(i, comp.id, strokeMm, comp.distanceRule);
        }
        if ((comp.leftActuation || comp.rightActuation) && !def.supportsActuationConfig) {
          throw new EngineeringError({
            category: 'InvalidTopology',
            code: 'PREFLIGHT_UNSUPPORTED_ACTUATION',
            message: `Component "${comp.id}" (${comp.type}) does not support leftActuation/rightActuation.`,
            offendingIds: [comp.id],
            suggestedFix: 'Only configure valve actuation on directional valve components (valve_3_2, valve_4_2, valve_5_2, valve_5_3).',
          });
        }
        simComps.set(comp.id, { ...comp });
        break;
      }

      case 'update_component': {
        const existing = simComps.get(op.id);
        if (!existing) {
          throw new EngineeringError({
            category: 'InvalidTopology',
            code: 'PREFLIGHT_COMPONENT_NOT_FOUND',
            message: `Patch op[${i}] (update_component) targets missing component "${op.id}".`,
            offendingIds: [op.id],
            suggestedFix: 'Inspect existing component IDs with circuit_query_components before patching.',
          });
        }
        const def = getCatalogComponent(existing.type);
        if (def) {
          if (op.patch.params) {
            validateComponentParams(i, op.id, def, op.patch.params);
          }
          if (op.patch.distanceRule) {
            if (!def.supportsDistanceRule) {
              throw new EngineeringError({
                category: 'InvalidTopology',
                code: 'PREFLIGHT_UNSUPPORTED_DISTANCE_RULE',
                message: `Component "${op.id}" (${existing.type}) does not support distanceRule markers.`,
                offendingIds: [op.id],
                suggestedFix: 'Only set distanceRule markers on cylinder components.',
              });
            }
            const mergedParams = { ...existing.params, ...(op.patch.params ?? {}) };
            const defaultStroke = existing.type === 'cylinder_single_acting' ? 50 : 100;
            const strokeMm = Number(mergedParams.strokeMm ?? defaultStroke);
            validateDistanceRuleMarkers(i, op.id, strokeMm, op.patch.distanceRule);
          }
          if ((op.patch.leftActuation || op.patch.rightActuation) && !def.supportsActuationConfig) {
            throw new EngineeringError({
              category: 'InvalidTopology',
              code: 'PREFLIGHT_UNSUPPORTED_ACTUATION',
              message: `Component "${op.id}" (${existing.type}) does not support valve actuation.`,
              offendingIds: [op.id],
              suggestedFix: 'Only set leftActuation/rightActuation on directional valve components.',
            });
          }
        }
        simComps.set(op.id, {
          ...existing,
          ...op.patch,
          params: { ...existing.params, ...(op.patch.params ?? {}) },
        });
        break;
      }

      case 'remove_component': {
        if (!simComps.has(op.id)) {
          throw new EngineeringError({
            category: 'InvalidTopology',
            code: 'PREFLIGHT_COMPONENT_NOT_FOUND',
            message: `Patch op[${i}] (remove_component) targets missing component "${op.id}".`,
            offendingIds: [op.id],
            suggestedFix: 'Verify the component ID with circuit_query_components.',
          });
        }
        simComps.delete(op.id);
        if (op.removeConnectedEdges !== false) {
          for (const [eid, edge] of Array.from(simEdgesById.entries())) {
            if (edge.from.componentId === op.id || edge.to.componentId === op.id) {
              simEdgesById.delete(eid);
              simEdgeIds.delete(eid);
              simEdgePairs.delete(
                normalizePairKey(edge.from.componentId, edge.from.port, edge.to.componentId, edge.to.port),
              );
            }
          }
        }
        break;
      }

      case 'connect': {
        if (op.id && simEdgeIds.has(op.id)) {
          throw new EngineeringError({
            category: 'InvalidTopology',
            code: 'PREFLIGHT_DUPLICATE_EDGE_ID',
            message: `Patch op[${i}] (connect) reuses existing edge ID "${op.id}".`,
            offendingIds: [op.id],
            suggestedFix: 'Omit edge id for automatic ID generation or choose a unique ID.',
          });
        }
        const fromComp = simComps.get(op.from.componentId);
        const toComp = simComps.get(op.to.componentId);
        if (!fromComp || !toComp) {
          throw new EngineeringError({
            category: 'InvalidTopology',
            code: 'PREFLIGHT_CONNECT_MISSING_COMPONENT',
            message: `Patch op[${i}] (connect) references missing component (${op.from.componentId} -> ${op.to.componentId}).`,
            offendingIds: [op.from.componentId, op.to.componentId].filter((id) => !simComps.has(id)),
            suggestedFix: 'Place add_component operations before connect operations in the same patch batch.',
          });
        }
        if (op.from.componentId === op.to.componentId && op.from.port === op.to.port) {
          throw new EngineeringError({
            category: 'InvalidTopology',
            code: 'PREFLIGHT_SELF_LOOP',
            message: `Patch op[${i}] (connect) cannot connect ${op.from.componentId}.${op.from.port} to itself.`,
            offendingIds: [op.from.componentId],
            suggestedFix: 'Connect two distinct ports.',
          });
        }
        const fromPort = getPortDefinition(fromComp.type, op.from.port);
        const toPort = getPortDefinition(toComp.type, op.to.port);
        if (!fromPort) {
          const validPorts = getCatalogComponent(fromComp.type)?.ports.map((p) => p.name).join(', ') ?? '';
          throw new EngineeringError({
            category: 'InvalidTopology',
            code: 'PREFLIGHT_INVALID_PORT',
            message: `Patch op[${i}] (connect) uses invalid port "${op.from.port}" on ${fromComp.id} (${fromComp.type}).`,
            offendingIds: [fromComp.id],
            suggestedFix: `Use one of the valid ports for ${fromComp.type}: [${validPorts}].`,
          });
        }
        if (!toPort) {
          const validPorts = getCatalogComponent(toComp.type)?.ports.map((p) => p.name).join(', ') ?? '';
          throw new EngineeringError({
            category: 'InvalidTopology',
            code: 'PREFLIGHT_INVALID_PORT',
            message: `Patch op[${i}] (connect) uses invalid port "${op.to.port}" on ${toComp.id} (${toComp.type}).`,
            offendingIds: [toComp.id],
            suggestedFix: `Use one of the valid ports for ${toComp.type}: [${validPorts}].`,
          });
        }
        if (fromPort.domain !== toPort.domain) {
          throw new EngineeringError({
            category: 'InvalidTopology',
            code: 'PREFLIGHT_DOMAIN_MISMATCH',
            message: `Patch op[${i}] (connect) attempts cross-domain wiring: ${fromComp.id}.${fromPort.name} (${fromPort.domain}) -> ${toComp.id}.${toPort.name} (${toPort.domain}).`,
            offendingIds: [fromComp.id, toComp.id],
            suggestedFix:
              'Connect pneumatic ports only to pneumatic ports and electrical ports only to electrical ports; bind domains via labels (e.g. solenoid Y1 or sensor a1).',
          });
        }
        const pairKey = normalizePairKey(op.from.componentId, op.from.port, op.to.componentId, op.to.port);
        if (simEdgePairs.has(pairKey)) {
          throw new EngineeringError({
            category: 'InvalidTopology',
            code: 'PREFLIGHT_DUPLICATE_CONNECTION',
            message: `Patch op[${i}] (connect) duplicates existing connection between ${op.from.componentId}.${op.from.port} and ${op.to.componentId}.${op.to.port}.`,
            offendingIds: [op.from.componentId, op.to.componentId],
            suggestedFix: 'Remove the redundant connect operation or disconnect the existing edge first.',
          });
        }
        simEdgePairs.add(pairKey);
        const edgeId = op.id ?? `__auto_${i}`;
        if (op.id) simEdgeIds.add(op.id);
        simEdgesById.set(edgeId, { from: op.from, to: op.to });
        break;
      }

      case 'disconnect': {
        if (!op.edgeId && (!op.from || !op.to)) {
          throw new EngineeringError({
            category: 'InvalidTopology',
            code: 'PREFLIGHT_INVALID_DISCONNECT',
            message: `Patch op[${i}] (disconnect) must specify either edgeId or both from and to PortRefs.`,
            offendingIds: [],
            suggestedFix: 'Pass edgeId or { from, to } to disconnect.',
          });
        }
        if (op.edgeId) {
          const existingEdge = simEdgesById.get(op.edgeId);
          if (existingEdge) {
            simEdgePairs.delete(
              normalizePairKey(
                existingEdge.from.componentId,
                existingEdge.from.port,
                existingEdge.to.componentId,
                existingEdge.to.port,
              ),
            );
            simEdgesById.delete(op.edgeId);
          }
          simEdgeIds.delete(op.edgeId);
        }
        if (op.from && op.to) {
          const pk = normalizePairKey(op.from.componentId, op.from.port, op.to.componentId, op.to.port);
          simEdgePairs.delete(pk);
          for (const [eid, edge] of Array.from(simEdgesById.entries())) {
            if (normalizePairKey(edge.from.componentId, edge.from.port, edge.to.componentId, edge.to.port) === pk) {
              simEdgesById.delete(eid);
              simEdgeIds.delete(eid);
            }
          }
        }
        break;
      }

      case 'set_distance_rule': {
        const comp = simComps.get(op.componentId);
        if (!comp) {
          throw new EngineeringError({
            category: 'InvalidTopology',
            code: 'PREFLIGHT_COMPONENT_NOT_FOUND',
            message: `Patch op[${i}] (set_distance_rule) targets missing component "${op.componentId}".`,
            offendingIds: [op.componentId],
            suggestedFix: 'Ensure the target cylinder exists before setting its distance rule.',
          });
        }
        const def = getCatalogComponent(comp.type);
        if (!def?.supportsDistanceRule) {
          throw new EngineeringError({
            category: 'InvalidTopology',
            code: 'PREFLIGHT_UNSUPPORTED_DISTANCE_RULE',
            message: `Component "${op.componentId}" (${comp.type}) does not support distanceRule markers.`,
            offendingIds: [op.componentId],
            suggestedFix: 'Target a single-acting or double-acting cylinder.',
          });
        }
        const defaultStroke = comp.type === 'cylinder_single_acting' ? 50 : 100;
        const strokeMm = Number(comp.params?.strokeMm ?? defaultStroke);
        validateDistanceRuleMarkers(i, op.componentId, strokeMm, op.markers);
        break;
      }

      case 'set_label': {
        const comp = simComps.get(op.componentId);
        if (!comp) {
          throw new EngineeringError({
            category: 'InvalidTopology',
            code: 'PREFLIGHT_COMPONENT_NOT_FOUND',
            message: `Patch op[${i}] (set_label) targets missing component "${op.componentId}".`,
            offendingIds: [op.componentId],
            suggestedFix: 'Ensure the target component exists before setting its label.',
          });
        }
        if (op.side === 'leftActuation' || op.side === 'rightActuation') {
          const def = getCatalogComponent(comp.type);
          if (!def?.supportsActuationConfig) {
            throw new EngineeringError({
              category: 'InvalidTopology',
              code: 'PREFLIGHT_UNSUPPORTED_ACTUATION',
              message: `Patch op[${i}] (set_label) cannot set ${op.side} label on non-valve "${op.componentId}" (${comp.type}).`,
              offendingIds: [op.componentId],
              suggestedFix: 'Use side="component" for non-valve components, or target a directional valve.',
            });
          }
        }
        break;
      }
    }
  }
}
