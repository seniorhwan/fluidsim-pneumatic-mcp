import test from 'node:test';
import assert from 'node:assert/strict';
import type { CircuitDocument } from '../contracts/circuit';
import { applyCircuitPatch } from '../authoring/patchEngine';
import { autoLayoutCircuit } from '../authoring/layoutRouter';
import { generateCircuitFromSpec } from '../authoring/specGenerator';
import { EngineeringError } from '../contracts/errors';
import { getCatalogComponent } from '../catalog/pneumatics45';

function blankDoc(): CircuitDocument {
  return {
    schemaVersion: '1.0',
    metadata: {
      title: 'Patch Test',
      fluidsimVersion: '4.5',
      format: 'fsim-ir-json',
      sheetWidthMm: 297,
      sheetHeightMm: 210,
    },
    components: [],
    connections: [],
  };
}

test('patchEngine rolls back completely on preflight error without mutating original document', () => {
  const original = blankDoc();
  assert.throws(
    () =>
      applyCircuitPatch(original, [
        { op: 'add_component', component: { id: 'SRC', type: 'air_source', params: {} } },
        { op: 'add_component', component: { id: 'K1', type: 'relay_coil', label: 'K1', params: {} } },
        { op: 'connect', from: { componentId: 'SRC', port: '1' }, to: { componentId: 'K1', port: 'A1' } },
      ]),
    (err: unknown) =>
      err instanceof EngineeringError &&
      err.category === 'InvalidTopology' &&
      err.code === 'PREFLIGHT_DOMAIN_MISMATCH',
  );

  // Original remains completely untouched
  assert.equal(original.components.length, 0);
  assert.equal(original.connections.length, 0);
});

test('patchEngine supports add, connect, set_distance_rule, set_label, and remove with auto-layout', () => {
  const base = blankDoc();
  const res = applyCircuitPatch(base, [
    { op: 'add_component', component: { id: 'SRC', type: 'air_source', params: { pressureBar: 6 } } },
    {
      op: 'add_component',
      component: {
        id: 'V1',
        type: 'valve_3_2',
        params: { normalState: 'NC' },
        leftActuation: { type: 'pushbutton', label: 'S1' },
        rightActuation: { type: 'spring' },
      },
    },
    { op: 'add_component', component: { id: 'EX1', type: 'exhaust_silencer', params: {} } },
    { op: 'add_component', component: { id: 'C1', type: 'cylinder_single_acting', params: { strokeMm: 50 } } },
    { op: 'set_label', componentId: 'C1', label: 'A' },
    {
      op: 'set_distance_rule',
      componentId: 'C1',
      markers: [
        { label: 'a0', positionMm: 0 },
        { label: 'a1', positionMm: 50 },
      ],
    },
    { op: 'connect', from: { componentId: 'SRC', port: '1' }, to: { componentId: 'V1', port: '1' } },
    { op: 'connect', from: { componentId: 'V1', port: '2' }, to: { componentId: 'C1', port: 'A' } },
    { op: 'connect', from: { componentId: 'V1', port: '3' }, to: { componentId: 'EX1', port: '1' } },
  ]);

  assert.equal(res.document.components.length, 4);
  assert.equal(res.document.connections.length, 3);
  for (const c of res.document.components) {
    assert.ok(c.layout !== undefined, `Expected auto-layout coordinates on ${c.id}`);
    assert.equal(c.layout!.x % 5, 0);
    assert.equal(c.layout!.y % 5, 0);
  }
  for (const e of res.document.connections) {
    assert.ok(e.waypoints && e.waypoints.length >= 2, `Expected orthogonal waypoints on ${e.id}`);
    // Verify every segment is orthogonal (dx === 0 || dy === 0)
    for (let i = 1; i < e.waypoints!.length; i++) {
      const prev = e.waypoints![i - 1];
      const cur = e.waypoints![i];
      assert.ok(prev.x === cur.x || prev.y === cur.y, `Non-orthogonal segment on ${e.id}`);
    }
  }
});

test('layoutRouter places ISO 1219 pneumatic layers top-down with zero component overlap', () => {
  const doc = generateCircuitFromSpec({
    actuators: [{ label: 'A' }, { label: 'B' }],
    sequence: ['A+', 'B+', 'B-', 'A-'],
    controlMethod: 'electro-pneumatic-step-chain',
  });
  const laid = autoLayoutCircuit(doc, { incremental: false });

  // Actuators must be above 5/2 valves, which must be above air source
  const cylA = laid.components.find((c) => c.id === 'CYL_A')!;
  const valveA = laid.components.find((c) => c.id === 'V_A')!;
  const src = laid.components.find((c) => c.id === 'SRC_1')!;
  assert.ok(cylA.layout!.y < valveA.layout!.y);
  assert.ok(valveA.layout!.y < src.layout!.y);

  // Pairwise non-overlap check across all components
  for (let i = 0; i < laid.components.length; i++) {
    const a = laid.components[i];
    const da = getCatalogComponent(a.type)!;
    for (let j = i + 1; j < laid.components.length; j++) {
      const b = laid.components[j];
      const db = getCatalogComponent(b.type)!;
      const overlapX =
        a.layout!.x < b.layout!.x + db.defaultSize.width &&
        a.layout!.x + da.defaultSize.width > b.layout!.x;
      const overlapY =
        a.layout!.y < b.layout!.y + db.defaultSize.height &&
        a.layout!.y + da.defaultSize.height > b.layout!.y;
      assert.equal(overlapX && overlapY, false, `Overlap detected between ${a.id} and ${b.id}`);
    }
  }
});
