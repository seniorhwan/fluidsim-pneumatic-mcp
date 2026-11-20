import test from 'node:test';
import assert from 'node:assert/strict';
import type { CircuitDocument } from '../contracts/circuit';
import { validateCircuitStatic } from '../simulator/validator';

function makeDoc(
  components: CircuitDocument['components'],
  connections: CircuitDocument['connections'],
): CircuitDocument {
  return {
    schemaVersion: '1.0',
    metadata: {
      title: 'Validator Test',
      fluidsimVersion: '4.5',
      format: 'fsim-ir-json',
      sheetWidthMm: 297,
      sheetHeightMm: 210,
    },
    components,
    connections,
  };
}

test('validator catches missing air source, open pneumatic ports, and missing exhaust terminators', () => {
  const doc = makeDoc(
    [
      {
        id: 'V1',
        type: 'valve_3_2',
        params: { normalState: 'NC' },
        leftActuation: { type: 'pushbutton', label: 'S1' },
        rightActuation: { type: 'spring' },
      },
      { id: 'C1', type: 'cylinder_single_acting', label: 'A', params: { strokeMm: 50 } },
    ],
    [{ id: 'E1', from: { componentId: 'V1', port: '2' }, to: { componentId: 'C1', port: 'A' }, domain: 'pneumatic' }],
  );

  const report = validateCircuitStatic(doc);
  assert.equal(report.valid, false);
  const codes = new Set(report.findings.map((f) => f.code));
  assert.ok(codes.has('MISSING_AIR_SOURCE'));
  assert.ok(codes.has('OPEN_PNEUMATIC_PORT'));
  assert.ok(codes.has('MISSING_EXHAUST_TERMINATOR'));
  for (const f of report.findings) {
    assert.ok(f.suggestedFix.length > 5);
  }
});

test('validator catches cross-domain pneumatic <-> electrical wiring', () => {
  const doc = makeDoc(
    [
      { id: 'SRC', type: 'air_source', params: { pressureBar: 6 } },
      { id: 'K1', type: 'relay_coil', label: 'K1', params: {} },
    ],
    [{ id: 'E_BAD', from: { componentId: 'SRC', port: '1' }, to: { componentId: 'K1', port: 'A1' }, domain: 'pneumatic' }],
  );

  const report = validateCircuitStatic(doc);
  assert.equal(report.valid, false);
  assert.ok(report.findings.some((f) => f.code === 'CROSS_DOMAIN_CONNECTION'));
});

test('validator catches orphaned solenoid, orphaned sensor, and orphaned relay contact', () => {
  const doc = makeDoc(
    [
      { id: 'P24', type: 'power_24v', params: {} },
      { id: 'P0', type: 'power_0v', params: {} },
      { id: 'LS1', type: 'limit_switch_no', label: 'a1', params: {} },
      { id: 'K9_NO', type: 'relay_contact_no', label: 'K9', params: {} },
      { id: 'SOL_Y2', type: 'valve_solenoid', label: 'Y2', params: {} },
    ],
    [
      { id: 'E1', from: { componentId: 'P24', port: 'OUT' }, to: { componentId: 'LS1', port: '13' }, domain: 'electrical' },
      { id: 'E2', from: { componentId: 'LS1', port: '14' }, to: { componentId: 'K9_NO', port: '13' }, domain: 'electrical' },
      { id: 'E3', from: { componentId: 'K9_NO', port: '14' }, to: { componentId: 'SOL_Y2', port: 'A1' }, domain: 'electrical' },
      { id: 'E4', from: { componentId: 'SOL_Y2', port: 'A2' }, to: { componentId: 'P0', port: 'IN' }, domain: 'electrical' },
    ],
  );

  const report = validateCircuitStatic(doc);
  assert.equal(report.valid, false);
  const codes = new Set(report.findings.map((f) => f.code));
  assert.ok(codes.has('ORPHANED_SOLENOID'));
  assert.ok(codes.has('ORPHANED_SENSOR_BINDING'));
  assert.ok(codes.has('ORPHANED_RELAY_CONTACT'));
});

test('validator catches direct +24V to 0V short-circuit and coil missing 0V return', () => {
  const shortDoc = makeDoc(
    [
      { id: 'P24', type: 'power_24v', params: {} },
      { id: 'P0', type: 'power_0v', params: {} },
      { id: 'S_NC', type: 'pushbutton_nc', label: 'S2', params: {} },
    ],
    [
      { id: 'E1', from: { componentId: 'P24', port: 'OUT' }, to: { componentId: 'S_NC', port: '11' }, domain: 'electrical' },
      { id: 'E2', from: { componentId: 'S_NC', port: '12' }, to: { componentId: 'P0', port: 'IN' }, domain: 'electrical' },
    ],
  );
  const shortRep = validateCircuitStatic(shortDoc);
  assert.ok(shortRep.findings.some((f) => f.code === 'DIRECT_SHORT_CIRCUIT'));

  const noReturnDoc = makeDoc(
    [
      { id: 'P24', type: 'power_24v', params: {} },
      { id: 'P0', type: 'power_0v', params: {} },
      { id: 'K1', type: 'relay_coil', label: 'K1', params: {} },
    ],
    [{ id: 'E1', from: { componentId: 'P24', port: 'OUT' }, to: { componentId: 'K1', port: 'A1' }, domain: 'electrical' }],
  );
  const noRetRep = validateCircuitStatic(noReturnDoc);
  assert.ok(noRetRep.findings.some((f) => f.code === 'MISSING_0V_RETURN'));
});

test('validator catches duplicate connections, unactuated valves, chamber short, dangling junction, and open electrical port', () => {
  const doc = makeDoc(
    [
      { id: 'SRC', type: 'air_source', params: { pressureBar: 6 } },
      { id: 'V_NOACT', type: 'valve_5_2', params: {} },
      { id: 'EX1', type: 'exhaust_silencer', params: {} },
      { id: 'EX2', type: 'exhaust_silencer', params: {} },
      { id: 'C1', type: 'cylinder_double_acting', label: 'A', params: { strokeMm: 100 } },
      { id: 'M_DANGLE', type: 'pneumatic_junction', params: {} },
      { id: 'P24', type: 'power_24v', params: {} },
      { id: 'P0', type: 'power_0v', params: {} },
      { id: 'S1', type: 'pushbutton_no', label: 'S1', params: {} },
    ],
    [
      { id: 'E1', from: { componentId: 'SRC', port: '1' }, to: { componentId: 'V_NOACT', port: '1' }, domain: 'pneumatic' },
      // Duplicate connection
      { id: 'E1_DUP', from: { componentId: 'SRC', port: '1' }, to: { componentId: 'V_NOACT', port: '1' }, domain: 'pneumatic' },
      { id: 'E2', from: { componentId: 'V_NOACT', port: '4' }, to: { componentId: 'C1', port: 'A' }, domain: 'pneumatic' },
      { id: 'E3', from: { componentId: 'V_NOACT', port: '2' }, to: { componentId: 'C1', port: 'B' }, domain: 'pneumatic' },
      // Short both chambers of C1 together
      { id: 'E_SHORT', from: { componentId: 'C1', port: 'A' }, to: { componentId: 'C1', port: 'B' }, domain: 'pneumatic' },
      { id: 'E4', from: { componentId: 'V_NOACT', port: '5' }, to: { componentId: 'EX1', port: '1' }, domain: 'pneumatic' },
      { id: 'E5', from: { componentId: 'V_NOACT', port: '3' }, to: { componentId: 'EX2', port: '1' }, domain: 'pneumatic' },
      // Dangling manifold connected only on 1 port
      { id: 'E6', from: { componentId: 'SRC', port: '1' }, to: { componentId: 'M_DANGLE', port: '1' }, domain: 'pneumatic' },
      // Electrical pushbutton with port 14 left open
      { id: 'E7', from: { componentId: 'P24', port: 'OUT' }, to: { componentId: 'S1', port: '13' }, domain: 'electrical' },
    ],
  );

  const report = validateCircuitStatic(doc);
  assert.equal(report.valid, false);
  const codes = new Set(report.findings.map((f) => f.code));
  assert.ok(codes.has('DUPLICATE_CONNECTION'), `Missing DUPLICATE_CONNECTION in ${[...codes]}`);
  assert.ok(codes.has('UNACTUATED_VALVE'), `Missing UNACTUATED_VALVE in ${[...codes]}`);
  assert.ok(codes.has('PNEUMATIC_CHAMBER_SHORT'), `Missing PNEUMATIC_CHAMBER_SHORT in ${[...codes]}`);
  assert.ok(codes.has('DANGLING_JUNCTION'), `Missing DANGLING_JUNCTION in ${[...codes]}`);
  assert.ok(codes.has('OPEN_ELECTRICAL_PORT'), `Missing OPEN_ELECTRICAL_PORT in ${[...codes]}`);
});

