import test from 'node:test';
import assert from 'node:assert/strict';
import { detectCircuitFormat, getGoldenFixtureStatus, REQUIRED_GOLDEN_FIXTURES } from '../codec/ctDetector';
import { parseCircuitBuffer } from '../codec/ctParser';
import { serializeCircuitDocument } from '../codec/ctSerializer';
import { verifyCodecRoundtrip } from '../codec/ctRoundtripGuard';
import { EngineeringError } from '../contracts/errors';
import { generateCircuitFromSpec } from '../authoring/specGenerator';
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

test('Phase 0 golden fixture gate blocks hallucinated native .ct parse and serialize', () => {
  const status = getGoldenFixtureStatus(process.cwd());
  assert.equal(status.readyForPhase1, false);
  assert.equal(status.missing.length, REQUIRED_GOLDEN_FIXTURES.length);

  const fakeCtBytes = Buffer.from('FLUIDSIM_DUMMY_CONTENT\r\nOBJECT 1\r\n', 'latin1');
  assert.throws(
    () => parseCircuitBuffer(fakeCtBytes, 'sample.ct'),
    (err: unknown) =>
      err instanceof EngineeringError &&
      err.category === 'UnsupportedFormatVersion' &&
      err.code === 'PHASE_0_GOLDEN_FIXTURES_REQUIRED',
  );

  const doc = generateCircuitFromSpec({
    actuators: [{ label: 'A' }],
    sequence: ['A+'],
    controlMethod: 'direct',
  });
  assert.throws(
    () => serializeCircuitDocument(doc, { targetPath: 'output.ct' }),
    (err: unknown) =>
      err instanceof EngineeringError &&
      err.category === 'UnsupportedFormatVersion' &&
      err.code === 'PHASE_0_GOLDEN_FIXTURES_REQUIRED',
  );
});

test('ctDetector rejects empty, ZIP, and XML files with clear error categories', () => {
  assert.throws(
    () => detectCircuitFormat(Buffer.alloc(0), 'empty.ct'),
    (err: unknown) => err instanceof EngineeringError && err.category === 'ParseError' && err.code === 'EMPTY_FILE',
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

test('scripts/inspect-ct inspects buffer structure and computes pairwise diffs', () => {
  const bufA = Buffer.from('[Sheet]\r\nWidth=297\r\nHeight=210\r\n', 'latin1');
  const bufB = Buffer.from('[Sheet]\r\nWidth=297\r\nHeight=210\r\n[Component]\r\nType=AirSource\r\nX=100\r\nY=180\r\n', 'latin1');

  const rep = inspectCtBuffer(bufB, '02_air_source.ct');
  assert.equal(rep.lineEnding, 'CRLF');
  assert.equal(rep.encodingGuess, 'utf8');
  assert.ok(rep.sectionTokens.some((t) => t.token === '[Component]'));
  assert.equal(rep.numericStats.minNumber, 100);
  assert.equal(rep.numericStats.maxNumber, 297);

  const diff = diffCtBuffers(bufA, bufB, '01_empty.ct', '02_air_source.ct');
  assert.ok(diff.byteDelta > 0);
  assert.ok(diff.addedLines.some((l) => l.text.includes('Type=AirSource')));
  assert.equal(diff.removedLines.length, 0);
});
