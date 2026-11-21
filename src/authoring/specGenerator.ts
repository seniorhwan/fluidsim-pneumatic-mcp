import {
  getSheetDimensions,
  type CircuitDocument,
  type ComponentNode,
  type ConnectionEdge,
  type SheetSizePreset,
} from '../contracts/circuit';
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
  /** Cylinder type (default 'double-acting'). */
  type?: 'double-acting' | 'single-acting';
  strokeMm?: number;
  /** If true (default), adds meter-out one-way flow control throttles on cylinder ports. */
  throttles?: boolean;
  throttleOpeningPct?: number;
}

export interface CircuitSpecRequest {
  title?: string;
  actuators: ActuatorSpec[];
  /**
   * Ordered steps. Supports:
   * - Single motions: "A+", "B-"
   * - Simultaneous motions: "A+B+", "A+,B+", "A+ & B+"
   * - Dwell timers: "WAIT:500ms", "DWELL:1s", "T:300ms"
   */
  sequence: string[];
  controlMethod: ControlMethod;
  startMode?: StartMode;
  includeEStop?: boolean;
  sheetSize?: SheetSizePreset;
}

export interface ParsedMotion {
  raw: string;
  actuator: string;
  direction: '+' | '-';
  endSensor: string;
}

export type ParsedStep =
  | {
      kind: 'motion';
      raw: string;
      motions: ParsedMotion[];
    }
  | {
      kind: 'dwell';
      raw: string;
      delayMs: number;
    };

export function parseSequenceToken(raw: string, validActuators?: Set<string>): ParsedStep {
  const trimmed = raw.trim();
  const dwellMatch = /^(?:WAIT|DWELL|T)\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(ms|s)?$/i.exec(trimmed);
  if (dwellMatch) {
    const val = Number(dwellMatch[1]);
    const unit = (dwellMatch[2] ?? 'ms').toLowerCase();
    const delayMs = Math.max(10, Math.round(unit === 's' ? val * 1000 : val));
    return { kind: 'dwell', raw: trimmed, delayMs };
  }

  // Strip separators (commas, &, whitespace) between simultaneous tokens such as "A+B+" or "A+ & B+"
  const compact = trimmed.replace(/[\s,&]+/g, '');
  const motions: ParsedMotion[] = [];
  const regex = /([A-Za-z][A-Za-z0-9]*)([+-])/g;
  let consumed = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(compact)) !== null) {
    if (match.index !== consumed) break;
    consumed = match.index + match[0].length;
    const actuator = match[1];
    const direction = match[2] as '+' | '-';
    if (validActuators && !validActuators.has(actuator)) {
      throw new EngineeringError({
        category: 'InvalidTopology',
        code: 'UNKNOWN_SEQUENCE_ACTUATOR',
        message: `Sequence token "${raw}" references actuator "${actuator}" which is not declared in actuators[].`,
        offendingIds: [actuator],
        suggestedFix: `Add { label: "${actuator}" } to actuators[] or fix the sequence token.`,
      });
    }
    const endSensor = `${actuator.toLowerCase()}${direction === '+' ? '1' : '0'}`;
    motions.push({ raw: `${actuator}${direction}`, actuator, direction, endSensor });
  }

  if (motions.length === 0 || consumed !== compact.length) {
    throw new EngineeringError({
      category: 'InvalidTopology',
      code: 'INVALID_SEQUENCE_TOKEN',
      message: `Sequence token "${raw}" is invalid. Expected motion like "A+", "B-", simultaneous "A+B+", or dwell "WAIT:500ms".`,
      offendingIds: [raw],
      suggestedFix: 'Use actuator label followed by "+" or "-", simultaneous groups like "A+B+", or dwell like "WAIT:500ms".',
    });
  }

  const seenActuators = new Set<string>();
  for (const m of motions) {
    if (seenActuators.has(m.actuator)) {
      throw new EngineeringError({
        category: 'InvalidTopology',
        code: 'CONFLICTING_SIMULTANEOUS_ACTUATOR',
        message: `Sequence step "${raw}" commands actuator "${m.actuator}" twice simultaneously.`,
        offendingIds: [m.actuator],
        suggestedFix: `Split "${m.actuator}" motions into consecutive sequence steps.`,
      });
    }
    seenActuators.add(m.actuator);
  }

  return { kind: 'motion', raw: trimmed, motions };
}

/**
 * Partitions a sequence into minimal cascade groups so no actuator appears twice in any group.
 */
export function partitionCascadeGroups(steps: ParsedStep[]): ParsedStep[][] {
  const groups: ParsedStep[][] = [];
  let current: ParsedStep[] = [];
  let used = new Set<string>();

  for (const step of steps) {
    if (step.kind === 'dwell') {
      current.push(step);
      continue;
    }
    const conflicts = step.motions.some((m) => used.has(m.actuator));
    if (conflicts && current.length > 0) {
      groups.push(current);
      current = [step];
      used = new Set(step.motions.map((m) => m.actuator));
    } else {
      current.push(step);
      for (const m of step.motions) used.add(m.actuator);
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
  const actuatorTypeByLabel = new Map<string, 'double-acting' | 'single-acting'>(
    spec.actuators.map((a) => [a.label, a.type ?? 'double-acting']),
  );
  const steps = spec.sequence.map((s) => parseSequenceToken(s, actuatorSet));
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

  // Actuator + 5/2 (or 3/2 for single-acting) valve + optional meter-out throttles
  const valveIdByActuator = new Map<string, string>();
  const extSolenoidByActuator = new Map<string, string>();
  const retSolenoidByActuator = new Map<string, string>();

  const isSimpleLatch =
    spec.controlMethod === 'electro-pneumatic-latch' &&
    spec.actuators.length === 1 &&
    steps.length <= 2 &&
    steps[0].kind === 'motion' &&
    steps[0].motions.length === 1 &&
    steps[0].motions[0].actuator === spec.actuators[0].label &&
    steps[0].motions[0].direction === '+' &&
    (steps.length === 1 || (steps[1].kind === 'motion' && steps[1].motions.length === 1));

  spec.actuators.forEach((act, idx) => {
    const isSingleActing = (act.type ?? 'double-acting') === 'single-acting';
    const strokeMm = act.strokeMm ?? (isSingleActing ? 50 : 100);
    const useThrottles = act.throttles ?? true;
    const throttlePct = act.throttleOpeningPct ?? 60;
    const cylId = `CYL_${act.label}`;
    const valveId = `V_${act.label}`;
    valveIdByActuator.set(act.label, valveId);

    const low = act.label.toLowerCase();
    if (isSingleActing) {
      addComp({
        id: cylId,
        type: 'cylinder_single_acting',
        label: act.label,
        params: {
          strokeMm,
          pistonDiameterMm: 20,
          springForceN: 25,
          externalLoadN: 0,
          initialPositionMm: 0,
        },
        distanceRule: [
          { label: `${low}0`, positionMm: 0, toleranceMm: 2 },
          { label: `${low}1`, positionMm: strokeMm, toleranceMm: 2 },
        ],
      });

      if (isElectro) {
        const yExt = `Y${idx * 2 + 1}`;
        extSolenoidByActuator.set(act.label, yExt);
        addComp({
          id: valveId,
          type: 'valve_3_2',
          label: valveId,
          params: { normalState: 'NC', nominalFlowLMin: 400 },
          leftActuation: { type: 'solenoid', label: yExt },
          rightActuation: { type: 'spring' },
        });
      } else {
        addComp({
          id: valveId,
          type: 'valve_3_2',
          label: valveId,
          params: { normalState: 'NC', nominalFlowLMin: 400 },
          leftActuation: { type: 'pneumatic_pilot' },
          rightActuation: { type: 'pneumatic_pilot' },
        });
      }

      connect('MANIFOLD_MAIN', '2', valveId, '1', 'pneumatic');
      addExhaust(valveId, '3');

      if (useThrottles) {
        const thA = `TH_${act.label}_A`;
        addComp({
          id: thA,
          type: 'flow_control_one_way',
          params: { openingPct: throttlePct, freeFlowDirection: '1_to_2' },
        });
        connect(valveId, '2', thA, '1', 'pneumatic');
        connect(thA, '2', cylId, 'A', 'pneumatic');
      } else {
        connect(valveId, '2', cylId, 'A', 'pneumatic');
      }
    } else {
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
    }
  });

  // =========================================================================
  // 2. CONTROL LOGIC BY METHOD
  // =========================================================================
  if (spec.controlMethod === 'direct') {
    buildDirectPneumaticControl(
      steps,
      startMode,
      valveIdByActuator,
      actuatorTypeByLabel,
      addComp,
      connect,
      addExhaust,
    );
  } else if (spec.controlMethod === 'pneumatic-cascade') {
    buildPneumaticCascadeControl(
      steps,
      startMode,
      valveIdByActuator,
      actuatorTypeByLabel,
      addComp,
      connect,
      addExhaust,
    );
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
      actuatorTypeByLabel,
      extSolenoidByActuator,
      retSolenoidByActuator,
      addComp,
      connect,
    );
  }

  const sheetSize: SheetSizePreset = spec.sheetSize ?? 'DIN_A4_LANDSCAPE';
  const sheetDims = getSheetDimensions(sheetSize);

  const doc: CircuitDocument = {
    schemaVersion: '1.0',
    metadata: {
      title: spec.title ?? `${spec.sequence.join(' ')} (${spec.controlMethod})`,
      fluidsimVersion: '4.5',
      format: 'fsim-ir-json',
      sheetSize,
      sheetDomain: isElectro ? 'electro-pneumatic' : 'pneumatic-only',
      sheetWidthMm: sheetDims.sheetWidthMm,
      sheetHeightMm: sheetDims.sheetHeightMm,
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

function targetPilotPortFor(
  actuator: string,
  direction: '+' | '-',
  actuatorTypeByLabel: Map<string, 'double-acting' | 'single-acting'>,
): string {
  if (actuatorTypeByLabel.get(actuator) === 'single-acting') {
    return direction === '+' ? '12' : '10';
  }
  return direction === '+' ? '14' : '12';
}

function buildPneumaticAndSensors(
  prefix: string,
  supplyId: string,
  supplyPort: string,
  sensors: string[],
  addComp: AddCompFn,
  connect: ConnectFn,
  addExhaust: AddExhaustFn,
): { id: string; port: string } {
  const outputs: Array<{ id: string; port: string }> = [];
  sensors.forEach((sensor, idx) => {
    const senId = `${prefix}_${idx + 1}_${sensor}`;
    addComp({
      id: senId,
      type: 'valve_3_2',
      label: sensor,
      params: { normalState: 'NC', nominalFlowLMin: 120 },
      leftActuation: { type: 'roller', label: sensor },
      rightActuation: { type: 'spring' },
    });
    connect(supplyId, supplyPort, senId, '1', 'pneumatic');
    addExhaust(senId, '3');
    outputs.push({ id: senId, port: '2' });
  });

  if (outputs.length === 1) {
    return outputs[0];
  }

  let cur = outputs[0];
  for (let i = 1; i < outputs.length; i++) {
    const andId = `AND_${prefix}_${i}`;
    addComp({ id: andId, type: 'dual_pressure_valve_and', params: {} });
    connect(cur.id, cur.port, andId, '1', 'pneumatic');
    connect(outputs[i].id, outputs[i].port, andId, '1_2', 'pneumatic');
    cur = { id: andId, port: '2' };
  }
  return cur;
}

function buildDirectPneumaticControl(
  steps: ParsedStep[],
  startMode: StartMode,
  valveIdByActuator: Map<string, string>,
  actuatorTypeByLabel: Map<string, 'double-acting' | 'single-acting'>,
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

  let prevSignal: { id: string; port: string } = { id: startValveId, port: '2' };

  steps.forEach((step, idx) => {
    if (step.kind === 'dwell') {
      const tdvId = `TDV_STEP_${idx + 1}`;
      addComp({
        id: tdvId,
        type: 'time_delay_valve',
        label: `T${idx + 1}`,
        params: { delayMs: step.delayMs, normalState: 'NC' },
      });
      connect('MANIFOLD_MAIN', '2', tdvId, '1', 'pneumatic');
      addExhaust(tdvId, '3');
      connect(prevSignal.id, prevSignal.port, tdvId, '12', 'pneumatic');
      prevSignal = { id: tdvId, port: '2' };
      return;
    }

    const trigger =
      idx === 0
        ? prevSignal
        : steps[idx - 1].kind === 'dwell'
          ? prevSignal
          : buildPneumaticAndSensors(
              `V_SEN_${idx}`,
              'MANIFOLD_MAIN',
              '2',
              (steps[idx - 1] as Extract<ParsedStep, { kind: 'motion' }>).motions.map((m) => m.endSensor),
              addComp,
              connect,
              addExhaust,
            );

    for (const m of step.motions) {
      const targetValve = valveIdByActuator.get(m.actuator)!;
      const targetPilot = targetPilotPortFor(m.actuator, m.direction, actuatorTypeByLabel);
      connect(trigger.id, trigger.port, targetValve, targetPilot, 'pneumatic');
    }

    if (idx + 1 < steps.length && steps[idx + 1].kind === 'dwell') {
      prevSignal = buildPneumaticAndSensors(
        `V_SEN_DWELL_${idx + 1}`,
        'MANIFOLD_MAIN',
        '2',
        step.motions.map((m) => m.endSensor),
        addComp,
        connect,
        addExhaust,
      );
    }
  });
}

function buildPneumaticCascadeControl(
  steps: ParsedStep[],
  startMode: StartMode,
  valveIdByActuator: Map<string, string>,
  actuatorTypeByLabel: Map<string, 'double-acting' | 'single-acting'>,
  addComp: AddCompFn,
  connect: ConnectFn,
  addExhaust: AddExhaustFn,
): void {
  const groups = partitionCascadeGroups(steps);
  if (groups.length <= 1) {
    buildDirectPneumaticControl(steps, startMode, valveIdByActuator, actuatorTypeByLabel, addComp, connect, addExhaust);
    return;
  }

  const M = groups.length;
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

  connect('MANIFOLD_MAIN', '2', casIds[0], '1', 'pneumatic');
  for (let k = 0; k < M - 1; k++) {
    connect(casIds[k], '4', busIds[k], '1', 'pneumatic');
    if (k < M - 2) {
      connect(casIds[k], '2', casIds[k + 1], '1', 'pneumatic');
    } else {
      connect(casIds[k], '2', busIds[M - 1], '1', 'pneumatic');
    }
  }

  const pilotSources = new Map<string, Array<{ id: string; port: string }>>();
  const addPilotFeed = (valveId: string, pilotPort: string, srcId: string, srcPort: string): void => {
    const key = `${valveId}::${pilotPort}`;
    const list = pilotSources.get(key) ?? [];
    list.push({ id: srcId, port: srcPort });
    pilotSources.set(key, list);
  };

  // Start trigger: BUS_G{M} -> last motion step's end sensors (if any) -> S1 -> V_CAS_1.14
  const lastMotionStep = [...steps].reverse().find((s): s is Extract<ParsedStep, { kind: 'motion' }> => s.kind === 'motion');
  let startIn: { id: string; port: string } = { id: busIds[M - 1], port: '2' };
  if (lastMotionStep) {
    startIn = buildPneumaticAndSensors(
      'V_SEN_INIT',
      busIds[M - 1],
      '2',
      lastMotionStep.motions.map((m) => m.endSensor),
      addComp,
      connect,
      addExhaust,
    );
  }

  const startValveId = 'V_START';
  addComp({
    id: startValveId,
    type: 'valve_3_2',
    label: 'S1',
    params: { normalState: 'NC', nominalFlowLMin: 120 },
    leftActuation: { type: startMode === 'continuous' ? 'detent' : 'pushbutton', label: 'S1' },
    rightActuation: { type: 'spring' },
  });
  connect(startIn.id, startIn.port, startValveId, '1', 'pneumatic');
  addExhaust(startValveId, '3');
  addPilotFeed(casIds[0], '14', startValveId, '2');

  let senCounter = 1;
  for (let g = 0; g < M; g++) {
    const group = groups[g];
    const busId = busIds[g];

    let curSignal: { id: string; port: string } = { id: busId, port: '2' };

    group.forEach((step, sIdx) => {
      if (step.kind === 'dwell') {
        const tdvId = `TDV_G${g + 1}_${sIdx + 1}`;
        addComp({
          id: tdvId,
          type: 'time_delay_valve',
          label: `T_G${g + 1}_${sIdx + 1}`,
          params: { delayMs: step.delayMs, normalState: 'NC' },
        });
        connect(busId, '2', tdvId, '1', 'pneumatic');
        addExhaust(tdvId, '3');
        connect(curSignal.id, curSignal.port, tdvId, '12', 'pneumatic');
        curSignal = { id: tdvId, port: '2' };
        return;
      }

      for (const m of step.motions) {
        const targetValve = valveIdByActuator.get(m.actuator)!;
        const targetPilot = targetPilotPortFor(m.actuator, m.direction, actuatorTypeByLabel);
        addPilotFeed(targetValve, targetPilot, curSignal.id, curSignal.port);
      }

      // Compute completion signal of this motion step if there is a next step in this group OR a group switch
      if (sIdx < group.length - 1 || g < M - 1) {
        curSignal = buildPneumaticAndSensors(
          `V_SEN_${senCounter++}`,
          busId,
          '2',
          step.motions.map((m) => m.endSensor),
          addComp,
          connect,
          addExhaust,
        );
      }
    });

    // End of group g -> switches to group g+1 (for g = 0 .. M-2)
    if (g < M - 1) {
      if (g < M - 2) {
        addPilotFeed(casIds[g + 1], '14', curSignal.id, curSignal.port);
        addPilotFeed(casIds[g], '12', curSignal.id, curSignal.port);
      } else {
        addPilotFeed(casIds[M - 2], '12', curSignal.id, curSignal.port);
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

  const secondStep = steps[1];
  if (steps.length === 2 && secondStep.kind === 'motion' && secondStep.motions[0].direction === '-') {
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
  actuatorTypeByLabel: Map<string, 'double-acting' | 'single-acting'>,
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

  // Helper to wire a series chain of NO completion contacts from (srcId, srcPort) -> returns last (id, port)
  const wireCompletionChain = (
    prefix: string,
    stepIdx: number,
    srcId: string,
    srcPort: string,
  ): { id: string; port: string } => {
    const st = steps[stepIdx];
    let curId = srcId;
    let curPort = srcPort;
    if (st.kind === 'dwell') {
      const tNoId = `${prefix}_T${stepIdx + 1}`;
      addComp({ id: tNoId, type: 'relay_contact_no', label: `T${stepIdx + 1}`, params: {} });
      connect(curId, curPort, tNoId, '13', 'electrical');
      return { id: tNoId, port: '14' };
    }
    st.motions.forEach((m, mIdx) => {
      const lsId = `${prefix}_${mIdx + 1}_${m.endSensor}`;
      addComp({ id: lsId, type: 'limit_switch_no', label: m.endSensor, params: {} });
      connect(curId, curPort, lsId, '13', 'electrical');
      curId = lsId;
      curPort = '14';
    });
    return { id: curId, port: curPort };
  };

  // Create step relays K1..KN (and on-delay timers T{i+1} for dwell steps)
  for (let i = 0; i < N; i++) {
    const kLabel = `K${i + 1}`;
    const coilId = `K${i + 1}_COIL`;
    const latchId = `K${i + 1}_LATCH`;
    const sumNodeId = `J_STEP_${i + 1}`;

    addComp({ id: coilId, type: 'relay_coil', label: kLabel, params: {} });
    addComp({ id: latchId, type: 'relay_contact_no', label: kLabel, params: {} });
    addComp({ id: sumNodeId, type: 'electrical_junction', params: {} });

    if (steps[i].kind === 'dwell') {
      const dwellStep = steps[i] as Extract<ParsedStep, { kind: 'dwell' }>;
      const tLabel = `T${i + 1}`;
      const tId = `${tLabel}_TIMER`;
      const tDriveId = `K${i + 1}_DRV_${tLabel}`;
      addComp({ id: tDriveId, type: 'relay_contact_no', label: kLabel, params: {} });
      addComp({ id: tId, type: 'timer_relay_on_delay', label: tLabel, params: { delayMs: dwellStep.delayMs } });
      connect('BUS_24V', '2', tDriveId, '13', 'electrical');
      connect(tDriveId, '14', tId, 'A1', 'electrical');
      connect(tId, 'A2', 'PWR_0V', 'IN', 'electrical');
    }

    // Set branch
    if (i === 0) {
      connect('BUS_24V', '2', 'PB_S1', '13', 'electrical');
      let tail: { id: string; port: string } = { id: 'PB_S1', port: '14' };
      const lastMotionIdx = [...steps.keys()].reverse().find((idx) => steps[idx].kind === 'motion');
      if (lastMotionIdx !== undefined) {
        tail = wireCompletionChain('LS_INIT', lastMotionIdx, tail.id, tail.port);
      }
      if (N > 1) {
        const lastNcId = `K${N}_INIT_NC`;
        addComp({ id: lastNcId, type: 'relay_contact_nc', label: `K${N}`, params: {} });
        connect(tail.id, tail.port, lastNcId, '11', 'electrical');
        connect(lastNcId, '12', sumNodeId, '1', 'electrical');
      } else {
        connect(tail.id, tail.port, sumNodeId, '1', 'electrical');
      }
    } else {
      const prevK = `K${i}`;
      const prevKNoId = `K${i}_SET_${i + 1}`;
      addComp({ id: prevKNoId, type: 'relay_contact_no', label: prevK, params: {} });
      connect('BUS_24V', '2', prevKNoId, '13', 'electrical');
      const tail = wireCompletionChain(`LS_STEP_${i + 1}`, i - 1, prevKNoId, '14');
      connect(tail.id, tail.port, sumNodeId, '1', 'electrical');
    }

    // Self-latch branch
    connect('BUS_24V', '2', latchId, '13', 'electrical');
    connect(latchId, '14', sumNodeId, '3', 'electrical');

    // Reset break contact(s) before coil
    if (i < N - 1) {
      const nextNcId = `K${i + 2}_RST_${i + 1}`;
      addComp({ id: nextNcId, type: 'relay_contact_nc', label: `K${i + 2}`, params: {} });
      connect(sumNodeId, '2', nextNcId, '11', 'electrical');
      connect(nextNcId, '12', coilId, 'A1', 'electrical');
    } else {
      const finalStep = steps[N - 1];
      if (finalStep.kind === 'dwell') {
        const tNcId = `T${N}_FINAL_NC`;
        addComp({ id: tNcId, type: 'relay_contact_nc', label: `T${N}`, params: {} });
        connect(sumNodeId, '2', tNcId, '11', 'electrical');
        connect(tNcId, '12', coilId, 'A1', 'electrical');
      } else {
        // De Morgan: NOT(s1 AND s2 ...) === (NOT s1) OR (NOT s2) ... -> parallel NC limit switches
        finalStep.motions.forEach((m, mIdx) => {
          const finalNcId = `LS_FINAL_NC_${mIdx + 1}_${m.endSensor}`;
          addComp({ id: finalNcId, type: 'limit_switch_nc', label: m.endSensor, params: {} });
          connect(sumNodeId, '2', finalNcId, '11', 'electrical');
          connect(finalNcId, '12', coilId, 'A1', 'electrical');
        });
      }
    }
    connect(coilId, 'A2', 'PWR_0V', 'IN', 'electrical');
  }

  // Output solenoid rungs
  const stepsBySolenoid = new Map<string, number[]>();
  const singleActingSetSteps = new Map<string, number[]>();
  const singleActingResetSteps = new Map<string, number[]>();

  for (const [act, actType] of actuatorTypeByLabel.entries()) {
    if (actType === 'single-acting') {
      singleActingSetSteps.set(act, []);
      singleActingResetSteps.set(act, []);
    }
  }

  steps.forEach((step, idx) => {
    if (step.kind === 'motion') {
      for (const m of step.motions) {
        if (actuatorTypeByLabel.get(m.actuator) === 'single-acting') {
          if (m.direction === '+') {
            singleActingSetSteps.get(m.actuator)!.push(idx + 1);
          } else {
            singleActingResetSteps.get(m.actuator)!.push(idx + 1);
          }
        } else {
          const sol =
            m.direction === '+'
              ? extSolenoidByActuator.get(m.actuator)!
              : retSolenoidByActuator.get(m.actuator)!;
          const list = stepsBySolenoid.get(sol) ?? [];
          list.push(idx + 1);
          stepsBySolenoid.set(sol, list);
        }
      }
    }
  });

  // Dedicated memory-latch relay K_HOLD_<act> for each single-acting actuator so its 3/2 spring-return
  // solenoid stays continuously energized across dwells and break-before-make step handoffs until <act>-.
  for (const [act, setSteps] of singleActingSetSteps.entries()) {
    const solLabel = extSolenoidByActuator.get(act)!;
    const solId = `SOL_${solLabel}`;
    addComp({ id: solId, type: 'valve_solenoid', label: solLabel, params: {} });
    connect(solId, 'A2', 'PWR_0V', 'IN', 'electrical');

    if (setSteps.length === 0) {
      const unusedSw = `PB_MAN_${solLabel}`;
      addComp({ id: unusedSw, type: 'pushbutton_no', label: `MAN_${solLabel}`, params: { detent: false } });
      connect('BUS_24V', '2', unusedSw, '13', 'electrical');
      connect(unusedSw, '14', solId, 'A1', 'electrical');
      continue;
    }

    const holdLabel = `K_HOLD_${act}`;
    const holdCoilId = `${holdLabel}_COIL`;
    const holdLatchId = `${holdLabel}_LATCH`;
    const holdSumId = `J_${holdLabel}`;
    const holdOutId = `${holdLabel}_OUT_${solLabel}`;

    addComp({ id: holdCoilId, type: 'relay_coil', label: holdLabel, params: {} });
    addComp({ id: holdLatchId, type: 'relay_contact_no', label: holdLabel, params: {} });
    addComp({ id: holdSumId, type: 'electrical_junction', params: {} });

    // Parallel set contacts for every step commanding <act>+
    for (const sNum of setSteps) {
      const setContactId = `K${sNum}_SET_${holdLabel}`;
      addComp({ id: setContactId, type: 'relay_contact_no', label: `K${sNum}`, params: {} });
      connect('BUS_24V', '2', setContactId, '13', 'electrical');
      connect(setContactId, '14', holdSumId, '1', 'electrical');
    }

    // Self-latch contact
    connect('BUS_24V', '2', holdLatchId, '13', 'electrical');
    connect(holdLatchId, '14', holdSumId, '3', 'electrical');

    // Series reset NC contacts for every step commanding <act>-
    const resetSteps = singleActingResetSteps.get(act) ?? [];
    let tailId = holdSumId;
    let tailPort = '2';
    for (const rNum of resetSteps) {
      const rstContactId = `K${rNum}_RST_${holdLabel}`;
      addComp({ id: rstContactId, type: 'relay_contact_nc', label: `K${rNum}`, params: {} });
      connect(tailId, tailPort, rstContactId, '11', 'electrical');
      tailId = rstContactId;
      tailPort = '12';
    }
    connect(tailId, tailPort, holdCoilId, 'A1', 'electrical');
    connect(holdCoilId, 'A2', 'PWR_0V', 'IN', 'electrical');

    // Output contact driving solenoid continuously without handoff glitch
    addComp({ id: holdOutId, type: 'relay_contact_no', label: holdLabel, params: {} });
    connect('BUS_24V', '2', holdOutId, '13', 'electrical');
    connect(holdOutId, '14', solId, 'A1', 'electrical');
  }

  // Ensure every referenced double-acting valve solenoid has an electrical coil
  for (const [act, yExt] of extSolenoidByActuator.entries()) {
    if (actuatorTypeByLabel.get(act) === 'single-acting') continue;
    if (!stepsBySolenoid.has(yExt)) stepsBySolenoid.set(yExt, []);
    const yRet = retSolenoidByActuator.get(act);
    if (yRet && !stepsBySolenoid.has(yRet)) stepsBySolenoid.set(yRet, []);
  }

  for (const [solLabel, stepNums] of stepsBySolenoid.entries()) {
    const solId = `SOL_${solLabel}`;
    addComp({ id: solId, type: 'valve_solenoid', label: solLabel, params: {} });
    connect(solId, 'A2', 'PWR_0V', 'IN', 'electrical');

    if (stepNums.length === 0) {
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
