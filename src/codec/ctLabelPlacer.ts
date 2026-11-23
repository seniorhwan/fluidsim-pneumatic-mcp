/**
 * 2D Collision-Free Label & Section-Header Placer (FluidSIM-MCP v2)
 *
 * Replaces all hardcoded text-component coordinates from v1 with a general
 * collision-aware 2D placement engine that checks:
 *  - Every component bounding box (including valve actuation extensions)
 *  - Extended piston-rod envelopes on actuators
 *  - Distance rules (R_SCHALT) and title-block / drawing-border reserved zones
 *  - All already-placed labels (designation + section headers)
 *  - All routed orthogonal wire segments (minimizing label-over-wire hits)
 */

import type { RectMm } from './ctTransform';

export interface WireSegmentMm {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  netId?: string;
}

export interface LabelableSymbol {
  id: string;
  type: string;
  label?: string;
  sectionLabel?: string;
  boxMm: RectMm;
  pistonRodBoxMm?: RectMm;
  isActuator?: boolean;
  isValve?: boolean;
  isJunction?: boolean;
}

export interface PlacedTextLabel {
  id: string;
  ownerId: string;
  kind: 'designation' | 'section';
  text: string;
  xMm: number;
  yMm: number;
  widthMm: number;
  heightMm: number;
  fontSizeMm: number;
  boxMm: RectMm;
  hadObstacleOverlap: boolean;
  wireHitCount: number;
}

export interface LabelPlacementInput {
  symbols: LabelableSymbol[];
  wireSegmentsMm: WireSegmentMm[];
  sheetBoundsMm: RectMm;
  reservedBoxesMm?: RectMm[];
  /** Font height in mm for component designations (default 3.0mm). */
  designationFontMm?: number;
  /** Font height in mm for section banners (default 3.8mm). */
  sectionFontMm?: number;
}

export interface LabelOverlapMetrics {
  labelObstacleOverlaps: number;
  labelLabelOverlaps: number;
  labelWireHits: number;
  labelOutOfBounds: number;
  details: string[];
}

export function rectOverlapArea(a: RectMm, b: RectMm, padMm = 0): number {
  const ox = Math.min(a.x + a.width, b.x + b.width + padMm) - Math.max(a.x, b.x - padMm);
  const oy = Math.min(a.y + a.height, b.y + b.height + padMm) - Math.max(a.y, b.y - padMm);
  if (ox <= 0.05 || oy <= 0.05) return 0;
  return ox * oy;
}

export function segmentIntersectsRect(seg: WireSegmentMm, rect: RectMm, padMm = 0.5): boolean {
  const rx1 = rect.x - padMm;
  const ry1 = rect.y - padMm;
  const rx2 = rect.x + rect.width + padMm;
  const ry2 = rect.y + rect.height + padMm;

  const minX = Math.min(seg.x1, seg.x2);
  const maxX = Math.max(seg.x1, seg.x2);
  const minY = Math.min(seg.y1, seg.y2);
  const maxY = Math.max(seg.y1, seg.y2);

  if (maxX < rx1 || minX > rx2 || maxY < ry1 || minY > ry2) return false;

  // Orthogonal segments (common case)
  if (Math.abs(seg.x1 - seg.x2) < 0.05 || Math.abs(seg.y1 - seg.y2) < 0.05) {
    return true;
  }

  // General Liang-Barsky test for slanted segments
  let t0 = 0;
  let t1 = 1;
  const dx = seg.x2 - seg.x1;
  const dy = seg.y2 - seg.y1;
  const checks: Array<[number, number]> = [
    [-dx, seg.x1 - rx1],
    [dx, rx2 - seg.x1],
    [-dy, seg.y1 - ry1],
    [dy, ry2 - seg.y1],
  ];
  for (const [p, q] of checks) {
    if (Math.abs(p) < 1e-6) {
      if (q < 0) return false;
    } else {
      const r = q / p;
      if (p < 0) {
        if (r > t1) return false;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return false;
        if (r < t1) t1 = r;
      }
    }
  }
  return t0 <= t1;
}

export function estimateTextBoxSizeMm(text: string, fontSizeMm: number): { width: number; height: number } {
  const lines = text.split('\n');
  const maxChars = Math.max(1, ...lines.map((l) => l.length));
  const width = Number(Math.max(4.5, maxChars * fontSizeMm * 0.62 + 1.4).toFixed(2));
  const height = Number(Math.max(3.6, lines.length * (fontSizeMm + 1.0) + 0.8).toFixed(2));
  return { width, height };
}

function isInsideBounds(box: RectMm, bounds: RectMm): boolean {
  return (
    box.x >= bounds.x - 0.1 &&
    box.y >= bounds.y - 0.1 &&
    box.x + box.width <= bounds.x + bounds.width + 0.1 &&
    box.y + box.height <= bounds.y + bounds.height + 0.1
  );
}

function clampToBounds(box: RectMm, bounds: RectMm): RectMm {
  const x = Math.max(bounds.x, Math.min(bounds.x + bounds.width - box.width, box.x));
  const y = Math.max(bounds.y, Math.min(bounds.y + bounds.height - box.height, box.y));
  return { x: Number(x.toFixed(2)), y: Number(y.toFixed(2)), width: box.width, height: box.height };
}

function generateCandidatePositions(
  sym: LabelableSymbol,
  w: number,
  h: number,
): Array<{ x: number; y: number; prefPenalty: number }> {
  const b = sym.boxMm;
  const gap = 1.8;
  const cx = b.x + b.width / 2 - w / 2;
  const cy = b.y + b.height / 2 - h / 2;

  const base: Array<{ x: number; y: number; prefPenalty: number }> = [];

  if (sym.isActuator) {
    // Actuators look cleanest labeled above-left, above-center, below-center, or to the left
    base.push(
      { x: b.x, y: b.y - h - gap, prefPenalty: 0 },
      { x: cx, y: b.y - h - gap, prefPenalty: 1 },
      { x: b.x - w - gap, y: cy, prefPenalty: 2 },
      { x: cx, y: b.y + b.height + gap, prefPenalty: 3 },
      { x: b.x, y: b.y + b.height + gap, prefPenalty: 4 },
      { x: b.x + b.width + gap, y: cy, prefPenalty: 6 },
    );
  } else if (sym.isValve) {
    // Directional valves have ports top & bottom and actuators left & right;
    // top-left, bottom-left, left-mid, and right-mid stay clearest of ports/wires
    base.push(
      { x: b.x - w - gap, y: cy, prefPenalty: 0 },
      { x: b.x - w - gap, y: b.y, prefPenalty: 1 },
      { x: b.x + b.width + gap, y: cy, prefPenalty: 2 },
      { x: b.x + b.width + gap, y: b.y, prefPenalty: 3 },
      { x: b.x - w - gap, y: b.y + b.height - h, prefPenalty: 4 },
      { x: b.x + b.width + gap, y: b.y + b.height - h, prefPenalty: 5 },
      { x: cx, y: b.y - h - gap, prefPenalty: 7 },
      { x: cx, y: b.y + b.height + gap, prefPenalty: 8 },
    );
  } else {
    // General inline components (throttles, check valves, filters, gauges, switches, coils)
    base.push(
      { x: b.x + b.width + gap, y: cy, prefPenalty: 0 },
      { x: b.x - w - gap, y: cy, prefPenalty: 1 },
      { x: cx, y: b.y - h - gap, prefPenalty: 2 },
      { x: cx, y: b.y + b.height + gap, prefPenalty: 3 },
      { x: b.x + b.width + gap, y: b.y - h * 0.5, prefPenalty: 4 },
      { x: b.x - w - gap, y: b.y - h * 0.5, prefPenalty: 5 },
      { x: b.x + b.width + gap, y: b.y + b.height - h * 0.5, prefPenalty: 6 },
      { x: b.x - w - gap, y: b.y + b.height - h * 0.5, prefPenalty: 7 },
    );
  }

  // Secondary ring offsets if immediate perimeter is congested
  const ringOffsets = [4.5, 8.5, 13.0];
  for (const off of ringOffsets) {
    base.push(
      { x: b.x - w - gap - off, y: cy, prefPenalty: 10 + off },
      { x: b.x + b.width + gap + off, y: cy, prefPenalty: 11 + off },
      { x: cx, y: b.y - h - gap - off, prefPenalty: 12 + off },
      { x: cx, y: b.y + b.height + gap + off, prefPenalty: 13 + off },
      { x: b.x - w - gap - off, y: b.y - h - gap, prefPenalty: 14 + off },
      { x: b.x + b.width + gap + off, y: b.y - h - gap, prefPenalty: 15 + off },
      { x: b.x - w - gap - off, y: b.y + b.height + gap, prefPenalty: 16 + off },
      { x: b.x + b.width + gap + off, y: b.y + b.height + gap, prefPenalty: 17 + off },
    );
  }

  return base;
}

/**
 * Places component designation labels and section headers without overlapping
 * component bodies, piston rods, reserved regions, other labels, or routed wires.
 */
export function placeSchematicLabels(input: LabelPlacementInput): PlacedTextLabel[] {
  const {
    symbols,
    wireSegmentsMm,
    sheetBoundsMm,
    reservedBoxesMm = [],
    designationFontMm = 2.8,
    sectionFontMm = 3.6,
  } = input;

  const obstacles: RectMm[] = [...reservedBoxesMm];
  for (const s of symbols) {
    obstacles.push(s.boxMm);
    if (s.pistonRodBoxMm) obstacles.push(s.pistonRodBoxMm);
  }

  const placed: PlacedTextLabel[] = [];

  const scoreBox = (
    cand: RectMm,
    prefPenalty: number,
  ): { score: number; obstacleHit: boolean; wireHits: number } => {
    let score = prefPenalty;
    let obstacleHit = false;

    if (!isInsideBounds(cand, sheetBoundsMm)) {
      score += 20_000;
      obstacleHit = true;
    }

    for (const obs of obstacles) {
      const area = rectOverlapArea(cand, obs, 0.4);
      if (area > 0) {
        score += 5_000 + area * 200;
        obstacleHit = true;
      }
    }

    for (const pl of placed) {
      const area = rectOverlapArea(cand, pl.boxMm, 0.5);
      if (area > 0) {
        score += 4_000 + area * 200;
        obstacleHit = true;
      }
    }

    let wireHits = 0;
    for (const seg of wireSegmentsMm) {
      if (segmentIntersectsRect(seg, cand, 0.45)) {
        wireHits += 1;
        score += 220;
      }
    }

    return { score, obstacleHit, wireHits };
  };

  // 1. Place section headers first (top of each functional section group)
  const sections = new Map<string, LabelableSymbol[]>();
  for (const s of symbols) {
    if (!s.sectionLabel) continue;
    const list = sections.get(s.sectionLabel) ?? [];
    list.push(s);
    sections.set(s.sectionLabel, list);
  }

  let sectionIdx = 0;
  for (const [secTitle, groupSyms] of sections.entries()) {
    sectionIdx += 1;
    const minX = Math.min(...groupSyms.map((s) => s.boxMm.x));
    const maxX = Math.max(...groupSyms.map((s) => s.boxMm.x + s.boxMm.width));
    const minY = Math.min(...groupSyms.map((s) => s.boxMm.y));
    const maxY = Math.max(...groupSyms.map((s) => s.boxMm.y + s.boxMm.height));
    const { width, height } = estimateTextBoxSizeMm(secTitle, sectionFontMm);

    const centerX = (minX + maxX) / 2 - width / 2;
    const candidates: Array<{ x: number; y: number; prefPenalty: number }> = [
      { x: centerX, y: Math.max(sheetBoundsMm.y + 1, minY - height - 5), prefPenalty: 0 },
      { x: minX, y: Math.max(sheetBoundsMm.y + 1, minY - height - 5), prefPenalty: 2 },
      { x: maxX - width, y: Math.max(sheetBoundsMm.y + 1, minY - height - 5), prefPenalty: 3 },
      { x: centerX, y: sheetBoundsMm.y + 2, prefPenalty: 4 },
      { x: minX, y: sheetBoundsMm.y + 2, prefPenalty: 5 },
      { x: maxX - width, y: sheetBoundsMm.y + 2, prefPenalty: 6 },
      { x: centerX, y: Math.max(sheetBoundsMm.y + 1, minY - height - 11), prefPenalty: 7 },
      { x: minX, y: Math.max(sheetBoundsMm.y + 1, minY - height - 11), prefPenalty: 8 },
      { x: centerX, y: Math.max(sheetBoundsMm.y + 1, minY - height - 18), prefPenalty: 9 },
      { x: centerX, y: maxY + 5, prefPenalty: 10 },
      { x: minX, y: maxY + 5, prefPenalty: 11 },
      { x: maxX - width, y: maxY + 5, prefPenalty: 12 },
      { x: centerX, y: maxY + 12, prefPenalty: 14 },
      { x: minX - width - 4, y: minY, prefPenalty: 16 },
      { x: maxX + 4, y: minY, prefPenalty: 17 },
      { x: centerX, y: sheetBoundsMm.y + 8, prefPenalty: 18 },
      { x: minX + 12, y: sheetBoundsMm.y + 2, prefPenalty: 19 },
      { x: minX - 12, y: sheetBoundsMm.y + 2, prefPenalty: 20 },
    ];

    let bestBox = clampToBounds({ x: centerX, y: sheetBoundsMm.y + 2, width, height }, sheetBoundsMm);
    let bestScore = Number.POSITIVE_INFINITY;
    let bestObsHit = true;
    let bestWireHits = 0;

    for (const c of candidates) {
      const box = clampToBounds({ x: c.x, y: c.y, width, height }, sheetBoundsMm);
      const res = scoreBox(box, c.prefPenalty);
      if (res.score < bestScore) {
        bestScore = res.score;
        bestBox = box;
        bestObsHit = res.obstacleHit;
        bestWireHits = res.wireHits;
      }
    }

    placed.push({
      id: `sec_label_${sectionIdx}`,
      ownerId: groupSyms[0].id,
      kind: 'section',
      text: secTitle,
      xMm: bestBox.x,
      yMm: bestBox.y,
      widthMm: bestBox.width,
      heightMm: bestBox.height,
      fontSizeMm: sectionFontMm,
      boxMm: bestBox,
      hadObstacleOverlap: bestObsHit,
      wireHitCount: bestWireHits,
    });
  }

  // 2. Place component designation labels (deterministic order: top-to-bottom, left-to-right)
  const labelTargets = symbols
    .filter((s) => !s.isJunction && s.label && s.label.trim().length > 0)
    .slice()
    .sort((a, b) => a.boxMm.y - b.boxMm.y || a.boxMm.x - b.boxMm.x || a.id.localeCompare(b.id));

  for (const sym of labelTargets) {
    const text = sym.label!.trim();
    const { width, height } = estimateTextBoxSizeMm(text, designationFontMm);
    const candidates = generateCandidatePositions(sym, width, height);

    let bestBox = clampToBounds(
      { x: sym.boxMm.x + sym.boxMm.width + 1.8, y: sym.boxMm.y, width, height },
      sheetBoundsMm,
    );
    let bestScore = Number.POSITIVE_INFINITY;
    let bestObsHit = true;
    let bestWireHits = 0;

    for (const c of candidates) {
      const box = clampToBounds({ x: c.x, y: c.y, width, height }, sheetBoundsMm);
      const res = scoreBox(box, c.prefPenalty);
      if (res.score < bestScore) {
        bestScore = res.score;
        bestBox = box;
        bestObsHit = res.obstacleHit;
        bestWireHits = res.wireHits;
        if (!res.obstacleHit && res.wireHits === 0 && c.prefPenalty <= 2) {
          break;
        }
      }
    }

    placed.push({
      id: `lbl_${sym.id}`,
      ownerId: sym.id,
      kind: 'designation',
      text,
      xMm: bestBox.x,
      yMm: bestBox.y,
      widthMm: bestBox.width,
      heightMm: bestBox.height,
      fontSizeMm: designationFontMm,
      boxMm: bestBox,
      hadObstacleOverlap: bestObsHit,
      wireHitCount: bestWireHits,
    });
  }

  return placed;
}

/**
 * Evaluates collision metrics for a placed label set against obstacles, other labels, and wires.
 */
export function evaluateLabelMetrics(
  labels: PlacedTextLabel[],
  obstacles: RectMm[],
  wireSegmentsMm: WireSegmentMm[],
  sheetBoundsMm: RectMm,
): LabelOverlapMetrics {
  let labelObstacleOverlaps = 0;
  let labelLabelOverlaps = 0;
  let labelWireHits = 0;
  let labelOutOfBounds = 0;
  const details: string[] = [];

  for (let i = 0; i < labels.length; i++) {
    const lbl = labels[i];
    if (!isInsideBounds(lbl.boxMm, sheetBoundsMm)) {
      labelOutOfBounds += 1;
      details.push(`Label "${lbl.text}" (${lbl.ownerId}) extends outside safe sheet bounds.`);
    }
    for (const obs of obstacles) {
      if (rectOverlapArea(lbl.boxMm, obs, 0) > 0.25) {
        labelObstacleOverlaps += 1;
        details.push(`Label "${lbl.text}" (${lbl.ownerId}) overlaps a component/obstacle box.`);
        break;
      }
    }
    for (let j = i + 1; j < labels.length; j++) {
      if (rectOverlapArea(lbl.boxMm, labels[j].boxMm, 0) > 0.2) {
        labelLabelOverlaps += 1;
        details.push(`Labels "${lbl.text}" and "${labels[j].text}" overlap.`);
      }
    }
    for (const seg of wireSegmentsMm) {
      if (segmentIntersectsRect(seg, lbl.boxMm, 0.25)) {
        labelWireHits += 1;
        break;
      }
    }
  }

  return {
    labelObstacleOverlaps,
    labelLabelOverlaps,
    labelWireHits,
    labelOutOfBounds,
    details,
  };
}
