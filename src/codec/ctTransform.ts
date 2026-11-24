/**
 * Unified D4 Dihedral Orientation Algebra for Festo FluidSIM Pneumatics 4.5.
 *
 * FluidSIM 4.5 supports all 8 elements of D4:
 *   rot ∈ {0, 90, 180, 270} (counter-clockwise degrees)
 *   followed by FLIPPED ∈ {0: none, 1: horizontal, 2: vertical, 3: both (H+V)}.
 *
 * Single source of truth used by:
 *   - layoutRouter.ts (bounding boxes & port-axis alignment)
 *   - ctWireRouter.ts (port anchor coordinates & outward exit normals)
 *   - ctTextCodec.ts (FluidSIM object headers, PConnection/EConnection hitboxes, BEGINSYM)
 *   - ctSvgRenderer.ts (headless visual SVG preview & diagnostics)
 */

import type { FluidSimFlippedCode, MirrorMode } from '../contracts/circuit';
import type { PortNormal } from '../contracts/catalog';

export type RotationDeg = 0 | 90 | 180 | 270;

export interface RectMm {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const FS_UNIT_PER_MM = 3072;

export function normalizeRotationDeg(raw?: number): RotationDeg {
  if (raw === undefined || raw === null || !Number.isFinite(raw)) return 0;
  const mod = ((Math.round(raw) % 360) + 360) % 360;
  if (mod === 90 || mod === 180 || mod === 270) return mod;
  return 0;
}

export function mirrorToFlippedCode(
  mirror?: MirrorMode,
  flipped?: boolean | number,
): FluidSimFlippedCode {
  if (mirror) {
    switch (mirror) {
      case 'horizontal':
        return 1;
      case 'vertical':
        return 2;
      case 'both':
        return 3;
      case 'none':
      default:
        return 0;
    }
  }
  if (flipped === true || flipped === 1) return 1;
  if (flipped === 2) return 2;
  if (flipped === 3) return 3;
  return 0;
}

export function flippedCodeToMirror(code: FluidSimFlippedCode | boolean | number | undefined): MirrorMode {
  if (code === true || code === 1) return 'horizontal';
  if (code === 2) return 'vertical';
  if (code === 3) return 'both';
  return 'none';
}

export function isHorizontalFlipped(code: FluidSimFlippedCode): boolean {
  return code === 1 || code === 3;
}

export function isVerticalFlipped(code: FluidSimFlippedCode): boolean {
  return code === 2 || code === 3;
}

/**
 * Computes transformed bounding-box dimensions (W', H') after D4 transform.
 */
export function transformBox(
  baseW: number,
  baseH: number,
  rot: RotationDeg,
  _flipped: FluidSimFlippedCode = 0,
): { w: number; h: number } {
  if (rot === 90 || rot === 270) {
    return { w: baseH, h: baseW };
  }
  return { w: baseW, h: baseH };
}

/**
 * Transforms a local point (x, y) inside [0..baseW] × [0..baseH] under FluidSIM 4.5's exact D4 action:
 *   1. Counter-clockwise rotation by `rot` degrees in screen coordinates (Y-down):
 *      - 0°:   (x, y)             in [0..W] × [0..H]
 *      - 90°:  (y, W - x)         in [0..H] × [0..W]   (CCW in Y-down screen space)
 *      - 180°: (W - x, H - y)     in [0..W] × [0..H]
 *      - 270°: (H - y, x)         in [0..H] × [0..W]
 *   2. Followed by reflection in the rotated box [0..W'] × [0..H']:
 *      - FLIPPED 1 (H):   x' = W' - x
 *      - FLIPPED 2 (V):   y' = H' - y
 *      - FLIPPED 3 (H+V): x' = W' - x, y' = H' - y
 */
export function transformPoint(
  x: number,
  y: number,
  baseW: number,
  baseH: number,
  rot: RotationDeg,
  flipped: FluidSimFlippedCode = 0,
): { x: number; y: number } {
  let rx = x;
  let ry = y;
  let boxW = baseW;
  let boxH = baseH;

  if (rot === 90) {
    rx = y;
    ry = baseW - x;
    boxW = baseH;
    boxH = baseW;
  } else if (rot === 180) {
    rx = baseW - x;
    ry = baseH - y;
  } else if (rot === 270) {
    rx = baseH - y;
    ry = x;
    boxW = baseH;
    boxH = baseW;
  }

  if (isHorizontalFlipped(flipped)) {
    rx = boxW - rx;
  }
  if (isVerticalFlipped(flipped)) {
    ry = boxH - ry;
  }

  return { x: rx, y: ry };
}

/**
 * Transforms a cardinal port exit normal (N | S | E | W) under the same D4 action.
 */
export function transformNormal(
  normal: PortNormal,
  rot: RotationDeg,
  flipped: FluidSimFlippedCode = 0,
): PortNormal {
  // Unit vector in screen coordinates (E=+x, W=-x, S=+y, N=-y)
  let dx = normal === 'E' ? 1 : normal === 'W' ? -1 : 0;
  let dy = normal === 'S' ? 1 : normal === 'N' ? -1 : 0;

  // Step 1: CCW rotation in Y-down screen space: (dx, dy) -> (dy, -dx) per 90° CCW
  if (rot === 90) {
    const nx = dy;
    const ny = -dx;
    dx = nx;
    dy = ny;
  } else if (rot === 180) {
    dx = -dx;
    dy = -dy;
  } else if (rot === 270) {
    const nx = -dy;
    const ny = dx;
    dx = nx;
    dy = ny;
  }

  // Step 2: Reflection
  if (isHorizontalFlipped(flipped)) dx = -dx;
  if (isVerticalFlipped(flipped)) dy = -dy;

  if (dx > 0) return 'E';
  if (dx < 0) return 'W';
  if (dy > 0) return 'S';
  return 'N';
}

export function normalToUnitVector(normal: PortNormal): { dx: number; dy: number } {
  switch (normal) {
    case 'N':
      return { dx: 0, dy: -1 };
    case 'S':
      return { dx: 0, dy: 1 };
    case 'E':
      return { dx: 1, dy: 0 };
    case 'W':
      return { dx: -1, dy: 0 };
  }
}

// =========================================================================
// Canonical SYM Vector Primitives & D4 Transformation
// =========================================================================

export type SymPrimitive =
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number; width?: number; style?: number }
  | { kind: 'rect'; x1: number; y1: number; x2: number; y2: number; fill?: boolean }
  | { kind: 'circle'; cx: number; cy: number; r: number; fill?: boolean }
  | {
      kind: 'arc';
      cx: number;
      cy: number;
      r: number;
      /** Start/end angles in degrees (0=E, 90=N, 180=W, 270=S standard math CCW, matching FluidSIM DXF arcs). */
      startDeg: number;
      endDeg: number;
    }
  | { kind: 'poly'; points: ReadonlyArray<{ x: number; y: number }>; fill?: boolean };

function normalizeAngleDeg(deg: number): number {
  const m = ((deg % 360) + 360) % 360;
  return Math.round(m * 100) / 100;
}

/**
 * Transforms an angle in standard mathematical CCW degrees (0=E, 90=N, 180=W, 270=S) under D4.
 * Note: Odd reflections (FLIPPED 1 or 2) reverse arc winding order, so startDeg & endDeg swap!
 */
function transformArcAngles(
  startDeg: number,
  endDeg: number,
  rot: RotationDeg,
  flipped: FluidSimFlippedCode,
): { startDeg: number; endDeg: number } {
  // Step 1: CCW rotation adds +rot degrees
  let a1 = normalizeAngleDeg(startDeg + rot);
  let a2 = normalizeAngleDeg(endDeg + rot);

  // Step 2: Reflections
  const flipH = isHorizontalFlipped(flipped);
  const flipV = isVerticalFlipped(flipped);
  if (flipH) {
    a1 = normalizeAngleDeg(180 - a1);
    a2 = normalizeAngleDeg(180 - a2);
  }
  if (flipV) {
    a1 = normalizeAngleDeg(360 - a1);
    a2 = normalizeAngleDeg(360 - a2);
  }

  // An odd number of reflections reverses CCW -> CW, so swap start & end to keep CCW arc span identical
  const isOddReflection = flipH !== flipV;
  if (isOddReflection) {
    return { startDeg: a2, endDeg: a1 };
  }
  return { startDeg: a1, endDeg: a2 };
}

/**
 * Transforms an array of canonical (rot=0, flip=0) vector primitives (in mm) through D4
 * into transformed coordinates (in mm) inside [0..W'] × [0..H'].
 */
export function transformSymPrimitivesMm(
  primitives: readonly SymPrimitive[],
  baseWMm: number,
  baseHMm: number,
  rot: RotationDeg,
  flipped: FluidSimFlippedCode = 0,
): SymPrimitive[] {
  const pt = (x: number, y: number) => transformPoint(x, y, baseWMm, baseHMm, rot, flipped);
  const out: SymPrimitive[] = [];

  for (const p of primitives) {
    if (p.kind === 'line') {
      const a = pt(p.x1, p.y1);
      const b = pt(p.x2, p.y2);
      out.push({ kind: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y, width: p.width, style: p.style });
    } else if (p.kind === 'rect') {
      const c1 = pt(p.x1, p.y1);
      const c2 = pt(p.x2, p.y2);
      out.push({
        kind: 'rect',
        x1: Math.min(c1.x, c2.x),
        y1: Math.min(c1.y, c2.y),
        x2: Math.max(c1.x, c2.x),
        y2: Math.max(c1.y, c2.y),
        fill: p.fill,
      });
    } else if (p.kind === 'circle') {
      const c = pt(p.cx, p.cy);
      out.push({ kind: 'circle', cx: c.x, cy: c.y, r: p.r, fill: p.fill });
    } else if (p.kind === 'arc') {
      const c = pt(p.cx, p.cy);
      const ang = transformArcAngles(p.startDeg, p.endDeg, rot, flipped);
      out.push({ kind: 'arc', cx: c.x, cy: c.y, r: p.r, startDeg: ang.startDeg, endDeg: ang.endDeg });
    } else if (p.kind === 'poly') {
      out.push({
        kind: 'poly',
        points: p.points.map((q) => pt(q.x, q.y)),
        fill: p.fill,
      });
    }
  }
  return out;
}

/**
 * Encodes canonical (rot=0, flip=0) mm primitives directly into authentic FluidSIM 4.5
 * `BEGINSYM` `SYM <idx>` numeric opcode lines (empirically verified against all 6 golden `.ct` files):
 *   - `1 x1 y1 x2 y2`                          — line segment (dashed lines subdivided into short `1` segments)
 *   - `3 cx cy r 0 2`                          — circle
 *   - `4 cx cy r startAng endAng 0 0 2`        — circular arc (angles in `Math.round(deg * 1024)`)
 *   - `5 x1 y1 x2 y2 x3 y3 x4 y4 0`            — filled 4-vertex polygon (triangles repeat vertex 3)
 *
 * IMPORTANT: FluidSIM 4.5 applies each object header's `rot` and `flip` natively when rendering
 * `dxf_prim_list` / `dxf_prim_list2` SYM blocks, so `BEGINSYM` primitives MUST remain unrotated
 * in canonical local raw units (`scale = unitPerMm`, default `FS_UNIT_PER_MM = 3072`).
 */
export function encodeSymPrimitivesToFluidSimLines(
  primitives: readonly SymPrimitive[],
  unitPerMm = FS_UNIT_PER_MM,
): string[] {
  const s = (v: number): number => Math.round(v * unitPerMm);
  const lines: string[] = [];

  for (const p of primitives) {
    if (p.kind === 'line') {
      if (p.style && p.style !== 0) {
        // Subdivide dashed/dotted lines into short authentic opcode-1 dash segments
        const dx = p.x2 - p.x1;
        const dy = p.y2 - p.y1;
        const len = Math.hypot(dx, dy);
        if (len > 1e-4) {
          const dashMm = 1.2;
          const gapMm = 0.8;
          const step = dashMm + gapMm;
          for (let d = 0; d < len; d += step) {
            const t0 = d / len;
            const t1 = Math.min(1, (d + dashMm) / len);
            lines.push(
              `1 ${s(p.x1 + dx * t0)} ${s(p.y1 + dy * t0)} ${s(p.x1 + dx * t1)} ${s(p.y1 + dy * t1)}`,
            );
          }
        }
      } else {
        lines.push(`1 ${s(p.x1)} ${s(p.y1)} ${s(p.x2)} ${s(p.y2)}`);
      }
    } else if (p.kind === 'rect') {
      const x1 = s(p.x1);
      const y1 = s(p.y1);
      const x2 = s(p.x2);
      const y2 = s(p.y2);
      if (p.fill) {
        lines.push(`5 ${x1} ${y1} ${x2} ${y1} ${x2} ${y2} ${x1} ${y2} 0`);
      } else {
        lines.push(`1 ${x1} ${y1} ${x2} ${y1}`);
        lines.push(`1 ${x2} ${y1} ${x2} ${y2}`);
        lines.push(`1 ${x2} ${y2} ${x1} ${y2}`);
        lines.push(`1 ${x1} ${y2} ${x1} ${y1}`);
      }
    } else if (p.kind === 'circle') {
      const cx = s(p.cx);
      const cy = s(p.cy);
      const r = Math.max(1, s(p.r));
      lines.push(`3 ${cx} ${cy} ${r} 0 2`);
    } else if (p.kind === 'arc') {
      const cx = s(p.cx);
      const cy = s(p.cy);
      const r = Math.max(1, s(p.r));
      const a1 = Math.round(normalizeAngleDeg(p.startDeg) * 1024);
      const a2 = Math.round(normalizeAngleDeg(p.endDeg) * 1024);
      lines.push(`4 ${cx} ${cy} ${r} ${a1} ${a2} 0 0 2`);
    } else if (p.kind === 'poly' && p.points.length >= 2) {
      if (p.fill && p.points.length === 3) {
        const [a, b, c] = p.points;
        lines.push(`5 ${s(a.x)} ${s(a.y)} ${s(b.x)} ${s(b.y)} ${s(c.x)} ${s(c.y)} ${s(c.x)} ${s(c.y)} 0`);
      } else if (p.fill && p.points.length === 4) {
        const [a, b, c, d] = p.points;
        lines.push(`5 ${s(a.x)} ${s(a.y)} ${s(b.x)} ${s(b.y)} ${s(c.x)} ${s(c.y)} ${s(d.x)} ${s(d.y)} 0`);
      } else if (p.fill && p.points.length > 4) {
        const a = p.points[0];
        for (let i = 1; i < p.points.length - 1; i++) {
          const b = p.points[i];
          const c = p.points[i + 1];
          lines.push(`5 ${s(a.x)} ${s(a.y)} ${s(b.x)} ${s(b.y)} ${s(c.x)} ${s(c.y)} ${s(c.x)} ${s(c.y)} 0`);
        }
      } else {
        for (let i = 0; i < p.points.length; i++) {
          const a = p.points[i];
          const b = p.points[(i + 1) % p.points.length];
          lines.push(`1 ${s(a.x)} ${s(a.y)} ${s(b.x)} ${s(b.y)}`);
        }
      }
    }
  }
  return lines;
}
