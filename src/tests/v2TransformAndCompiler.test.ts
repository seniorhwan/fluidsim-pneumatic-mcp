import test from 'node:test';
import assert from 'node:assert/strict';
import type { CircuitDocument, ComponentNode, FluidSimFlippedCode } from '../contracts/circuit';
import type { PortNormal } from '../contracts/catalog';
import {
  flippedCodeToMirror,
  mirrorToFlippedCode,
  normalizeRotationDeg,
  transformBox,
  transformNormal,
  transformPoint,
  transformSymPrimitivesMm,
  type RotationDeg,
  type SymPrimitive,
} from '../codec/ctTransform';
import {
  compileFluidSim45Valve,
  verifyCtValveSolverInvariants,
} from '../codec/ctValveCompiler';
import { normalizeCircuitTopology } from '../authoring/topologyNormalizer';
import { serializeCircuitDocument } from '../codec/ctSerializer';
import { parseCircuitBuffer } from '../codec/ctParser';
import { decodeCtContainer } from '../codec/ctBinaryCodec';
import { verifyCtVisualLayoutInvariants } from '../codec/ctTextCompiler';

test('D4 orientation algebra: all 16 (rot x FLIPPED) combinations preserve box bounds, port invariance, and reflection-safe arc reversal', () => {
  const rots: RotationDeg[] = [0, 90, 180, 270];
  const flips: FluidSimFlippedCode[] = [0, 1, 2, 3];
  const baseW = 24;
  const baseH = 10;
  const samplePt = { x: 4, y: 2 };
  const normals: PortNormal[] = ['N', 'E', 'S', 'W'];

  // Verify mirror <-> FLIPPED roundtrip mapping
  assert.equal(mirrorToFlippedCode('none'), 0);
  assert.equal(mirrorToFlippedCode('horizontal'), 1);
  assert.equal(mirrorToFlippedCode('vertical'), 2);
  assert.equal(mirrorToFlippedCode('both'), 3);
  assert.equal(flippedCodeToMirror(0), 'none');
  assert.equal(flippedCodeToMirror(1), 'horizontal');
  assert.equal(flippedCodeToMirror(2), 'vertical');
  assert.equal(flippedCodeToMirror(3), 'both');

  // Verify rotation normalization wraps cleanly
  assert.equal(normalizeRotationDeg(0), 0);
  assert.equal(normalizeRotationDeg(90), 90);
  assert.equal(normalizeRotationDeg(450), 90);
  assert.equal(normalizeRotationDeg(-90), 270);

  for (const rot of rots) {
    for (const flip of flips) {
      const tBox = transformBox(baseW, baseH, rot, flip);
      if (rot === 90 || rot === 270) {
        assert.equal(tBox.w, baseH);
        assert.equal(tBox.h, baseW);
      } else {
        assert.equal(tBox.w, baseW);
        assert.equal(tBox.h, baseH);
      }

      const pt = transformPoint(samplePt.x, samplePt.y, baseW, baseH, rot, flip);
      assert.ok(pt.x >= -1e-6 && pt.x <= tBox.w + 1e-6, `Point X out of box for rot=${rot}, flip=${flip}: ${pt.x}`);
      assert.ok(pt.y >= -1e-6 && pt.y <= tBox.h + 1e-6, `Point Y out of box for rot=${rot}, flip=${flip}: ${pt.y}`);

      // Applying the same flip twice at rot=0 returns the original point
      if (rot === 0) {
        const ptBack = transformPoint(pt.x, pt.y, baseW, baseH, 0, flip);
        assert.ok(Math.abs(ptBack.x - samplePt.x) < 1e-6);
        assert.ok(Math.abs(ptBack.y - samplePt.y) < 1e-6);
      }

      // All 4 normals remain bijective under every D4 transform
      const mappedNormals = new Set(normals.map((n) => transformNormal(n, rot, flip)));
      assert.equal(mappedNormals.size, 4, `Non-bijective normals for rot=${rot}, flip=${flip}`);
    }
  }

  // Verify reflection-safe arc winding reversal (FLIPPED=1 horizontal mirror reverses CCW arc)
  const arcPrim: SymPrimitive[] = [{ kind: 'arc', cx: 12, cy: 5, r: 4, startDeg: 0, endDeg: 90 }];
  const unflippedArc = transformSymPrimitivesMm(arcPrim, baseW, baseH, 0, 0)[0];
  const hMirroredArc = transformSymPrimitivesMm(arcPrim, baseW, baseH, 0, 1)[0];
  const bothMirroredArc = transformSymPrimitivesMm(arcPrim, baseW, baseH, 0, 3)[0];
  assert.equal(unflippedArc.kind, 'arc');
  assert.equal(hMirroredArc.kind, 'arc');
  assert.equal(bothMirroredArc.kind, 'arc');
  if (unflippedArc.kind === 'arc' && hMirroredArc.kind === 'arc' && bothMirroredArc.kind === 'arc') {
    // At flip=0: [0, 90] (90 deg sweep)
    assert.equal(unflippedArc.startDeg, 0);
    assert.equal(unflippedArc.endDeg, 90);
    // At flip=1 (odd reflection): 0->180, 90->90, reversed so CCW goes 90->180!
    assert.equal(hMirroredArc.startDeg, 90);
    assert.equal(hMirroredArc.endDeg, 180);
    // At flip=3 (even / 180 deg rotation): 0->180, 90->270, preserves CCW order 180->270!
    assert.equal(bothMirroredArc.startDeg, 180);
    assert.equal(bothMirroredArc.endDeg, 270);
  }
});

test('compileFluidSim45Valve emits authentic F9-safe CV_ID/VALUECLASS/POS/PILOT properties across WV_2, WV_3, WV_4, WV_5 with zero AL_PE1_PE2', () => {
  const valveCases: ComponentNode[] = [
    {
      id: 'V22_SOL',
      type: 'valve_2_2',
      label: '-2M1',
      params: { normalState: 'NC', nominalFlowLMin: 250 },
      leftActuation: { type: 'solenoid', label: '-2M1', manualOverride: true, internalPilot: true },
      rightActuation: { type: 'pneumatic_spring', springReturn: true },
    },
    {
      id: 'V32_NO',
      type: 'valve_3_2',
      label: '-3M1',
      params: { normalState: 'NO', normallyOpen: true, nominalFlowLMin: 300 },
      leftActuation: { type: 'solenoid', label: '-3M1', manualOverride: true, internalPilot: true },
      rightActuation: { type: 'spring' },
    },
    {
      id: 'V42_PB',
      type: 'valve_4_2',
      label: 'V42',
      params: { initialState: 'right', nominalFlowLMin: 400 },
      leftActuation: { type: 'pushbutton' },
      rightActuation: { type: 'spring' },
    },
    {
      id: 'V52_PILOT',
      type: 'valve_5_2',
      label: '1V1',
      params: { initialState: 'right', nominalFlowLMin: 500 },
      leftActuation: { type: 'pneumatic_pilot' },
      rightActuation: { type: 'pneumatic_pilot' },
    },
    {
      id: 'V53_CC',
      type: 'valve_5_3',
      label: '-1V1',
      params: { centerType: 'closed', nominalFlowLMin: 500 },
      leftActuation: { type: 'solenoid', label: '-1M1', manualOverride: true, internalPilot: true },
      rightActuation: { type: 'solenoid', label: '-1M2', manualOverride: true, internalPilot: true },
    },
  ];

  const expectedClasses = ['WV_2', 'WV_3', 'WV_4', 'WV_5', 'WV_5'];
  valveCases.forEach((v, idx) => {
    const spec = compileFluidSim45Valve(v);
    assert.equal(spec.cls, expectedClasses[idx]);
    const joined = spec.props.join('\n');
    for (const requiredKey of [
      'S CV_ID S ',
      'S VALUECLASS S ',
      'S POS S ',
      'S POS_RESET S ',
      'S SWITCHED_POS S ',
      'S SWITCHED_POS_R S ',
      'S DOMINANT F ',
      'S AFL F ',
      'S AFR F ',
      'S DIR S ',
      'S DIR2 S ',
      'S CONF_L I ',
      'S CONF_R I ',
      'S BODY_COUNT I ',
    ]) {
      assert.ok(joined.includes(requiredKey), `${v.id} missing mandatory F9 property ${requiredKey}`);
    }
    assert.ok(!joined.includes('AL_PE1_PE2'), `${v.id} must NEVER emit invalid AL_PE1_PE2`);
    assert.ok(!joined.includes('AR_PE1_PE2'), `${v.id} must NEVER emit invalid AR_PE1_PE2`);
  });

  // Internal pilot solenoid must emit AL_PE1 + PILOT_L B T
  const v22Props = compileFluidSim45Valve(valveCases[0]).props.join('\n');
  assert.ok(v22Props.includes('S ACTUATION_L_EL_PN S AL_PE1'));
  assert.ok(v22Props.includes('S PILOT_L B T'));
  assert.ok(v22Props.includes('S ACTUATION_L_MA S AL_MA1'));
  assert.ok(v22Props.includes('S PNEU_SPRING_R S TRUE'));

  // 5/3 closed center must emit BODY_COUNT I 3 and both PILOT_L/PILOT_R
  const v53Props = compileFluidSim45Valve(valveCases[4]).props.join('\n');
  assert.ok(v53Props.includes('S BODY_COUNT I 3'));
  assert.ok(v53Props.includes('S PILOT_L B T'));
  assert.ok(v53Props.includes('S PILOT_R B T'));

  // Negative checks: verifyCtValveSolverInvariants catches missing CV_ID, invalid AL_PE1_PE2, and 4-gate PTriconnection
  const badCtBody = [
    'WV_3 O0 10000 10000 50000 30000 0 0 1617923',
    ' S ACTUATION_L_EL_PN S AL_PE1_PE2',
    'PTriconnection O1 60000 10000 72288 22288 0 0 6553603',
    'PConnection O2 61024 11024 71264 21264 0 0 6553603',
    'PConnection O3 61024 11024 71264 21264 0 0 6553603',
    'PConnection O4 61024 11024 71264 21264 0 0 6553603',
    'PConnection O5 61024 11024 71264 21264 0 0 6553603',
    ' S state INT 4',
    'gate1 # 1 2',
    'gate2 # 1 3',
    'gate3 # 1 4',
    'gate4 # 1 5',
  ].join('\n');
  const badReport = verifyCtValveSolverInvariants(badCtBody);
  assert.equal(badReport.ok, false);
  assert.ok(badReport.valveErrors.length >= 2, 'Expected missing CV_ID & AL_PE1_PE2 errors');
  assert.ok(badReport.junctionErrors.length >= 1, 'Expected bogus 4th gate S state INT 4 error');
});

test('topologyNormalizer decomposes 4-endpoint named nets into strictly 3-gate T-junction trees and compiles inline portTerminators cleanly to native .ct', () => {
  const doc: CircuitDocument = {
    schemaVersion: '2.0',
    metadata: {
      title: 'v2 Net & Inline Terminator Test',
      fluidsimVersion: '4.5',
      format: 'fsim-ir-json',
      sheetSize: 'DIN_A4_LANDSCAPE',
      sheetDomain: 'pneumatic-only',
      allowExternalElectricalSheet: true,
      sheetWidthMm: 297,
      sheetHeightMm: 210,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    components: [
      { id: 'SRC', type: 'air_source', label: '0Z1', params: { pressureBar: 6 } },
      {
        id: 'V1',
        type: 'valve_3_2',
        label: '1V1',
        params: { normalState: 'NC' },
        leftActuation: { type: 'solenoid', label: 'Y1', internalPilot: true },
        rightActuation: { type: 'spring' },
        portTerminators: { '3': 'exhaust_silencer' },
      },
      { id: 'N1', type: 'nozzle', label: '1V2', params: { openingPct: 50 } },
      { id: 'N2', type: 'nozzle', label: '1V3', params: { openingPct: 50 } },
      { id: 'N3', type: 'nozzle', label: '1V4', params: { openingPct: 50 } },
      { id: 'EX_N1', type: 'exhaust_silencer', params: {} },
      { id: 'EX_N2', type: 'exhaust_silencer', params: {} },
      { id: 'EX_N3', type: 'exhaust_silencer', params: {} },
    ],
    connections: [],
    nets: [
      {
        id: 'NET_SUP',
        domain: 'pneumatic',
        endpoints: [
          { componentId: 'SRC', port: '1' },
          { componentId: 'V1', port: '1' },
        ],
      },
      {
        id: 'NET_NOZZLES',
        name: 'Air Cushion Manifold',
        domain: 'pneumatic',
        endpoints: [
          { componentId: 'V1', port: '2' },
          { componentId: 'N1', port: '1' },
          { componentId: 'N2', port: '1' },
          { componentId: 'N3', port: '1' },
        ],
      },
      { id: 'NET_EX1', domain: 'pneumatic', endpoints: [{ componentId: 'N1', port: '2' }, { componentId: 'EX_N1', port: '1' }] },
      { id: 'NET_EX2', domain: 'pneumatic', endpoints: [{ componentId: 'N2', port: '2' }, { componentId: 'EX_N2', port: '1' }] },
      { id: 'NET_EX3', domain: 'pneumatic', endpoints: [{ componentId: 'N3', port: '2' }, { componentId: 'EX_N3', port: '1' }] },
    ],
  };

  const view = normalizeCircuitTopology(doc);
  // 4-endpoint net NET_NOZZLES decomposes into 2 binary 3-gate junctions + 1 inline terminator -> 3 synthetic components
  const synthJunctions = view.document.components.filter(
    (c) => c.type === 'pneumatic_junction' && view.syntheticComponentIds.has(c.id),
  );
  assert.equal(synthJunctions.length, 2);
  assert.equal(view.inlineTerminators.get('V1:3'), 'exhaust_silencer');

  // Compile to native .ct, check F9 solver & visual invariants, and re-parse cleanly
  const ctBytes = serializeCircuitDocument(doc, { targetPath: 'v2_nets_test.ct' });
  const decoded = decodeCtContainer(ctBytes, 'v2_nets_test.ct');
  const vis = verifyCtVisualLayoutInvariants(decoded.ctBody, decoded.trailerText);
  assert.equal(vis.ok, true, `Visual/F9 invariants failed: ${JSON.stringify(vis)}`);
  assert.equal(vis.f9Solver.ok, true);
  assert.equal(vis.f9Solver.junctionErrors.length, 0);
  assert.equal(vis.f9Solver.valveErrors.length, 0);
  assert.ok(decoded.ctBody.includes('NozzleP '), 'Expected official FluidSIM 4.5 NozzleP class');
  assert.ok(decoded.ctBody.includes('ex_type S EX3'), 'Expected inline exhaust_silencer embedded as EX3');

  const reparsed = parseCircuitBuffer(ctBytes, 'v2_nets_test.ct');
  assert.equal(reparsed.document.components.filter((c) => c.type === 'nozzle').length, 3);
});
