import fs from 'node:fs';
import path from 'node:path';
import { EngineeringError } from '../contracts/errors';
import { isFluidSimCtBuffer } from './ctBinaryCodec';

export type DetectedFormat =
  | 'fsim-ir-json'
  | 'fluidsim-4.5-ct'
  | 'unknown';

export interface DetectionResult {
  format: DetectedFormat;
  detectedVersion: string | null;
  encoding: 'utf8' | 'latin1' | 'binary';
  byteLength: number;
  magicHex: string;
}

export const REQUIRED_GOLDEN_FIXTURES = [
  '01_direct_indirect_cylinders.ct',
  '02_speed_control_throttle.ct',
  '03_pneumatic_abba_sequence.ct',
  '04_electro_pneumatic_abba.ct',
  '05_timer_counter_electro.ct',
  '06_electrical_latch_legacy.ct',
] as const;

export function getGoldenFixtureStatus(repoRoot = process.cwd()): {
  present: string[];
  missing: string[];
  readyForPhase1: boolean;
} {
  const goldenDir = path.resolve(repoRoot, 'fixtures', 'golden');
  const present: string[] = [];
  const missing: string[] = [];

  for (const name of REQUIRED_GOLDEN_FIXTURES) {
    const full = path.join(goldenDir, name);
    if (fs.existsSync(full) && fs.statSync(full).size > 0) {
      present.push(name);
    } else {
      missing.push(name);
    }
  }

  return {
    present,
    missing,
    readyForPhase1: missing.length === 0,
  };
}

export function detectCircuitFormat(buffer: Buffer, filePath = ''): DetectionResult {
  const byteLength = buffer.length;
  const magicHex = buffer.subarray(0, 16).toString('hex');

  if (byteLength === 0) {
    throw new EngineeringError({
      category: 'ParseError',
      code: 'EMPTY_FILE',
      message: `Circuit file "${filePath || '<buffer>'}" is empty (0 bytes).`,
      offendingIds: filePath ? [filePath] : [],
      suggestedFix: 'Provide a valid FluidSIM 4.5 .ct or .fsim.json file, or create one with circuit_create.',
    });
  }

  // Reject ZIP/OLE/FluidSIM 5+ archive containers clearly
  if (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04) {
    throw new EngineeringError({
      category: 'UnsupportedFormatVersion',
      code: 'UNSUPPORTED_ZIP_CONTAINER',
      message: `File "${filePath || '<buffer>'}" is a ZIP container (PK header), not a FluidSIM Pneumatics 4.5 circuit file.`,
      offendingIds: filePath ? [filePath] : [],
      suggestedFix: 'Export the circuit from Festo FluidSIM Pneumatics 4.5 (.ct) or use .fsim.json IR format.',
    });
  }

  // Empirically verified Festo FluidSIM 4.x/4.5 native .ct container signature
  if (isFluidSimCtBuffer(buffer)) {
    return {
      format: 'fluidsim-4.5-ct',
      detectedVersion: '4.5',
      encoding: 'binary',
      byteLength,
      magicHex,
    };
  }

  const utf8Head = buffer.subarray(0, Math.min(buffer.length, 512)).toString('utf8').trimStart();
  if (utf8Head.startsWith('{')) {
    try {
      const parsed = JSON.parse(buffer.toString('utf8')) as {
        schemaVersion?: string;
        metadata?: { format?: string; fluidsimVersion?: string };
      };
      if (parsed && parsed.schemaVersion === '1.0' && parsed.metadata) {
        return {
          format: 'fsim-ir-json',
          detectedVersion: parsed.metadata.fluidsimVersion ?? '4.5',
          encoding: 'utf8',
          byteLength,
          magicHex,
        };
      }
    } catch (err) {
      throw new EngineeringError({
        category: 'ParseError',
        code: 'MALFORMED_JSON_IR',
        message: `File "${filePath || '<buffer>'}" starts with "{" but is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        offendingIds: filePath ? [filePath] : [],
        suggestedFix: 'Fix JSON syntax or recreate the circuit via circuit_create.',
      });
    }
  }

  // Check if file has XML header (e.g. FluidSIM 5/6 XML or foreign CAD)
  if (utf8Head.startsWith('<?xml') || utf8Head.startsWith('<')) {
    throw new EngineeringError({
      category: 'UnsupportedFormatVersion',
      code: 'UNSUPPORTED_XML_FORMAT',
      message: `File "${filePath || '<buffer>'}" appears to be XML rather than FluidSIM Pneumatics 4.5 .ct.`,
      offendingIds: filePath ? [filePath] : [],
      suggestedFix: 'Save the circuit in Festo FluidSIM Pneumatics 4.5 (.ct) format.',
    });
  }

  throw new EngineeringError({
    category: 'UnsupportedFormatVersion',
    code: 'UNRECOGNIZED_CIRCUIT_FORMAT',
    message: `Could not recognize format of "${filePath || '<buffer>'}" (magic=${magicHex}).`,
    offendingIds: filePath ? [filePath] : [],
    suggestedFix: 'Provide a valid Festo FluidSIM Pneumatics 4.5 .ct file or a .fsim.json circuit IR file.',
  });
}
