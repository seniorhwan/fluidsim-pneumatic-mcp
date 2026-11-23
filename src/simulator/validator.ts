import type { CircuitDocument, ComponentNode, ConnectionEdge } from '../contracts/circuit';
import type {
  StaticValidationFinding,
  StaticValidationOptions,
  StaticValidationReport,
} from '../contracts/simulation';
import { getCatalogComponent, getPortDefinition } from '../catalog/pneumatics45';
import { normalizeCircuitTopology } from '../authoring/topologyNormalizer';

function portKey(componentId: string, port: string): string {
  return `${componentId}::${port}`;
}

export function validateCircuitStatic(
  rawDoc: CircuitDocument,
  options?: StaticValidationOptions,
): StaticValidationReport {
  const { document: doc } = normalizeCircuitTopology(rawDoc);
  const allowExternalElectricalSheet =
    options?.allowExternalElectricalSheet === true ||
    doc.metadata.allowExternalElectricalSheet === true ||
    doc.metadata.sheetDomain === 'pneumatic-only';
  const findings: StaticValidationFinding[] = [];
  const compById = new Map<string, ComponentNode>();
  const connectedPorts = new Set<string>();
  const portAdjacency = new Map<string, string[]>();

  const addPortEdge = (a: string, b: string): void => {
    const la = portAdjacency.get(a) ?? [];
    la.push(b);
    portAdjacency.set(a, la);
    const lb = portAdjacency.get(b) ?? [];
    lb.push(a);
    portAdjacency.set(b, lb);
  };

  // 1. Validate component definitions & duplicate IDs
  for (const comp of doc.components) {
    if (compById.has(comp.id)) {
      findings.push({
        severity: 'error',
        category: 'InvalidTopology',
        code: 'DUPLICATE_COMPONENT_ID',
        message: `Duplicate component ID "${comp.id}" found.`,
        offendingIds: [comp.id],
        suggestedFix: `Rename one of the duplicate "${comp.id}" components to a unique ID.`,
      });
      continue;
    }
    compById.set(comp.id, comp);

    const def = getCatalogComponent(comp.type);
    if (!def) {
      findings.push({
        severity: 'error',
        category: 'InvalidTopology',
        code: 'UNKNOWN_COMPONENT_TYPE',
        message: `Component "${comp.id}" uses unknown catalog type "${comp.type}".`,
        offendingIds: [comp.id],
        suggestedFix: 'Run catalog_search to find a valid FluidSIM 4.5 componentType.',
      });
      continue;
    }

    // Validate parameter keys & numeric ranges
    for (const [k, v] of Object.entries(comp.params)) {
      const spec = def.parameters.find((p) => p.key === k);
      if (!spec) {
        findings.push({
          severity: 'warning',
          category: 'InvalidTopology',
          code: 'UNKNOWN_PARAMETER',
          message: `Component "${comp.id}" (${comp.type}) has unrecognized parameter "${k}".`,
          offendingIds: [comp.id],
          suggestedFix: `Remove parameter "${k}" or check valid parameters via catalog_search.`,
        });
        continue;
      }
      if (spec.type === 'number' && typeof v === 'number') {
        if ((spec.min !== undefined && v < spec.min) || (spec.max !== undefined && v > spec.max)) {
          findings.push({
            severity: 'error',
            category: 'InvalidTopology',
            code: 'PARAMETER_OUT_OF_RANGE',
            message: `Parameter "${k}"=${v} on "${comp.id}" is outside allowed range [${spec.min ?? '-inf'}, ${spec.max ?? '+inf'}].`,
            offendingIds: [comp.id],
            suggestedFix: `Set "${k}" on "${comp.id}" within [${spec.min ?? 0}, ${spec.max ?? 100}].`,
          });
        }
      }
      if (spec.type === 'enum' && spec.enumValues && !spec.enumValues.includes(String(v))) {
        findings.push({
          severity: 'error',
          category: 'InvalidTopology',
          code: 'INVALID_ENUM_PARAMETER',
          message: `Parameter "${k}"="${String(v)}" on "${comp.id}" must be one of: ${spec.enumValues.join(', ')}.`,
          offendingIds: [comp.id],
          suggestedFix: `Update "${k}" on "${comp.id}" to a valid enum value.`,
        });
      }
    }
  }

  // 2. Validate connections & domain compatibility
  const edgeIds = new Set<string>();
  const seenPortPairs = new Map<string, string>();
  const validEdges: ConnectionEdge[] = [];

  for (const edge of doc.connections) {
    if (edgeIds.has(edge.id)) {
      findings.push({
        severity: 'error',
        category: 'InvalidTopology',
        code: 'DUPLICATE_EDGE_ID',
        message: `Duplicate connection edge ID "${edge.id}".`,
        offendingIds: [edge.id],
        suggestedFix: `Assign a unique ID to edge "${edge.id}".`,
      });
    }
    edgeIds.add(edge.id);

    const fromComp = compById.get(edge.from.componentId);
    const toComp = compById.get(edge.to.componentId);
    if (!fromComp || !toComp) {
      findings.push({
        severity: 'error',
        category: 'InvalidTopology',
        code: 'DANGLING_CONNECTION',
        message: `Edge "${edge.id}" references a missing component (${edge.from.componentId} -> ${edge.to.componentId}).`,
        offendingIds: [edge.id, edge.from.componentId, edge.to.componentId],
        suggestedFix: `Remove edge "${edge.id}" or add the missing component before connecting.`,
      });
      continue;
    }

    if (edge.from.componentId === edge.to.componentId && edge.from.port === edge.to.port) {
      findings.push({
        severity: 'error',
        category: 'InvalidTopology',
        code: 'SELF_LOOP_CONNECTION',
        message: `Edge "${edge.id}" connects port ${edge.from.componentId}.${edge.from.port} to itself.`,
        offendingIds: [edge.id, edge.from.componentId],
        suggestedFix: `Disconnect self-loop edge "${edge.id}".`,
      });
      continue;
    }

    const fromPort = getPortDefinition(fromComp.type, edge.from.port);
    const toPort = getPortDefinition(toComp.type, edge.to.port);
    if (!fromPort || !toPort) {
      findings.push({
        severity: 'error',
        category: 'InvalidTopology',
        code: 'INVALID_PORT_REFERENCE',
        message: `Edge "${edge.id}" references an invalid port (${fromComp.id}.${edge.from.port} -> ${toComp.id}.${edge.to.port}).`,
        offendingIds: [edge.id, fromComp.id, toComp.id],
        suggestedFix: 'Check valid port names with catalog_search and reconnect using exact ISO 1219 / IEC port names.',
      });
      continue;
    }

    if (fromPort.domain !== toPort.domain || edge.domain !== fromPort.domain) {
      findings.push({
        severity: 'error',
        category: 'InvalidTopology',
        code: 'CROSS_DOMAIN_CONNECTION',
        message: `Edge "${edge.id}" mixes domains: ${fromComp.id}.${fromPort.name} (${fromPort.domain}) -> ${toComp.id}.${toPort.name} (${toPort.domain}).`,
        offendingIds: [edge.id, fromComp.id, toComp.id],
        suggestedFix:
          'Keep pneumatic hoses strictly between pneumatic ports and electrical wires between electrical ports; link domains via matching solenoid/sensor labels (e.g. Y1, a1).',
      });
      continue;
    }

    const fk = portKey(fromComp.id, fromPort.name);
    const tk = portKey(toComp.id, toPort.name);
    const pairKey = fk < tk ? `${fk}<->${tk}` : `${tk}<->${fk}`;
    const prevEdgeId = seenPortPairs.get(pairKey);
    if (prevEdgeId) {
      findings.push({
        severity: 'warning',
        category: 'InvalidTopology',
        code: 'DUPLICATE_CONNECTION',
        message: `Edge "${edge.id}" duplicates existing connection "${prevEdgeId}" between ${fromComp.id}.${fromPort.name} and ${toComp.id}.${toPort.name}.`,
        offendingIds: [edge.id, prevEdgeId],
        suggestedFix: `Disconnect duplicate edge "${edge.id}".`,
      });
    } else {
      seenPortPairs.set(pairKey, edge.id);
    }

    validEdges.push(edge);
    connectedPorts.add(fk);
    connectedPorts.add(tk);
    addPortEdge(fk, tk);
  }

  // 3. Domain presence checks
  const pneumaticComps = doc.components.filter((c) => {
    const def = getCatalogComponent(c.type);
    return def && (def.domain === 'pneumatic' || def.domain === 'hybrid');
  });
  const electricalComps = doc.components.filter((c) => {
    const def = getCatalogComponent(c.type);
    return def && def.domain === 'electrical';
  });

  const airSources = doc.components.filter((c) => c.type === 'air_source');
  const pneumaticWorkComps = pneumaticComps.filter(
    (c) =>
      c.type !== 'air_source' &&
      c.type !== 'exhaust_silencer' &&
      c.type !== 'pneumatic_junction' &&
      c.type !== 'pneumatic_manifold' &&
      c.type !== 'blind_plug',
  );
  if (pneumaticWorkComps.length > 0 && airSources.length === 0) {
    findings.push({
      severity: 'error',
      category: 'PneumaticRuleViolation',
      code: 'MISSING_AIR_SOURCE',
      message: 'Circuit contains pneumatic valves/actuators but has no compressed air_source.',
      offendingIds: pneumaticWorkComps.map((c) => c.id),
      suggestedFix: 'Add an "air_source" component (6.0 bar) and connect port 1 to the pneumatic supply manifold or valve port 1.',
    });
  }

  // 4. Open pneumatic ports & missing exhaust terminators
  for (const comp of pneumaticComps) {
    const def = getCatalogComponent(comp.type);
    if (!def) continue;
    // Symmetric multi-port distribution nodes (pneumatic_junction / pneumatic_manifold)
    // are valid once any 2+ ports are connected (validated by DANGLING_JUNCTION below).
    const isSymmetricDistributor =
      comp.type === 'pneumatic_junction' || comp.type === 'pneumatic_manifold';
    const wiredPortCount = isSymmetricDistributor
      ? def.ports.filter((p) => connectedPorts.has(portKey(comp.id, p.name))).length
      : 0;

    if (!isSymmetricDistributor || wiredPortCount < 2) {
      for (const p of def.ports) {
        if (!p.required) continue;
        const pk = portKey(comp.id, p.name);
        if (!connectedPorts.has(pk)) {
          if (p.role === 'exhaust') {
            findings.push({
              severity: 'error',
              category: 'PneumaticRuleViolation',
              code: 'MISSING_EXHAUST_TERMINATOR',
              message: `Exhaust port "${p.name}" on ${comp.id} (${comp.type}) is open with no exhaust_silencer terminator.`,
              offendingIds: [comp.id],
              suggestedFix: `Add an "exhaust_silencer" component and connect it to ${comp.id}.${p.name}.`,
            });
          } else {
            findings.push({
              severity: 'error',
              category: 'PneumaticRuleViolation',
              code: 'OPEN_PNEUMATIC_PORT',
              message: `Required pneumatic ${p.role} port "${p.name}" on ${comp.id} (${comp.type}) is unconnected.`,
              offendingIds: [comp.id],
              suggestedFix: `Connect ${comp.id}.${p.name} to the appropriate pneumatic line, supply, or actuator port.`,
            });
          }
        }
      }
    }

    // Check pneumatic pilot ports if actuation is pneumatic_pilot (pneumatic_spring is internal, no external port required)
    if (def.supportsActuationConfig) {
      const leftPilotPort = comp.type === 'valve_3_2' || comp.type === 'valve_2_2' ? '12' : '14';
      const rightPilotPort = comp.type === 'valve_3_2' || comp.type === 'valve_2_2' ? '10' : '12';
      if (comp.leftActuation?.type === 'pneumatic_pilot' && !connectedPorts.has(portKey(comp.id, leftPilotPort))) {
        findings.push({
          severity: 'error',
          category: 'PneumaticRuleViolation',
          code: 'UNCONNECTED_PILOT_PORT',
          message: `Valve ${comp.id} has leftActuation="pneumatic_pilot" but pilot port "${leftPilotPort}" is unconnected.`,
          offendingIds: [comp.id],
          suggestedFix: `Connect a pilot signal line to ${comp.id}.${leftPilotPort} or use "pneumatic_spring" if internally air-spring returned.`,
        });
      }
      if (comp.rightActuation?.type === 'pneumatic_pilot' && !connectedPorts.has(portKey(comp.id, rightPilotPort))) {
        findings.push({
          severity: 'error',
          category: 'PneumaticRuleViolation',
          code: 'UNCONNECTED_PILOT_PORT',
          message: `Valve ${comp.id} has rightActuation="pneumatic_pilot" but pilot port "${rightPilotPort}" is unconnected.`,
          offendingIds: [comp.id],
          suggestedFix: `Connect a pilot signal line to ${comp.id}.${rightPilotPort} or use "pneumatic_spring" if internally air-spring returned.`,
        });
      }
      if (
        (!comp.leftActuation || comp.leftActuation.type === 'none') &&
        (!comp.rightActuation || comp.rightActuation.type === 'none')
      ) {
        findings.push({
          severity: 'error',
          category: 'PneumaticRuleViolation',
          code: 'UNACTUATED_VALVE',
          message: `Directional valve ${comp.id} (${comp.type}) has neither leftActuation nor rightActuation configured and can never switch.`,
          offendingIds: [comp.id],
          suggestedFix: `Configure leftActuation (e.g. solenoid, pneumatic_pilot, pushbutton, roller) and rightActuation (e.g. spring, pneumatic_spring, or pilot) on ${comp.id}.`,
        });
      }
    }

    if (comp.type === 'pneumatic_junction') {
      const wiredCount = ['1', '2', '3', '4'].filter((pn) => connectedPorts.has(portKey(comp.id, pn))).length;
      if (wiredCount < 2) {
        findings.push({
          severity: 'warning',
          category: 'PneumaticRuleViolation',
          code: 'DANGLING_JUNCTION',
          message: `Pneumatic junction ${comp.id} has only ${wiredCount} connected port(s).`,
          offendingIds: [comp.id],
          suggestedFix: `Connect at least 2 pneumatic lines to ${comp.id} or remove the unused junction.`,
        });
      }
    } else if (comp.type === 'pneumatic_manifold') {
      const wiredCount = ['1', '2', '3', '4', '5', '6', '7', '8'].filter((pn) =>
        connectedPorts.has(portKey(comp.id, pn)),
      ).length;
      if (wiredCount < 2) {
        findings.push({
          severity: 'warning',
          category: 'PneumaticRuleViolation',
          code: 'DANGLING_JUNCTION',
          message: `Pneumatic manifold ${comp.id} has only ${wiredCount} connected port(s).`,
          offendingIds: [comp.id],
          suggestedFix: `Connect at least 2 pneumatic lines/plugs to ${comp.id} or remove the unused manifold.`,
        });
      }
    }
  }

  // 4b. Check for double-acting / rodless / swivel actuator chamber A directly shorted to chamber B
  const pneuDirectGraph = new Map<string, Set<string>>();
  const linkDirect = (a: string, b: string): void => {
    if (!pneuDirectGraph.has(a)) pneuDirectGraph.set(a, new Set());
    if (!pneuDirectGraph.has(b)) pneuDirectGraph.set(b, new Set());
    pneuDirectGraph.get(a)!.add(b);
    pneuDirectGraph.get(b)!.add(a);
  };
  for (const e of validEdges) {
    if (e.domain !== 'pneumatic') continue;
    linkDirect(portKey(e.from.componentId, e.from.port), portKey(e.to.componentId, e.to.port));
  }
  for (const c of pneumaticComps) {
    if (c.type === 'pneumatic_junction') {
      linkDirect(portKey(c.id, '1'), portKey(c.id, '2'));
      linkDirect(portKey(c.id, '1'), portKey(c.id, '3'));
      linkDirect(portKey(c.id, '1'), portKey(c.id, '4'));
    } else if (c.type === 'pneumatic_manifold') {
      for (const pn of ['2', '3', '4', '5', '6', '7', '8']) {
        linkDirect(portKey(c.id, '1'), portKey(c.id, pn));
      }
    }
  }
  for (const c of pneumaticComps) {
    if (
      c.type !== 'cylinder_double_acting' &&
      c.type !== 'cylinder_rodless' &&
      c.type !== 'swivel_drive'
    ) {
      continue;
    }
    const start = portKey(c.id, 'A');
    const target = portKey(c.id, 'B');
    const seen = new Set<string>([start]);
    const q = [start];
    let shorted = false;
    while (q.length > 0) {
      const u = q.shift()!;
      if (u === target) {
        shorted = true;
        break;
      }
      for (const v of pneuDirectGraph.get(u) ?? []) {
        if (!seen.has(v)) {
          seen.add(v);
          q.push(v);
        }
      }
    }
    if (shorted) {
      findings.push({
        severity: 'error',
        category: 'PneumaticRuleViolation',
        code: 'PNEUMATIC_CHAMBER_SHORT',
        message: `Double-acting cylinder ${c.id} has chambers A and B shorted together on the same pneumatic line.`,
        offendingIds: [c.id],
        suggestedFix: `Connect ${c.id}.A to directional valve port 4 and ${c.id}.B to port 2 separately.`,
      });
    }
  }

  // 5. Pneumatic supply reachability BFS from air_source
  if (airSources.length > 0) {
    const visitedPorts = new Set<string>();
    const queue: string[] = [];
    for (const src of airSources) {
      const k = portKey(src.id, '1');
      visitedPorts.add(k);
      queue.push(k);
    }
    while (queue.length > 0) {
      const curr = queue.shift()!;
      for (const next of portAdjacency.get(curr) ?? []) {
        if (!visitedPorts.has(next)) {
          visitedPorts.add(next);
          queue.push(next);
        }
      }
      const [cid, pname] = curr.split('::');
      const comp = compById.get(cid);
      if (!comp) continue;
      // Traverse through supply-forwarding components
      const forwardPorts: string[] = [];
      if (
        comp.type === 'air_service_unit' ||
        comp.type === 'pressure_regulator' ||
        comp.type === 'pressure_relief_valve'
      ) {
        if (pname === '1') forwardPorts.push('2');
      } else if (comp.type === 'pneumatic_junction') {
        forwardPorts.push('1', '2', '3', '4');
      } else if (comp.type === 'pneumatic_manifold') {
        forwardPorts.push('1', '2', '3', '4', '5', '6', '7', '8');
      } else if (
        comp.type === 'flow_control_one_way' ||
        comp.type === 'throttle_valve' ||
        comp.type === 'air_filter' ||
        comp.type === 'air_reservoir' ||
        comp.type === 'check_valve' ||
        comp.type === 'check_valve_spring' ||
        comp.type === 'check_valve_pilot_open' ||
        comp.type === 'nozzle' ||
        comp.type === 'orifice'
      ) {
        if (pname === '1') forwardPorts.push('2');
        if (pname === '2') forwardPorts.push('1');
      } else if (comp.type === 'quick_exhaust_valve') {
        if (pname === '1') forwardPorts.push('2');
      } else if (comp.type === 'shuttle_valve_or' || comp.type === 'dual_pressure_valve_and') {
        if (pname === '1' || pname === '1_2') forwardPorts.push('2');
      } else if (
        comp.type === 'valve_2_2' ||
        comp.type === 'valve_3_2' ||
        comp.type === 'time_delay_valve' ||
        comp.type === 'pressure_sequence_valve'
      ) {
        if (pname === '1') forwardPorts.push('2');
      } else if (comp.type === 'vacuum_suction_nozzle') {
        if (pname === '1') forwardPorts.push('1v');
      } else if (comp.type === 'valve_4_2' || comp.type === 'valve_5_2' || comp.type === 'valve_5_3') {
        if (pname === '1') forwardPorts.push('2', '4');
      }

      for (const fp of forwardPorts) {
        const fk = portKey(cid, fp);
        if (!visitedPorts.has(fk)) {
          visitedPorts.add(fk);
          queue.push(fk);
        }
      }
    }

    for (const comp of pneumaticComps) {
      const def = getCatalogComponent(comp.type);
      if (!def) continue;
      if (
        comp.type === 'valve_2_2' ||
        comp.type === 'valve_3_2' ||
        comp.type === 'valve_4_2' ||
        comp.type === 'valve_5_2' ||
        comp.type === 'valve_5_3' ||
        comp.type === 'time_delay_valve' ||
        comp.type === 'pressure_sequence_valve' ||
        comp.type === 'vacuum_suction_nozzle'
      ) {
        const supplyKey = portKey(comp.id, '1');
        if (connectedPorts.has(supplyKey) && !visitedPorts.has(supplyKey)) {
          findings.push({
            severity: 'error',
            category: 'PneumaticRuleViolation',
            code: 'UNREACHABLE_AIR_SUPPLY',
            message: `Supply port 1 on ${comp.id} (${comp.type}) has no pneumatic path back to an air_source.`,
            offendingIds: [comp.id],
            suggestedFix: `Connect ${comp.id}.1 to the compressed air_source or an active cascade supply line.`,
          });
        }
      }
    }
  }

  // 6. Label cross-reference validation (distance rules, pressure switches, limit switches, relays, solenoids)
  const distanceMarkers = new Map<string, string[]>();
  const pressureSwitchLabels = new Map<string, string[]>();
  const coilLabels = new Map<string, string[]>();
  const solenoidLabels = new Map<string, string[]>();
  const valveSolenoidRefs = new Map<string, string[]>();

  for (const comp of doc.components) {
    if (comp.distanceRule) {
      const maxSpan =
        comp.type === 'swivel_drive'
          ? typeof comp.params.maxAngleDeg === 'number'
            ? comp.params.maxAngleDeg
            : 180
          : typeof comp.params.strokeMm === 'number'
            ? comp.params.strokeMm
            : comp.type === 'cylinder_single_acting'
              ? 50
              : comp.type === 'cylinder_rodless'
                ? 200
                : 100;
      const unit = comp.type === 'swivel_drive' ? 'deg' : 'mm';
      for (const m of comp.distanceRule) {
        const list = distanceMarkers.get(m.label) ?? [];
        list.push(comp.id);
        distanceMarkers.set(m.label, list);
        if (m.positionMm < 0 || m.positionMm > maxSpan) {
          findings.push({
            severity: 'error',
            category: 'PneumaticRuleViolation',
            code: 'DISTANCE_RULE_OUT_OF_STROKE',
            message: `Distance-rule marker "${m.label}" (${m.positionMm} ${unit}) on ${comp.id} exceeds span (${maxSpan} ${unit}).`,
            offendingIds: [comp.id],
            suggestedFix: `Set marker "${m.label}" positionMm within [0, ${maxSpan}].`,
          });
        }
      }
    }

    if (
      (comp.type === 'pressure_switch_differential' || comp.type === 'pressure_switch_pew') &&
      comp.label
    ) {
      const list = pressureSwitchLabels.get(comp.label) ?? [];
      list.push(comp.id);
      pressureSwitchLabels.set(comp.label, list);
    }

    if (
      comp.type === 'relay_coil' ||
      comp.type === 'timer_relay_on_delay' ||
      comp.type === 'timer_relay_off_delay' ||
      comp.type === 'electrical_counter'
    ) {
      if (!comp.label) {
        findings.push({
          severity: 'error',
          category: 'ElectricalRuleViolation',
          code: 'UNLABELED_COIL',
          message: `Coil component "${comp.id}" (${comp.type}) has no label (e.g., K1, T1, C1).`,
          offendingIds: [comp.id],
          suggestedFix: `Assign a unique label to "${comp.id}" using set_label.`,
        });
      } else {
        const list = coilLabels.get(comp.label) ?? [];
        list.push(comp.id);
        coilLabels.set(comp.label, list);
      }
    }

    if (comp.type === 'valve_solenoid') {
      if (!comp.label) {
        findings.push({
          severity: 'error',
          category: 'ElectricalRuleViolation',
          code: 'UNLABELED_SOLENOID',
          message: `Valve solenoid "${comp.id}" has no label (e.g., Y1).`,
          offendingIds: [comp.id],
          suggestedFix: `Set label on "${comp.id}" to match a directional valve solenoid pilot (e.g., Y1).`,
        });
      } else {
        const list = solenoidLabels.get(comp.label) ?? [];
        list.push(comp.id);
        solenoidLabels.set(comp.label, list);
      }
    }

    if (comp.leftActuation?.type === 'solenoid' && comp.leftActuation.label) {
      const list = valveSolenoidRefs.get(comp.leftActuation.label) ?? [];
      list.push(comp.id);
      valveSolenoidRefs.set(comp.leftActuation.label, list);
    }
    if (comp.rightActuation?.type === 'solenoid' && comp.rightActuation.label) {
      const list = valveSolenoidRefs.get(comp.rightActuation.label) ?? [];
      list.push(comp.id);
      valveSolenoidRefs.set(comp.rightActuation.label, list);
    }
  }

  for (const [label, ids] of distanceMarkers.entries()) {
    if (ids.length > 1) {
      findings.push({
        severity: 'error',
        category: 'PneumaticRuleViolation',
        code: 'DUPLICATE_DISTANCE_RULE_LABEL',
        message: `Distance-rule marker label "${label}" is defined multiple times on: ${ids.join(', ')}.`,
        offendingIds: ids,
        suggestedFix: `Use unique distance-rule labels per cylinder (e.g. a0/a1 for A, b0/b1 for B).`,
      });
    }
  }

  for (const [label, ids] of coilLabels.entries()) {
    if (ids.length > 1) {
      findings.push({
        severity: 'error',
        category: 'ElectricalRuleViolation',
        code: 'DUPLICATE_COIL_LABEL',
        message: `Relay/timer/counter coil label "${label}" is duplicated across: ${ids.join(', ')}.`,
        offendingIds: ids,
        suggestedFix: `Give each coil a unique label (e.g. K1, K2) or drive one coil with parallel branches.`,
      });
    }
  }

  for (const [label, ids] of solenoidLabels.entries()) {
    if (ids.length > 1) {
      findings.push({
        severity: 'error',
        category: 'ElectricalRuleViolation',
        code: 'DUPLICATE_SOLENOID_LABEL',
        message: `Solenoid label "${label}" appears on multiple electrical coils: ${ids.join(', ')}.`,
        offendingIds: ids,
        suggestedFix: `Keep a single valve_solenoid "${label}" and wire parallel control branches to its A1 terminal.`,
      });
    }
    if (!valveSolenoidRefs.has(label)) {
      findings.push({
        severity: 'error',
        category: 'ElectricalRuleViolation',
        code: 'ORPHANED_SOLENOID',
        message: `Electrical solenoid "${label}" (${ids.join(', ')}) has no matching pneumatic valve pilot with label "${label}".`,
        offendingIds: ids,
        suggestedFix: `Set leftActuation or rightActuation on the target directional valve to { type: "solenoid", label: "${label}" }.`,
      });
    }
  }

  if (!allowExternalElectricalSheet) {
    for (const [label, valveIds] of valveSolenoidRefs.entries()) {
      if (!solenoidLabels.has(label)) {
        findings.push({
          severity: 'error',
          category: 'ElectricalRuleViolation',
          code: 'UNBOUND_VALVE_SOLENOID',
          message: `Valve(s) ${valveIds.join(', ')} reference solenoid "${label}", but no electrical valve_solenoid "${label}" exists.`,
          offendingIds: valveIds,
          suggestedFix: `Add a "valve_solenoid" component with label "${label}" in the 24V/0V ladder, or set allowExternalElectricalSheet=true / sheetDomain="pneumatic-only" for pneumatic-only sheets.`,
        });
      }
    }
  }

  // Validate sensor & relay contact bindings
  for (const comp of doc.components) {
    if (
      comp.type === 'limit_switch_no' ||
      comp.type === 'limit_switch_nc' ||
      comp.type === 'proximity_switch_magnetic'
    ) {
      if (!comp.label || (!distanceMarkers.has(comp.label) && !pressureSwitchLabels.has(comp.label))) {
        findings.push({
          severity: 'error',
          category: 'ElectricalRuleViolation',
          code: 'ORPHANED_SENSOR_BINDING',
          message: `Sensor "${comp.id}" (${comp.type}) references label "${comp.label ?? '<none>'}", which is not defined on any actuator distanceRule or pressure switch.`,
          offendingIds: [comp.id],
          suggestedFix: `Add marker "${comp.label ?? 'a1'}" to the target actuator via set_distance_rule or add a matching pressure_switch_differential.`,
        });
      }
    }

    if (
      comp.type === 'relay_contact_no' ||
      comp.type === 'relay_contact_nc' ||
      comp.type === 'relay_contact_changeover'
    ) {
      if (!comp.label || (!coilLabels.has(comp.label) && !pressureSwitchLabels.has(comp.label))) {
        findings.push({
          severity: 'error',
          category: 'ElectricalRuleViolation',
          code: 'ORPHANED_RELAY_CONTACT',
          message: `Relay contact "${comp.id}" references coil/switch "${comp.label ?? '<none>'}", which does not exist.`,
          offendingIds: [comp.id],
          suggestedFix: `Add a relay_coil/timer/counter/pressure_switch_differential labeled "${comp.label ?? 'K1'}" or fix the contact label.`,
        });
      }
    }

    // Check pneumatic roller limit switches on valves
    for (const side of [comp.leftActuation, comp.rightActuation]) {
      if (side && (side.type === 'roller' || side.type === 'idle_return_roller')) {
        if (!side.label || !distanceMarkers.has(side.label)) {
          findings.push({
            severity: 'error',
            category: 'PneumaticRuleViolation',
            code: 'ORPHANED_ROLLER_SENSOR',
            message: `Valve "${comp.id}" has ${side.type} actuation referencing "${side.label ?? '<none>'}", which is not on any cylinder distanceRule.`,
            offendingIds: [comp.id],
            suggestedFix: `Add distance-rule marker "${side.label ?? 'a1'}" on the corresponding cylinder.`,
          });
        }
      }
    }
  }

  // 7. Static opposing-pilot risk warning on bistable pneumatic valves
  for (const comp of doc.components) {
    if (comp.type !== 'valve_5_2' && comp.type !== 'valve_4_2') continue;
    if (
      comp.leftActuation?.type === 'pneumatic_pilot' &&
      comp.rightActuation?.type === 'pneumatic_pilot'
    ) {
      const leftDriver = findDirectPilotDriver(comp.id, '14', validEdges, compById);
      const rightDriver = findDirectPilotDriver(comp.id, '12', validEdges, compById);
      if (
        leftDriver?.leftActuation?.type === 'roller' &&
        rightDriver?.leftActuation?.type === 'roller'
      ) {
        // Check if both roller valves are fed directly from constant air supply rather than cascade group lines
        const leftFedDirect = isFedDirectlyFromAirSource(leftDriver.id, validEdges, compById);
        const rightFedDirect = isFedDirectlyFromAirSource(rightDriver.id, validEdges, compById);
        if (leftFedDirect && rightFedDirect) {
          findings.push({
            severity: 'warning',
            category: 'PneumaticRuleViolation',
            code: 'STATIC_OPPOSING_PILOT_RISK',
            message: `Bistable valve ${comp.id} has both pilots (14 via ${leftDriver.id}, 12 via ${rightDriver.id}) driven by constant-supply roller valves, which can cause opposing-pilot lockup in reversing sequences.`,
            offendingIds: [comp.id, leftDriver.id, rightDriver.id],
            suggestedFix:
              'Verify with circuit_simulate; if opposing pilots occur, use cascade group supply lines, idle-return rollers, or an electro-pneumatic step-chain.',
          });
        }
      }
    }
  }

  // 8. Electrical ladder validation (24V/0V rails, short-circuit, coil return & reachability)
  if (electricalComps.length > 0) {
    const rails24 = electricalComps.filter((c) => c.type === 'power_24v');
    const rails0 = electricalComps.filter((c) => c.type === 'power_0v');

    if (rails24.length === 0) {
      findings.push({
        severity: 'error',
        category: 'ElectricalRuleViolation',
        code: 'MISSING_24V_RAIL',
        message: 'Circuit contains electrical components but has no +24V power_24v rail.',
        offendingIds: electricalComps.map((c) => c.id),
        suggestedFix: 'Add a "power_24v" component and wire its OUT port to the top of your ladder rungs.',
      });
    }
    if (rails0.length === 0) {
      findings.push({
        severity: 'error',
        category: 'ElectricalRuleViolation',
        code: 'MISSING_0V_RAIL',
        message: 'Circuit contains electrical components but has no 0V power_0v return rail.',
        offendingIds: electricalComps.map((c) => c.id),
        suggestedFix: 'Add a "power_0v" component and wire coil A2 / lamp X2 terminals to its IN port.',
      });
    }

    // Build electrical conductivity graph (wires + junctions + switches/contacts, NOT coils)
    const wireGraph = new Map<string, Set<string>>();
    const allSwitchGraph = new Map<string, Set<string>>();
    const restClosedGraph = new Map<string, Set<string>>();

    const link = (g: Map<string, Set<string>>, a: string, b: string): void => {
      if (!g.has(a)) g.set(a, new Set());
      if (!g.has(b)) g.set(b, new Set());
      g.get(a)!.add(b);
      g.get(b)!.add(a);
    };

    for (const e of validEdges) {
      if (e.domain !== 'electrical') continue;
      const a = portKey(e.from.componentId, e.from.port);
      const b = portKey(e.to.componentId, e.to.port);
      link(wireGraph, a, b);
      link(allSwitchGraph, a, b);
      link(restClosedGraph, a, b);
    }

    for (const c of electricalComps) {
      if (c.type === 'electrical_junction') {
        const ports = ['1', '2', '3', '4'];
        for (let i = 0; i < ports.length; i++) {
          for (let j = i + 1; j < ports.length; j++) {
            const a = portKey(c.id, ports[i]);
            const b = portKey(c.id, ports[j]);
            link(wireGraph, a, b);
            link(allSwitchGraph, a, b);
            link(restClosedGraph, a, b);
          }
        }
      } else if (
        c.type === 'pushbutton_no' ||
        c.type === 'limit_switch_no' ||
        c.type === 'relay_contact_no'
      ) {
        link(allSwitchGraph, portKey(c.id, '13'), portKey(c.id, '14'));
      } else if (
        c.type === 'pushbutton_nc' ||
        c.type === 'limit_switch_nc' ||
        c.type === 'relay_contact_nc'
      ) {
        link(allSwitchGraph, portKey(c.id, '11'), portKey(c.id, '12'));
        link(restClosedGraph, portKey(c.id, '11'), portKey(c.id, '12'));
      } else if (c.type === 'proximity_switch_magnetic') {
        link(allSwitchGraph, portKey(c.id, '13'), portKey(c.id, '14'));
        if (c.params.normalState === 'NC') {
          link(restClosedGraph, portKey(c.id, '13'), portKey(c.id, '14'));
        }
      } else if (c.type === 'relay_contact_changeover') {
        link(allSwitchGraph, portKey(c.id, '11'), portKey(c.id, '12'));
        link(allSwitchGraph, portKey(c.id, '11'), portKey(c.id, '14'));
        link(restClosedGraph, portKey(c.id, '11'), portKey(c.id, '12'));
      }
    }

    const bfs = (graph: Map<string, Set<string>>, seeds: string[]): Set<string> => {
      const seen = new Set<string>(seeds);
      const q = [...seeds];
      while (q.length > 0) {
        const u = q.shift()!;
        for (const v of graph.get(u) ?? []) {
          if (!seen.has(v)) {
            seen.add(v);
            q.push(v);
          }
        }
      }
      return seen;
    };

    const seeds24 = rails24.map((r) => portKey(r.id, 'OUT'));
    const seeds0 = rails0.map((r) => portKey(r.id, 'IN'));

    // Direct short check (pure wire OR rest-closed contacts bridging 24V -> 0V without a load)
    const reachFrom24Rest = bfs(restClosedGraph, seeds24);
    const shorted0 = seeds0.filter((s) => reachFrom24Rest.has(s));
    if (shorted0.length > 0) {
      findings.push({
        severity: 'error',
        category: 'ElectricalRuleViolation',
        code: 'DIRECT_SHORT_CIRCUIT',
        message: 'Direct short-circuit path detected between +24V and 0V rails without a coil/lamp load.',
        offendingIds: [...rails24.map((r) => r.id), ...rails0.map((r) => r.id)],
        suggestedFix: 'Insert a relay_coil, valve_solenoid, or indicator_lamp load in series before connecting to the 0V rail.',
      });
    }

    // Coil / solenoid / lamp reachability from +24V and 0V
    const reachFrom24Any = bfs(allSwitchGraph, seeds24);
    const reachFrom0Any = bfs(allSwitchGraph, seeds0);

    for (const c of electricalComps) {
      const loadPorts: Array<[string, string]> = [];
      if (
        c.type === 'relay_coil' ||
        c.type === 'valve_solenoid' ||
        c.type === 'timer_relay_on_delay' ||
        c.type === 'timer_relay_off_delay' ||
        c.type === 'electrical_counter'
      ) {
        loadPorts.push(['A1', 'A2']);
      } else if (c.type === 'indicator_lamp') {
        loadPorts.push(['X1', 'X2']);
      }

      for (const [pIn, pOut] of loadPorts) {
        const kIn = portKey(c.id, pIn);
        const kOut = portKey(c.id, pOut);
        const inCan24 = reachFrom24Any.has(kIn);
        const outCan0 = reachFrom0Any.has(kOut);
        const swappedOk = reachFrom24Any.has(kOut) && reachFrom0Any.has(kIn);

        if (!outCan0 && !swappedOk) {
          findings.push({
            severity: 'error',
            category: 'ElectricalRuleViolation',
            code: 'MISSING_0V_RETURN',
            message: `Electrical load "${c.id}" (${c.label ?? c.type}) has no return path from terminal ${pOut} to the 0V rail.`,
            offendingIds: [c.id],
            suggestedFix: `Connect ${c.id}.${pOut} to power_0v.IN.`,
          });
        }
        if (!inCan24 && !swappedOk) {
          findings.push({
            severity: 'error',
            category: 'ElectricalRuleViolation',
            code: 'UNREACHABLE_ELECTRICAL_RUNG',
            message: `Electrical load "${c.id}" (${c.label ?? c.type}) cannot be energized from +24V rail through terminal ${pIn}.`,
            offendingIds: [c.id],
            suggestedFix: `Wire ${c.id}.${pIn} through switches/contacts back to power_24v.OUT.`,
          });
        }
      }
    }

    // Warn on floating/unconnected switch/contact ports or dangling electrical junctions
    for (const c of electricalComps) {
      if (c.type === 'electrical_junction') {
        const wiredCount = ['1', '2', '3', '4'].filter((pn) => connectedPorts.has(portKey(c.id, pn))).length;
        if (wiredCount < 2) {
          findings.push({
            severity: 'warning',
            category: 'ElectricalRuleViolation',
            code: 'DANGLING_JUNCTION',
            message: `Electrical junction ${c.id} has only ${wiredCount} connected port(s).`,
            offendingIds: [c.id],
            suggestedFix: `Connect at least 2 wires to ${c.id} or remove the unused junction.`,
          });
        }
      } else if (
        c.type === 'pushbutton_no' ||
        c.type === 'limit_switch_no' ||
        c.type === 'proximity_switch_magnetic' ||
        c.type === 'relay_contact_no'
      ) {
        if (!connectedPorts.has(portKey(c.id, '13')) || !connectedPorts.has(portKey(c.id, '14'))) {
          findings.push({
            severity: 'warning',
            category: 'ElectricalRuleViolation',
            code: 'OPEN_ELECTRICAL_PORT',
            message: `Electrical switch/contact "${c.id}" (${c.label ?? c.type}) has an unconnected terminal (13 or 14).`,
            offendingIds: [c.id],
            suggestedFix: `Wire both terminals 13 and 14 of "${c.id}" into a ladder rung or remove it.`,
          });
        }
      } else if (
        c.type === 'pushbutton_nc' ||
        c.type === 'limit_switch_nc' ||
        c.type === 'relay_contact_nc'
      ) {
        if (!connectedPorts.has(portKey(c.id, '11')) || !connectedPorts.has(portKey(c.id, '12'))) {
          findings.push({
            severity: 'warning',
            category: 'ElectricalRuleViolation',
            code: 'OPEN_ELECTRICAL_PORT',
            message: `Electrical NC switch/contact "${c.id}" (${c.label ?? c.type}) has an unconnected terminal (11 or 12).`,
            offendingIds: [c.id],
            suggestedFix: `Wire both terminals 11 and 12 of "${c.id}" into a ladder rung or remove it.`,
          });
        }
      }
    }
  }

  const errorCount = findings.filter((f) => f.severity === 'error').length;
  const warningCount = findings.filter((f) => f.severity === 'warning').length;

  return {
    valid: errorCount === 0,
    errorCount,
    warningCount,
    findings,
  };
}

function findDirectPilotDriver(
  valveId: string,
  pilotPort: string,
  edges: ConnectionEdge[],
  compById: Map<string, ComponentNode>,
): ComponentNode | undefined {
  for (const e of edges) {
    if (e.domain !== 'pneumatic') continue;
    if (e.to.componentId === valveId && e.to.port === pilotPort) {
      return compById.get(e.from.componentId);
    }
    if (e.from.componentId === valveId && e.from.port === pilotPort) {
      return compById.get(e.to.componentId);
    }
  }
  return undefined;
}

function isFedDirectlyFromAirSource(
  compId: string,
  edges: ConnectionEdge[],
  compById: Map<string, ComponentNode>,
): boolean {
  const seen = new Set<string>([compId]);
  const q: Array<{ id: string; port: string }> = [{ id: compId, port: '1' }];
  while (q.length > 0) {
    const cur = q.shift()!;
    for (const e of edges) {
      if (e.domain !== 'pneumatic') continue;
      let other: { componentId: string; port: string } | null = null;
      if (e.from.componentId === cur.id && e.from.port === cur.port) other = e.to;
      else if (e.to.componentId === cur.id && e.to.port === cur.port) other = e.from;
      if (!other) continue;
      const oc = compById.get(other.componentId);
      if (!oc) continue;
      if (oc.type === 'air_source') return true;
      if (
        (oc.type === 'air_service_unit' || oc.type === 'pneumatic_junction' || oc.type === 'pressure_regulator') &&
        !seen.has(oc.id)
      ) {
        seen.add(oc.id);
        q.push({ id: oc.id, port: '1' });
      }
    }
  }
  return false;
}
