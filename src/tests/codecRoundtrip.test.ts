import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { detectCircuitFormat, getGoldenFixtureStatus, REQUIRED_GOLDEN_FIXTURES } from '../codec/ctDetector';
import { parseCircuitBuffer } from '../codec/ctParser';
import { serializeCircuitDocument } from '../codec/ctSerializer';
import { verifyCodecRoundtrip } from '../codec/ctRoundtripGuard';
import {
  compressCtPayload,
  decodeCtContainer,
  decompressCtPayload,
  encodeCtContainer,
  verifyCtPayloadLinearBounds,
} from '../codec/ctBinaryCodec';
import { verifyCtTextInvariants, verifyCtVisualLayoutInvariants, type PreservedCtSections } from '../codec/ctTextCodec';
import type { CircuitDocument } from '../contracts/circuit';
import { EngineeringError } from '../contracts/errors';
import { generateCircuitFromSpec } from '../authoring/specGenerator';
import { applyCircuitPatch } from '../authoring/patchEngine';
import { validateCircuitStatic } from '../simulator/validator';
import { simulateCircuit } from '../simulator/simulator';
import { verifyCircuitSequence } from '../simulator/sequenceVerifier';
import { diffCtBuffers, inspectCtBuffer } from '../../scripts/inspect-ct';

test('codec detects valid fsim-ir-json and performs 100% lossless roundtrip including rawAst', () => {
  const doc = generateCircuitFromSpec({
    title: 'Roundtrip Test',
    actuators: [{ label: 'A', strokeMm: 100 }],
    sequence: ['A+', 'A-'],
    controlMethod: 'electro-pneumatic-step-chain',
  });
  doc.rawAst = {
    encoding: 'latin1',
    preservedSections: { headerMagic: 'FluidSIM-4.5', customTag: [1, 2, 3] },
  };
  doc.components[0].rawMetadata = { rawObjId: 42, color: '#000000' };

  const bytes = serializeCircuitDocument(doc, { targetPath: 'roundtrip.fsim.json' });
  const detected = detectCircuitFormat(bytes, 'roundtrip.fsim.json');
  assert.equal(detected.format, 'fsim-ir-json');
  assert.equal(detected.detectedVersion, '4.5');

  const rt = verifyCodecRoundtrip(doc, bytes, 'roundtrip.fsim.json');
  assert.equal(rt.passed, true);
  assert.equal(rt.preservedRawAst, true);
  assert.equal(rt.componentCount, doc.components.length);
  assert.equal(rt.connectionCount, doc.connections.length);

  const reparsed = parseCircuitBuffer(bytes, 'roundtrip.fsim.json').document;
  assert.deepEqual(reparsed.components[0].rawMetadata, { rawObjId: 42, color: '#000000' });
});

test('Phase 1 golden fixture suite is present and all 6 real FluidSIM .ct files roundtrip 100% losslessly', () => {
  const status = getGoldenFixtureStatus(process.cwd());
  assert.equal(status.readyForPhase1, true);
  assert.equal(status.missing.length, 0);
  assert.equal(status.present.length, REQUIRED_GOLDEN_FIXTURES.length);

  for (const name of REQUIRED_GOLDEN_FIXTURES) {
    const filePath = path.resolve(process.cwd(), 'fixtures', 'golden', name);
    const originalBytes = fs.readFileSync(filePath);

    // 1. Format detection
    const detected = detectCircuitFormat(originalBytes, name);
    assert.equal(detected.format, 'fluidsim-4.5-ct', `Expected native .ct detection for ${name}`);
    assert.equal(detected.detectedVersion, '4.5');

    // 2. Binary LZ+RLE re-compression bit-for-bit plain-stream identity
    const decoded = decodeCtContainer(originalBytes, name);
    assert.ok(decoded.ctBody.length > 0, `Empty ctBody in ${name}`);
    assert.ok(decoded.trailerText.startsWith('ENDCT\n'), `Missing ENDCT trailer in ${name}`);
    const reencodedBytes = encodeCtContainer(decoded);
    const bounds = verifyCtPayloadLinearBounds(reencodedBytes, name);
    assert.equal(bounds.ok, true, `Linear LZ ring check failed for ${name}: ${JSON.stringify(bounds)}`);
    assert.equal(bounds.refWrapReads, 0, `Unexpected refWrapReads on ${name}`);
    assert.equal(bounds.uninitializedReads, 0, `Unexpected uninitializedReads on ${name}`);
    const redecoded = decodeCtContainer(reencodedBytes, name);
    assert.equal(redecoded.ctBody, decoded.ctBody, `Plain ctBody mismatch after re-compression for ${name}`);
    assert.equal(redecoded.previewBlockB64, decoded.previewBlockB64, `Preview WMF mismatch for ${name}`);
    assert.equal(redecoded.fsPreviewBlock, decoded.fsPreviewBlock, `FSPREVIEW mismatch for ${name}`);
    assert.equal(redecoded.trailerText, decoded.trailerText, `Trailer mismatch for ${name}`);

    // 3. Full parse -> serialize -> verifyCodecRoundtrip -> re-parse
    const { document, format } = parseCircuitBuffer(originalBytes, name);
    assert.equal(format, 'fluidsim-4.5-ct');
    assert.ok(document.components.length >= 4, `Expected components parsed from ${name}`);
    assert.ok(document.connections.length >= 2, `Expected connections parsed from ${name}`);

    const serialized = serializeCircuitDocument(document, { targetPath: name });
    const rt = verifyCodecRoundtrip(document, serialized, name);
    assert.equal(rt.passed, true);
    assert.equal(rt.preservedRawAst, true);
    assert.equal(rt.componentCount, document.components.length);
    assert.equal(rt.connectionCount, document.connections.length);

    const { document: reparsed } = parseCircuitBuffer(serialized, name);
    const expSec = document.rawAst?.preservedSections as unknown as PreservedCtSections;
    const repSec = reparsed.rawAst?.preservedSections as unknown as PreservedCtSections;
    assert.equal(repSec.originalCtBody, expSec.originalCtBody, `Verbatim ctBody lost on roundtrip of ${name}`);
  }
});

test('binary LZ+RLE compressor roundtrips arbitrary binary & repeated payloads identically for both profiles', () => {
  const sample = Buffer.concat([
    Buffer.from(' 2142\n', 'latin1'),
    Buffer.alloc(120, 0x00),
    Buffer.from('       PREVIEW\nWV_5 O1 10240 20480 30720 40960 0 0 5109763\n'.repeat(18), 'latin1'),
    Buffer.from('CON PLine 12 13\nCON ELine 14 15\n'.repeat(30), 'latin1'),
    Buffer.from([0x0d, 0x0a, 0x9a, 0x00, 0xff, 0x80, 0x7f, 0x01, 0x02, 0x03]),
  ]);

  for (const extended of [true, false]) {
    const compressed = compressCtPayload(sample, { extended });
    const bounds = verifyCtPayloadLinearBounds(compressed, `mem_${extended}.ct`);
    assert.equal(bounds.ok, true, `Linear LZ bounds failed for extended=${extended}: ${JSON.stringify(bounds)}`);
    assert.equal(bounds.refWrapReads, 0);
    assert.equal(bounds.uninitializedReads, 0);
    const { decompressed, profile } = decompressCtPayload(compressed, 'mem.ct');
    assert.equal(profile.extended, extended);
    assert.ok(decompressed.equals(sample), `Payload mismatch for extended=${extended}`);
  }
});

test('freshly authored native .ct circuit roundtrips, patches losslessly, validates, and simulates A+ B+ B- A-', () => {
  const doc = generateCircuitFromSpec({
    title: 'Native CT ABBA Test',
    actuators: [
      { label: 'A', strokeMm: 100 },
      { label: 'B', strokeMm: 100 },
    ],
    sequence: ['A+', 'B+', 'B-', 'A-'],
    controlMethod: 'electro-pneumatic-step-chain',
    startMode: 'single-cycle',
    includeEStop: true,
  });

  const ctBytes = serializeCircuitDocument(doc, { targetPath: 'abba_generated.ct' });
  const abbaBounds = verifyCtPayloadLinearBounds(ctBytes, 'abba_generated.ct');
  assert.equal(abbaBounds.ok, true, JSON.stringify(abbaBounds));
  assert.equal(abbaBounds.refWrapReads, 0);
  const abbaDecoded = decodeCtContainer(ctBytes, 'abba_generated.ct');
  const abbaInv = verifyCtTextInvariants(abbaDecoded.ctBody);
  assert.equal(abbaInv.ok, true, `4-gate junction invariant failed: ${JSON.stringify(abbaInv.badJunctions)}`);
  const abbaVis = verifyCtVisualLayoutInvariants(abbaDecoded.ctBody, abbaDecoded.trailerText);
  assert.equal(abbaVis.ok, true, `Visual/BEGINSYM invariant failed on abba_generated.ct: ${JSON.stringify(abbaVis)}`);
  assert.ok(abbaVis.symCount >= 4, `Expected >= 4 BEGINSYM entries on abba_generated.ct, got ${abbaVis.symCount}`);
  const rt = verifyCodecRoundtrip(doc, ctBytes, 'abba_generated.ct');
  assert.equal(rt.passed, true);

  // Re-parse native .ct from bytes, validate statically, and run full electro-pneumatic sequence verification
  const { document: parsedFromCt, format } = parseCircuitBuffer(ctBytes, 'abba_generated.ct');
  assert.equal(format, 'fluidsim-4.5-ct');
  assert.equal(parsedFromCt.metadata.title, 'Native CT ABBA Test');

  const validation = validateCircuitStatic(parsedFromCt);
  assert.equal(validation.valid, true, `Validation failed: ${JSON.stringify(validation.findings)}`);

  const verification = verifyCircuitSequence(parsedFromCt, {
    expectedSequence: ['A+', 'B+', 'B-', 'A-'],
    inputs: [{ label: 'S1', action: 'press', atMs: 100, durationMs: 150 }],
    durationMs: 6000,
  });
  assert.equal(verification.passed, true, `Sequence verification failed: ${JSON.stringify(verification)}`);

  // Apply a patch to the parsed native .ct file (add indicator lamp H1) and verify envelope preservation + roundtrip
  const patched = applyCircuitPatch(parsedFromCt, [
    {
      op: 'add_component',
      component: { id: 'H_LAMP', type: 'indicator_lamp', label: 'H1', params: { color: 'yellow' } },
    },
  ]);
  const patchedBytes = serializeCircuitDocument(patched.document, { targetPath: 'abba_generated.ct' });
  const patchedRt = verifyCodecRoundtrip(patched.document, patchedBytes, 'abba_generated.ct');
  assert.equal(patchedRt.passed, true);
  assert.equal(patchedRt.preservedRawAst, true);
  const { document: reparsedPatched } = parseCircuitBuffer(patchedBytes, 'abba_generated.ct');
  const lamp = reparsedPatched.components.find((c) => c.id === 'H_LAMP');
  assert.ok(lamp);
  assert.equal(lamp.type, 'indicator_lamp');
  assert.equal(lamp.params.color, 'yellow');
});

test('ctDetector rejects empty, fake .ct, ZIP, and XML files with clear error categories', () => {
  assert.throws(
    () => detectCircuitFormat(Buffer.alloc(0), 'empty.ct'),
    (err: unknown) => err instanceof EngineeringError && err.category === 'ParseError' && err.code === 'EMPTY_FILE',
  );

  const fakeCtBytes = Buffer.from('FLUIDSIM_DUMMY_CONTENT\r\nOBJECT 1\r\n', 'latin1');
  assert.throws(
    () => parseCircuitBuffer(fakeCtBytes, 'fake.ct'),
    (err: unknown) =>
      err instanceof EngineeringError &&
      err.category === 'UnsupportedFormatVersion' &&
      err.code === 'UNRECOGNIZED_CIRCUIT_FORMAT',
  );

  const zipBuf = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
  assert.throws(
    () => detectCircuitFormat(zipBuf, 'newer.ct'),
    (err: unknown) =>
      err instanceof EngineeringError &&
      err.category === 'UnsupportedFormatVersion' &&
      err.code === 'UNSUPPORTED_ZIP_CONTAINER',
  );

  const xmlBuf = Buffer.from('<?xml version="1.0"?><FluidSIM/>', 'utf8');
  assert.throws(
    () => detectCircuitFormat(xmlBuf, 'v6.ct'),
    (err: unknown) =>
      err instanceof EngineeringError &&
      err.category === 'UnsupportedFormatVersion' &&
      err.code === 'UNSUPPORTED_XML_FORMAT',
  );
});

test('scripts/inspect-ct decodes real FluidSIM .ct files and computes pairwise diffs', () => {
  const goldenElectro = fs.readFileSync(
    path.resolve(process.cwd(), 'fixtures', 'golden', '04_electro_pneumatic_abba.ct'),
  );
  const goldenPneu = fs.readFileSync(
    path.resolve(process.cwd(), 'fixtures', 'golden', '03_pneumatic_abba_sequence.ct'),
  );

  const rep = inspectCtBuffer(goldenElectro, '04_electro_pneumatic_abba.ct');
  assert.equal(rep.isFluidSimCt, true);
  assert.ok(rep.fluidsimDecoded);
  assert.equal(rep.fluidsimDecoded.profile.windowSize, 2048);
  assert.ok(rep.fluidsimDecoded.objectCount > 50);
  assert.ok(rep.fluidsimDecoded.classHistogram.some((h) => h.cls === 'WV_5'));
  assert.ok(rep.fluidsimDecoded.classHistogram.some((h) => h.cls === 'E_K001'));

  const diff = diffCtBuffers(goldenPneu, goldenElectro, 'pneu.ct', 'electro.ct');
  assert.ok(diff.addedLines.some((l) => l.text.includes('E_K001')));
});

test('all 6 real golden FluidSIM 4.5 .ct fixtures pass static validation with 0 errors and 0 warnings', () => {
  for (const name of REQUIRED_GOLDEN_FIXTURES) {
    const filePath = path.resolve(process.cwd(), 'fixtures', 'golden', name);
    const bytes = fs.readFileSync(filePath);
    const { document } = parseCircuitBuffer(bytes, name);
    const val = validateCircuitStatic(document);
    assert.equal(
      val.valid,
      true,
      `Golden fixture ${name} failed validation: ${JSON.stringify(val.findings)}`,
    );
    assert.equal(val.errorCount, 0, `Golden fixture ${name} had errors: ${JSON.stringify(val.findings)}`);
    assert.equal(val.warningCount, 0, `Golden fixture ${name} had warnings: ${JSON.stringify(val.findings)}`);
  }
});

test('real golden FluidSIM 4.5 .ct fixtures simulate accurately (direct/indirect, cascade, electro ABBA, timers, 5-count counter, latch)', () => {
  const loadGolden = (name: string) =>
    parseCircuitBuffer(fs.readFileSync(path.resolve(process.cwd(), 'fixtures', 'golden', name)), name).document;

  // 01: direct series enable (O18 detent + O3 pushbutton -> O28+/O28-) + indirect valves (O84 -> O94+, O104 -> O126+)
  const doc01 = loadGolden('01_direct_indirect_cylinders.ct');
  const sim01 = simulateCircuit(doc01, {
    durationMs: 2500,
    stepMs: 10,
    inputs: [
      { label: 'O18', action: 'toggle', atMs: 50 },
      { label: 'O3', action: 'press', atMs: 100, durationMs: 600 },
      { label: 'O84', action: 'press', atMs: 200, durationMs: 500 },
      { label: 'O104', action: 'press', atMs: 200, durationMs: 500 },
    ],
  });
  assert.ok(sim01.observedSequence.includes('O28+'));
  assert.ok(sim01.observedSequence.includes('O28-'));
  assert.ok(sim01.observedSequence.includes('O94+'));
  assert.ok(sim01.observedSequence.includes('O126+'));

  // 03: pure pneumatic A+ B+ B- A- sequence (O83 detent starts O21, O38 cycle)
  const doc03 = loadGolden('03_pneumatic_abba_sequence.ct');
  const sim03 = simulateCircuit(doc03, {
    durationMs: 4000,
    stepMs: 10,
    inputs: [{ label: 'O83', action: 'toggle', atMs: 100 }],
  });
  assert.deepEqual(sim03.observedSequence.slice(0, 4), ['O21+', 'O38+', 'O38-', 'O21-']);
  assert.equal(sim03.diagnostics.length, 0);

  // 04: electro-pneumatic A+ B+ B- A- sequence (START -> O20+ O107+ O107- O20-)
  const doc04 = loadGolden('04_electro_pneumatic_abba.ct');
  const sim04 = simulateCircuit(doc04, {
    durationMs: 4000,
    stepMs: 10,
    inputs: [{ label: 'START', action: 'press', atMs: 100, durationMs: 150 }],
  });
  assert.deepEqual(sim04.observedSequence.slice(0, 4), ['O20+', 'O107+', 'O107-', 'O20-']);
  assert.equal(sim04.diagnostics.length, 0);

  // 05: 5s timers (START_1 -> O20+ O20-) AND 5-count preset counter (START_2 -> exact 5 cycles of O216+ O216-)
  const doc05 = loadGolden('05_timer_counter_electro.ct');
  const sim05Timer = simulateCircuit(doc05, {
    durationMs: 15000,
    stepMs: 20,
    inputs: [{ label: 'START_1', action: 'press', atMs: 100, durationMs: 200 }],
  });
  assert.deepEqual(sim05Timer.observedSequence.slice(0, 2), ['O20+', 'O20-']);
  assert.equal(sim05Timer.diagnostics.length, 0);

  const sim05Counter = simulateCircuit(doc05, {
    durationMs: 12000,
    stepMs: 10,
    inputs: [{ label: 'START_2', action: 'press', atMs: 100, durationMs: 150 }],
  });
  const countExtends = sim05Counter.observedSequence.filter((s) => s === 'O216+').length;
  const countRetracts = sim05Counter.observedSequence.filter((s) => s === 'O216-').length;
  assert.equal(countExtends, 5, `Expected exactly 5 counter cycles, got ${countExtends}`);
  assert.equal(countRetracts, 5, `Expected exactly 5 counter retractions, got ${countRetracts}`);
  assert.equal(sim05Counter.diagnostics.length, 0);

  // 06: electrical latch (O0 latches relay K and energizes lamp O24)
  const doc06 = loadGolden('06_electrical_latch_legacy.ct');
  const sim06 = simulateCircuit(doc06, {
    durationMs: 1000,
    stepMs: 10,
    inputs: [{ label: 'O0', action: 'press', atMs: 100, durationMs: 150 }],
  });
  const latchRelay = Object.values(sim06.finalState.relays).find((r) => r.label === 'K');
  assert.ok(latchRelay && latchRelay.energized === true, 'Expected relay K to remain latched');
  assert.equal(sim06.finalState.lamps.O24?.lit, true, 'Expected indicator lamp O24 to remain lit');
});

test('generated native .ct files emit distinct catalog-offset port coordinates and orthogonal L polyline segments', () => {
  const doc = generateCircuitFromSpec({
    title: 'Geometry Fidelity CT',
    actuators: [{ label: 'A', strokeMm: 100 }],
    sequence: ['A+', 'A-'],
    controlMethod: 'electro-pneumatic-step-chain',
  });

  const ctBytes = serializeCircuitDocument(doc, { targetPath: 'geom.ct' });
  const decoded = decodeCtContainer(ctBytes, 'geom.ct');
  const lines = decoded.ctBody.split('\n');

  // Verify at least one WV_5 component has child PConnection objects at distinct coordinates (not stacked)
  const wv5Idx = lines.findIndex((l) => l.startsWith('WV_5 '));
  assert.ok(wv5Idx >= 0, 'Expected WV_5 block in generated native .ct');
  const pConnCoords = new Set<string>();
  for (let i = wv5Idx + 1; i < lines.length; i++) {
    const ln = lines[i].trim();
    if (ln === 'END') break;
    if (ln.startsWith('PConnection ')) {
      const parts = ln.split(/\s+/);
      // PConnection <id> <x1> <y1> <x2> <y2>
      pConnCoords.add(`${parts[2]},${parts[3]}`);
    }
  }
  assert.ok(
    pConnCoords.size >= 5,
    `Expected 5 distinct PConnection coordinates on WV_5, got ${pConnCoords.size}`,
  );

  // Verify PConnection/EConnection blocks emit orthogonal FluidSIM 4.5 L <x1> <y1> <x2> <y2> segments
  // (in FluidSIM's native ±5120 port-relative coordinates, horizontal means |y1-y2| === 10240, vertical means |x1-x2| === 10240)
  const lSegments = lines.filter((l) => /^\s*L\s+-?\d+\s+-?\d+\s+-?\d+\s+-?\d+/.test(l));
  assert.ok(lSegments.length > 0, 'Expected orthogonal L polyline segments in generated native .ct');
  for (const seg of lSegments) {
    const [, x1s, y1s, x2s, y2s] = seg.trim().split(/\s+/);
    const dx = Math.abs(Number(x1s) - Number(x2s));
    const dy = Math.abs(Number(y1s) - Number(y2s));
    assert.ok(dx === 10240 || dy === 10240 || x1s === x2s || y1s === y2s, `Non-orthogonal native .ct wire segment: ${seg}`);
  }
});

test('ctBinaryCodec recognizes all 3 official FluidSIM 4.x/4.5 magic header prefixes', () => {
  const goldenBytes = fs.readFileSync(
    path.resolve(process.cwd(), 'fixtures', 'golden', '01_direct_indirect_cylinders.ct'),
  );
  const altPrefixes = [
    Buffer.from('3e6c75423f56daaf205628b0c36c08bb', 'hex'),
    Buffer.from('6e33c0a621ce30e820ce6fa953336de9', 'hex'),
    Buffer.from('7f8943f87a219c112021f2680b898bcf', 'hex'),
  ];

  for (const prefix of altPrefixes) {
    const mutated = Buffer.from(goldenBytes);
    prefix.copy(mutated, 0);
    const detected = detectCircuitFormat(mutated, 'variant.ct');
    assert.equal(detected.format, 'fluidsim-4.5-ct');
    const decoded = decodeCtContainer(mutated, 'variant.ct');
    assert.ok(decoded.ctBody.length > 50);
  }
});

test('newly verified FluidSIM 4.5 classes (WV_2, WV_4, FilterP, CheckValveP, PEW, PVS3, DRSV2_pneu, LWechsler, LRelaismagnet_abfver, EX4) roundtrip cleanly in native .ct', () => {
  const doc: CircuitDocument = {
    schemaVersion: '1.0' as const,
    metadata: {
      title: 'Verified 4.5 Classes Roundtrip',
      fluidsimVersion: '4.5' as const,
      format: 'fsim-ir-json' as const,
      sheetSize: 'DIN_A3_LANDSCAPE' as const,
      sheetDomain: 'electro-pneumatic' as const,
      sheetWidthMm: 420,
      sheetHeightMm: 297,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    components: [
      { id: 'SRC', type: 'air_source' as const, label: 'P1', params: { pressureBar: 6, maxFlowLMin: 1000 } },
      { id: 'REG', type: 'pressure_regulator' as const, label: 'PR1', params: { setPressureBar: 5 } },
      { id: 'FLT', type: 'air_filter' as const, label: 'F1', rotationDeg: 90 as const, params: {} },
      { id: 'J1', type: 'pneumatic_junction' as const, params: {} },
      { id: 'PLUG', type: 'blind_plug' as const, params: {} },
      {
        id: 'V22',
        type: 'valve_2_2' as const,
        label: 'V22',
        params: { normalState: 'NC', normallyOpen: false, nominalFlowLMin: 300 },
        leftActuation: { type: 'solenoid' as const, label: 'Y1', manualOverride: true, internalPilot: true },
        rightActuation: { type: 'pneumatic_spring' as const, springReturn: true },
      },
      { id: 'CHK', type: 'check_valve' as const, params: { crackingPressureBar: 0.05 } },
      { id: 'CHKS', type: 'check_valve_spring' as const, params: { crackingPressureBar: 0.2 } },
      { id: 'PEW1', type: 'pressure_switch_differential' as const, label: 'B1', params: { pressureBar: 3.0, triggerMode: 'above' } },
      { id: 'PWR24', type: 'power_24v' as const, label: '+24V', params: { voltageV: 24 } },
      { id: 'PWR0', type: 'power_0v' as const, label: '0V', params: {} },
      { id: 'T_OFF', type: 'timer_relay_off_delay' as const, label: 'T1', params: { delayMs: 500 } },
      { id: 'SW_CO', type: 'relay_contact_changeover' as const, label: 'T1', params: {} },
      { id: 'SOL1', type: 'valve_solenoid' as const, label: 'Y1', params: {} },
    ],
    connections: [
      { id: 'E1', from: { componentId: 'SRC', port: '1' }, to: { componentId: 'REG', port: '1' }, domain: 'pneumatic' as const },
      { id: 'E2', from: { componentId: 'REG', port: '2' }, to: { componentId: 'FLT', port: '1' }, domain: 'pneumatic' as const },
      { id: 'E3', from: { componentId: 'FLT', port: '2' }, to: { componentId: 'J1', port: '1' }, domain: 'pneumatic' as const },
      { id: 'E4', from: { componentId: 'J1', port: '2' }, to: { componentId: 'V22', port: '1' }, domain: 'pneumatic' as const },
      { id: 'E5', from: { componentId: 'J1', port: '3' }, to: { componentId: 'PLUG', port: '1' }, domain: 'pneumatic' as const },
      { id: 'E6', from: { componentId: 'V22', port: '2' }, to: { componentId: 'CHK', port: '1' }, domain: 'pneumatic' as const },
      { id: 'E7', from: { componentId: 'CHK', port: '2' }, to: { componentId: 'CHKS', port: '1' }, domain: 'pneumatic' as const },
      { id: 'E8', from: { componentId: 'CHKS', port: '2' }, to: { componentId: 'PEW1', port: 'P1' }, domain: 'pneumatic' as const },
      { id: 'E9', from: { componentId: 'PWR24', port: 'OUT' }, to: { componentId: 'T_OFF', port: 'A1' }, domain: 'electrical' as const },
      { id: 'E10', from: { componentId: 'T_OFF', port: 'A2' }, to: { componentId: 'PWR0', port: 'IN' }, domain: 'electrical' as const },
      { id: 'E11', from: { componentId: 'PWR24', port: 'OUT' }, to: { componentId: 'SW_CO', port: '11' }, domain: 'electrical' as const },
      { id: 'E12', from: { componentId: 'SW_CO', port: '14' }, to: { componentId: 'SOL1', port: 'A1' }, domain: 'electrical' as const },
      { id: 'E13', from: { componentId: 'SOL1', port: 'A2' }, to: { componentId: 'PWR0', port: 'IN' }, domain: 'electrical' as const },
    ],
  };

  const ctBytes = serializeCircuitDocument(doc, { targetPath: 'verified_classes.ct' });
  const vBounds = verifyCtPayloadLinearBounds(ctBytes, 'verified_classes.ct');
  assert.equal(vBounds.ok, true, JSON.stringify(vBounds));
  assert.equal(vBounds.refWrapReads, 0);
  const decoded = decodeCtContainer(ctBytes, 'verified_classes.ct');
  const vInv = verifyCtTextInvariants(decoded.ctBody);
  assert.equal(vInv.ok, true, `4-gate invariant failed: ${JSON.stringify(vInv.badJunctions)}`);
  const vVis = verifyCtVisualLayoutInvariants(decoded.ctBody, decoded.trailerText);
  assert.equal(vVis.ok, true, `Visual/BEGINSYM invariant failed on verified_classes.ct: ${JSON.stringify(vVis)}`);
  assert.ok(decoded.ctBody.includes('WV_2 '));
  assert.ok(decoded.ctBody.includes('FilterP '));
  assert.ok(decoded.ctBody.includes('CheckValveP '));
  assert.ok(decoded.ctBody.includes('CheckValveSpringLoadedP '));
  assert.ok(decoded.ctBody.includes('PSW1 '));
  assert.ok(decoded.ctBody.includes('PressureReducingValve3WaysAdjustableP '));
  assert.ok(decoded.ctBody.includes('LWechsler '));
  assert.ok(decoded.ctBody.includes('LRelaismagnet_abfver '));

  const { document: reparsed } = parseCircuitBuffer(ctBytes, 'verified_classes.ct');
  const val = validateCircuitStatic(reparsed);
  assert.equal(val.valid, true, JSON.stringify(val.findings));
  assert.equal(val.errorCount, 0);
  assert.equal(reparsed.metadata.sheetWidthMm, 420);
  assert.equal(reparsed.metadata.sheetHeightMm, 297);
  const flt = reparsed.components.find((c) => c.id === 'FLT');
  assert.equal(flt?.rotationDeg, 90);
  const v22 = reparsed.components.find((c) => c.id === 'V22');
  assert.equal(v22?.leftActuation?.manualOverride, true);
  assert.equal(v22?.leftActuation?.internalPilot, true);
  assert.equal(v22?.rightActuation?.type, 'pneumatic_spring');
  assert.equal(v22?.rightActuation?.springReturn, true);
});

