import test from 'node:test';
import assert from 'node:assert/strict';
import type { CircuitDocument } from '../contracts/circuit';
import { simulateCircuit } from '../simulator/simulator';
import { verifyCircuitSequence } from '../simulator/sequenceVerifier';
import { validateCircuitStatic } from '../simulator/validator';
import { generateCircuitFromSpec } from '../authoring/specGenerator';

test('direct 3/2 pushbutton + single-acting cylinder extends on press and retracts on release', () => {
  const doc: CircuitDocument = {
    schemaVersion: '1.0',
    metadata: {
      title: 'Direct SAC',
      fluidsimVersion: '4.5',
      format: 'fsim-ir-json',
      sheetWidthMm: 297,
      sheetHeightMm: 210,
    },
    components: [
      { id: 'SRC', type: 'air_source', params: { pressureBar: 6 } },
      {
        id: 'V1',
        type: 'valve_3_2',
        label: 'S1',
        params: { normalState: 'NC' },
        leftActuation: { type: 'pushbutton', label: 'S1' },
        rightActuation: { type: 'spring' },
      },
      { id: 'EX1', type: 'exhaust_silencer', params: {} },
      { id: 'C1', type: 'cylinder_single_acting', label: 'A', params: { strokeMm: 50, springForceN: 25 } },
    ],
    connections: [
      { id: 'E1', from: { componentId: 'SRC', port: '1' }, to: { componentId: 'V1', port: '1' }, domain: 'pneumatic' },
      { id: 'E2', from: { componentId: 'V1', port: '2' }, to: { componentId: 'C1', port: 'A' }, domain: 'pneumatic' },
      { id: 'E3', from: { componentId: 'V1', port: '3' }, to: { componentId: 'EX1', port: '1' }, domain: 'pneumatic' },
    ],
  };

  assert.equal(validateCircuitStatic(doc).valid, true);

  const sim = simulateCircuit(doc, {
    durationMs: 2000,
    stepMs: 10,
    inputs: [{ label: 'S1', action: 'press', atMs: 100, durationMs: 700 }],
  });

  assert.deepEqual(sim.observedSequence, ['A+', 'A-']);
  assert.equal(sim.diagnostics.length, 0);
  assert.equal(sim.finalState.cylinders.C1.pct, 0);
});

test('24V relay self-latching holds after momentary S1 press and drops with S2 stop priority', () => {
  const doc = generateCircuitFromSpec({
    title: 'Electro Latch Test',
    actuators: [{ label: 'A', strokeMm: 100, throttles: false }],
    sequence: ['A+'],
    controlMethod: 'electro-pneumatic-latch',
    startMode: 'single-cycle',
  });

  assert.equal(validateCircuitStatic(doc).valid, true);

  // Momentary press S1 at 100ms (latches K1 -> A extends and stays extended), then press S2 stop at 1000ms (A retracts)
  const sim = simulateCircuit(doc, {
    durationMs: 2200,
    stepMs: 10,
    inputs: [
      { label: 'S1', action: 'press', atMs: 100, durationMs: 100 },
      { label: 'S2', action: 'press', atMs: 1000, durationMs: 150 },
    ],
  });

  assert.deepEqual(sim.observedSequence, ['A+', 'A-']);
  assert.equal(sim.finalState.relays.K1_COIL.energized, false);
  assert.equal(sim.finalState.cylinders.CYL_A.pct, 0);

  // Verify Stop priority: simultaneous S1 + S2 press keeps K1 de-energized
  const stopPrioritySim = simulateCircuit(doc, {
    durationMs: 800,
    stepMs: 10,
    inputs: [
      { label: 'S1', action: 'press', atMs: 100, durationMs: 300 },
      { label: 'S2', action: 'press', atMs: 100, durationMs: 300 },
    ],
  });
  assert.deepEqual(stopPrioritySim.observedSequence, []);
  assert.equal(stopPrioritySim.finalState.relays.K1_COIL.energized, false);
});

test('meter-out throttle openingPct demonstrably slows cylinder cycle timing', () => {
  const fastDoc = generateCircuitFromSpec({
    actuators: [{ label: 'A', strokeMm: 100, throttles: true, throttleOpeningPct: 100 }],
    sequence: ['A+', 'A-'],
    controlMethod: 'electro-pneumatic-step-chain',
  });
  const slowDoc = generateCircuitFromSpec({
    actuators: [{ label: 'A', strokeMm: 100, throttles: true, throttleOpeningPct: 25 }],
    sequence: ['A+', 'A-'],
    controlMethod: 'electro-pneumatic-step-chain',
  });

  const fastRes = verifyCircuitSequence(fastDoc, {
    expectedSequence: ['A+', 'A-'],
    inputs: [{ label: 'S1', action: 'press', atMs: 100, durationMs: 120 }],
    durationMs: 5000,
  });
  const slowRes = verifyCircuitSequence(slowDoc, {
    expectedSequence: ['A+', 'A-'],
    inputs: [{ label: 'S1', action: 'press', atMs: 100, durationMs: 120 }],
    durationMs: 5000,
  });

  assert.equal(fastRes.passed, true);
  assert.equal(slowRes.passed, true);
  assert.ok(fastRes.cycleTimeMs !== null && slowRes.cycleTimeMs !== null);
  assert.ok(
    slowRes.cycleTimeMs > fastRes.cycleTimeMs * 2,
    `Expected throttled cycle (${slowRes.cycleTimeMs}ms) to be >2x unrestricted (${fastRes.cycleTimeMs}ms)`,
  );
});

test('classic A+ B+ B- A- detects opposing-pilot deadlock in direct mode, and passes in pneumatic-cascade and electro-pneumatic-step-chain', () => {
  // 1. Naive direct-pilot A+ B+ B- A- MUST fail with OPPOSING_PILOT_SIGNAL
  const naiveDirect = generateCircuitFromSpec({
    actuators: [{ label: 'A' }, { label: 'B' }],
    sequence: ['A+', 'B+', 'B-', 'A-'],
    controlMethod: 'direct',
  });
  const directCheck = verifyCircuitSequence(naiveDirect, {
    expectedSequence: ['A+', 'B+', 'B-', 'A-'],
    inputs: [{ label: 'S1', action: 'press', atMs: 100, durationMs: 150 }],
    durationMs: 4000,
  });
  assert.equal(directCheck.passed, false);
  assert.ok(
    directCheck.diagnostics.some((d) => d.code === 'OPPOSING_PILOT_SIGNAL'),
    `Expected OPPOSING_PILOT_SIGNAL diagnostic, got: ${JSON.stringify(directCheck.diagnostics)}`,
  );

  // 2. Pneumatic Cascade A+ B+ B- A- MUST pass cleanly with zero validation errors
  const cascade = generateCircuitFromSpec({
    actuators: [{ label: 'A' }, { label: 'B' }],
    sequence: ['A+', 'B+', 'B-', 'A-'],
    controlMethod: 'pneumatic-cascade',
  });
  assert.equal(validateCircuitStatic(cascade).valid, true);
  const cascadeCheck = verifyCircuitSequence(cascade, {
    expectedSequence: ['A+', 'B+', 'B-', 'A-'],
    inputs: [{ label: 'S1', action: 'press', atMs: 100, durationMs: 150 }],
    durationMs: 5000,
  });
  assert.equal(cascadeCheck.passed, true, cascadeCheck.failureSummary);
  assert.deepEqual(cascadeCheck.observedSequence, ['A+', 'B+', 'B-', 'A-']);

  // 3. Electro-Pneumatic Step-Chain A+ B+ B- A- with E-stop MUST pass BOTH full sequence AND E-stop interruption
  const stepChain = generateCircuitFromSpec({
    actuators: [{ label: 'A' }, { label: 'B' }],
    sequence: ['A+', 'B+', 'B-', 'A-'],
    controlMethod: 'electro-pneumatic-step-chain',
    includeEStop: true,
  });
  assert.equal(validateCircuitStatic(stepChain).valid, true);
  const stepCheck = verifyCircuitSequence(stepChain, {
    expectedSequence: ['A+', 'B+', 'B-', 'A-'],
    inputs: [{ label: 'S1', action: 'press', atMs: 100, durationMs: 150 }],
    durationMs: 6000,
    eStopCheck: {
      label: 'ESTOP',
      triggerAtMs: 300,
      expectNoFurtherMotionsAfterMs: 250,
    },
  });
  assert.equal(stepCheck.passed, true, stepCheck.failureSummary);
  assert.equal(stepCheck.eStopVerified, true);
});

test('3-group pneumatic cascade (A+ A- B+ B-) and logic/timer components simulate accurately', () => {
  const threeGroup = generateCircuitFromSpec({
    actuators: [{ label: 'A', throttles: false }, { label: 'B', throttles: false }],
    sequence: ['A+', 'A-', 'B+', 'B-'],
    controlMethod: 'pneumatic-cascade',
  });
  assert.equal(validateCircuitStatic(threeGroup).valid, true);
  const check = verifyCircuitSequence(threeGroup, {
    expectedSequence: ['A+', 'A-', 'B+', 'B-'],
    inputs: [{ label: 'S1', action: 'press', atMs: 100, durationMs: 150 }],
    durationMs: 5000,
  });
  assert.equal(check.passed, true, check.failureSummary);

  // Two-hand AND logic valve + time-delay valve test
  const logicDoc: CircuitDocument = {
    schemaVersion: '1.0',
    metadata: {
      title: 'AND + Timer',
      fluidsimVersion: '4.5',
      format: 'fsim-ir-json',
      sheetWidthMm: 297,
      sheetHeightMm: 210,
    },
    components: [
      { id: 'SRC', type: 'air_source', params: { pressureBar: 6 } },
      { id: 'S1', type: 'valve_3_2', label: 'S1', params: { normalState: 'NC' }, leftActuation: { type: 'pushbutton', label: 'S1' }, rightActuation: { type: 'spring' } },
      { id: 'S2', type: 'valve_3_2', label: 'S2', params: { normalState: 'NC' }, leftActuation: { type: 'pushbutton', label: 'S2' }, rightActuation: { type: 'spring' } },
      { id: 'EX1', type: 'exhaust_silencer', params: {} },
      { id: 'EX2', type: 'exhaust_silencer', params: {} },
      { id: 'EX3', type: 'exhaust_silencer', params: {} },
      { id: 'AND1', type: 'dual_pressure_valve_and', params: {} },
      { id: 'TD1', type: 'time_delay_valve', params: { delayMs: 300, normalState: 'NC' } },
      { id: 'C1', type: 'cylinder_single_acting', label: 'A', params: { strokeMm: 50 } },
    ],
    connections: [
      { id: 'E1', from: { componentId: 'SRC', port: '1' }, to: { componentId: 'S1', port: '1' }, domain: 'pneumatic' },
      { id: 'E2', from: { componentId: 'SRC', port: '1' }, to: { componentId: 'S2', port: '1' }, domain: 'pneumatic' },
      { id: 'E3', from: { componentId: 'SRC', port: '1' }, to: { componentId: 'TD1', port: '1' }, domain: 'pneumatic' },
      { id: 'E4', from: { componentId: 'S1', port: '3' }, to: { componentId: 'EX1', port: '1' }, domain: 'pneumatic' },
      { id: 'E5', from: { componentId: 'S2', port: '3' }, to: { componentId: 'EX2', port: '1' }, domain: 'pneumatic' },
      { id: 'E6', from: { componentId: 'TD1', port: '3' }, to: { componentId: 'EX3', port: '1' }, domain: 'pneumatic' },
      { id: 'E7', from: { componentId: 'S1', port: '2' }, to: { componentId: 'AND1', port: '1' }, domain: 'pneumatic' },
      { id: 'E8', from: { componentId: 'S2', port: '2' }, to: { componentId: 'AND1', port: '1_2' }, domain: 'pneumatic' },
      { id: 'E9', from: { componentId: 'AND1', port: '2' }, to: { componentId: 'TD1', port: '12' }, domain: 'pneumatic' },
      { id: 'E10', from: { componentId: 'TD1', port: '2' }, to: { componentId: 'C1', port: 'A' }, domain: 'pneumatic' },
    ],
  };

  assert.equal(validateCircuitStatic(logicDoc).valid, true);

  // Only S1 pressed -> should NOT extend
  const oneHand = simulateCircuit(logicDoc, {
    durationMs: 1200,
    inputs: [{ label: 'S1', action: 'press', atMs: 100, durationMs: 800 }],
  });
  assert.deepEqual(oneHand.observedSequence, []);

  // Both S1 & S2 pressed for 900ms -> delays 300ms then extends!
  const twoHand = simulateCircuit(logicDoc, {
    durationMs: 1500,
    inputs: [
      { label: 'S1', action: 'press', atMs: 100, durationMs: 900 },
      { label: 'S2', action: 'press', atMs: 100, durationMs: 900 },
    ],
  });
  assert.ok(twoHand.observedSequence.includes('A+'));
  const startEv = twoHand.events.find((e) => e.kind === 'cylinder_start_extend');
  assert.ok(startEv && startEv.timeMs >= 400, `Expected delay >= 400ms, got ${startEv?.timeMs}ms`);
});

test('simultaneous motions (A+B+, A-B-) pass validation and sequence verification in both electro-pneumatic and pneumatic-cascade modes', () => {
  for (const controlMethod of ['electro-pneumatic-step-chain', 'pneumatic-cascade'] as const) {
    const doc = generateCircuitFromSpec({
      actuators: [{ label: 'A', throttles: false }, { label: 'B', throttles: false }],
      sequence: ['A+B+', 'A-B-'],
      controlMethod,
    });
    const val = validateCircuitStatic(doc);
    assert.equal(val.valid, true, `${controlMethod} simultaneous validation failed: ${JSON.stringify(val.findings)}`);

    const res = verifyCircuitSequence(doc, {
      expectedSequence: ['A+B+', 'A-B-'],
      inputs: [{ label: 'S1', action: 'press', atMs: 100, durationMs: 150 }],
      durationMs: 6000,
    });
    assert.equal(res.passed, true, `${controlMethod} simultaneous failed: ${res.failureSummary}`);
  }
});

test('dwell timer steps (A+, WAIT:300ms, A-) hold extended and pass in both electro-pneumatic and pneumatic-cascade modes', () => {
  for (const controlMethod of ['electro-pneumatic-step-chain', 'pneumatic-cascade'] as const) {
    const noDwell = generateCircuitFromSpec({
      actuators: [{ label: 'A', throttles: false }],
      sequence: ['A+', 'A-'],
      controlMethod,
    });
    const withDwell = generateCircuitFromSpec({
      actuators: [{ label: 'A', throttles: false }],
      sequence: ['A+', 'WAIT:350ms', 'A-'],
      controlMethod,
    });
    assert.equal(validateCircuitStatic(withDwell).valid, true);

    const baseRes = verifyCircuitSequence(noDwell, {
      expectedSequence: ['A+', 'A-'],
      inputs: [{ label: 'S1', action: 'press', atMs: 100, durationMs: 150 }],
      durationMs: 5000,
    });
    const dwellRes = verifyCircuitSequence(withDwell, {
      expectedSequence: ['A+', 'WAIT:350ms', 'A-'],
      inputs: [{ label: 'S1', action: 'press', atMs: 100, durationMs: 150 }],
      durationMs: 5000,
    });
    assert.equal(baseRes.passed, true, baseRes.failureSummary);
    assert.equal(dwellRes.passed, true, `${controlMethod} dwell failed: ${dwellRes.failureSummary}`);
    assert.ok(baseRes.cycleTimeMs !== null && dwellRes.cycleTimeMs !== null);
    assert.ok(
      dwellRes.cycleTimeMs - baseRes.cycleTimeMs >= 300,
      `${controlMethod}: expected dwell cycle (${dwellRes.cycleTimeMs}ms) >= base (${baseRes.cycleTimeMs}ms) + 300ms`,
    );
  }
});

test('single-acting cylinder in multi-step electro-pneumatic step-chain holds extended across intermediate steps', () => {
  const doc = generateCircuitFromSpec({
    actuators: [
      { label: 'A', type: 'single-acting', strokeMm: 50, throttles: false },
      { label: 'B', type: 'double-acting', strokeMm: 100, throttles: false },
    ],
    sequence: ['A+', 'B+', 'B-', 'A-'],
    controlMethod: 'electro-pneumatic-step-chain',
  });
  const val = validateCircuitStatic(doc);
  assert.equal(val.valid, true, JSON.stringify(val.findings));

  const res = verifyCircuitSequence(doc, {
    expectedSequence: ['A+', 'B+', 'B-', 'A-'],
    inputs: [{ label: 'S1', action: 'press', atMs: 100, durationMs: 150 }],
    durationMs: 6000,
  });
  assert.equal(res.passed, true, res.failureSummary);
  assert.deepEqual(res.observedSequence, ['A+', 'B+', 'B-', 'A-']);
});

test('3-actuator sequence (A+ B+ C+ C- B- A-), continuous multi-cycle verification, and pneumatic cascade E-stop', () => {
  // 3-actuator electro-pneumatic continuous mode
  const contDoc = generateCircuitFromSpec({
    actuators: [
      { label: 'A', throttles: false },
      { label: 'B', throttles: false },
      { label: 'C', throttles: false },
    ],
    sequence: ['A+', 'B+', 'C+', 'C-', 'B-', 'A-'],
    controlMethod: 'electro-pneumatic-step-chain',
    startMode: 'continuous',
    includeEStop: true,
  });
  assert.equal(validateCircuitStatic(contDoc).valid, true);

  const contRes = verifyCircuitSequence(contDoc, {
    expectedSequence: ['A+', 'B+', 'C+', 'C-', 'B-', 'A-'],
    inputs: [{ label: 'S1', action: 'toggle', atMs: 100 }],
    durationMs: 12000,
    allowRepeatCycles: true,
    minCycles: 2,
  });
  assert.equal(contRes.passed, true, contRes.failureSummary);
  assert.ok((contRes.cyclesObserved ?? 0) >= 2, `Expected >=2 cycles, got ${contRes.cyclesObserved}`);

  // Pneumatic cascade with E-stop interruption
  const pneuEStopDoc = generateCircuitFromSpec({
    actuators: [{ label: 'A' }, { label: 'B' }],
    sequence: ['A+', 'B+', 'B-', 'A-'],
    controlMethod: 'pneumatic-cascade',
    includeEStop: true,
  });
  assert.equal(validateCircuitStatic(pneuEStopDoc).valid, true);
  const pneuCheck = verifyCircuitSequence(pneuEStopDoc, {
    expectedSequence: ['A+', 'B+', 'B-', 'A-'],
    inputs: [{ label: 'S1', action: 'press', atMs: 100, durationMs: 150 }],
    durationMs: 6000,
    eStopCheck: {
      label: 'ESTOP',
      triggerAtMs: 300,
      expectNoFurtherMotionsAfterMs: 300,
    },
  });
  assert.equal(pneuCheck.passed, true, pneuCheck.failureSummary);
  assert.equal(pneuCheck.eStopVerified, true);
});

test('coupled simulator emits EXHAUST_BLOCKED, ACTUATOR_STALLED_OVERLOAD, RELAY_OSCILLATION_CHATTER, LIVE_SHORT_CIRCUIT, and models quick_exhaust_valve speedup', () => {
  const baseMeta = {
    title: 'Diag Test',
    fluidsimVersion: '4.5' as const,
    format: 'fsim-ir-json' as const,
    sheetWidthMm: 297,
    sheetHeightMm: 210,
  };

  // 1. EXHAUST_BLOCKED: double-acting cylinder whose retract chamber cannot vent (port 3 has no exhaust silencer)
  const blockedDoc: CircuitDocument = {
    schemaVersion: '1.0',
    metadata: baseMeta,
    components: [
      { id: 'SRC', type: 'air_source', params: { pressureBar: 6 } },
      {
        id: 'V1',
        type: 'valve_5_2',
        params: {},
        leftActuation: { type: 'pushbutton', label: 'S1' },
        rightActuation: { type: 'spring' },
      },
      { id: 'EX5', type: 'exhaust_silencer', params: {} },
      { id: 'C1', type: 'cylinder_double_acting', label: 'A', params: { strokeMm: 100 } },
    ],
    connections: [
      { id: 'E1', from: { componentId: 'SRC', port: '1' }, to: { componentId: 'V1', port: '1' }, domain: 'pneumatic' },
      { id: 'E2', from: { componentId: 'V1', port: '4' }, to: { componentId: 'C1', port: 'A' }, domain: 'pneumatic' },
      { id: 'E3', from: { componentId: 'V1', port: '2' }, to: { componentId: 'C1', port: 'B' }, domain: 'pneumatic' },
      { id: 'E4', from: { componentId: 'V1', port: '5' }, to: { componentId: 'EX5', port: '1' }, domain: 'pneumatic' },
    ],
  };
  const blockedSim = simulateCircuit(blockedDoc, {
    durationMs: 1000,
    inputs: [{ label: 'S1', action: 'press', atMs: 100, durationMs: 600 }],
  });
  assert.ok(blockedSim.diagnostics.some((d) => d.code === 'EXHAUST_BLOCKED'));

  // 2. ACTUATOR_STALLED_OVERLOAD: excessive external load > pneumatic piston force
  const overloadDoc: CircuitDocument = {
    schemaVersion: '1.0',
    metadata: baseMeta,
    components: [
      { id: 'SRC', type: 'air_source', params: { pressureBar: 6 } },
      {
        id: 'V1',
        type: 'valve_3_2',
        params: { normalState: 'NC' },
        leftActuation: { type: 'pushbutton', label: 'S1' },
        rightActuation: { type: 'spring' },
      },
      { id: 'EX1', type: 'exhaust_silencer', params: {} },
      { id: 'C1', type: 'cylinder_single_acting', label: 'A', params: { strokeMm: 50, externalLoadN: 5000 } },
    ],
    connections: [
      { id: 'E1', from: { componentId: 'SRC', port: '1' }, to: { componentId: 'V1', port: '1' }, domain: 'pneumatic' },
      { id: 'E2', from: { componentId: 'V1', port: '2' }, to: { componentId: 'C1', port: 'A' }, domain: 'pneumatic' },
      { id: 'E3', from: { componentId: 'V1', port: '3' }, to: { componentId: 'EX1', port: '1' }, domain: 'pneumatic' },
    ],
  };
  const overloadSim = simulateCircuit(overloadDoc, {
    durationMs: 800,
    inputs: [{ label: 'S1', action: 'press', atMs: 100, durationMs: 500 }],
  });
  assert.ok(overloadSim.diagnostics.some((d) => d.code === 'ACTUATOR_STALLED_OVERLOAD'));

  // 3. RELAY_OSCILLATION_CHATTER: K1 coil fed through its own NC contact K1
  const chatterDoc: CircuitDocument = {
    schemaVersion: '1.0',
    metadata: baseMeta,
    components: [
      { id: 'P24', type: 'power_24v', params: {} },
      { id: 'P0', type: 'power_0v', params: {} },
      { id: 'K1_NC', type: 'relay_contact_nc', label: 'K1', params: {} },
      { id: 'K1', type: 'relay_coil', label: 'K1', params: {} },
    ],
    connections: [
      { id: 'E1', from: { componentId: 'P24', port: 'OUT' }, to: { componentId: 'K1_NC', port: '11' }, domain: 'electrical' },
      { id: 'E2', from: { componentId: 'K1_NC', port: '12' }, to: { componentId: 'K1', port: 'A1' }, domain: 'electrical' },
      { id: 'E3', from: { componentId: 'K1', port: 'A2' }, to: { componentId: 'P0', port: 'IN' }, domain: 'electrical' },
    ],
  };
  const chatterSim = simulateCircuit(chatterDoc, { durationMs: 300 });
  assert.ok(chatterSim.diagnostics.some((d) => d.code === 'RELAY_OSCILLATION_CHATTER'));

  // 4. LIVE_SHORT_CIRCUIT: +24V directly through pushbutton_no to 0V when pressed
  const shortDoc: CircuitDocument = {
    schemaVersion: '1.0',
    metadata: baseMeta,
    components: [
      { id: 'P24', type: 'power_24v', params: {} },
      { id: 'P0', type: 'power_0v', params: {} },
      { id: 'S1', type: 'pushbutton_no', label: 'S1', params: {} },
    ],
    connections: [
      { id: 'E1', from: { componentId: 'P24', port: 'OUT' }, to: { componentId: 'S1', port: '13' }, domain: 'electrical' },
      { id: 'E2', from: { componentId: 'S1', port: '14' }, to: { componentId: 'P0', port: 'IN' }, domain: 'electrical' },
    ],
  };
  const shortSim = simulateCircuit(shortDoc, {
    durationMs: 300,
    inputs: [{ label: 'S1', action: 'press', atMs: 50, durationMs: 100 }],
  });
  assert.ok(shortSim.diagnostics.some((d) => d.code === 'LIVE_SHORT_CIRCUIT'));

  // 5. quick_exhaust_valve demonstrably speeds up single-acting cylinder retraction
  const makeSac = (withQev: boolean): CircuitDocument => ({
    schemaVersion: '1.0',
    metadata: baseMeta,
    components: [
      { id: 'SRC', type: 'air_source', params: { pressureBar: 6 } },
      {
        id: 'V1',
        type: 'valve_3_2',
        params: { normalState: 'NC' },
        leftActuation: { type: 'pushbutton', label: 'S1' },
        rightActuation: { type: 'spring' },
      },
      { id: 'EX1', type: 'exhaust_silencer', params: {} },
      ...(withQev
        ? [
            { id: 'QEV', type: 'quick_exhaust_valve' as const, params: {} },
            { id: 'EX2', type: 'exhaust_silencer' as const, params: {} },
          ]
        : []),
      { id: 'C1', type: 'cylinder_single_acting', label: 'A', params: { strokeMm: 100 } },
    ],
    connections: withQev
      ? [
          { id: 'E1', from: { componentId: 'SRC', port: '1' }, to: { componentId: 'V1', port: '1' }, domain: 'pneumatic' },
          { id: 'E2', from: { componentId: 'V1', port: '2' }, to: { componentId: 'QEV', port: '1' }, domain: 'pneumatic' },
          { id: 'E3', from: { componentId: 'QEV', port: '2' }, to: { componentId: 'C1', port: 'A' }, domain: 'pneumatic' },
          { id: 'E4', from: { componentId: 'QEV', port: '3' }, to: { componentId: 'EX2', port: '1' }, domain: 'pneumatic' },
          { id: 'E5', from: { componentId: 'V1', port: '3' }, to: { componentId: 'EX1', port: '1' }, domain: 'pneumatic' },
        ]
      : [
          { id: 'E1', from: { componentId: 'SRC', port: '1' }, to: { componentId: 'V1', port: '1' }, domain: 'pneumatic' },
          { id: 'E2', from: { componentId: 'V1', port: '2' }, to: { componentId: 'C1', port: 'A' }, domain: 'pneumatic' },
          { id: 'E3', from: { componentId: 'V1', port: '3' }, to: { componentId: 'EX1', port: '1' }, domain: 'pneumatic' },
        ],
  });

  const simNormal = simulateCircuit(makeSac(false), {
    durationMs: 2500,
    stepMs: 10,
    inputs: [{ label: 'S1', action: 'press', atMs: 100, durationMs: 800 }],
  });
  const simQev = simulateCircuit(makeSac(true), {
    durationMs: 2500,
    stepMs: 10,
    inputs: [{ label: 'S1', action: 'press', atMs: 100, durationMs: 800 }],
  });
  const retractNormal = simNormal.events.find((e) => e.kind === 'cylinder_retracted')!.timeMs;
  const retractQev = simQev.events.find((e) => e.kind === 'cylinder_retracted')!.timeMs;
  assert.ok(
    retractQev < retractNormal,
    `Expected quick_exhaust_valve retraction (${retractQev}ms) < normal (${retractNormal}ms)`,
  );
});

