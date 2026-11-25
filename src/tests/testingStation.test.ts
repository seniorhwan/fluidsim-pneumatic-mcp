import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceGuard } from '../safety/workspaceGuard';
import { handleCircuitBuild } from '../mcp/tools/authorTools';
import { handleCircuitRenderSvg } from '../mcp/tools/readTools';
import { parseCircuitBuffer } from '../codec/ctParser';
import { decodeCtContainer } from '../codec/ctBinaryCodec';
import { verifyCtVisualLayoutInvariants } from '../codec/ctTextCompiler';
import { simulateCircuit } from '../simulator/simulator';

test('Festo MPS Testing Station builds in 1-call circuit_build, passes F9/SVG/visual diagnostics, preserves mirror+rot, and simulates accurately', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'fsim-testing-station-'));
  const guard = new WorkspaceGuard({ workspaceRoot: workspace });
  const ctx = {
    guard,
    accessMode: 'authoring' as const,
    maxPayloadBytes: 131_072,
    repoRoot: process.cwd(),
    serverVersion: '2.0.0',
  };

  try {
    const built = handleCircuitBuild(ctx, {
      path: 'testing_station.ct',
      title: 'Festo MPS Testing Station — Pneumatic Plan',
      sheetSize: 'DIN_A3_LANDSCAPE',
      sheetDomain: 'pneumatic-only',
      allowExternalElectricalSheet: true,
      components: [
        // Supply backbone
        { id: 'SRC_0Z0', type: 'air_source', label: '-0Z0', paramsJson: '{"pressureBar":6,"maxFlowLMin":1000}', sectionLabel: 'Air Supply' },
        { id: 'FRL_0Z1', type: 'air_service_unit', label: '-0Z1', paramsJson: '{"nominalPressureBar":6}', group: 'supply' },
        { id: 'PEW_0B1', type: 'pressure_switch_pew', label: '-0B1', paramsJson: '{"pressureBar":4.5,"triggerMode":"above"}', group: 'supply' },

        // Branch 1: Lifting module (5/3 closed center + cross-piloted check valves + meter-out throttles + rodless cylinder)
        {
          id: 'V_1V1',
          type: 'valve_5_3',
          label: '-1V1',
          paramsJson: '{"centerType":"closed","nominalFlowLMin":500}',
          leftActuation: { type: 'solenoid', label: '-1M1', manualOverride: true, internalPilot: true },
          rightActuation: { type: 'solenoid', label: '-1M2', manualOverride: true, internalPilot: true },
          portTerminators: [
            { port: '3', terminator: 'exhaust_silencer' },
            { port: '5', terminator: 'exhaust_silencer' },
          ],
          group: 'lift',
          sectionLabel: '1: Lifting Module',
        },
        { id: 'CHK_1V4', type: 'check_valve_pilot_open', label: '-1V4', paramsJson: '{"crackingPressureBar":0.2}', group: 'lift' },
        { id: 'CHK_1V5', type: 'check_valve_pilot_open', label: '-1V5', paramsJson: '{"crackingPressureBar":0.2}', group: 'lift' },
        { id: 'FC_1V2', type: 'flow_control_one_way', label: '-1V2', paramsJson: '{"openingPct":60}', group: 'lift' },
        { id: 'FC_1V3', type: 'flow_control_one_way', label: '-1V3', paramsJson: '{"openingPct":60}', group: 'lift' },
        {
          id: 'CYL_1A1',
          type: 'cylinder_rodless',
          label: '-1A1',
          paramsJson: '{"strokeMm":200,"pistonDiameterMm":25}',
          distanceRule: [
            { label: '-1B1', positionMm: 0 },
            { label: '-1B2', positionMm: 200 },
          ],
          group: 'lift',
        },

        // Branch 2: Air cushion slide (3/2 NC valve + 3 parallel nozzles via named net)
        {
          id: 'V_2V1',
          type: 'valve_3_2',
          label: '-2V1',
          paramsJson: '{"normalState":"NC","nominalFlowLMin":300}',
          leftActuation: { type: 'solenoid', label: '-2M1', manualOverride: true, internalPilot: true },
          rightActuation: { type: 'spring' },
          portTerminators: [{ port: '3', terminator: 'exhaust_silencer' }],
          group: 'cushion',
          sectionLabel: '2: Air Cushion Slide',
        },
        { id: 'NOZ_2V2', type: 'nozzle', label: '-2V2', paramsJson: '{"openingPct":45}', portTerminators: [{ port: '2', terminator: 'exhaust_silencer' }], group: 'cushion' },
        { id: 'NOZ_2V3', type: 'nozzle', label: '-2V3', paramsJson: '{"openingPct":45}', portTerminators: [{ port: '2', terminator: 'exhaust_silencer' }], group: 'cushion' },
        { id: 'NOZ_2V4', type: 'nozzle', label: '-2V4', paramsJson: '{"openingPct":45}', portTerminators: [{ port: '2', terminator: 'exhaust_silencer' }], group: 'cushion' },

        // Branch 3: Ejector module (rotated 180 + mirrored 'both' / FLIPPED=3 5/2 valve + double-acting cylinder)
        {
          id: 'V_3V2',
          type: 'valve_5_2',
          label: '-3V2',
          rotationDeg: 180,
          mirror: 'both',
          paramsJson: '{"initialState":"right","nominalFlowLMin":450}',
          leftActuation: { type: 'solenoid', label: '-3M1', manualOverride: true, internalPilot: true },
          rightActuation: { type: 'spring' },
          portTerminators: [
            { port: '3', terminator: 'exhaust_silencer' },
            { port: '5', terminator: 'exhaust_silencer' },
          ],
          group: 'eject',
          sectionLabel: '3: Ejector Cylinder',
        },
        {
          id: 'CYL_3A1',
          type: 'cylinder_double_acting',
          label: '-3A1',
          paramsJson: '{"strokeMm":100,"pistonDiameterMm":20}',
          distanceRule: [
            { label: '-3B1', positionMm: 0 },
            { label: '-3B2', positionMm: 100 },
          ],
          group: 'eject',
        },
      ],
      nets: [
        // Supply backbone net (5 endpoints -> auto-decomposed into 3-gate T-junction chain!)
        {
          id: 'NET_RAW',
          domain: 'pneumatic',
          endpoints: [
            { componentId: 'SRC_0Z0', port: '1' },
            { componentId: 'FRL_0Z1', port: '1' },
          ],
        },
        {
          id: 'NET_SUPPLY_MAIN',
          name: '6 bar Supply Bus',
          domain: 'pneumatic',
          endpoints: [
            { componentId: 'FRL_0Z1', port: '2' },
            { componentId: 'PEW_0B1', port: 'P1' },
            { componentId: 'V_1V1', port: '1' },
            { componentId: 'V_2V1', port: '1' },
            { componentId: 'V_3V2', port: '1' },
          ],
        },
        // Branch 1 cross-piloted lifting cylinder lines
        {
          id: 'NET_LIFT_A_VALVE',
          domain: 'pneumatic',
          endpoints: [
            { componentId: 'V_1V1', port: '4' },
            { componentId: 'CHK_1V4', port: '1' },
            { componentId: 'CHK_1V5', port: '12' },
          ],
        },
        {
          id: 'NET_LIFT_B_VALVE',
          domain: 'pneumatic',
          endpoints: [
            { componentId: 'V_1V1', port: '2' },
            { componentId: 'CHK_1V5', port: '1' },
            { componentId: 'CHK_1V4', port: '12' },
          ],
        },
        {
          id: 'NET_LIFT_A_MID',
          domain: 'pneumatic',
          endpoints: [
            { componentId: 'CHK_1V4', port: '2' },
            { componentId: 'FC_1V2', port: '1' },
          ],
        },
        {
          id: 'NET_LIFT_A_CYL',
          domain: 'pneumatic',
          endpoints: [
            { componentId: 'FC_1V2', port: '2' },
            { componentId: 'CYL_1A1', port: 'A' },
          ],
        },
        {
          id: 'NET_LIFT_B_MID',
          domain: 'pneumatic',
          endpoints: [
            { componentId: 'CHK_1V5', port: '2' },
            { componentId: 'FC_1V3', port: '1' },
          ],
        },
        {
          id: 'NET_LIFT_B_CYL',
          domain: 'pneumatic',
          endpoints: [
            { componentId: 'FC_1V3', port: '2' },
            { componentId: 'CYL_1A1', port: 'B' },
          ],
        },
        // Branch 2 air cushion 3-nozzle manifold net
        {
          id: 'NET_CUSHION',
          name: 'Air Cushion',
          domain: 'pneumatic',
          endpoints: [
            { componentId: 'V_2V1', port: '2' },
            { componentId: 'NOZ_2V2', port: '1' },
            { componentId: 'NOZ_2V3', port: '1' },
            { componentId: 'NOZ_2V4', port: '1' },
          ],
        },
        // Branch 3 ejector cylinder lines
        {
          id: 'NET_EJECT_A',
          domain: 'pneumatic',
          endpoints: [
            { componentId: 'V_3V2', port: '4' },
            { componentId: 'CYL_3A1', port: 'A' },
          ],
        },
        {
          id: 'NET_EJECT_B',
          domain: 'pneumatic',
          endpoints: [
            { componentId: 'V_3V2', port: '2' },
            { componentId: 'CYL_3A1', port: 'B' },
          ],
        },
      ],
    });

    assert.equal(built.postconditionPassed, true, `Postcondition failed: ${JSON.stringify(built)}`);
    assert.equal(built.validation.valid, true, `Validation findings: ${JSON.stringify(built.validation)}`);
    assert.equal(built.validation.errorCount, 0);
    assert.equal(built.validation.warningCount, 0);

    // Inspect compiled native .ct binary & AST invariants
    const ctPath = path.join(workspace, 'testing_station.ct');
    const ctBytes = fs.readFileSync(ctPath);
    const decoded = decodeCtContainer(ctBytes, 'testing_station.ct');

    for (const expectedCls of [
      'Wartungseinheit2 ',
      'PEW ',
      'WV_5 ',
      'WV_3 ',
      'CheckValvePilotOperatedSpringLoadedP ',
      'DRSV2_pneu ',
      'CylDGPPAB ',
      'NozzleP ',
    ]) {
      assert.ok(decoded.ctBody.includes(expectedCls), `Expected authentic FluidSIM 4.5 class "${expectedCls.trim()}"`);
    }
    assert.ok(decoded.ctBody.includes('S SLEDGE B T'), 'Expected CylDGPPAB rodless cylinder SLEDGE B T');
    assert.ok(!decoded.ctBody.includes('AL_PE1_PE2'), 'Must never emit invalid AL_PE1_PE2');
    assert.ok(!decoded.ctBody.includes('AR_PE1_PE2'), 'Must never emit invalid AR_PE1_PE2');
    assert.ok(
      /WV_5 O\d+ -?\d+ -?\d+ -?\d+ -?\d+ 180 -30720 /.test(decoded.ctBody),
      'Expected rot=180 and authentic FluidSIM 4.5 WV_5 flipOffset=-30720 on mirrored valve -3V2',
    );
    assert.ok(decoded.ctBody.includes(' S FLIPPED I 3'), 'Expected S FLIPPED I 3 on mirrored valve -3V2');

    const ctVis = verifyCtVisualLayoutInvariants(decoded.ctBody, decoded.trailerText);
    assert.equal(ctVis.ok, true, `Visual/F9 invariants failed: ${JSON.stringify(ctVis)}`);
    assert.equal(ctVis.f9Solver.ok, true);
    assert.equal(ctVis.f9Solver.valveErrors.length, 0);
    assert.equal(ctVis.f9Solver.junctionErrors.length, 0);

    // Render headless SVG + verify layout diagnostics
    const svgOut = handleCircuitRenderSvg(ctx, {
      path: 'testing_station.ct',
      includeSvg: true,
    });
    assert.ok(typeof svgOut.svg === 'string' && svgOut.svg.includes('<svg'));
    assert.equal(svgOut.diagnostics.componentOverlaps, 0, JSON.stringify(svgOut.diagnostics));
    assert.equal(svgOut.diagnostics.wireThroughComponent, 0, JSON.stringify(svgOut.diagnostics));
    assert.equal(svgOut.diagnostics.labelOverlaps, 0, JSON.stringify(svgOut.diagnostics));
    assert.equal(svgOut.diagnostics.outOfBoundsCount, 0, JSON.stringify(svgOut.diagnostics));
    assert.equal(svgOut.diagnostics.f9SolverOk, true);
    assert.ok(svgOut.diagnostics.qualityScore >= 85, `Expected qualityScore >= 85, got ${svgOut.diagnostics.qualityScore}`);

    // Re-parse native .ct and verify mirror/rotation roundtrip + behavioral simulation
    const { document: reparsed } = parseCircuitBuffer(ctBytes, 'testing_station.ct');
    const v3v2 = reparsed.components.find((c) => c.id === 'V_3V2');
    assert.equal(v3v2?.rotationDeg, 180);
    assert.equal(v3v2?.mirror, 'both');
    assert.equal(v3v2?.flipped, 3);

    // Simulate lifting up (-1M1), center-hold (release -1M1), air cushion (-2M1), ejector (-3M1), and lowering (-1M2)
    // Note: -1A1 has 200mm stroke throttled at 50% openingPct (~140 mm/s), so full stroke takes ~1.45s.
    const sim = simulateCircuit(reparsed, {
      durationMs: 5600,
      stepMs: 10,
      inputs: [
        { label: '-1M1', action: 'press', atMs: 100, durationMs: 1800 },
        { label: '-2M1', action: 'press', atMs: 2000, durationMs: 500 },
        { label: '-3M1', action: 'press', atMs: 2100, durationMs: 900 },
        { label: '-1M2', action: 'press', atMs: 3300, durationMs: 1800 },
      ],
    });
    const liftEvents = sim.events.filter((e) => e.componentId === 'CYL_1A1');
    const ejectEvents = sim.events.filter((e) => e.componentId === 'CYL_3A1');
    assert.ok(
      liftEvents.some((e) => e.kind === 'cylinder_extended'),
      `Expected lifting rodless cylinder -1A1 to extend via pilot-unlocked check valve: ${JSON.stringify(sim.observedSequence)}`,
    );
    assert.ok(
      liftEvents.some((e) => e.kind === 'cylinder_retracted'),
      `Expected lifting rodless cylinder -1A1 to retract on -1M2: ${JSON.stringify(sim.observedSequence)}`,
    );
    assert.ok(
      ejectEvents.some((e) => e.kind === 'cylinder_extended') &&
        ejectEvents.some((e) => e.kind === 'cylinder_retracted'),
      `Expected ejector cylinder -3A1 to extend and retract: ${JSON.stringify(sim.observedSequence)}`,
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
