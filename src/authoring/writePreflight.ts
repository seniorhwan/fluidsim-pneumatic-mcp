import type { CircuitDocument, CircuitPatchOp, ComponentNode } from '../contracts/circuit';
import { EngineeringError } from '../contracts/errors';
import { getCatalogComponent, getPortDefinition } from '../catalog/pneumatics45';

/**
 * Pre-mutation checks executed before applying a patch batch to a circuit document.
 * Guarantees domain matching, valid port names, catalog membership, and ID uniqueness.
 */
export function runWritePreflight(doc: CircuitDocument, ops: readonly CircuitPatchOp[]): void {
  const simComps = new Map<string, ComponentNode>(doc.components.map((c) => [c.id, { ...c }]));
  const simEdgeIds = new Set<string>(doc.connections.map((e) => e.id));

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
        if (comp.distanceRule && !def.supportsDistanceRule) {
          throw new EngineeringError({
            category: 'InvalidTopology',
            code: 'PREFLIGHT_UNSUPPORTED_DISTANCE_RULE',
            message: `Component "${comp.id}" (${comp.type}) does not support distanceRule markers.`,
            offendingIds: [comp.id],
            suggestedFix: 'Only attach distanceRule markers to cylinder_single_acting or cylinder_double_acting components.',
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
        simComps.set(op.id, { ...existing, ...op.patch });
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
        if (op.id) simEdgeIds.add(op.id);
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
        if (op.edgeId) simEdgeIds.delete(op.edgeId);
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
        break;
      }
    }
  }
}
