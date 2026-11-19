#!/usr/bin/env node
/**
 * Phase 0 Reverse-Engineering & Pairwise Diff Tool for Festo FluidSIM Pneumatics 4.5 (.ct) files.
 *
 * Usage:
 *   npm run inspect-ct -- fixtures/golden/01_empty.ct
 *   npm run inspect-ct -- --diff fixtures/golden/01_empty.ct fixtures/golden/02_air_source.ct
 *   npm run inspect-ct -- --check-golden
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getGoldenFixtureStatus, REQUIRED_GOLDEN_FIXTURES } from '../src/codec/ctDetector';

export interface CtInspectionReport {
  filePath: string;
  byteLength: number;
  sha256: string;
  magicHex: string;
  magicAscii: string;
  encodingGuess: 'utf8' | 'latin1' | 'utf16le' | 'binary';
  lineEnding: 'CRLF' | 'LF' | 'CR' | 'MIXED' | 'NONE';
  lineCount: number;
  nullByteCount: number;
  printableRatio: number;
  headerPreview: string[];
  sectionTokens: Array<{ token: string; count: number }>;
  numericStats: {
    integerCount: number;
    floatCount: number;
    minNumber: number | null;
    maxNumber: number | null;
  };
}

export function inspectCtBuffer(buffer: Buffer, filePath = '<buffer>'): CtInspectionReport {
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const magicBytes = buffer.subarray(0, Math.min(32, buffer.length));
  const magicHex = magicBytes.toString('hex');
  const magicAscii = Array.from(magicBytes)
    .map((b) => (b >= 32 && b <= 126 ? String.fromCharCode(b) : '.'))
    .join('');

  let nullByteCount = 0;
  let printableCount = 0;
  for (let i = 0; i < buffer.length; i++) {
    const b = buffer[i];
    if (b === 0) nullByteCount++;
    if ((b >= 32 && b <= 126) || b === 9 || b === 10 || b === 13) printableCount++;
  }
  const printableRatio = buffer.length > 0 ? Number((printableCount / buffer.length).toFixed(4)) : 0;

  let encodingGuess: CtInspectionReport['encodingGuess'] = 'utf8';
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    encodingGuess = 'utf16le';
  } else if (nullByteCount > buffer.length * 0.05) {
    encodingGuess = 'binary';
  } else {
    const utf8Text = buffer.toString('utf8');
    if (utf8Text.includes('\uFFFD')) {
      encodingGuess = 'latin1';
    }
  }

  const text = encodingGuess === 'utf8' ? buffer.toString('utf8') : buffer.toString('latin1');
  const crlfCount = (text.match(/\r\n/g) ?? []).length;
  const lfOnlyCount = (text.match(/(?<!\r)\n/g) ?? []).length;
  const crOnlyCount = (text.match(/\r(?!\n)/g) ?? []).length;

  let lineEnding: CtInspectionReport['lineEnding'] = 'NONE';
  if (crlfCount > 0 && lfOnlyCount === 0 && crOnlyCount === 0) lineEnding = 'CRLF';
  else if (lfOnlyCount > 0 && crlfCount === 0 && crOnlyCount === 0) lineEnding = 'LF';
  else if (crOnlyCount > 0 && crlfCount === 0 && lfOnlyCount === 0) lineEnding = 'CR';
  else if (crlfCount + lfOnlyCount + crOnlyCount > 0) lineEnding = 'MIXED';

  const lines = text.split(/\r\n|\n|\r/);
  const headerPreview = lines.slice(0, 25).map((l) => l.slice(0, 140));

  // Extract candidate structural/section identifiers (keywords, bracketed headers, tagged blocks)
  const tokenCounts = new Map<string, number>();
  const tokenRegex = /(?:^\[[^\]]+\]|^[A-Za-z_][A-Za-z0-9_.:-]{1,40}(?=\s|[=({:])|<[A-Za-z0-9_:-]+>)/gm;
  let match: RegExpExecArray | null;
  while ((match = tokenRegex.exec(text)) !== null) {
    const tok = match[0];
    tokenCounts.set(tok, (tokenCounts.get(tok) ?? 0) + 1);
  }
  const sectionTokens = Array.from(tokenCounts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 40)
    .map(([token, count]) => ({ token, count }));

  // Numeric stats for coordinate scaling inspection
  const numMatches = text.match(/-?\d+(?:\.\d+)?/g) ?? [];
  let integerCount = 0;
  let floatCount = 0;
  let minNumber: number | null = null;
  let maxNumber: number | null = null;
  for (const rawNum of numMatches) {
    const n = Number(rawNum);
    if (!Number.isFinite(n)) continue;
    if (rawNum.includes('.')) floatCount++;
    else integerCount++;
    if (minNumber === null || n < minNumber) minNumber = n;
    if (maxNumber === null || n > maxNumber) maxNumber = n;
  }

  return {
    filePath,
    byteLength: buffer.length,
    sha256,
    magicHex,
    magicAscii,
    encodingGuess,
    lineEnding,
    lineCount: lines.length,
    nullByteCount,
    printableRatio,
    headerPreview,
    sectionTokens,
    numericStats: {
      integerCount,
      floatCount,
      minNumber,
      maxNumber,
    },
  };
}

export interface PairwiseDiffResult {
  fileA: string;
  fileB: string;
  byteDelta: number;
  lineDelta: number;
  addedLines: Array<{ lineNo: number; text: string }>;
  removedLines: Array<{ lineNo: number; text: string }>;
  firstDifferingByteOffset: number | null;
}

export function diffCtBuffers(
  bufA: Buffer,
  bufB: Buffer,
  fileA = 'A',
  fileB = 'B',
): PairwiseDiffResult {
  const minLen = Math.min(bufA.length, bufB.length);
  let firstDifferingByteOffset: number | null = null;
  for (let i = 0; i < minLen; i++) {
    if (bufA[i] !== bufB[i]) {
      firstDifferingByteOffset = i;
      break;
    }
  }
  if (firstDifferingByteOffset === null && bufA.length !== bufB.length) {
    firstDifferingByteOffset = minLen;
  }

  const linesA = bufA.toString('latin1').split(/\r\n|\n|\r/);
  const linesB = bufB.toString('latin1').split(/\r\n|\n|\r/);

  const setA = new Map<string, number>();
  for (const l of linesA) setA.set(l, (setA.get(l) ?? 0) + 1);
  const setB = new Map<string, number>();
  for (const l of linesB) setB.set(l, (setB.get(l) ?? 0) + 1);

  const addedLines: Array<{ lineNo: number; text: string }> = [];
  const removedLines: Array<{ lineNo: number; text: string }> = [];

  const copyA = new Map(setA);
  linesB.forEach((line, idx) => {
    const rem = copyA.get(line) ?? 0;
    if (rem > 0) {
      copyA.set(line, rem - 1);
    } else if (addedLines.length < 150) {
      addedLines.push({ lineNo: idx + 1, text: line.slice(0, 160) });
    }
  });

  const copyB = new Map(setB);
  linesA.forEach((line, idx) => {
    const rem = copyB.get(line) ?? 0;
    if (rem > 0) {
      copyB.set(line, rem - 1);
    } else if (removedLines.length < 150) {
      removedLines.push({ lineNo: idx + 1, text: line.slice(0, 160) });
    }
  });

  return {
    fileA,
    fileB,
    byteDelta: bufB.length - bufA.length,
    lineDelta: linesB.length - linesA.length,
    addedLines,
    removedLines,
    firstDifferingByteOffset,
  };
}

function runCli(): void {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(
      [
        'FluidSIM 4.5 .ct Reverse-Engineering Inspector (Phase 0)',
        '',
        'Usage:',
        '  inspect-ct --check-golden',
        '  inspect-ct <file.ct>',
        '  inspect-ct --diff <base.ct> <target.ct>',
      ].join('\n'),
    );
    return;
  }

  if (args[0] === '--check-golden') {
    const status = getGoldenFixtureStatus(process.cwd());
    console.log(
      JSON.stringify(
        {
          required: REQUIRED_GOLDEN_FIXTURES,
          ...status,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (args[0] === '--diff') {
    const [, fileA, fileB] = args;
    if (!fileA || !fileB) {
      console.error('Usage: inspect-ct --diff <base.ct> <target.ct>');
      process.exitCode = 1;
      return;
    }
    const bufA = fs.readFileSync(path.resolve(fileA));
    const bufB = fs.readFileSync(path.resolve(fileB));
    console.log(JSON.stringify(diffCtBuffers(bufA, bufB, fileA, fileB), null, 2));
    return;
  }

  const target = path.resolve(args[0]);
  const buf = fs.readFileSync(target);
  console.log(JSON.stringify(inspectCtBuffer(buf, args[0]), null, 2));
}

const isDirectExecution =
  typeof process.argv[1] === 'string' &&
  path.resolve(process.argv[1]).endsWith(path.normalize('scripts/inspect-ct.ts'));

if (isDirectExecution) {
  runCli();
}
