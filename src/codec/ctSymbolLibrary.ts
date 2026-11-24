/**
 * Lean FluidSIM 4.5 Symbol Allocator (v2)
 *
 * Allocates deduplicated `BEGINSYM .. ENDSYM` vector symbol blocks directly from
 * the official `FLUIDSIM45_PROTOTYPES` registry and `ctValveCompiler.ts`,
 * encoded via `encodeSymPrimitivesToFluidSimLines` in `ctTransform.ts`.
 */

import type { ComponentNode } from '../contracts/circuit';
import {
  encodeSymPrimitivesToFluidSimLines,
  FS_UNIT_PER_MM,
  type SymPrimitive,
} from './ctTransform';
import { getFluidSim45Prototype } from './prototypes/fluidsim45Prototypes';
import { buildValveSymPrimitives } from './ctValveCompiler';

const VALVE_TYPES = new Set(['valve_2_2', 'valve_3_2', 'valve_4_2', 'valve_5_2', 'valve_5_3']);

export function isDirectionalValveType(type: string): boolean {
  return VALVE_TYPES.has(type);
}

/**
 * Deduplicating allocator for `BEGINSYM .. ENDSYM` blocks in FluidSIM 4.5 `.ct` trailers.
 *
 * IMPORTANT: FluidSIM 4.5 natively applies object-header `rot` and `flip` to `BEGINSYM` geometry
 * (empirically verified in `fixtures/golden/02_speed_control_throttle.ct` on rotated `DV_P1` and `CheckValveP`).
 * Therefore, all `SYM` blocks are encoded strictly in canonical unrotated local raw units (`unitPerMm`).
 */
export class CtSymbolAllocator {
  private readonly blocks: string[] = [];
  private readonly keyToIndex = new Map<string, number>();

  /** Registers an arbitrary list of FluidSIM SYM primitive lines and returns its 0-based index. */
  registerLines(lines: readonly string[]): number {
    const body = lines.join('\n');
    const existing = this.keyToIndex.get(body);
    if (existing !== undefined) return existing;
    const idx = this.blocks.length;
    this.keyToIndex.set(body, idx);
    this.blocks.push(`SYM ${idx}\n${body}`);
    return idx;
  }

  /** Registers canonical (rot=0, flip=0) mm-domain SymPrimitives scaled by `unitPerMm`. */
  registerPrimitives(
    primitives: readonly SymPrimitive[],
    opts?: { unitPerMm?: number },
  ): number {
    const scale = opts?.unitPerMm ?? FS_UNIT_PER_MM;
    const lines = encodeSymPrimitivesToFluidSimLines(primitives, scale);
    return this.registerLines(lines.length > 0 ? lines : [`1 0 0 ${scale} ${scale}`]);
  }

  /**
   * Allocates canonical unrotated `dxf_prim_list` (and optional `dxf_prim_list2`)
   * for any catalog component using `FLUIDSIM45_PROTOTYPES` or `buildValveSymPrimitives`.
   */
  allocateForComponent(
    comp: ComponentNode,
    unitPerMm: number = FS_UNIT_PER_MM,
  ): { dxf1?: number; dxf2?: number } {
    const proto = getFluidSim45Prototype(comp.type);
    if (!proto) return {};
    if (!proto.usesDxfSym && !isDirectionalValveType(comp.type)) {
      return {};
    }

    const prims1 = isDirectionalValveType(comp.type)
      ? buildValveSymPrimitives(comp)
      : proto.symPrimitives;

    const dxf1 = this.registerPrimitives(prims1, { unitPerMm });

    let dxf2: number | undefined;
    if (proto.usesDxfSym2 && proto.symPrimitives2 && proto.symPrimitives2.length > 0) {
      dxf2 = this.registerPrimitives(proto.symPrimitives2, { unitPerMm });
    }

    return { dxf1, dxf2 };
  }

  get count(): number {
    return this.blocks.length;
  }

  /** Emits the complete FluidSIM 4.5 trailer `BEGINSYM .. ENDSYM` block. */
  toTrailerSection(): string {
    if (this.blocks.length === 0) return '';
    return `BEGINSYM\n${this.blocks.join('\n')}\nENDSYM\n`;
  }
}
