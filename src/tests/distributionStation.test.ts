import test from 'node:test';
import assert from 'node:assert/strict';
import type { CircuitDocument, ComponentNode } from '../contracts/circuit';
import { getCatalogComponent } from '../catalog/pneumatics45';
import { autoLayoutCircuit, getEffectiveRotationDeg } from '../authoring/layoutRouter';
import { validateCircuitStatic } from '../simulator/validator';
import { simulateCircuit } from '../simulator/simulator';
import { serializeCircuitDocument } from '../codec/ctSerializer';
import { parseCircuitBuffer } from '../codec/ctParser';
import { verifyCodecRoundtrip } from '../codec/ctRoundtripGuard';
import { decodeCtContainer, verifyCtPayloadLinearBounds } from '../codec/ctBinaryCodec';
import { verifyCtTextInvariants } from '../codec/ctTextCodec';

function buildFestoDistributionStationCircuit(): CircuitDocument {
  const now = new Date().toISOString();
  const components: ComponentNode[] = [
    // Main Air Supply + Service Unit (-0Z1) + Manifold Buses (CPV10 block) + Blind Plugs
    { id: 'SRC_1', type: 'air_source', label: 'P', params: { pressureBar: 6.0, maxFlowLMin: 1000 } },
    { id: 'FRL_0Z1', type: 'air_service_unit', label: '-0Z1', params: { nominalPressureBar: 6.0 } },
    { id: 'BUS_1', type: 'pneumatic_manifold', label: '1', params: {} },
    { id: 'PLUG_BUS1', type: 'blind_plug', label: '11', params: {} },
    { id: 'BUS_EXH', type: 'pneumatic_manifold', label: '3/5', params: {} },
    { id: 'EX_MAIN', type: 'exhaust_silencer', label: '3/5', params: {} },
    { id: 'PLUG_EXH', type: 'blind_plug', label: '82/84', params: {} },

    // =========================================================================
    // BRANCH 1: Stack Magazine Ejector Cylinder (-1A1)
    // =========================================================================
    {
      id: 'V_1V1',
      type: 'valve_5_2',
      label: '-1V1',
      params: { initialState: 'right', nominalFlowLMin: 400 },
      leftActuation: { type: 'solenoid', label: '-1M1', manualOverride: true, internalPilot: true },
      rightActuation: { type: 'pneumatic_spring', springReturn: true },
    },
    {
      id: 'TH_1V2',
      type: 'flow_control_one_way',
      label: '-1V2',
      rotationDeg: 180,
      params: { openingPct: 50, freeFlowDirection: '1_to_2' },
    },
    {
      id: 'TH_1V3',
      type: 'flow_control_one_way',
      label: '-1V3',
      rotationDeg: 180,
      params: { openingPct: 50, freeFlowDirection: '1_to_2' },
    },
    {
      id: 'CYL_1A1',
      type: 'cylinder_double_acting',
      label: '-1A1',
      params: { strokeMm: 100, pistonDiameterMm: 20, rodDiameterMm: 8, externalLoadN: 0, cushioning: true, initialPositionMm: 0 },
      distanceRule: [
        { label: '-1B1', positionMm: 0, toleranceMm: 2 },
        { label: '-1B2', positionMm: 100, toleranceMm: 2 },
      ],
    },

    // =========================================================================
    // BRANCH 2: Vacuum Suction & Blow-Off (-2M1, -2M2, -2V1, -2V2, -2V3, -2Z1, -2B1, -2A1)
    // =========================================================================
    {
      id: 'V_2M1',
      type: 'valve_2_2',
      label: '-2M1',
      params: { normalState: 'NC', normallyOpen: false, nominalFlowLMin: 250 },
      leftActuation: { type: 'solenoid', label: '-2M1', manualOverride: true, internalPilot: true },
      rightActuation: { type: 'pneumatic_spring', springReturn: true },
    },
    {
      id: 'V_2M2',
      type: 'valve_2_2',
      label: '-2M2',
      params: { normalState: 'NC', normallyOpen: false, nominalFlowLMin: 250 },
      leftActuation: { type: 'solenoid', label: '-2M2', manualOverride: true, internalPilot: true },
      rightActuation: { type: 'pneumatic_spring', springReturn: true },
    },
    {
      id: 'VENT_2V1',
      type: 'vacuum_suction_nozzle',
      label: '-2V1',
      params: { vacuumBar: -0.75, minSupplyBar: 2.0 },
    },
    { id: 'EX_2V1', type: 'exhaust_silencer', label: '3', params: {} },
    {
      id: 'CHK_2V2',
      type: 'check_valve_spring',
      label: '-2V2',
      params: { crackingPressureBar: 0.15 },
    },
    {
      id: 'THR_2V3',
      type: 'throttle_valve',
      label: '-2V3',
      params: { openingPct: 40 },
    },
    { id: 'J_VAC_1', type: 'pneumatic_junction', params: {} },
    {
      id: 'FLT_2Z1',
      type: 'air_filter',
      label: '-2Z1',
      rotationDeg: 90,
      params: { nominalFlowLMin: 500 },
    },
    { id: 'J_VAC_2', type: 'pneumatic_junction', params: {} },
    {
      id: 'PSW_2B1',
      type: 'pressure_switch_differential',
      label: '-2B1',
      params: { pressureBar: -0.45, triggerMode: 'below' },
    },
    {
      id: 'CUP_2A1',
      type: 'vacuum_sucker',
      label: '-2A1',
      params: { gripThresholdBar: -0.4 },
    },

    // =========================================================================
    // BRANCH 3: Semi-Rotary Swivel Drive (-3A1) driven by dual Normally-Open 3/2 valves (-3M1, -3M2)
    // =========================================================================
    {
      id: 'V_3M1',
      type: 'valve_3_2',
      label: '-3M1',
      params: { normalState: 'NO', normallyOpen: true, nominalFlowLMin: 300 },
      leftActuation: { type: 'solenoid', label: '-3M1', manualOverride: true, internalPilot: true },
      rightActuation: { type: 'pneumatic_spring', springReturn: true },
    },
    {
      id: 'V_3M2',
      type: 'valve_3_2',
      label: '-3M2',
      params: { normalState: 'NO', normallyOpen: true, nominalFlowLMin: 300 },
      leftActuation: { type: 'solenoid', label: '-3M2', manualOverride: true, internalPilot: true },
      rightActuation: { type: 'pneumatic_spring', springReturn: true },
    },
    {
      id: 'TH_3V2',
      type: 'flow_control_one_way',
      label: '-3V2',
      rotationDeg: 180,
      params: { openingPct: 60, freeFlowDirection: '1_to_2' },
    },
    {
      id: 'TH_3V3',
      type: 'flow_control_one_way',
      label: '-3V3',
      rotationDeg: 180,
      params: { openingPct: 60, freeFlowDirection: '1_to_2' },
    },
    {
      id: 'SWIVEL_3A1',
      type: 'swivel_drive',
      label: '-3A1',
      params: { maxAngleDeg: 180, initialAngleDeg: 0, torqueNm: 5, externalLoadNm: 0 },
      distanceRule: [
        { label: '-3B1', positionMm: 0, toleranceMm: 2 },
        { label: '-3B2', positionMm: 180, toleranceMm: 2 },
      ],
    },
  ];

  const connections: CircuitDocument['connections'] = [
    // Supply & exhaust manifolds
    { id: 'E1', from: { componentId: 'SRC_1', port: '1' }, to: { componentId: 'FRL_0Z1', port: '1' }, domain: 'pneumatic' },
    { id: 'E2', from: { componentId: 'FRL_0Z1', port: '2' }, to: { componentId: 'BUS_1', port: '1' }, domain: 'pneumatic' },
    { id: 'E3', from: { componentId: 'BUS_1', port: '8' }, to: { componentId: 'PLUG_BUS1', port: '1' }, domain: 'pneumatic' },
    { id: 'E4', from: { componentId: 'BUS_EXH', port: '1' }, to: { componentId: 'EX_MAIN', port: '1' }, domain: 'pneumatic' },
    { id: 'E5', from: { componentId: 'BUS_EXH', port: '8' }, to: { componentId: 'PLUG_EXH', port: '1' }, domain: 'pneumatic' },

    // Branch 1: -1V1 -> -1V2/-1V3 -> -1A1
    { id: 'E10', from: { componentId: 'BUS_1', port: '2' }, to: { componentId: 'V_1V1', port: '1' }, domain: 'pneumatic' },
    { id: 'E11', from: { componentId: 'V_1V1', port: '3' }, to: { componentId: 'BUS_EXH', port: '2' }, domain: 'pneumatic' },
    { id: 'E12', from: { componentId: 'V_1V1', port: '5' }, to: { componentId: 'BUS_EXH', port: '3' }, domain: 'pneumatic' },
    { id: 'E13', from: { componentId: 'V_1V1', port: '4' }, to: { componentId: 'TH_1V2', port: '1' }, domain: 'pneumatic' },
    { id: 'E14', from: { componentId: 'TH_1V2', port: '2' }, to: { componentId: 'CYL_1A1', port: 'A' }, domain: 'pneumatic' },
    { id: 'E15', from: { componentId: 'V_1V1', port: '2' }, to: { componentId: 'TH_1V3', port: '1' }, domain: 'pneumatic' },
    { id: 'E16', from: { componentId: 'TH_1V3', port: '2' }, to: { componentId: 'CYL_1A1', port: 'B' }, domain: 'pneumatic' },

    // Branch 2: Vacuum (-2M1 -> -2V1 -> -2V2 <- J_VAC_1 <- -2V3 <- -2M2; J_VAC_1 -> -2Z1 -> J_VAC_2 -> -2B1 & -2A1)
    { id: 'E20', from: { componentId: 'BUS_1', port: '3' }, to: { componentId: 'V_2M1', port: '1' }, domain: 'pneumatic' },
    { id: 'E21', from: { componentId: 'V_2M1', port: '2' }, to: { componentId: 'VENT_2V1', port: '1' }, domain: 'pneumatic' },
    { id: 'E22', from: { componentId: 'VENT_2V1', port: '3' }, to: { componentId: 'EX_2V1', port: '1' }, domain: 'pneumatic' },
    { id: 'E23', from: { componentId: 'J_VAC_1', port: '1' }, to: { componentId: 'CHK_2V2', port: '1' }, domain: 'pneumatic' },
    { id: 'E24', from: { componentId: 'CHK_2V2', port: '2' }, to: { componentId: 'VENT_2V1', port: '1v' }, domain: 'pneumatic' },
    { id: 'E25', from: { componentId: 'BUS_1', port: '4' }, to: { componentId: 'V_2M2', port: '1' }, domain: 'pneumatic' },
    { id: 'E26', from: { componentId: 'V_2M2', port: '2' }, to: { componentId: 'THR_2V3', port: '1' }, domain: 'pneumatic' },
    { id: 'E27', from: { componentId: 'THR_2V3', port: '2' }, to: { componentId: 'J_VAC_1', port: '2' }, domain: 'pneumatic' },
    { id: 'E28', from: { componentId: 'J_VAC_1', port: '3' }, to: { componentId: 'FLT_2Z1', port: '1' }, domain: 'pneumatic' },
    { id: 'E29', from: { componentId: 'FLT_2Z1', port: '2' }, to: { componentId: 'J_VAC_2', port: '1' }, domain: 'pneumatic' },
    { id: 'E30', from: { componentId: 'J_VAC_2', port: '2' }, to: { componentId: 'PSW_2B1', port: 'P1' }, domain: 'pneumatic' },
    { id: 'E31', from: { componentId: 'J_VAC_2', port: '3' }, to: { componentId: 'CUP_2A1', port: '1v' }, domain: 'pneumatic' },

    // Branch 3: Swivel drive (-3M1 / -3M2 NO 3/2 valves -> -3V2 / -3V3 -> -3A1)
    { id: 'E40', from: { componentId: 'BUS_1', port: '5' }, to: { componentId: 'V_3M1', port: '1' }, domain: 'pneumatic' },
    { id: 'E41', from: { componentId: 'BUS_1', port: '6' }, to: { componentId: 'V_3M2', port: '1' }, domain: 'pneumatic' },
    { id: 'E42', from: { componentId: 'V_3M1', port: '3' }, to: { componentId: 'BUS_EXH', port: '4' }, domain: 'pneumatic' },
    { id: 'E43', from: { componentId: 'V_3M2', port: '3' }, to: { componentId: 'BUS_EXH', port: '5' }, domain: 'pneumatic' },
    { id: 'E44', from: { componentId: 'V_3M1', port: '2' }, to: { componentId: 'TH_3V2', port: '1' }, domain: 'pneumatic' },
    { id: 'E45', from: { componentId: 'TH_3V2', port: '2' }, to: { componentId: 'SWIVEL_3A1', port: 'A' }, domain: 'pneumatic' },
    { id: 'E46', from: { componentId: 'V_3M2', port: '2' }, to: { componentId: 'TH_3V3', port: '1' }, domain: 'pneumatic' },
    { id: 'E47', from: { componentId: 'TH_3V3', port: '2' }, to: { componentId: 'SWIVEL_3A1', port: 'B' }, domain: 'pneumatic' },
  ];

  return autoLayoutCircuit({
    schemaVersion: '1.0',
    metadata: {
      title: 'Festo MPS-C Distributing Station (Pneumatic Sheet)',
      fluidsimVersion: '4.5',
      format: 'fsim-ir-json',
      sheetSize: 'DIN_A3_LANDSCAPE',
      sheetDomain: 'pneumatic-only',
      allowExternalElectricalSheet: true,
      sheetWidthMm: 420,
      sheetHeightMm: 297,
      createdAt: now,
      updatedAt: now,
    },
    components,
    connections,
  });
}

test('Festo MPS-C Distributing Station passes static validation (0 errors, 0 warnings), fits DIN A3 with zero overlaps, preserves rotations, and roundtrips native .ct', () => {
  const doc = buildFestoDistributionStationCircuit();

  // 1. Static validation passes with ZERO errors and ZERO warnings on pneumatic-only sheet
  const val = validateCircuitStatic(doc);
  assert.equal(val.valid, true, `Expected valid Distribution Station, got: ${JSON.stringify(val.findings)}`);
  assert.equal(val.errorCount, 0);
  assert.equal(val.warningCount, 0);

  // 2. DIN A3 bounds (420 x 297 mm) + preserved rotations + zero overlapping boxes
  assert.ok(
    doc.metadata.sheetWidthMm <= 420,
    `Expected layout width <= 420mm (DIN A3), got ${doc.metadata.sheetWidthMm}mm`,
  );
  assert.ok(
    doc.metadata.sheetHeightMm <= 297,
    `Expected layout height <= 297mm (DIN A3), got ${doc.metadata.sheetHeightMm}mm`,
  );

  assert.equal(doc.components.find((c) => c.id === 'FLT_2Z1')?.layout?.rotationDeg, 90);
  assert.equal(doc.components.find((c) => c.id === 'TH_1V2')?.layout?.rotationDeg, 180);
  assert.equal(doc.components.find((c) => c.id === 'TH_3V2')?.layout?.rotationDeg, 180);

  const boxes = doc.components.map((c) => {
    assert.ok(c.layout, `Missing layout on ${c.id}`);
    const def = getCatalogComponent(c.type)!;
    const rot = getEffectiveRotationDeg(c);
    const w = rot === 90 || rot === 270 ? def.defaultSize.height : def.defaultSize.width;
    const h = rot === 90 || rot === 270 ? def.defaultSize.width : def.defaultSize.height;
    return { id: c.id, x: c.layout.x, y: c.layout.y, w, h };
  });
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      const overlapX = a.x < b.x + b.w && a.x + a.w > b.x;
      const overlapY = a.y < b.y + b.h && a.y + a.h > b.y;
      assert.equal(overlapX && overlapY, false, `Overlap detected between ${a.id} and ${b.id}`);
    }
  }

  // 3. Native FluidSIM 4.5 .ct roundtrip preserves all metadata, rotations, composite actuation, and normallyOpen
  const ctBytes = serializeCircuitDocument(doc, { targetPath: 'distribution_station.ct' });
  const lzBounds = verifyCtPayloadLinearBounds(ctBytes, 'distribution_station.ct');
  assert.equal(lzBounds.ok, true, `Distribution Station LZ linear bounds failed: ${JSON.stringify(lzBounds)}`);
  assert.equal(lzBounds.refWrapReads, 0);
  assert.equal(lzBounds.uninitializedReads, 0);

  const decoded = decodeCtContainer(ctBytes, 'distribution_station.ct');
  const inv = verifyCtTextInvariants(decoded.ctBody);
  assert.equal(inv.ok, true, `PTriconnection/ETriconnection 4-gate invariant failed: ${JSON.stringify(inv.badJunctions)}`);
  for (const cls of [
    'PAV1S ',
    'PAV1 ',
    'PAR1b ',
    'DRSV2_pneu ',
    'CheckValveSpringLoadedP ',
    'FilterP ',
    'WV_2 ',
    'WV_3 ',
    'WV_5 ',
    'PEW ',
  ]) {
    assert.ok(decoded.ctBody.includes(cls), `Expected genuine FluidSIM 4.5 class "${cls.trim()}" in distribution_station.ct`);
  }
  assert.ok(decoded.ctBody.includes('SWITCHED_POS_R S (2\tC3P)'), 'Expected native FluidSIM 4.5 NO WV_3 SWITCHED_POS_R');

  const rt = verifyCodecRoundtrip(doc, ctBytes, 'distribution_station.ct');
  assert.equal(rt.passed, true);

  const { document: reparsed } = parseCircuitBuffer(ctBytes, 'distribution_station.ct');
  assert.equal(reparsed.metadata.sheetWidthMm, 420);
  assert.equal(reparsed.metadata.sheetHeightMm, 297);
  assert.equal(reparsed.metadata.allowExternalElectricalSheet, true);
  assert.equal(reparsed.components.find((c) => c.id === 'FLT_2Z1')?.rotationDeg, 90);
  assert.equal(reparsed.components.find((c) => c.id === 'TH_1V2')?.rotationDeg, 180);
  assert.equal(reparsed.components.find((c) => c.id === 'V_3M1')?.params.normallyOpen, true);
  assert.equal(reparsed.components.find((c) => c.id === 'V_1V1')?.leftActuation?.manualOverride, true);
  assert.equal(reparsed.components.find((c) => c.id === 'V_1V1')?.rightActuation?.type, 'pneumatic_spring');

  const valReparsed = validateCircuitStatic(reparsed);
  assert.equal(valReparsed.valid, true, JSON.stringify(valReparsed.findings));
  assert.equal(valReparsed.errorCount, 0);
  assert.equal(valReparsed.warningCount, 0);
});

test('Festo MPS-C Distributing Station simulates ejector cylinder, vacuum suction/PEW switch/blow-off release, and 180-deg swivel drive', () => {
  const doc = buildFestoDistributionStationCircuit();

  // Simulate full operational sequence via manual overrides / external PLC solenoid drives:
  // 1) t=100..900ms: -1M1 extends ejector -1A1, then retracts on release
  // 2) t=100..1500ms: -2M1 turns on Venturi vacuum -> -2A1 grips & -2B1 switches ON
  // 3) t=1600..2100ms: -2M2 fires blow-off -> -2A1 releases & -2B1 drops
  // 4) t=200..1400ms: -3M2 energizes (exhausting B while NO -3M1 pressurizes A) -> -3A1 swivels 0->180 deg
  // 5) t=1500..2800ms: -3M1 energizes (exhausting A while NO -3M2 pressurizes B) -> -3A1 returns 180->0 deg
  const sim = simulateCircuit(doc, {
    durationMs: 3200,
    stepMs: 10,
    inputs: [
      { label: '-1M1', action: 'press', atMs: 100, durationMs: 900 },
      { label: '-2M1', action: 'hold', atMs: 100 },
      { label: '-2M1', action: 'release', atMs: 1500 },
      { label: '-2M2', action: 'press', atMs: 1600, durationMs: 400 },
      { label: '-3M2', action: 'press', atMs: 200, durationMs: 1200 },
      { label: '-3M1', action: 'press', atMs: 1500, durationMs: 1200 },
    ],
  });

  assert.equal(sim.diagnostics.length, 0, `Unexpected simulation diagnostics: ${JSON.stringify(sim.diagnostics)}`);
  assert.ok(sim.observedSequence.includes('-1A1+'), `Expected -1A1+ in ${JSON.stringify(sim.observedSequence)}`);
  assert.ok(sim.observedSequence.includes('-1A1-'), `Expected -1A1- in ${JSON.stringify(sim.observedSequence)}`);
  assert.ok(sim.observedSequence.includes('-3A1+'), `Expected -3A1+ swivel 180deg in ${JSON.stringify(sim.observedSequence)}`);
  assert.ok(sim.observedSequence.includes('-3A1-'), `Expected -3A1- swivel 0deg in ${JSON.stringify(sim.observedSequence)}`);

  assert.ok(
    sim.events.some((e) => e.kind === 'vacuum_gripped' && e.componentId === 'CUP_2A1'),
    'Expected vacuum_gripped event on CUP_2A1',
  );
  assert.ok(
    sim.events.some((e) => e.kind === 'vacuum_released' && e.componentId === 'CUP_2A1'),
    'Expected vacuum_released event on CUP_2A1',
  );
  assert.ok(
    sim.events.some((e) => e.kind === 'sensor_triggered' && e.label === '-2B1'),
    'Expected -2B1 PEW differential vacuum switch to trigger',
  );
  assert.equal(sim.finalState.cylinders.SWIVEL_3A1?.unit, 'deg');
  assert.equal(sim.finalState.vacuum?.CUP_2A1?.gripped, false);
  assert.equal(sim.finalState.pressureSwitches?.PSW_2B1?.active, false);
});
