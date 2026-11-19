import type { CircuitDocument, ComponentNode, ConnectionEdge } from '../contracts/circuit';
import { EngineeringError } from '../contracts/errors';
import { autoLayoutCircuit } from './layoutRouter';

export type ControlMethod =
  | 'direct'
  | 'pneumatic-cascade'
  | 'electro-pneumatic-step-chain'
  | 'electro-pneumatic-latch';

export type StartMode = 'single-cycle' | 'continuous';

export interface ActuatorSpec {
  /** Single-letter or short actuator label, e.g. "A", "B", "C". */
  label: string;
  strokeMm?: number;
  /** If true (default), adds meter-out one-way flow control throttles on both cylinder ports. */
  throttles?: boolean;
  throttleOpeningPct?: number;
}

export interface CircuitSpecRequest {
  title?: string;
  actuators: ActuatorSpec[];
  sequence: string[];
  controlMethod: ControlMethod;
  startMode?: StartMode;
  includeEStop?: boolean;
}

interface ParsedStep {
  raw: string;
  actuator: string;
  direction: '+' | '-';
  endSensor: string;
}

function parseStep(raw: string, validActuators: Set<string>): ParsedStep {
  const trimmed = raw.trim();
  const match = /^([A-Za-z][A-Za-z0-9]*)([+-])$/.exec(trimmed);
  if (!match) {
    throw new EngineeringError({
      category: 'InvalidTopology',
      code: 'INVALID_SEQUENCE_TOKEN',
      message: `Sequence token "${raw}" is invalid. Expected format like "A+", "B-", "C+".`,
      offendingIds: [raw],
      suggestedFix: 'Use actuator label followed by "+" (extend) or "-" (retract), e.g. ["A+", "B+", "B-", "A-"].',
    });
  }
  const actuator = match[1];
  const direction = match[2] as '+' | '-';
  if (!validActuators.has(actuator)) {
    throw new EngineeringError({
      category: 'InvalidTopology',
      code: 'UNKNOWN_SEQUENCE_ACTUATOR',
      message: `Sequence token "${raw}" references actuator "${actuator}" which is not declared in actuators[].`,
      offendingIds: [actuator],
      suggestedFix: `Add { label: "${actuator}" } to actuators[] or fix the sequence token.`,
    });
  }
  const endSensor = `${actuator.toLowerCase()}${direction === '+' ? '1' : '0'}`;
  return { raw: trimmed, actuator, direction, endSensor };
}

/**
 * Partitions a motion sequence into minimal cascade groups so no actuator appears twice in any group.
 */
export function partitionCascadeGroups(steps: ParsedStep[]): ParsedStep[][] {
  const groups: ParsedStep[][] = [];
  let current: ParsedStep[] = [];
  let used = new Set<string>();

  for (const step of steps) {
    if (used.has(step.actuator)) {
      groups.push(current);
      current = [step];
      used = new Set([step.actuator]);
    } else {
      current.push(step);
      used.add(step.actuator);
    }
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/**
 * Generates a complete, auto-laid-out industrial pneumatic or electro-pneumatic circuit
 * from a declarative actuator + sequence specification.
 */
export function generateCircuitFromSpec(spec: CircuitSpecRequest): CircuitDocument {
  if (!spec.actuators || spec.actuators.length === 0) {
    throw new EngineeringError({
      category: 'InvalidTopology',
      code: 'EMPTY_ACTUATOR_SPEC',
      message: 'Spec requires at least one actuator in actuators[].',
      offendingIds: [],
      suggestedFix: 'Provide actuators such as [{ label: "A", strokeMm: 100 }].',
    });
  }
  if (!spec.sequence || spec.sequence.length === 0) {
    throw new EngineeringError({
      category: 'InvalidTopology',
      code: 'EMPTY_SEQUENCE_SPEC',
      message: 'Spec requires a non-empty sequence array, e.g. ["A+", "B+", "B-", "A-"].',
      offendingIds: [],
      suggestedFix: 'Provide one or more motion tokens in sequence[].',
    });
  }

  const actuatorSet = new Set(spec.actuators.map((a) => a.label));
  const steps = spec.sequence.map((s) => parseStep(s, actuatorSet));
  const startMode: StartMode = spec.startMode ?? 'single-cycle';
  const includeEStop = spec.includeEStop ?? false;

  const components: ComponentNode[] = [];
  const connections: ConnectionEdge[] = [];
  let edgeSeq = 1;

  const addComp = (c: ComponentNode): ComponentNode => {
    components.push(c);
    return c;
  };

  const connect = (
    fromId: string,
    fromPort: string,
    toId: string,
    toPort: string,
    domain: 'pneumatic' | 'electrical',
  ): void => {
    connections.push({
      id: `E${edgeSeq++}`,
      from: { componentId: fromId, port: fromPort },
      to: { componentId: toId, port: toPort },
      domain,
    });
  };

  const addExhaust = (valveId: string, port: string): void => {
    const exId = `EX_${valveId}_${port}`;
    addComp({ id: exId, type: 'exhaust_silencer', params: {} });
    connect(valveId, port, exId, '1', 'pneumatic');
  };

  // =========================================================================
  // 1. PNEUMATIC AIR SUPPLY & POWER STAGE
  // =========================================================================
  addComp({ id: 'SRC_1', type: 'air_source', label: 'P1', params: { pressureBar: 6.0, maxFlowLMin: 1000 } });
  addComp({ id: 'FRL_1', type: 'air_service_unit', label: 'FRL1', params: { nominalPressureBar: 6.0 } });
  connect('SRC_1', '1', 'FRL_1', '1', 'pneumatic');

  const isElectro =
    spec.controlMethod === 'electro-pneumatic-step-chain' ||
    spec.controlMethod === 'electro-pneumatic-latch';

  addComp({ id: 'MANIFOLD_MAIN', type: 'pneumatic_junction', params: {} });

  if (includeEStop) {
    if (isElectro) {
      // Safety 3/2 NC valve energized by Y_SAFE (which drops instantly on E-stop)
      addComp({
        id: 'V_SAFE',
        type: 'valve_3_2',
        label: 'V_SAFE',
        params: { normalState: 'NC', nominalFlowLMin: 1000 },
        leftActuation: { type: 'solenoid', label: 'Y_SAFE' },
        rightActuation: { type: 'spring' },
      });
      connect('FRL_1', '2', 'V_SAFE', '1', 'pneumatic');
      connect('V_SAFE', '2', 'MANIFOLD_MAIN', '1', 'pneumatic');
      addExhaust('V_SAFE', '3');
    } else {
      // Pneumatic 3/2 NO detent E-stop valve (press cuts & dumps main air supply)
      addComp({
        id: 'V_ESTOP',
        type: 'valve_3_2',
        label: 'ESTOP',
        params: { normalState: 'NO', nominalFlowLMin: 1000 },
        leftActuation: { type: 'detent', label: 'ESTOP' },
        rightActuation: { type: 'spring' },
      });
      connect('FRL_1', '2', 'V_ESTOP', '1', 'pneumatic');
      connect('V_ESTOP', '2', 'MANIFOLD_MAIN', '1', 'pneumatic');
      addExhaust('V_ESTOP', '3');
    }
  } else {
    connect('FRL_1', '2', 'MANIFOLD_MAIN', '1', 'pneumatic');
  }

  // Actuator + 5/2 valve + optional meter-out throttles
  const valveIdByActuator = new Map<string, string>();
  const extSolenoidByActuator = new Map<string, string>();
  const retSolenoidByActuator = new Map<string, string>();

  const isSimpleLatch =
    spec.controlMethod === 'electro-pneumatic-latch' &&
    spec.actuators.length === 1 &&
    spec.sequence.length <= 2 &&
    spec.sequence[0] === `${spec.actuators[0].label}+`;

  spec.actuators.forEach((act, idx) => {
    const strokeMm = act.strokeMm ?? 100;
    const useThrottles = act.throttles ?? true;
    const throttlePct = act.throttleOpeningPct ?? 60;
    const cylId = `CYL_${act.label}`;
    const valveId = `V_${act.label}`;
    valveIdByActuator.set(act.label, valveId);

    const low = act.label.toLowerCase();
    addComp({
      id: cylId,
      type: 'cylinder_double_acting',
      label: act.label,
      params: {
        strokeMm,
        pistonDiameterMm: 25,
        rodDiameterMm: 10,
        externalLoadN: 0,
        cushioning: true,
        initialPositionMm: 0,
      },
      distanceRule: [
        { label: `${low}0`, positionMm: 0, toleranceMm: 2 },
        { label: `${low}1`, positionMm: strokeMm, toleranceMm: 2 },
      ],
    });

    if (isElectro) {
      const yExt = `Y${idx * 2 + 1}`;
      const yRet = `Y${idx * 2 + 2}`;
      extSolenoidByActuator.set(act.label, yExt);
      retSolenoidByActuator.set(act.label, yRet);

      addComp({
        id: valveId,
        type: 'valve_5_2',
        label: valveId,
        params: { initialState: 'right', nominalFlowLMin: 500 },
        leftActuation: { type: 'solenoid', label: yExt },
        rightActuation: isSimpleLatch ? { type: 'spring' } : { type: 'solenoid', label: yRet },
      });
    } else {
      addComp({
        id: valveId,
        type: 'valve_5_2',
        label: valveId,
        params: { initialState: 'right', nominalFlowLMin: 500 },
        leftActuation: { type: 'pneumatic_pilot' },
        rightActuation: { type: 'pneumatic_pilot' },
      });
    }

    connect('MANIFOLD_MAIN', '2', valveId, '1', 'pneumatic');
    addExhaust(valveId, '3');
    addExhaust(valveId, '5');

    if (useThrottles) {
      const thA = `TH_${act.label}_A`;
      const thB = `TH_${act.label}_B`;
      addComp({
        id: thA,
        type: 'flow_control_one_way',
        params: { openingPct: throttlePct, freeFlowDirection: '1_to_2' },
      });
      addComp({
        id: thB,
        type: 'flow_control_one_way',
        params: { openingPct: throttlePct, freeFlowDirection: '1_to_2' },
      });
      connect(valveId, '4', thA, '1', 'pneumatic');
      connect(thA, '2', cylId, 'A', 'pneumatic');
      connect(valveId, '2', thB, '1', 'pneumatic');
      connect(thB, '2', cylId, 'B', 'pneumatic');
    } else {
      connect(valveId, '4', cylId, 'A', 'pneumatic');
      connect(valveId, '2', cylId, 'B', 'pneumatic');
    }
  });

  // =========================================================================
  // 2. CONTROL LOGIC BY METHOD
  // =========================================================================
  if (spec.controlMethod === 'direct') {
    buildDirectPneumaticControl(steps, startMode, valveIdByActuator, addComp, connect, addExhaust);
  } else if (spec.controlMethod === 'pneumatic-cascade') {
    buildPneumaticCascadeControl(steps, startMode, valveIdByActuator, addComp, connect, addExhaust);
  } else if (isSimpleLatch) {
    buildSimpleElectroLatch(
      spec.actuators[0].label,
      steps,
      startMode,
      includeEStop,
      extSolenoidByActuator.get(spec.actuators[0].label)!,
      addComp,
      connect,
    );
  } else {
    buildElectroStepChain(
      steps,
      startMode,
      includeEStop,
      extSolenoidByActuator,
      retSolenoidByActuator,
      addComp,
      connect,
    );
  }

  const doc: CircuitDocument = {
    schemaVersion: '1.0',
    metadata: {
      title: spec.title ?? `${spec.sequence.join(' ')} (${spec.controlMethod})`,
      fluidsimVersion: '4.5',
      format: 'fsim-ir-json',
      sheetWidthMm: 297,
      sheetHeightMm: 210,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    components,
    connections,
  };

  return autoLayoutCircuit(doc);
}

type AddCompFn = (c: ComponentNode) => ComponentNode;
type ConnectFn = (
  fromId: string,
  fromPort: string,
  toId: string,
  toPort: string,
  domain: 'pneumatic' | 'electrical',
) => void;
type AddExhaustFn = (valveId: string, port: string) => void;

function buildDirectPneumaticControl(
  steps: ParsedStep[],
  startMode: StartMode,
  valveIdByActuator: Map<string, string>,
  addComp: AddCompFn,
  connect: ConnectFn,
  addExhaust: AddExhaustFn,
): void {
  const startValveId = 'V_START';
  addComp({
    id: startValveId,
    type: 'valve_3_2',
    label: 'S1',
    params: { normalState: 'NC', nominalFlowLMin: 120 },
    leftActuation: { type: startMode === 'continuous' ? 'detent' : 'pushbutton', label: 'S1' },
    rightActuation: { type: 'spring' },
  });
  connect('MANIFOLD_MAIN', '2', startValveId, '1', 'pneumatic');
  addExhaust(startValveId, '3');

  steps.forEach((step, idx) => {
    const targetValve = valveIdByActuator.get(step.actuator)!;
    const targetPilot = step.direction === '+' ? '14' : '12';
    if (idx === 0) {
      connect(startValveId, '2', targetValve, targetPilot, 'pneumatic');
    } else {
      const prevStep = steps[idx - 1];
      const senId = `V_SEN_${idx}_${prevStep.endSensor}`;
      addComp({
        id: senId,
        type: 'valve_3_2',
        label: prevStep.endSensor,
        params: { normalState: 'NC', nominalFlowLMin: 120 },
        leftActuation: { type: 'roller', label: prevStep.endSensor },
        rightActuation: { type: 'spring' },
      });
      connect('MANIFOLD_MAIN', '2', senId, '1', 'pneumatic');
      addExhaust(senId, '3');
      connect(senId, '2', targetValve, targetPilot, 'pneumatic');
    }
  });
}

function buildPneumaticCascadeControl(
  steps: ParsedStep[],
  startMode: StartMode,
  valveIdByActuator: Map<string, string>,
  addComp: AddCompFn,
  connect: ConnectFn,
  addExhaust: AddExhaustFn,
): void {
  const groups = partitionCascadeGroups(steps);
  if (groups.length <= 1) {
    buildDirectPneumaticControl(steps, startMode, valveIdByActuator, addComp, connect, addExhaust);
    return;
  }

  const M = groups.length;
  // Create M-1 reversing 5/2 valves and M group bus junctions
  const busIds: string[] = [];
  for (let g = 0; g < M; g++) {
    const bId = `BUS_G${g + 1}`;
    addComp({ id: bId, type: 'pneumatic_junction', label: `G${g + 1}`, params: {} });
    busIds.push(bId);
  }

  const casIds: string[] = [];
  for (let k = 0; k < M - 1; k++) {
    const cid = `V_CAS_${k + 1}`;
    addComp({
      id: cid,
      type: 'valve_5_2',
      label: cid,
      params: { initialState: 'right', nominalFlowLMin: 400 },
      leftActuation: { type: 'pneumatic_pilot' },
      rightActuation: { type: 'pneumatic_pilot' },
    });
    addExhaust(cid, '3');
    addExhaust(cid, '5');
    casIds.push(cid);
  }

  // Wire cascade supply ladder:
  // MAIN -> V_CAS_1.1; V_CAS_k.4 -> BUS_G{k+1}; V_CAS_k.2 -> V_CAS_{k+1}.1; V_CAS_{M-1}.2 -> BUS_G{M}
  connect('MANIFOLD_MAIN', '2', casIds[0], '1', 'pneumatic');
  for (let k = 0; k < M - 1; k++) {
    connect(casIds[k], '4', busIds[k], '1', 'pneumatic');
    if (k < M - 2) {
      connect(casIds[k], '2', casIds[k + 1], '1', 'pneumatic');
    } else {
      connect(casIds[k], '2', busIds[M - 1], '1', 'pneumatic');
    }
  }

  // Helper to wire multiple triggers into the same pilot port via OR shuttle if needed
  const pilotSources = new Map<string, Array<{ id: string; port: string }>>();
  const addPilotFeed = (valveId: string, pilotPort: string, srcId: string, srcPort: string): void => {
    const key = `${valveId}::${pilotPort}`;
    const list = pilotSources.get(key) ?? [];
    list.push({ id: srcId, port: srcPort });
    pilotSources.set(key, list);
  };

  // Start trigger: BUS_G{M} (resting active group) -> last step endSensor -> S1 -> V_CAS_1.14
  const lastStep = steps[steps.length - 1];
  const senLastId = `V_SEN_INIT_${lastStep.endSensor}`;
  addComp({
    id: senLastId,
    type: 'valve_3_2',
    label: lastStep.endSensor,
    params: { normalState: 'NC', nominalFlowLMin: 120 },
    leftActuation: { type: 'roller', label: lastStep.endSensor },
    rightActuation: { type: 'spring' },
  });
  connect(busIds[M - 1], '2', senLastId, '1', 'pneumatic');
  addExhaust(senLastId, '3');

  const startValveId = 'V_START';
  addComp({
    id: startValveId,
    type: 'valve_3_2',
    label: 'S1',
    params: { normalState: 'NC', nominalFlowLMin: 120 },
    leftActuation: { type: startMode === 'continuous' ? 'detent' : 'pushbutton', label: 'S1' },
    rightActuation: { type: 'spring' },
  });
  connect(senLastId, '2', startValveId, '1', 'pneumatic');
  addExhaust(startValveId, '3');
  addPilotFeed(casIds[0], '14', startValveId, '2');

  // Wire each group's internal steps and group-switching sensor
  let senCounter = 1;
  for (let g = 0; g < M; g++) {
    const group = groups[g];
    const busId = busIds[g];

    group.forEach((step, sIdx) => {
      const targetValve = valveIdByActuator.get(step.actuator)!;
      const targetPilot = step.direction === '+' ? '14' : '12';
      if (sIdx === 0) {
        // First step in group is powered directly from group bus
        addPilotFeed(targetValve, targetPilot, busId, '2');
      } else {
        const prevStep = group[sIdx - 1];
        const senId = `V_SEN_${senCounter++}_${prevStep.endSensor}`;
        addComp({
          id: senId,
          type: 'valve_3_2',
          label: prevStep.endSensor,
          params: { normalState: 'NC', nominalFlowLMin: 120 },
          leftActuation: { type: 'roller', label: prevStep.endSensor },
          rightActuation: { type: 'spring' },
        });
        connect(busId, '2', senId, '1', 'pneumatic');
        addExhaust(senId, '3');
        addPilotFeed(targetValve, targetPilot, senId, '2');
      }
    });

    // End of group g -> switches to group g+1 (for g = 0 .. M-2)
    if (g < M - 1) {
      const groupEndStep = group[group.length - 1];
      const swSenId = `V_SEN_GRP_${g + 1}_${groupEndStep.endSensor}`;
      addComp({
        id: swSenId,
        type: 'valve_3_2',
        label: groupEndStep.endSensor,
        params: { normalState: 'NC', nominalFlowLMin: 120 },
        leftActuation: { type: 'roller', label: groupEndStep.endSensor },
        rightActuation: { type: 'spring' },
      });
      connect(busId, '2', swSenId, '1', 'pneumatic');
      addExhaust(swSenId, '3');

      if (g < M - 2) {
        // Switch V_CAS_{g+2} left (14) and reset V_CAS_{g+1} right (12)
        addPilotFeed(casIds[g + 1], '14', swSenId, '2');
        addPilotFeed(casIds[g], '12', swSenId, '2');
      } else {
        // Final group switch: reset V_CAS_{M-1} right (12) -> activates BUS_G{M}
        addPilotFeed(casIds[M - 2], '12', swSenId, '2');
      }
    }
  }

  // Realize pilot connections (inserting shuttle_valve_or if a pilot has multiple drivers)
  let shuttleIdx = 1;
  for (const [key, sources] of pilotSources.entries()) {
    const [valveId, pilotPort] = key.split('::');
    if (sources.length === 1) {
      connect(sources[0].id, sources[0].port, valveId, pilotPort, 'pneumatic');
    } else {
      let prevSrc = sources[0];
      for (let i = 1; i < sources.length; i++) {
        const orId = `OR_PILOT_${shuttleIdx++}`;
        addComp({ id: orId, type: 'shuttle_valve_or', params: {} });
        connect(prevSrc.id, prevSrc.port, orId, '1', 'pneumatic');
        connect(sources[i].id, sources[i].port, orId, '1_2', 'pneumatic');
        prevSrc = { id: orId, port: '2' };
      }
      connect(prevSrc.id, prevSrc.port, valveId, pilotPort, 'pneumatic');
    }
  }
}

function buildSimpleElectroLatch(
  actuatorLabel: string,
  steps: ParsedStep[],
  startMode: StartMode,
  includeEStop: boolean,
  yExtLabel: string,
  addComp: AddCompFn,
  connect: ConnectFn,
): void {
  addComp({ id: 'PWR_24V', type: 'power_24v', label: '+24V', params: { voltageV: 24 } });
  addComp({ id: 'PWR_0V', type: 'power_0v', label: '0V', params: {} });
  addComp({ id: 'BUS_24V', type: 'electrical_junction', params: {} });

  if (includeEStop) {
    addComp({ id: 'PB_ESTOP', type: 'pushbutton_nc', label: 'ESTOP', params: { detent: true } });
    connect('PWR_24V', 'OUT', 'PB_ESTOP', '11', 'electrical');
    connect('PB_ESTOP', '12', 'BUS_24V', '1', 'electrical');
    addComp({ id: 'SOL_SAFE', type: 'valve_solenoid', label: 'Y_SAFE', params: {} });
    connect('BUS_24V', '2', 'SOL_SAFE', 'A1', 'electrical');
    connect('SOL_SAFE', 'A2', 'PWR_0V', 'IN', 'electrical');
  } else {
    connect('PWR_24V', 'OUT', 'BUS_24V', '1', 'electrical');
  }

  // Classic start/stop self-latching relay K1
  addComp({
    id: 'PB_S1',
    type: 'pushbutton_no',
    label: 'S1',
    params: { detent: startMode === 'continuous' },
  });
  addComp({ id: 'K1_LATCH', type: 'relay_contact_no', label: 'K1', params: {} });
  addComp({ id: 'PB_S2', type: 'pushbutton_nc', label: 'S2', params: { detent: false } });
  addComp({ id: 'K1_COIL', type: 'relay_coil', label: 'K1', params: {} });

  connect('BUS_24V', '2', 'PB_S1', '13', 'electrical');
  connect('BUS_24V', '2', 'K1_LATCH', '13', 'electrical');

  // If sequence includes retraction (["A+", "A-"]), break latch automatically at a1
  if (steps.length === 2 && steps[1].direction === '-') {
    const low = actuatorLabel.toLowerCase();
    addComp({ id: 'LS_A1_NC', type: 'limit_switch_nc', label: `${low}1`, params: {} });
    connect('PB_S1', '14', 'PB_S2', '11', 'electrical');
    connect('K1_LATCH', '14', 'PB_S2', '11', 'electrical');
    connect('PB_S2', '12', 'LS_A1_NC', '11', 'electrical');
    connect('LS_A1_NC', '12', 'K1_COIL', 'A1', 'electrical');
  } else {
    connect('PB_S1', '14', 'PB_S2', '11', 'electrical');
    connect('K1_LATCH', '14', 'PB_S2', '11', 'electrical');
    connect('PB_S2', '12', 'K1_COIL', 'A1', 'electrical');
  }
  connect('K1_COIL', 'A2', 'PWR_0V', 'IN', 'electrical');

  // Solenoid output rung
  addComp({ id: 'K1_OUT', type: 'relay_contact_no', label: 'K1', params: {} });
  addComp({ id: 'SOL_Y1', type: 'valve_solenoid', label: yExtLabel, params: {} });
  connect('BUS_24V', '2', 'K1_OUT', '13', 'electrical');
  connect('K1_OUT', '14', 'SOL_Y1', 'A1', 'electrical');
  connect('SOL_Y1', 'A2', 'PWR_0V', 'IN', 'electrical');
}

function buildElectroStepChain(
  steps: ParsedStep[],
  startMode: StartMode,
  includeEStop: boolean,
  extSolenoidByActuator: Map<string, string>,
  retSolenoidByActuator: Map<string, string>,
  addComp: AddCompFn,
  connect: ConnectFn,
): void {
  addComp({ id: 'PWR_24V', type: 'power_24v', label: '+24V', params: { voltageV: 24 } });
  addComp({ id: 'PWR_0V', type: 'power_0v', label: '0V', params: {} });
  addComp({ id: 'BUS_24V', type: 'electrical_junction', params: {} });

  if (includeEStop) {
    addComp({ id: 'PB_ESTOP', type: 'pushbutton_nc', label: 'ESTOP', params: { detent: true } });
    connect('PWR_24V', 'OUT', 'PB_ESTOP', '11', 'electrical');
    connect('PB_ESTOP', '12', 'BUS_24V', '1', 'electrical');

    addComp({ id: 'SOL_SAFE', type: 'valve_solenoid', label: 'Y_SAFE', params: {} });
    connect('BUS_24V', '2', 'SOL_SAFE', 'A1', 'electrical');
    connect('SOL_SAFE', 'A2', 'PWR_0V', 'IN', 'electrical');
  } else {
    connect('PWR_24V', 'OUT', 'BUS_24V', '1', 'electrical');
  }

  const N = steps.length;
  addComp({
    id: 'PB_S1',
    type: 'pushbutton_no',
    label: 'S1',
    params: { detent: startMode === 'continuous' },
  });

  // Create step relays K1..KN
  for (let i = 0; i < N; i++) {
    const kLabel = `K${i + 1}`;
    const coilId = `K${i + 1}_COIL`;
    const latchId = `K${i + 1}_LATCH`;
    const sumNodeId = `J_STEP_${i + 1}`;

    addComp({ id: coilId, type: 'relay_coil', label: kLabel, params: {} });
    addComp({ id: latchId, type: 'relay_contact_no', label: kLabel, params: {} });
    addComp({ id: sumNodeId, type: 'electrical_junction', params: {} });

    // Set branch
    if (i === 0) {
      const initSensor = steps[N - 1].endSensor;
      const initLsId = `LS_INIT_${initSensor}`;
      addComp({ id: initLsId, type: 'limit_switch_no', label: initSensor, params: {} });
      connect('BUS_24V', '2', 'PB_S1', '13', 'electrical');
      connect('PB_S1', '14', initLsId, '13', 'electrical');
      if (N > 1) {
        const lastNcId = `K${N}_INIT_NC`;
        addComp({ id: lastNcId, type: 'relay_contact_nc', label: `K${N}`, params: {} });
        connect(initLsId, '14', lastNcId, '11', 'electrical');
        connect(lastNcId, '12', sumNodeId, '1', 'electrical');
      } else {
        connect(initLsId, '14', sumNodeId, '1', 'electrical');
      }
    } else {
      const prevK = `K${i}`;
      const prevSensor = steps[i - 1].endSensor;
      const prevKNoId = `K${i}_SET_${i + 1}`;
      const prevLsId = `LS_STEP_${i + 1}_${prevSensor}`;
      addComp({ id: prevKNoId, type: 'relay_contact_no', label: prevK, params: {} });
      addComp({ id: prevLsId, type: 'limit_switch_no', label: prevSensor, params: {} });
      connect('BUS_24V', '2', prevKNoId, '13', 'electrical');
      connect(prevKNoId, '14', prevLsId, '13', 'electrical');
      connect(prevLsId, '14', sumNodeId, '1', 'electrical');
    }

    // Self-latch branch
    connect('BUS_24V', '2', latchId, '13', 'electrical');
    connect(latchId, '14', sumNodeId, '3', 'electrical');

    // Reset break contact before coil
    if (i < N - 1) {
      const nextNcId = `K${i + 2}_RST_${i + 1}`;
      addComp({ id: nextNcId, type: 'relay_contact_nc', label: `K${i + 2}`, params: {} });
      connect(sumNodeId, '2', nextNcId, '11', 'electrical');
      connect(nextNcId, '12', coilId, 'A1', 'electrical');
    } else {
      // Final step breaks cleanly on its own completion sensor (zero oscillation!)
      const finalNcId = `LS_FINAL_NC_${steps[N - 1].endSensor}`;
      addComp({ id: finalNcId, type: 'limit_switch_nc', label: steps[N - 1].endSensor, params: {} });
      connect(sumNodeId, '2', finalNcId, '11', 'electrical');
      connect(finalNcId, '12', coilId, 'A1', 'electrical');
    }
    connect(coilId, 'A2', 'PWR_0V', 'IN', 'electrical');
  }

  // Output solenoid rungs (group steps by solenoid label so each valve solenoid has one unique coil)
  const stepsBySolenoid = new Map<string, number[]>();
  steps.forEach((step, idx) => {
    const sol =
      step.direction === '+'
        ? extSolenoidByActuator.get(step.actuator)!
        : retSolenoidByActuator.get(step.actuator)!;
    const list = stepsBySolenoid.get(sol) ?? [];
    list.push(idx + 1);
    stepsBySolenoid.set(sol, list);
  });

  // Ensure every referenced valve solenoid has an electrical coil even if an actuator only extends or retracts
  for (const [act, yExt] of extSolenoidByActuator.entries()) {
    if (!stepsBySolenoid.has(yExt)) stepsBySolenoid.set(yExt, []);
    const yRet = retSolenoidByActuator.get(act)!;
    if (!stepsBySolenoid.has(yRet)) stepsBySolenoid.set(yRet, []);
  }

  for (const [solLabel, stepNums] of stepsBySolenoid.entries()) {
    const solId = `SOL_${solLabel}`;
    addComp({ id: solId, type: 'valve_solenoid', label: solLabel, params: {} });
    connect(solId, 'A2', 'PWR_0V', 'IN', 'electrical');

    if (stepNums.length === 0) {
      // Unused solenoid direction: wire via normally-open dummy pushbutton so static validator sees valid rung
      const unusedSw = `PB_MAN_${solLabel}`;
      addComp({ id: unusedSw, type: 'pushbutton_no', label: `MAN_${solLabel}`, params: { detent: false } });
      connect('BUS_24V', '2', unusedSw, '13', 'electrical');
      connect(unusedSw, '14', solId, 'A1', 'electrical');
    } else {
      for (const sNum of stepNums) {
        const contactId = `K${sNum}_OUT_${solLabel}`;
        addComp({ id: contactId, type: 'relay_contact_no', label: `K${sNum}`, params: {} });
        connect('BUS_24V', '2', contactId, '13', 'electrical');
        connect(contactId, '14', solId, 'A1', 'electrical');
      }
    }
  }
}
