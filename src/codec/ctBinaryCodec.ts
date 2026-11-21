import { EngineeringError } from '../contracts/errors';

/**
 * Empirically verified Festo FluidSIM Pneumatics 4.x/4.5 `.ct` binary container codec.
 * See `/docs/CT_FORMAT_4_5.md` for full byte-level specification.
 */

export const FLUIDSIM_CT_MAGIC_PREFIX = Buffer.from(
  '3e6c75423f56daaf205628b0c36c08bbb4654292',
  'hex',
);

/**
 * All three empirically verified Festo FluidSIM 4.x/4.5 `.ct` container magic prefixes
 * observed across 263 official Didactic circuits (all share `FLUIDSIM_CT_MARKER_LINE`).
 */
export const FLUIDSIM_CT_MAGIC_PREFIXES: readonly Buffer[] = [
  Buffer.from('3e6c75423f56daaf205628b0c36c08bb', 'hex'),
  Buffer.from('6e33c0a621ce30e820ce6fa953336de9', 'hex'),
  Buffer.from('7f8943f87a219c112021f2680b898bcf', 'hex'),
];

export const FLUIDSIM_CT_MARKER_LINE = Buffer.from('50c2e8b3557fcece', 'hex');

export const FLUIDSIM_CT_XOR_KEY = 0x9a;

export interface CtCompressionProfile {
  extended: boolean;
  windowSize: number;
  maxLen: number;
  indexBits: number;
  initRpos: number;
  rawHeaderHex: string;
}

export interface DecodedCtContainer {
  headerLinesB64: string[];
  profile: CtCompressionProfile;
  /** Raw bytes from start of decompressed stream up to and including "ENDPREVIEW\n". */
  previewBlockB64: string;
  /** Optional "BEGIN_FSPREVIEW\n...END_FSPREVIEW\n" block preserved verbatim. */
  fsPreviewBlock?: string;
  /** Plain-text circuit body (between preview and "\nENDCT\n"). */
  ctBody: string;
  /** Everything from "ENDCT\n" to the end of the decompressed stream (BEGINDSD..ENDSYM). */
  trailerText: string;
  decompressedByteLength: number;
}

// Default minimal FluidSIM 4.5 obfuscated header lines (A4 sheet) derived from verified golden fixtures.
const DEFAULT_CT_HEADER_LINES_HEX: readonly string[] = [
  '3e6c75423f56daaf205628b0c36c08bbb4654292342034e337e34a2cd94f204ad92b347a2b2cd9',
  '8282',
  'b3c2ce2082494d09201c49b8a82082f61c1c1c1c1c1c2082',
  '092049201c20a7',
  '1c201c2057821c205749a72082',
  '1c',
  '1c',
  '50c2e8b3557fcece',
];

// Minimal valid 2142-byte WMF blank preview prefix matching FluidSIM 4.5's fixed preview envelope.
function buildDefaultPreviewBlock(): Buffer {
  const wmf = Buffer.alloc(2142, 0);
  // Standard Windows 3.0 memory metafile header (18 bytes):
  // mtType=1, mtHeaderSize=9, mtVersion=0x0300, mtSize=1071 words (2142 bytes), mtNoObjects=0, mtMaxRecord=3, mtNoParameters=0
  wmf.writeUInt16LE(1, 0);
  wmf.writeUInt16LE(9, 2);
  wmf.writeUInt16LE(0x0300, 4);
  wmf.writeUInt32LE(1071, 6);
  wmf.writeUInt16LE(0, 10);
  wmf.writeUInt32LE(3, 12);
  wmf.writeUInt16LE(0, 16);
  // EOF WMF record: rdSize=3, rdFunction=0x0000
  wmf.writeUInt32LE(3, 18);
  wmf.writeUInt16LE(0, 22);

  const lenAscii = Buffer.from(' 2142\n', 'latin1');
  const lenU32 = Buffer.alloc(4);
  lenU32.writeUInt32LE(2142, 0);
  const endMarker = Buffer.from('ENDPREVIEW\n', 'latin1');
  return Buffer.concat([lenAscii, lenU32, wmf, endMarker]);
}

export function isFluidSimCtBuffer(buffer: Buffer): boolean {
  if (buffer.length < 32) return false;
  const prefix = buffer.subarray(0, 16);
  const magicMatched = FLUIDSIM_CT_MAGIC_PREFIXES.some((m) => prefix.equals(m));
  if (!magicMatched) return false;
  // Confirm the 8-byte FluidSIM payload boundary marker line appears in the container header
  const scanWindow = buffer.subarray(16, Math.min(buffer.length, 4096));
  return scanWindow.indexOf(FLUIDSIM_CT_MARKER_LINE) >= 0;
}

export function splitCtLines(buffer: Buffer): Buffer[] {
  const lines: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < buffer.length - 1; i++) {
    if (buffer[i] === 0x0d && buffer[i + 1] === 0x0a) {
      lines.push(buffer.subarray(start, i));
      start = i + 2;
      i++;
    }
  }
  if (start < buffer.length) {
    lines.push(buffer.subarray(start));
  }
  return lines;
}

export function parseCompressionProfile(unmasked: Buffer, filePath = ''): CtCompressionProfile {
  if (unmasked.length < 8) {
    throw new EngineeringError({
      category: 'ParseError',
      code: 'CT_PAYLOAD_TOO_SHORT',
      message: `FluidSIM .ct payload in "${filePath || '<buffer>'}" is truncated (${unmasked.length} bytes).`,
      offendingIds: filePath ? [filePath] : [],
      suggestedFix: 'Re-export the .ct file from Festo FluidSIM Pneumatics 4.5.',
    });
  }

  const versionFlag = unmasked.readUInt16LE(0);
  if (versionFlag !== 1) {
    throw new EngineeringError({
      category: 'UnsupportedFormatVersion',
      code: 'CT_UNSUPPORTED_STREAM_VERSION',
      message: `Unsupported FluidSIM .ct compression stream flag ${versionFlag} in "${filePath || '<buffer>'}".`,
      offendingIds: filePath ? [filePath] : [],
      suggestedFix: 'Ensure the circuit was saved by Festo FluidSIM Pneumatics 4.5.',
    });
  }

  const field1 = unmasked.readUInt16LE(2);
  if (field1 === 0) {
    if (unmasked.length < 16) {
      throw new EngineeringError({
        category: 'ParseError',
        code: 'CT_EXTENDED_HEADER_TRUNCATED',
        message: `FluidSIM .ct extended compression header is truncated in "${filePath || '<buffer>'}".`,
        offendingIds: filePath ? [filePath] : [],
        suggestedFix: 'Re-export the .ct file from Festo FluidSIM Pneumatics 4.5.',
      });
    }
    const initRpos = unmasked.readUInt16LE(4);
    const windowSize = unmasked.readUInt16LE(6);
    const maxLen = unmasked.readUInt16LE(8);
    const indexBits = unmasked.readUInt16LE(10);
    return {
      extended: true,
      windowSize,
      maxLen,
      indexBits,
      initRpos,
      rawHeaderHex: unmasked.subarray(0, 16).toString('hex'),
    };
  }

  const windowSize = field1;
  const maxLen = unmasked.readUInt16LE(4);
  const initRpos = unmasked.readUInt16LE(6);
  const indexBits = Math.round(Math.log2(windowSize));
  return {
    extended: false,
    windowSize,
    maxLen,
    indexBits,
    initRpos,
    rawHeaderHex: unmasked.subarray(0, 8).toString('hex'),
  };
}

export function decompressCtPayload(maskedPayload: Buffer, filePath = ''): {
  profile: CtCompressionProfile;
  decompressed: Buffer;
} {
  const data = Buffer.allocUnsafe(maskedPayload.length);
  for (let i = 0; i < maskedPayload.length; i++) {
    data[i] = maskedPayload[i] ^ FLUIDSIM_CT_XOR_KEY;
  }

  const profile = parseCompressionProfile(data, filePath);
  const hdrLen = profile.extended ? 16 : 8;
  const W = profile.windowSize;
  const maxLen = profile.maxLen;
  const shift = profile.indexBits - 8;
  if (shift < 0 || shift > 6 || W < 64 || (W & (W - 1)) !== 0) {
    throw new EngineeringError({
      category: 'UnsupportedFormatVersion',
      code: 'CT_INVALID_COMPRESSION_PARAMS',
      message: `Invalid FluidSIM .ct compression parameters (W=${W}, indexBits=${profile.indexBits}) in "${filePath || '<buffer>'}".`,
      offendingIds: filePath ? [filePath] : [],
      suggestedFix: 'Save the circuit using Festo FluidSIM Pneumatics 4.5.',
    });
  }

  const ringLimit = W - 1;
  const mask = (1 << shift) - 1;
  const rleMax = 1 << shift;
  const longMax = 2 << shift;

  const ring = Buffer.alloc(W, 0);
  if (profile.extended && profile.initRpos >= 14) {
    Buffer.from('       PREVIEW', 'latin1').copy(ring, 0);
  }
  let rpos = profile.initRpos % ringLimit;

  const out: number[] = [];
  const tmp = Buffer.allocUnsafe(256);
  let p = hdrLen;

  while (p < data.length) {
    const b = data[p];
    if (b >= 0x80) {
      const n = b - 0x80;
      if (p + 1 + n > data.length) {
        throw new EngineeringError({
          category: 'ParseError',
          code: 'CT_STREAM_TRUNCATED_LITERAL',
          message: `Truncated literal run at offset ${p} in "${filePath || '<buffer>'}".`,
          offendingIds: filePath ? [filePath] : [],
          suggestedFix: 'Verify the .ct file is not corrupted or truncated.',
        });
      }
      for (let j = 0; j < n; j++) {
        const c = data[p + 1 + j];
        out.push(c);
        ring[rpos++] = c;
        if (rpos >= ringLimit) rpos = 0;
      }
      p += 1 + n;
    } else if (b < rleMax) {
      if (p + 3 > data.length) {
        throw new EngineeringError({
          category: 'ParseError',
          code: 'CT_STREAM_TRUNCATED_RLE',
          message: `Truncated RLE token at offset ${p} in "${filePath || '<buffer>'}".`,
          offendingIds: filePath ? [filePath] : [],
          suggestedFix: 'Verify the .ct file is not corrupted or truncated.',
        });
      }
      const count = ((b & mask) << 8) | data[p + 1];
      const val = data[p + 2];
      for (let j = 0; j < count; j++) {
        out.push(val);
      }
      if (count <= maxLen && rpos + count < ringLimit) {
        for (let j = 0; j < count; j++) {
          ring[rpos++] = val;
        }
      }
      p += 3;
    } else if (b < longMax) {
      if (p + 3 > data.length) {
        throw new EngineeringError({
          category: 'ParseError',
          code: 'CT_STREAM_TRUNCATED_LONG_LZ',
          message: `Truncated long-LZ token at offset ${p} in "${filePath || '<buffer>'}".`,
          offendingIds: filePath ? [filePath] : [],
          suggestedFix: 'Verify the .ct file is not corrupted or truncated.',
        });
      }
      const ref = ((b & mask) << 8) | data[p + 1];
      const len = data[p + 2];
      for (let j = 0; j < len; j++) {
        tmp[j] = ring[(ref + j) % ringLimit];
      }
      if (rpos + len >= ringLimit) rpos = 0;
      for (let j = 0; j < len; j++) {
        const c = tmp[j];
        out.push(c);
        ring[rpos++] = c;
      }
      p += 3;
    } else {
      if (p + 2 > data.length) {
        throw new EngineeringError({
          category: 'ParseError',
          code: 'CT_STREAM_TRUNCATED_SHORT_LZ',
          message: `Truncated short-LZ token at offset ${p} in "${filePath || '<buffer>'}".`,
          offendingIds: filePath ? [filePath] : [],
          suggestedFix: 'Verify the .ct file is not corrupted or truncated.',
        });
      }
      const len = (b >> shift) + 1;
      const ref = ((b & mask) << 8) | data[p + 1];
      for (let j = 0; j < len; j++) {
        tmp[j] = ring[(ref + j) % ringLimit];
      }
      if (rpos + len >= ringLimit) rpos = 0;
      for (let j = 0; j < len; j++) {
        const c = tmp[j];
        out.push(c);
        ring[rpos++] = c;
      }
      p += 2;
    }
  }

  return {
    profile,
    decompressed: Buffer.from(out),
  };
}

/**
 * Deterministic FluidSIM 4.5 LZ + RLE encoder (Profile A: W=2048, maxLen=16, indexBits=11, initRpos=14).
 * Produces valid FluidSIM 4.5 `.ct` compressed payloads guaranteed to roundtrip bit-for-bit identically.
 */
export function compressCtPayload(
  plainBytes: Buffer,
  profile?: Partial<CtCompressionProfile>,
): Buffer {
  const extended = profile?.extended ?? true;
  const W = extended ? 2048 : 512;
  const maxLen = extended ? 16 : 64;
  const indexBits = extended ? 11 : 9;
  const initRpos = extended ? 14 : 12;
  const shift = indexBits - 8;
  const ringLimit = W - 1;
  const maxShortLen = extended ? 16 : 64;
  const maxLongLen = extended ? 255 : 0;

  const header = profile?.rawHeaderHex
    ? Buffer.from(profile.rawHeaderHex, 'hex')
    : extended
      ? Buffer.from('010000000e00000810000b009a003000', 'hex')
      : Buffer.from('0100000240000c00', 'hex');

  const ring = Buffer.alloc(W, 0);
  if (extended && initRpos >= 14) {
    Buffer.from('       PREVIEW', 'latin1').copy(ring, 0);
  }
  let rpos = initRpos % ringLimit;
  let maxFilled = initRpos;
  let wrapped = false;
  const out: number[] = [...header];

  // Flush pending literal bytes in chunks of up to 127 (0x81..0xff)
  let litBuf: number[] = [];
  const flushLiterals = () => {
    let idx = 0;
    while (idx < litBuf.length) {
      const chunk = Math.min(127, litBuf.length - idx);
      out.push(0x80 + chunk);
      for (let k = 0; k < chunk; k++) {
        out.push(litBuf[idx + k]);
      }
      idx += chunk;
    }
    litBuf = [];
  };

  let i = 0;
  const n = plainBytes.length;

  while (i < n) {
    // 1. Check RLE run (4..2047 identical bytes)
    let rleLen = 1;
    const maxRle = Math.min((1 << indexBits) - 1, n - i);
    while (rleLen < maxRle && plainBytes[i + rleLen] === plainBytes[i]) {
      rleLen++;
    }

    if (rleLen >= 4) {
      flushLiterals();
      const val = plainBytes[i];
      out.push((rleLen >> 8) & ((1 << shift) - 1));
      out.push(rleLen & 0xff);
      out.push(val);
      if (rleLen <= maxLen && rpos + rleLen < ringLimit) {
        for (let j = 0; j < rleLen; j++) {
          ring[rpos++] = val;
        }
        if (rpos > maxFilled) maxFilled = rpos;
      }
      i += rleLen;
      continue;
    }

    // 2. Search ring buffer linearly for longest match >= 3.
    // FluidSIM 4.5's native C++ decompressor reads ring[ref .. ref + len - 1] LINEARLY
    // without modulo wrap-around, so we strictly enforce ref + mlen <= searchLimit <= ringLimit.
    let bestLen = 0;
    let bestRef = 0;
    const maxAllowedMatch = Math.min(
      extended ? maxLongLen : maxShortLen,
      n - i,
      ringLimit - 1,
    );
    const searchLimit = wrapped ? ringLimit : maxFilled;

    if (maxAllowedMatch >= 3 && searchLimit >= 3) {
      const b0 = plainBytes[i];
      const b1 = plainBytes[i + 1];
      const b2 = plainBytes[i + 2];
      for (let ref = 0; ref <= searchLimit - 3; ref++) {
        if (ring[ref] === b0 && ring[ref + 1] === b1 && ring[ref + 2] === b2) {
          const avail = Math.min(maxAllowedMatch, searchLimit - ref);
          let mlen = 3;
          while (mlen < avail && ring[ref + mlen] === plainBytes[i + mlen]) {
            mlen++;
          }
          if (mlen > bestLen) {
            bestLen = mlen;
            bestRef = ref;
            if (bestLen === maxAllowedMatch) break;
          }
        }
      }
    }

    if (bestLen >= 3) {
      flushLiterals();
      // Snapshot bytes linearly BEFORE updating ring (exact mirror of FluidSIM C++ decoder)
      const snap = Buffer.allocUnsafe(bestLen);
      for (let j = 0; j < bestLen; j++) {
        snap[j] = ring[bestRef + j];
      }
      if (rpos + bestLen >= ringLimit) {
        rpos = 0;
        wrapped = true;
        maxFilled = ringLimit;
      }
      for (let j = 0; j < bestLen; j++) {
        ring[rpos++] = snap[j];
      }
      if (rpos > maxFilled) maxFilled = rpos;

      if (bestLen <= maxShortLen) {
        const b0 = ((bestLen - 1) << shift) | ((bestRef >> 8) & ((1 << shift) - 1));
        const b1 = bestRef & 0xff;
        out.push(b0, b1);
      } else {
        const b0 = (1 << shift) | ((bestRef >> 8) & ((1 << shift) - 1));
        const b1 = bestRef & 0xff;
        out.push(b0, b1, bestLen);
      }
      i += bestLen;
      continue;
    }

    // 3. Literal byte
    const c = plainBytes[i++];
    litBuf.push(c);
    ring[rpos++] = c;
    if (rpos > maxFilled) maxFilled = rpos;
    if (rpos >= ringLimit) {
      rpos = 0;
      wrapped = true;
      maxFilled = ringLimit;
    }
  }

  flushLiterals();

  // Apply XOR 0x9A mask
  const masked = Buffer.allocUnsafe(out.length);
  for (let k = 0; k < out.length; k++) {
    masked[k] = out[k] ^ FLUIDSIM_CT_XOR_KEY;
  }
  return masked;
}

/**
 * Audits a compressed FluidSIM `.ct` payload (XOR-masked bytes) to verify that every emitted
 * LZ back-reference strictly satisfies FluidSIM 4.5's linear C++ ring-buffer bounds:
 * `ref + len <= ringLimit` and (before first wrap) `ref + len <= maxFilled`.
 */
export function verifyCtPayloadLinearBounds(maskedOrContainerBytes: Buffer, filePath = ''): {
  ok: boolean;
  refWrapReads: number;
  uninitializedReads: number;
  maxRefEnd: number;
  ringLimit: number;
  lzTokenCount: number;
} {
  let maskedBytes = maskedOrContainerBytes;
  if (isFluidSimCtBuffer(maskedOrContainerBytes)) {
    const lines = splitCtLines(maskedOrContainerBytes);
    let markerIdx = -1;
    for (let i = lines.length - 2; i >= 0; i--) {
      if (lines[i].equals(FLUIDSIM_CT_MARKER_LINE)) {
        markerIdx = i;
        break;
      }
    }
    if (markerIdx >= 0 && markerIdx + 1 < lines.length) {
      const payloadParts = lines.slice(markerIdx + 1);
      maskedBytes =
        payloadParts.length === 1
          ? payloadParts[0]
          : Buffer.concat(
              payloadParts.flatMap((part, idx) =>
                idx === 0 ? [part] : [Buffer.from([0x0d, 0x0a]), part],
              ),
            );
    }
  }

  const unmasked = Buffer.allocUnsafe(maskedBytes.length);
  for (let i = 0; i < maskedBytes.length; i++) {
    unmasked[i] = maskedBytes[i] ^ FLUIDSIM_CT_XOR_KEY;
  }
  const profile = parseCompressionProfile(unmasked, filePath);
  const headerLen = profile.rawHeaderHex.length / 2;
  const data = unmasked.subarray(headerLen);

  const shift = profile.indexBits - 8;
  const mask = (1 << shift) - 1;
  const rleMax = 1 << shift;
  const longMax = profile.extended ? 2 << shift : rleMax;
  const ringLimit = profile.windowSize - 1;

  let rpos = profile.initRpos % ringLimit;
  let maxFilled = profile.initRpos;
  let wrapped = false;
  let p = 0;
  let refWrapReads = 0;
  let uninitializedReads = 0;
  let maxRefEnd = 0;
  let lzTokenCount = 0;

  while (p < data.length) {
    const b = data[p];
    if (b >= 0x80) {
      const n = b - 0x80;
      for (let j = 0; j < n; j++) {
        rpos++;
        if (rpos > maxFilled) maxFilled = rpos;
        if (rpos >= ringLimit) {
          rpos = 0;
          wrapped = true;
          maxFilled = ringLimit;
        }
      }
      p += 1 + n;
    } else if (b < rleMax) {
      const count = ((b & mask) << 8) | data[p + 1];
      if (count <= profile.maxLen && rpos + count < ringLimit) {
        rpos += count;
        if (rpos > maxFilled) maxFilled = rpos;
      }
      p += 3;
    } else if (b < longMax) {
      const ref = ((b & mask) << 8) | data[p + 1];
      const len = data[p + 2];
      lzTokenCount++;
      const refEnd = ref + len;
      if (refEnd > maxRefEnd) maxRefEnd = refEnd;
      if (refEnd > ringLimit) refWrapReads++;
      if (!wrapped && refEnd > maxFilled) uninitializedReads++;
      if (rpos + len >= ringLimit) {
        rpos = 0;
        wrapped = true;
        maxFilled = ringLimit;
      }
      rpos += len;
      if (rpos > maxFilled) maxFilled = rpos;
      p += 3;
    } else {
      const len = (b >> shift) + 1;
      const ref = ((b & mask) << 8) | data[p + 1];
      lzTokenCount++;
      const refEnd = ref + len;
      if (refEnd > maxRefEnd) maxRefEnd = refEnd;
      if (refEnd > ringLimit) refWrapReads++;
      if (!wrapped && refEnd > maxFilled) uninitializedReads++;
      if (rpos + len >= ringLimit) {
        rpos = 0;
        wrapped = true;
        maxFilled = ringLimit;
      }
      rpos += len;
      if (rpos > maxFilled) maxFilled = rpos;
      p += 2;
    }
  }

  return {
    ok: refWrapReads === 0 && uninitializedReads === 0,
    refWrapReads,
    uninitializedReads,
    maxRefEnd,
    ringLimit,
    lzTokenCount,
  };
}

export function decodeCtContainer(buffer: Buffer, filePath = ''): DecodedCtContainer {
  if (!isFluidSimCtBuffer(buffer)) {
    throw new EngineeringError({
      category: 'UnsupportedFormatVersion',
      code: 'CT_INVALID_MAGIC',
      message: `File "${filePath || '<buffer>'}" does not start with the Festo FluidSIM Pneumatics .ct signature.`,
      offendingIds: filePath ? [filePath] : [],
      suggestedFix: 'Ensure the file is a valid Festo FluidSIM Pneumatics 4.5 .ct circuit.',
    });
  }

  const lines = splitCtLines(buffer);
  if (lines.length < 3) {
    throw new EngineeringError({
      category: 'ParseError',
      code: 'CT_MALFORMED_CONTAINER',
      message: `FluidSIM .ct file "${filePath || '<buffer>'}" has too few container lines (${lines.length}).`,
      offendingIds: filePath ? [filePath] : [],
      suggestedFix: 'Verify the .ct file was not truncated.',
    });
  }

  // Locate the 8-byte marker line immediately before the compressed payload
  let markerIdx = -1;
  for (let i = lines.length - 2; i >= 0; i--) {
    if (lines[i].equals(FLUIDSIM_CT_MARKER_LINE)) {
      markerIdx = i;
      break;
    }
  }
  if (markerIdx < 0 || markerIdx + 1 >= lines.length) {
    throw new EngineeringError({
      category: 'ParseError',
      code: 'CT_MISSING_PAYLOAD_MARKER',
      message: `FluidSIM .ct file "${filePath || '<buffer>'}" is missing the payload section boundary marker.`,
      offendingIds: filePath ? [filePath] : [],
      suggestedFix: 'Re-save the circuit from Festo FluidSIM Pneumatics 4.5.',
    });
  }

  const headerLines = lines.slice(0, markerIdx + 1);
  // Payload may contain raw 0x0d 0x0a bytes by coincidence, so rejoin everything after markerIdx + 1 with CRLF!
  const payloadParts = lines.slice(markerIdx + 1);
  const maskedPayload =
    payloadParts.length === 1
      ? payloadParts[0]
      : Buffer.concat(
          payloadParts.flatMap((part, idx) =>
            idx === 0 ? [part] : [Buffer.from([0x0d, 0x0a]), part],
          ),
        );

  const { profile, decompressed } = decompressCtPayload(maskedPayload, filePath);
  const fullText = decompressed.toString('latin1');

  const endPreviewMarker = 'ENDPREVIEW\n';
  const endPreviewIdx = fullText.indexOf(endPreviewMarker);
  let previewBlock: Buffer;
  let afterPreview: string;
  if (endPreviewIdx >= 0) {
    const splitPos = endPreviewIdx + endPreviewMarker.length;
    previewBlock = decompressed.subarray(0, splitPos);
    afterPreview = fullText.slice(splitPos);
  } else {
    previewBlock = Buffer.alloc(0);
    afterPreview = fullText;
  }

  let fsPreviewBlock: string | undefined;
  if (afterPreview.startsWith('BEGIN_FSPREVIEW\n')) {
    const endFsMarker = 'END_FSPREVIEW\n';
    const endFsIdx = afterPreview.indexOf(endFsMarker);
    if (endFsIdx >= 0) {
      const splitPos = endFsIdx + endFsMarker.length;
      fsPreviewBlock = afterPreview.slice(0, splitPos);
      afterPreview = afterPreview.slice(splitPos);
    }
  }

  const endCtMarker = '\nENDCT\n';
  const endCtIdx = afterPreview.indexOf(endCtMarker);
  let ctBody: string;
  let trailerText: string;
  if (endCtIdx >= 0) {
    ctBody = afterPreview.slice(0, endCtIdx);
    trailerText = afterPreview.slice(endCtIdx + 1); // starts with "ENDCT\n"
  } else if (afterPreview.startsWith('ENDCT\n')) {
    ctBody = '';
    trailerText = afterPreview;
  } else {
    throw new EngineeringError({
      category: 'ParseError',
      code: 'CT_MISSING_ENDCT',
      message: `Decompressed FluidSIM .ct payload in "${filePath || '<buffer>'}" is missing ENDCT section terminator.`,
      offendingIds: filePath ? [filePath] : [],
      suggestedFix: 'Verify the file is a valid Festo FluidSIM Pneumatics 4.5 circuit.',
    });
  }

  return {
    headerLinesB64: headerLines.map((buf) => buf.toString('base64')),
    profile,
    previewBlockB64: previewBlock.toString('base64'),
    ...(fsPreviewBlock !== undefined ? { fsPreviewBlock } : {}),
    ctBody,
    trailerText,
    decompressedByteLength: decompressed.length,
  };
}

export function encodeCtContainer(container: {
  headerLinesB64?: string[];
  profile?: Partial<CtCompressionProfile>;
  previewBlockB64?: string;
  fsPreviewBlock?: string;
  ctBody: string;
  trailerText?: string;
}): Buffer {
  const headerLines =
    container.headerLinesB64 && container.headerLinesB64.length > 0
      ? container.headerLinesB64.map((b64) => Buffer.from(b64, 'base64'))
      : DEFAULT_CT_HEADER_LINES_HEX.map((hex) => Buffer.from(hex, 'hex'));

  const previewBlock =
    container.previewBlockB64 && container.previewBlockB64.length > 0
      ? Buffer.from(container.previewBlockB64, 'base64')
      : buildDefaultPreviewBlock();

  const fsPreview = container.fsPreviewBlock ?? '';
  const trailer = container.trailerText ?? 'ENDCT\nBEGINDSD\nENDDSD\nBEGINSYM\nENDSYM\n';
  const bodyPart = container.ctBody.length > 0 ? `${container.ctBody}\n` : '';
  const textTail = Buffer.from(`${fsPreview}${bodyPart}${trailer}`, 'latin1');
  const fullPlain = Buffer.concat([previewBlock, textTail]);

  const maskedPayload = compressCtPayload(fullPlain, container.profile);
  const crlf = Buffer.from([0x0d, 0x0a]);
  const parts: Buffer[] = [];
  for (const h of headerLines) {
    parts.push(h, crlf);
  }
  parts.push(maskedPayload);
  return Buffer.concat(parts);
}
