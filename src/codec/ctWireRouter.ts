import { parseCtBodyAst } from './ctTextCodec';

export interface RawPoint {
  x: number;
  y: number;
}

export interface CtRoutingObstacle {
  ownerId: number;
  cls: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface CtRoutingPort {
  objId: number;
  parentId: number;
  cls: string;
  cx: number;
  cy: number;
  hidden: boolean;
}

export interface CtRoutingEdge {
  key: string;
  fromPortId: number;
  toPortId: number;
  isManifoldBridge?: boolean;
}

export interface CtSheetBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface CtWireGeometryReport {
  ok: boolean;
  outOfBoundsObjects: Array<{ cls: string; objId: number; x1: number; y1: number; x2: number; y2: number }>;
  outOfBoundsSegments: Array<{ portObjId: number; ax: number; ay: number; bx: number; by: number }>;
  linesThroughComponents: Array<{ portObjId: number; cls: string; ownerId: number }>;
  linesThroughConnections: Array<{ portObjId: number; hitPortObjId: number; cx: number; cy: number }>;
  superimposedLines: Array<{ portObjA: number; portObjB: number; axis: 'H' | 'V'; coord: number }>;
}

const PORT_CLASSES = new Set(['PConnection', 'EConnection', 'UEConnection', 'UMConnection']);
const CHECKED_PORT_CLASSES = new Set(['PConnection', 'EConnection']);
const JUNCTION_CLASSES = new Set(['PTriconnection', 'ETriconnection']);

export function getFluidSimPrintableBounds(sheetWidthMm: number, sheetHeightMm: number): CtSheetBounds {
  if (sheetWidthMm > 300 || sheetHeightMm > 220) {
    return {
      minX: 6144,
      minY: 6144,
      maxX: 1105920,
      maxY: 829440,
    };
  }
  return {
    minX: 6144,
    minY: 6144,
    maxX: 819200,
    maxY: 583680,
  };
}

interface HorizSeg {
  y: number;
  minX: number;
  maxX: number;
}

interface VertSeg {
  x: number;
  minY: number;
  maxY: number;
}

function segmentIntersectsRect(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): boolean {
  const minX = Math.min(ax, bx);
  const maxX = Math.max(ax, bx);
  const minY = Math.min(ay, by);
  const maxY = Math.max(ay, by);
  return maxX >= x1 && minX <= x2 && maxY >= y1 && minY <= y2;
}

function pointInsideRect(x: number, y: number, x1: number, y1: number, x2: number, y2: number): boolean {
  return x >= x1 && x <= x2 && y >= y1 && y <= y2;
}

export function simplifyOrthogonalPath(rawPts: readonly RawPoint[]): RawPoint[] {
  if (rawPts.length <= 1) return rawPts.map((p) => ({ x: p.x, y: p.y }));
  const deduped: RawPoint[] = [{ x: rawPts[0].x, y: rawPts[0].y }];
  for (let i = 1; i < rawPts.length; i++) {
    const prev = deduped[deduped.length - 1];
    const cur = rawPts[i];
    if (prev.x === cur.x && prev.y === cur.y) continue;
    deduped.push({ x: cur.x, y: cur.y });
  }
  const merged: RawPoint[] = [];
  for (const p of deduped) {
    if (merged.length >= 2) {
      const a = merged[merged.length - 2];
      const b = merged[merged.length - 1];
      if ((a.x === b.x && b.x === p.x) || (a.y === b.y && b.y === p.y)) {
        merged[merged.length - 1] = p;
        continue;
      }
    }
    merged.push(p);
  }
  return merged;
}

class MinHeap<T> {
  private readonly items: Array<{ key: number; val: T }> = [];

  get size(): number {
    return this.items.length;
  }

  push(key: number, val: T): void {
    this.items.push({ key, val });
    let i = this.items.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.items[p].key <= this.items[i].key) break;
      const tmp = this.items[p];
      this.items[p] = this.items[i];
      this.items[i] = tmp;
      i = p;
    }
  }

  pop(): { key: number; val: T } | undefined {
    if (this.items.length === 0) return undefined;
    const top = this.items[0];
    const last = this.items.pop()!;
    if (this.items.length > 0) {
      this.items[0] = last;
      let i = 0;
      const n = this.items.length;
      while (true) {
        const l = i * 2 + 1;
        const r = l + 1;
        let smallest = i;
        if (l < n && this.items[l].key < this.items[smallest].key) smallest = l;
        if (r < n && this.items[r].key < this.items[smallest].key) smallest = r;
        if (smallest === i) break;
        const tmp = this.items[i];
        this.items[i] = this.items[smallest];
        this.items[smallest] = tmp;
        i = smallest;
      }
    }
    return top;
  }
}

function buildTrackCoords(
  mandatory: readonly number[],
  candidates: readonly number[],
  minBound: number,
  maxBound: number,
): number[] {
  const mandatorySorted = Array.from(new Set(mandatory)).sort((a, b) => a - b);
  const tracks: number[] = [...mandatorySorted];
  const allCandidates = [...candidates];
  for (let v = minBound; v <= maxBound; v += 15360) {
    allCandidates.push(v);
  }
  allCandidates.sort((a, b) => a - b);
  for (const c of allCandidates) {
    if (c < minBound || c > maxBound) continue;
    if (tracks.some((t) => Math.abs(t - c) < 3072)) continue;
    tracks.push(c);
  }
  tracks.sort((a, b) => a - b);
  return tracks;
}

export function routeCtConnections(input: {
  bounds: CtSheetBounds;
  obstacles: readonly CtRoutingObstacle[];
  ports: ReadonlyMap<number, CtRoutingPort>;
  edges: readonly CtRoutingEdge[];
}): Map<string, RawPoint[]> {
  const { bounds, obstacles, ports, edges } = input;
  const result = new Map<string, RawPoint[]>();

  const mandatoryX: number[] = [];
  const mandatoryY: number[] = [];
  const candidateX: number[] = [];
  const candidateY: number[] = [];

  for (const p of ports.values()) {
    mandatoryX.push(p.cx);
    mandatoryY.push(p.cy);
    candidateX.push(p.cx - 9216, p.cx + 9216);
    candidateY.push(p.cy - 9216, p.cy + 9216);
  }
  for (const obs of obstacles) {
    candidateX.push(obs.x1 - 9216, obs.x2 + 9216);
    candidateY.push(obs.y1 - 9216, obs.y2 + 9216);
  }

  const xs = buildTrackCoords(mandatoryX, candidateX, bounds.minX, bounds.maxX);
  const ys = buildTrackCoords(mandatoryY, candidateY, bounds.minY, bounds.maxY);
  const xIndex = new Map<number, number>(xs.map((v, i) => [v, i]));
  const yIndex = new Map<number, number>(ys.map((v, i) => [v, i]));

  const routedHoriz: HorizSeg[] = [];
  const routedVert: VertSeg[] = [];
  const allPorts = Array.from(ports.values()).filter((p) => CHECKED_PORT_CLASSES.has(p.cls));

  const recordPath = (pts: readonly RawPoint[]): void => {
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      if (a.y === b.y && a.x !== b.x) {
        routedHoriz.push({ y: a.y, minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x) });
      } else if (a.x === b.x && a.y !== b.y) {
        routedVert.push({ x: a.x, minY: Math.min(a.y, b.y), maxY: Math.max(a.y, b.y) });
      }
    }
  };

  const countCrossings = (ax: number, ay: number, bx: number, by: number): number => {
    let count = 0;
    if (ay === by) {
      const minX = Math.min(ax, bx);
      const maxX = Math.max(ax, bx);
      for (const v of routedVert) {
        if (v.x > minX && v.x < maxX && ay > v.minY && ay < v.maxY) count++;
      }
    } else if (ax === bx) {
      const minY = Math.min(ay, by);
      const maxY = Math.max(ay, by);
      for (const h of routedHoriz) {
        if (h.y > minY && h.y < maxY && ax > h.minX && ax < h.maxX) count++;
      }
    }
    return count;
  };

  const isSegmentValid = (
    ax: number,
    ay: number,
    bx: number,
    by: number,
    portA: CtRoutingPort,
    portB: CtRoutingPort,
    parallelGap: number,
    avoidHiddenPorts: boolean,
    allowSharedEndpointStem = false,
  ): boolean => {
    if (ax === bx && ay === by) return true;
    const minX = Math.min(ax, bx);
    const maxX = Math.max(ax, bx);
    const minY = Math.min(ay, by);
    const maxY = Math.max(ay, by);

    // 1. Sheet bounds check (allow stepping inward if an endpoint port lies outside)
    const allowedMinX = Math.min(bounds.minX, portA.cx, portB.cx);
    const allowedMaxX = Math.max(bounds.maxX, portA.cx, portB.cx);
    const allowedMinY = Math.min(bounds.minY, portA.cy, portB.cy);
    const allowedMaxY = Math.max(bounds.maxY, portA.cy, portB.cy);
    if (minX < allowedMinX || maxX > allowedMaxX || minY < allowedMinY || maxY > allowedMaxY) {
      return false;
    }

    // 2. Component obstacle check
    for (const obs of obstacles) {
      const isEndpointComp = obs.ownerId === portA.parentId || obs.ownerId === portB.parentId;
      if (!isEndpointComp) {
        if (segmentIntersectsRect(ax, ay, bx, by, obs.x1 - 512, obs.y1 - 512, obs.x2 + 512, obs.y2 + 512)) {
          return false;
        }
      } else if (!JUNCTION_CLASSES.has(obs.cls)) {
        const ix1 = obs.x1 + 1024;
        const iy1 = obs.y1 + 1024;
        const ix2 = obs.x2 - 1024;
        const iy2 = obs.y2 - 1024;
        if (ix1 < ix2 && iy1 < iy2) {
          const portInside =
            (obs.ownerId === portA.parentId && pointInsideRect(portA.cx, portA.cy, ix1, iy1, ix2, iy2)) ||
            (obs.ownerId === portB.parentId && pointInsideRect(portB.cx, portB.cy, ix1, iy1, ix2, iy2));
          if (!portInside && segmentIntersectsRect(ax, ay, bx, by, ix1, iy1, ix2, iy2)) {
            return false;
          }
        }
      }
    }

    // 3. Port dot check (Lines through connections)
    for (const p of allPorts) {
      if (!avoidHiddenPorts && p.hidden) continue;
      if (p.objId === portA.objId || p.objId === portB.objId) continue;
      if (p.cx === portA.cx && p.cy === portA.cy) continue;
      if (p.cx === portB.cx && p.cy === portB.cy) continue;
      if (segmentIntersectsRect(ax, ay, bx, by, p.cx - 5632, p.cy - 5632, p.cx + 5632, p.cy + 5632)) {
        return false;
      }
    }

    // 4. Collinear overlap check (Superimposed lines)
    const touchesEndpoint =
      allowSharedEndpointStem &&
      ((ax === portA.cx && ay === portA.cy) ||
        (bx === portA.cx && by === portA.cy) ||
        (ax === portB.cx && ay === portB.cy) ||
        (bx === portB.cx && by === portB.cy));
    if (!touchesEndpoint) {
      if (ay === by) {
        for (const s of routedHoriz) {
          if (Math.abs(ay - s.y) < parallelGap && Math.min(maxX, s.maxX) - Math.max(minX, s.minX) > 0) {
            return false;
          }
        }
      } else if (ax === bx) {
        for (const s of routedVert) {
          if (Math.abs(ax - s.x) < parallelGap && Math.min(maxY, s.maxY) - Math.max(minY, s.minY) > 0) {
            return false;
          }
        }
      }
    }

    return true;
  };

  const nearParallelPenalty = (ax: number, ay: number, bx: number, by: number): number => {
    if (ay === by) {
      const minX = Math.min(ax, bx);
      const maxX = Math.max(ax, bx);
      for (const s of routedHoriz) {
        if (Math.abs(ay - s.y) < 6144 && Math.min(maxX, s.maxX) - Math.max(minX, s.minX) > 0) {
          return 8000;
        }
      }
    } else if (ax === bx) {
      const minY = Math.min(ay, by);
      const maxY = Math.max(ay, by);
      for (const s of routedVert) {
        if (Math.abs(ax - s.x) < 6144 && Math.min(maxY, s.maxY) - Math.max(minY, s.minY) > 0) {
          return 8000;
        }
      }
    }
    return 0;
  };

  const isPathValidZeroCross = (
    pts: readonly RawPoint[],
    portA: CtRoutingPort,
    portB: CtRoutingPort,
  ): boolean => {
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      if (!isSegmentValid(a.x, a.y, b.x, b.y, portA, portB, 4096, true)) return false;
      if (countCrossings(a.x, a.y, b.x, b.y) > 0) return false;
    }
    return true;
  };

  const runAStar = (
    portA: CtRoutingPort,
    portB: CtRoutingPort,
    parallelGap: number,
    avoidHiddenPorts: boolean,
    allowSharedEndpointStem = false,
  ): RawPoint[] | null => {
    const sx = xIndex.get(portA.cx);
    const sy = yIndex.get(portA.cy);
    const gx = xIndex.get(portB.cx);
    const gy = yIndex.get(portB.cy);
    if (sx === undefined || sy === undefined || gx === undefined || gy === undefined) {
      return null;
    }

    const nX = xs.length;
    const nY = ys.length;
    const totalStates = nX * nY * 3;
    const dist = new Float64Array(totalStates);
    dist.fill(Number.POSITIVE_INFINITY);
    const parent = new Int32Array(totalStates);
    parent.fill(-1);

    const stateId = (ix: number, iy: number, dir: number): number => (iy * nX + ix) * 3 + dir;
    const startState = stateId(sx, sy, 0);
    dist[startState] = 0;

    const heap = new MinHeap<number>();
    const hStart = Math.abs(portA.cx - portB.cx) + Math.abs(portA.cy - portB.cy);
    heap.push(hStart, startState);

    const dirs: Array<{ dx: number; dy: number; dir: number }> = [
      { dx: 1, dy: 0, dir: 1 },
      { dx: -1, dy: 0, dir: 1 },
      { dx: 0, dy: 1, dir: 2 },
      { dx: 0, dy: -1, dir: 2 },
    ];

    let goalState = -1;
    let expansions = 0;
    const maxExpansions = 40000;

    while (heap.size > 0 && expansions < maxExpansions) {
      const top = heap.pop()!;
      const sId = top.val;
      const d = dist[sId];
      if (top.key > d + Math.abs(xs[Math.floor((sId / 3) % nX)] - portB.cx) + Math.abs(ys[Math.floor(sId / 3 / nX)] - portB.cy) + 30001) {
        continue;
      }

      const cellIdx = Math.floor(sId / 3);
      const prevDir = sId % 3;
      const ix = cellIdx % nX;
      const iy = Math.floor(cellIdx / nX);

      if (ix === gx && iy === gy) {
        goalState = sId;
        break;
      }

      expansions++;
      const curX = xs[ix];
      const curY = ys[iy];

      for (const step of dirs) {
        const nx = ix + step.dx;
        const ny = iy + step.dy;
        if (nx < 0 || nx >= nX || ny < 0 || ny >= nY) continue;
        const nextX = xs[nx];
        const nextY = ys[ny];
        if (!isSegmentValid(curX, curY, nextX, nextY, portA, portB, parallelGap, avoidHiddenPorts, allowSharedEndpointStem)) {
          continue;
        }
        const stepDist = Math.abs(nextX - curX) + Math.abs(nextY - curY);
        const bendCost = prevDir !== 0 && prevDir !== step.dir ? 30000 : 0;
        const crossCost = countCrossings(curX, curY, nextX, nextY) * 45000;
        const nearCost = nearParallelPenalty(curX, curY, nextX, nextY);
        const nd = d + stepDist + bendCost + crossCost + nearCost;
        const nState = stateId(nx, ny, step.dir);
        if (nd < dist[nState]) {
          dist[nState] = nd;
          parent[nState] = sId;
          const heur =
            Math.abs(nextX - portB.cx) +
            Math.abs(nextY - portB.cy) +
            (nextX !== portB.cx && nextY !== portB.cy ? 30000 : 0);
          heap.push(nd + heur, nState);
        }
      }
    }

    if (goalState < 0) return null;

    const rawPath: RawPoint[] = [];
    let cur = goalState;
    while (cur >= 0) {
      const cellIdx = Math.floor(cur / 3);
      const ix = cellIdx % nX;
      const iy = Math.floor(cellIdx / nX);
      rawPath.push({ x: xs[ix], y: ys[iy] });
      cur = parent[cur];
    }
    rawPath.reverse();
    return simplifyOrthogonalPath(rawPath);
  };

  // Partition into manifold bridges (routed first) and normal edges (sorted shortest Manhattan first)
  const bridgeEdges = edges.filter((e) => e.isManifoldBridge);
  const normalEdges = edges
    .filter((e) => !e.isManifoldBridge)
    .sort((a, b) => {
      const paA = ports.get(a.fromPortId);
      const paB = ports.get(a.toPortId);
      const pbA = ports.get(b.fromPortId);
      const pbB = ports.get(b.toPortId);
      const dA = paA && paB ? Math.abs(paA.cx - paB.cx) + Math.abs(paA.cy - paB.cy) : 0;
      const dB = pbA && pbB ? Math.abs(pbA.cx - pbB.cx) + Math.abs(pbA.cy - pbB.cy) : 0;
      if (dA !== dB) return dA - dB;
      return a.key.localeCompare(b.key);
    });

  for (const edge of bridgeEdges) {
    const portA = ports.get(edge.fromPortId);
    const portB = ports.get(edge.toPortId);
    if (!portA || !portB) continue;
    const pts = simplifyOrthogonalPath([
      { x: portA.cx, y: portA.cy },
      ...(portA.cx !== portB.cx && portA.cy !== portB.cy ? [{ x: portB.cx, y: portA.cy }] : []),
      { x: portB.cx, y: portB.cy },
    ]);
    recordPath(pts);
    result.set(edge.key, pts);
  }

  for (const edge of normalEdges) {
    const portA = ports.get(edge.fromPortId);
    const portB = ports.get(edge.toPortId);
    if (!portA || !portB) continue;

    const pA = { x: portA.cx, y: portA.cy };
    const pB = { x: portB.cx, y: portB.cy };

    // Fast path: 0-bend straight or 1-bend L-route with zero crossings
    let chosen: RawPoint[] | null = null;
    const fastCandidates: RawPoint[][] = [];
    if (pA.x === pB.x || pA.y === pB.y) {
      fastCandidates.push([pA, pB]);
    } else {
      fastCandidates.push([pA, { x: pB.x, y: pA.y }, pB]);
      fastCandidates.push([pA, { x: pA.x, y: pB.y }, pB]);
    }
    for (const cand of fastCandidates) {
      if (isPathValidZeroCross(cand, portA, portB)) {
        chosen = cand;
        break;
      }
    }

    if (!chosen) {
      chosen =
        runAStar(portA, portB, 4096, true) ??
        runAStar(portA, portB, 1536, true) ??
        runAStar(portA, portB, 512, false) ??
        runAStar(portA, portB, 512, false, true);
    }

    if (!chosen) {
      // Deterministic orthogonal fallback
      const midY = Math.round((pA.y + pB.y) / 2);
      chosen = simplifyOrthogonalPath(
        pA.x === pB.x || pA.y === pB.y
          ? [pA, pB]
          : [pA, { x: pA.x, y: midY }, { x: pB.x, y: midY }, pB],
      );
    }

    recordPath(chosen);
    result.set(edge.key, chosen);
  }

  return result;
}

export function verifyCtWireGeometryInvariants(
  ctBody: string,
  options?: { sheetWidthMm?: number; sheetHeightMm?: number },
): CtWireGeometryReport {
  const ast = parseCtBodyAst(ctBody);

  // Determine sheet dimensions from options or embedded _MCP_SHEET_W / _MCP_SHEET_H
  let sheetW = options?.sheetWidthMm ?? 297;
  let sheetH = options?.sheetHeightMm ?? 210;
  if (!options?.sheetWidthMm || !options?.sheetHeightMm) {
    for (const obj of ast.objects) {
      if (obj.cls !== 'text') continue;
      for (const line of obj.props) {
        const mw = line.match(/^\s+S\s+_MCP_SHEET_W\s+F\s+([\d.]+)/);
        if (mw) sheetW = Number(mw[1]);
        const mh = line.match(/^\s+S\s+_MCP_SHEET_H\s+F\s+([\d.]+)/);
        if (mh) sheetH = Number(mh[1]);
      }
    }
  }

  const maxX = sheetW > 300 || sheetH > 220 ? 1167360 : 860160;
  const maxY = sheetW > 300 || sheetH > 220 ? 860160 : 614400;

  const parentOfPort = new Map<number, number>();
  for (const g of ast.gates) {
    parentOfPort.set(g.childId, g.parentId);
  }

  const objById = new Map<number, (typeof ast.objects)[number]>();
  for (const obj of ast.objects) {
    objById.set(obj.objId, obj);
  }

  const outOfBoundsObjects: CtWireGeometryReport['outOfBoundsObjects'] = [];
  const outOfBoundsSegments: CtWireGeometryReport['outOfBoundsSegments'] = [];
  const linesThroughComponents: CtWireGeometryReport['linesThroughComponents'] = [];
  const linesThroughConnections: CtWireGeometryReport['linesThroughConnections'] = [];
  const superimposedLines: CtWireGeometryReport['superimposedLines'] = [];

  const nonPortComps: Array<{ objId: number; cls: string; x1: number; y1: number; x2: number; y2: number }> = [];
  const ports: CtRoutingPort[] = [];
  const segments: Array<{ portObjId: number; ax: number; ay: number; bx: number; by: number }> = [];

  for (const obj of ast.objects) {
    if (PORT_CLASSES.has(obj.cls)) {
      const cx = Math.round((obj.x1 + obj.x2) / 2);
      const cy = Math.round((obj.y1 + obj.y2) / 2);
      const hidden = obj.props.some((p) => p.includes('S state INT 4'));
      ports.push({
        objId: obj.objId,
        parentId: parentOfPort.get(obj.objId) ?? -1,
        cls: obj.cls,
        cx,
        cy,
        hidden,
      });

      if (CHECKED_PORT_CLASSES.has(obj.cls)) {
        for (const line of obj.props) {
          const lm = line.match(/^L\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)$/);
          if (!lm) continue;
          const ax = cx + Number(lm[1]) - 5120;
          const ay = cy + Number(lm[2]) - 5120;
          const bx = cx + Number(lm[3]) + 5120;
          const by = cy + Number(lm[4]) + 5120;
          segments.push({ portObjId: obj.objId, ax, ay, bx, by });
        }
      }
    } else {
      if (obj.x1 < 0 || obj.y1 < 0 || obj.x2 > maxX || obj.y2 > maxY) {
        outOfBoundsObjects.push({
          cls: obj.cls,
          objId: obj.objId,
          x1: obj.x1,
          y1: obj.y1,
          x2: obj.x2,
          y2: obj.y2,
        });
      }
      if (obj.cls !== 'text' && obj.cls !== 'R_SCHALT') {
        nonPortComps.push({
          objId: obj.objId,
          cls: obj.cls,
          x1: obj.x1,
          y1: obj.y1,
          x2: obj.x2,
          y2: obj.y2,
        });
      }
    }
  }

  const connPeerByPort = new Map<number, number[]>();
  for (const c of ast.connections) {
    const aList = connPeerByPort.get(c.portObjA) ?? [];
    aList.push(c.portObjB);
    connPeerByPort.set(c.portObjA, aList);
    const bList = connPeerByPort.get(c.portObjB) ?? [];
    bList.push(c.portObjA);
    connPeerByPort.set(c.portObjB, bList);
  }

  const portById = new Map<number, CtRoutingPort>(ports.map((p) => [p.objId, p]));
  const visiblePorts = ports.filter((p) => CHECKED_PORT_CLASSES.has(p.cls) && !p.hidden);

  for (const seg of segments) {
    const minX = Math.min(seg.ax, seg.bx);
    const maxSegX = Math.max(seg.ax, seg.bx);
    const minY = Math.min(seg.ay, seg.by);
    const maxSegY = Math.max(seg.ay, seg.by);

    if (minX < 0 || minY < 0 || maxSegX > maxX || maxSegY > maxY) {
      outOfBoundsSegments.push(seg);
    }

    const pA = portById.get(seg.portObjId);
    const peers = connPeerByPort.get(seg.portObjId) ?? [];
    const endpointOwners = new Set<number>();
    const endpointCoords: Array<{ cx: number; cy: number }> = [];
    if (pA) {
      endpointOwners.add(pA.parentId);
      endpointCoords.push({ cx: pA.cx, cy: pA.cy });
    }
    for (const pid of peers) {
      const pB = portById.get(pid);
      if (pB) {
        endpointOwners.add(pB.parentId);
        endpointCoords.push({ cx: pB.cx, cy: pB.cy });
      }
    }

    for (const comp of nonPortComps) {
      if (!endpointOwners.has(comp.objId)) {
        if (segmentIntersectsRect(seg.ax, seg.ay, seg.bx, seg.by, comp.x1 + 512, comp.y1 + 512, comp.x2 - 512, comp.y2 - 512)) {
          linesThroughComponents.push({ portObjId: seg.portObjId, cls: comp.cls, ownerId: comp.objId });
        }
      } else if (!JUNCTION_CLASSES.has(comp.cls)) {
        const ix1 = comp.x1 + 1536;
        const iy1 = comp.y1 + 1536;
        const ix2 = comp.x2 - 1536;
        const iy2 = comp.y2 - 1536;
        if (ix1 < ix2 && iy1 < iy2) {
          const epInside = endpointCoords.some((c) => pointInsideRect(c.cx, c.cy, ix1, iy1, ix2, iy2));
          if (!epInside && segmentIntersectsRect(seg.ax, seg.ay, seg.bx, seg.by, ix1, iy1, ix2, iy2)) {
            linesThroughComponents.push({ portObjId: seg.portObjId, cls: comp.cls, ownerId: comp.objId });
          }
        }
      }
    }

    for (const p of visiblePorts) {
      if (p.objId === seg.portObjId || peers.includes(p.objId)) continue;
      if (endpointCoords.some((c) => c.cx === p.cx && c.cy === p.cy)) continue;
      if (segmentIntersectsRect(seg.ax, seg.ay, seg.bx, seg.by, p.cx - 5120, p.cy - 5120, p.cx + 5120, p.cy + 5120)) {
        linesThroughConnections.push({ portObjId: seg.portObjId, hitPortObjId: p.objId, cx: p.cx, cy: p.cy });
      }
    }
  }

  for (let i = 0; i < segments.length; i++) {
    const a = segments[i];
    const aHoriz = Math.abs(a.ay - a.by) < 128;
    const aVert = Math.abs(a.ax - a.bx) < 128;
    for (let j = i + 1; j < segments.length; j++) {
      const b = segments[j];
      const bHoriz = Math.abs(b.ay - b.by) < 128;
      const bVert = Math.abs(b.ax - b.bx) < 128;
      if (aHoriz && bHoriz && Math.abs(a.ay - b.ay) < 512) {
        const lo = Math.max(Math.min(a.ax, a.bx), Math.min(b.ax, b.bx));
        const hi = Math.min(Math.max(a.ax, a.bx), Math.max(b.ax, b.bx));
        if (hi - lo > 512) {
          superimposedLines.push({ portObjA: a.portObjId, portObjB: b.portObjId, axis: 'H', coord: a.ay });
        }
      } else if (aVert && bVert && Math.abs(a.ax - b.ax) < 512) {
        const lo = Math.max(Math.min(a.ay, a.by), Math.min(b.ay, b.by));
        const hi = Math.min(Math.max(a.ay, a.by), Math.max(b.ay, b.by));
        if (hi - lo > 512) {
          superimposedLines.push({ portObjA: a.portObjId, portObjB: b.portObjId, axis: 'V', coord: a.ax });
        }
      }
    }
  }

  return {
    ok:
      outOfBoundsObjects.length === 0 &&
      outOfBoundsSegments.length === 0 &&
      linesThroughComponents.length === 0 &&
      linesThroughConnections.length === 0 &&
      superimposedLines.length === 0,
    outOfBoundsObjects,
    outOfBoundsSegments,
    linesThroughComponents,
    linesThroughConnections,
    superimposedLines,
  };
}
