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
} from '../codec/ctBinaryCodec';
import type { PreservedCtSections } from '../codec/ctTextCodec';
import { EngineeringError } from '../contracts/errors';
import { generateCircuitFromSpec } from '../authoring/specGenerator';
import { applyCircuitPatch } from '../authoring/patchEngine';
import { validateCircuitStatic } from '../simulator/validator';
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
