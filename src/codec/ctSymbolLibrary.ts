import type { ValveActuationSide } from '../contracts/circuit';

/**
 * FluidSIM Pneumatics 4.5 `BEGINSYM ... ENDSYM` vector symbol primitive library.
 *
 * FluidSIM 4.5 draws `CylDGPPAB`, `WV_2`, `WV_3`, `WV_4`, `WV_5`, `DRSV2_pneu`,
 * `FilterP`, `CheckValveP`, `CheckValveSpringLoadedP`, `Wartungseinheit2`, etc.
 * via `S dxf_prim_list V <idx>` pointing to `SYM <idx>` vector primitive blocks
 * inside `BEGINSYM ... ENDSYM` in the `.ct` trailer.
 *
 * Primitive opcodes (verified against golden fixtures `01..05.ct`):
 * - `1 x1 y1 x2 y2`                             line segment
 * - `3 cx cy r flag1 flag2`                     circle (flag1=0, flag2=2)
 * - `4 cx cy r startDeg1024 endDeg1024 f1 f2 f3` arc
 * - `5 x1 y1 x2 y2 x3 y3 x4 y4 color`           filled polygon/arrowhead (color=0 black)
 */

export class CtSymbolAllocator {
  private readonly symbols: string[][] = [];

  public alloc(primitives: readonly string[]): number {
    const idx = this.symbols.length;
    this.symbols.push([...primitives]);
    return idx;
  }

  public get count(): number {
    return this.symbols.length;
  }

  public renderTrailer(): string {
    const lines: string[] = ['ENDCT', 'BEGINDSD', 'ENDDSD', 'BEGINSYM'];
    for (let i = 0; i < this.symbols.length; i++) {
      lines.push(`SYM ${i}`);
      for (const prim of this.symbols[i]) {
        lines.push(prim);
      }
    }
    lines.push('ENDSYM');
    return `${lines.join('\n')}\n`;
  }
}

// =========================================================================
// ACTUATOR SYMBOLS (verbatim / aligned with golden fixtures 01..04.ct)
// =========================================================================

/**
 * `CylDGPPAB` barrel + port stems (`57344 x 32768`, `56 x 32` * 1024).
 * Verbatim from golden `01_direct_indirect_cylinders.ct` SYM 3 (SA) & SYM 8 (DA).
 */
export function buildCylinderSyms(isSingleActing: boolean): {
  body: string[];
  rod: string[];
} {
  if (isSingleActing) {
    return {
      body: [
        '1 0 24576 57344 24576',
        '1 0 0 57344 0',
        '1 4096 24576 4096 32768',
        '1 0 0 0 24576',
        '1 57344 15360 57344 24576',
        '1 57344 0 57344 9216',
      ],
      rod: [],
    };
  }
  return {
    body: [
      '1 4096 24576 4096 32768',
      '1 53248 24576 53248 32768',
      '1 57344 0 57344 9216',
      '1 57344 15360 57344 24576',
      '1 0 0 0 24576',
      '1 0 0 57344 0',
      '1 0 24576 57344 24576',
    ],
    rod: [],
  };
}

/**
 * `PAR1b` Semi-rotary / swivel drive (`30720 x 39936`, `30 x 39` * 1024).
 */
export function buildSwivelDriveSym(): string[] {
  return [
    // Outer rotary housing circle (cx=15360, cy=16384, r=12288)
    '3 15360 16384 12288 0 2',
    // Inner shaft circle
    '3 15360 16384 3072 0 2',
    // Vane partition line from center to top
    '1 15360 4096 15360 13312',
    // Curved bidirectional swivel indicator arc above housing
    '4 15360 16384 15360 46080 138240 0 0 2',
    // Left & right port stems down to y=39936 (ports A at x=7168, B at x=23552)
    '1 7168 25600 7168 39936',
    '1 23552 25600 23552 39936',
  ];
}

// =========================================================================
// DIRECTIONAL VALVE SYMBOLS (WV_2, WV_3, WV_4, WV_5 2-pos & 3-pos)
// =========================================================================

function buildLeftActuationPrimitives(act?: ValveActuationSide): string[] {
  if (!act || act.type === 'none') return [];
  const p: string[] = [];

  switch (act.type) {
    case 'solenoid': {
      // Standard ISO 1219 solenoid rectangle (0..18432, 18432..30720) + diagonal slash (golden 04.ct SYM 1)
      p.push(
        '1 0 30720 0 18432',
        '1 12288 18432 6144 30720',
        '1 18432 30720 0 30720',
        '1 0 18432 18432 18432',
      );
      if (act.internalPilot) {
        // Internal servo-pilot triangle inside right side of solenoid box
        p.push(
          '1 13312 20480 17408 24576',
          '1 17408 24576 13312 28672',
          '1 13312 20480 13312 28672',
        );
      }
      if (act.manualOverride) {
        // Manual override T-pushbutton attached to left edge of solenoid
        p.push(
          '1 0 21504 -4096 21504',
          '1 0 27648 -4096 27648',
          '1 -4096 19456 -4096 29696',
        );
      }
      break;
    }
    case 'pneumatic_pilot':
    case 'pneumatic_spring': {
      // ISO 1219 pneumatic pilot triangle pointing right into valve body (golden 01.ct SYM 10)
      p.push(
        '1 0 24576 5120 24576',
        '1 5120 20480 5120 28672',
        '1 5120 20480 11264 24576',
        '1 11264 24576 5120 28672',
        '1 11264 24576 18432 24576',
      );
      break;
    }
    case 'roller':
    case 'idle_return_roller': {
      // ISO 1219 roller circle + lever (golden 01.ct SYM 0)
      p.push(
        '3 7168 16384 2048 0 2',
        '1 1024 30720 6361 18266',
        '1 18432 27648 2340 27648',
        '1 4973 21504 18432 21504',
      );
      break;
    }
    case 'pushbutton':
    case 'detent': {
      // ISO 1219 manual pushbutton / detent notch (golden 02.ct SYM 2)
      p.push(
        '1 4096 18432 4096 30720',
        '1 18432 21504 4096 21504',
        '1 18432 27648 4096 27648',
      );
      if (act.type === 'detent') {
        p.push(
          '1 8192 21504 10240 25600',
          '1 10240 25600 12288 21504',
        );
      }
      break;
    }
    case 'spring': {
      // Left zigzag spring
      p.push(
        '1 18432 24576 17408 18944',
        '1 17408 18944 15360 30208',
        '1 15360 30208 13312 18944',
        '1 13312 18944 11264 30208',
        '1 11264 30208 9216 18944',
        '1 9216 18944 7168 30208',
        '1 7168 30208 6144 24576',
      );
      break;
    }
  }
  return p;
}

function buildRightActuationPrimitives(bodyRightX: number, act?: ValveActuationSide): string[] {
  if (!act || act.type === 'none') return [];
  const p: string[] = [];
  const x0 = bodyRightX;
  const xEnd = bodyRightX + 18432;

  switch (act.type) {
    case 'spring': {
      // Right zigzag spring (verbatim relative to bodyRightX from golden 01.ct SYM 0 / SYM 7)
      p.push(
        `1 ${x0} 24576 ${x0 + 1024} 18944`,
        `1 ${x0 + 1024} 18944 ${x0 + 3072} 30208`,
        `1 ${x0 + 3072} 30208 ${x0 + 5120} 18944`,
        `1 ${x0 + 5120} 18944 ${x0 + 7168} 30208`,
        `1 ${x0 + 7168} 30208 ${x0 + 9216} 18944`,
        `1 ${x0 + 9216} 18944 ${x0 + 11264} 30208`,
        `1 ${x0 + 11264} 30208 ${x0 + 12288} 24576`,
      );
      break;
    }
    case 'pneumatic_spring': {
      // ISO 1219 internal air-spring triangle pointing left into valve body + optional mechanical spring
      p.push(
        `1 ${x0} 24576 ${x0 + 7168} 24576`,
        `1 ${x0 + 13312} 20480 ${x0 + 13312} 28672`,
        `1 ${x0 + 13312} 20480 ${x0 + 7168} 24576`,
        `1 ${x0 + 7168} 24576 ${x0 + 13312} 28672`,
      );
      if (act.springReturn) {
        p.push(
          `1 ${x0} 12288 ${x0 + 2048} 8192`,
          `1 ${x0 + 2048} 8192 ${x0 + 5120} 16384`,
          `1 ${x0 + 5120} 16384 ${x0 + 8192} 8192`,
          `1 ${x0 + 8192} 8192 ${x0 + 11264} 16384`,
          `1 ${x0 + 11264} 16384 ${x0 + 12288} 12288`,
        );
      }
      break;
    }
    case 'solenoid': {
      // Right solenoid rectangle + slash (verbatim relative to bodyRightX from golden 04.ct SYM 1)
      p.push(
        `1 ${xEnd} 30720 ${xEnd} 18432`,
        `1 ${x0 + 6144} 18432 ${x0 + 12288} 30720`,
        `1 ${x0} 30720 ${xEnd} 30720`,
        `1 ${xEnd} 18432 ${x0} 18432`,
      );
      break;
    }
    case 'pneumatic_pilot': {
      p.push(
        `1 ${xEnd} 24576 ${x0 + 13312} 24576`,
        `1 ${x0 + 13312} 20480 ${x0 + 13312} 28672`,
        `1 ${x0 + 13312} 20480 ${x0 + 7168} 24576`,
        `1 ${x0 + 7168} 24576 ${x0 + 13312} 28672`,
        `1 ${x0 + 7168} 24576 ${x0} 24576`,
      );
      break;
    }
    case 'pushbutton':
    case 'detent': {
      p.push(
        `1 ${x0 + 14336} 18432 ${x0 + 14336} 30720`,
        `1 ${x0} 21504 ${x0 + 14336} 21504`,
        `1 ${x0} 27648 ${x0 + 14336} 27648`,
      );
      break;
    }
    case 'roller':
    case 'idle_return_roller': {
      p.push(
        `3 ${x0 + 11264} 16384 2048 0 2`,
        `1 ${x0 + 17408} 30720 ${x0 + 12071} 18266`,
        `1 ${x0} 27648 ${x0 + 16092} 27648`,
        `1 ${x0 + 13459} 21504 ${x0} 21504`,
      );
      break;
    }
  }
  return p;
}

export function buildValveSym(
  valveType: 'valve_2_2' | 'valve_3_2' | 'valve_4_2' | 'valve_5_2' | 'valve_5_3',
  options: {
    leftActuation?: ValveActuationSide;
    rightActuation?: ValveActuationSide;
    normallyOpen?: boolean;
    centerType?: string;
  },
): string[] {
  const p: string[] = [];
  p.push(...buildLeftActuationPrimitives(options.leftActuation));

  if (valveType === 'valve_5_2') {
    // Verbatim golden 04_electro_pneumatic_abba.ct SYM 1 valve body (x = 18432..92160)
    p.push(
      // Left chamber (1->4, 2->3, 5 blocked)
      '1 22528 24576 26624 24576',
      '1 24576 24576 24576 30720',
      '1 49152 6144 49152 30720',
      '5 49152 30720 51200 22528 47104 22528 47104 22528 0',
      '1 36864 30720 24576 6144',
      '5 24576 6144 26407 14387 30070 12555 30070 12555 0',
      '1 18432 30720 18432 6144',
      '1 18432 6144 55296 6144',
      '1 55296 6144 55296 30720',
      '1 55296 30720 18432 30720',
      // Right chamber (1->2, 4->5, 3 blocked)
      '1 61440 6144 61440 30720',
      '5 61440 30720 59392 22528 63488 22528 63488 22528 0',
      '1 88064 24576 83968 24576',
      '1 86016 24576 86016 30720',
      '1 73728 30720 86016 6144',
      '5 86016 6144 84184 14387 80521 12555 80521 12555 0',
      '1 55296 30720 55296 6144',
      '1 55296 6144 92160 6144',
      '1 92160 6144 92160 30720',
      '1 92160 30720 55296 30720',
      // Port stems on active right chamber (ports 4, 2 top; 5, 1, 3 bottom)
      '1 61440 0 61440 6144',
      '1 86016 0 86016 6144',
      '1 61440 30720 61440 36864',
      '1 73728 30720 73728 36864',
      '1 86016 30720 86016 36864',
    );
    p.push(...buildRightActuationPrimitives(92160, options.rightActuation));
    return p;
  }

  if (valveType === 'valve_5_3') {
    // 3 chambers: Left (18432..55296), Center (55296..92160), Right (92160..129024)
    p.push(
      // Left chamber
      '1 18432 30720 18432 6144',
      '1 18432 6144 55296 6144',
      '1 55296 6144 55296 30720',
      '1 55296 30720 18432 30720',
      '1 36864 30720 24576 6144',
      '1 49152 6144 49152 30720',
      '1 22528 24576 26624 24576',
      '1 24576 24576 24576 30720',
      // Center chamber (55296..92160)
      '1 55296 30720 55296 6144',
      '1 55296 6144 92160 6144',
      '1 92160 6144 92160 30720',
      '1 92160 30720 55296 30720',
      // Closed center T-bars (default)
      '1 61440 6144 61440 12288',
      '1 59392 12288 63488 12288',
      '1 86016 6144 86016 12288',
      '1 83968 12288 88064 12288',
      '1 61440 24576 61440 30720',
      '1 59392 24576 63488 24576',
      '1 73728 24576 73728 30720',
      '1 71680 24576 75776 24576',
      '1 86016 24576 86016 30720',
      '1 83968 24576 88064 24576',
      // Right chamber (92160..129024)
      '1 92160 30720 92160 6144',
      '1 92160 6144 129024 6144',
      '1 129024 6144 129024 30720',
      '1 129024 30720 92160 30720',
      '1 98304 6144 98304 30720',
      '1 110592 30720 122880 6144',
      '1 120832 24576 124928 24576',
      '1 122880 24576 122880 30720',
      // Center port stems (4, 2 top; 5, 1, 3 bottom)
      '1 61440 0 61440 6144',
      '1 86016 0 86016 6144',
      '1 61440 30720 61440 36864',
      '1 73728 30720 73728 36864',
      '1 86016 30720 86016 36864',
    );
    p.push(...buildRightActuationPrimitives(129024, options.rightActuation));
    return p;
  }

  if (valveType === 'valve_4_2') {
    // Two 24576x24576 chambers (18432..43008 and 43008..67584)
    p.push(
      // Left chamber (parallel arrows: 1->4 up, 2->3 down)
      '1 18432 30720 43008 30720',
      '1 43008 30720 43008 6144',
      '1 43008 6144 18432 6144',
      '1 18432 6144 18432 30720',
      '1 24576 6144 24576 30720',
      '5 24576 6144 22528 14336 26624 14336 26624 14336 0',
      '1 36864 6144 36864 30720',
      '5 36864 30720 34816 22528 38912 22528 38912 22528 0',
      // Right chamber (crossed arrows: 1->2 up-right, 4->3 down-right)
      '1 43008 30720 67584 30720',
      '1 67584 30720 67584 6144',
      '1 67584 6144 43008 6144',
      '1 43008 6144 43008 30720',
      '1 49152 30720 61440 6144',
      '5 61440 6144 57344 12288 61440 14336 61440 14336 0',
      '1 49152 6144 61440 30720',
      '5 61440 30720 57344 24576 61440 22528 61440 22528 0',
      // Port stems on right chamber (4, 2 top; 1, 3 bottom)
      '1 49152 0 49152 6144',
      '1 61440 0 61440 6144',
      '1 49152 30720 49152 36864',
      '1 61440 30720 61440 36864',
    );
    p.push(...buildRightActuationPrimitives(67584, options.rightActuation));
    return p;
  }

  if (valveType === 'valve_3_2') {
    // Two 24576x24576 chambers (18432..43008 and 43008..67584)
    p.push(
      '1 18432 30720 43008 30720',
      '1 43008 30720 43008 6144',
      '1 43008 6144 18432 6144',
      '1 18432 6144 18432 30720',
      '1 43008 30720 67584 30720',
      '1 67584 30720 67584 6144',
      '1 67584 6144 43008 6144',
      '1 43008 6144 43008 30720',
    );
    if (options.normallyOpen) {
      // NO: Left chamber (actuated) = 2->3 exhaust + 1 blocked; Right chamber (rest) = 1->2 open + 3 blocked
      p.push(
        // Left chamber (exhaust 2->3, block 1)
        '1 22528 24576 26624 24576',
        '1 24576 24576 24576 30720',
        '1 36864 30720 24576 6144',
        '5 36864 30720 35019 22486 31374 24288 31374 24288 0',
        // Right chamber (open 1->2, block 3)
        '1 59392 24576 63488 24576',
        '1 61440 24576 61440 30720',
        '1 49152 6144 49152 30720',
        '5 49152 6144 47104 14336 51200 14336 51200 14336 0',
      );
    } else {
      // NC (verbatim golden 01.ct SYM 0): Left = 1->2 open + 3 blocked; Right = 2->3 exhaust + 1 blocked
      p.push(
        '1 34816 24576 38912 24576',
        '1 36864 24576 36864 30720',
        '5 24576 6144 22528 14336 26624 14336 26624 14336 0',
        '1 24576 6144 24576 30720',
        '1 61440 30720 49152 6144',
        '5 61440 30720 59595 22486 55950 24288 55950 24288 0',
        '1 47104 24576 51200 24576',
        '1 49152 24576 49152 30720',
      );
    }
    // Port stems on right chamber (port 2 top x=49152; port 1 bottom x=49152; port 3 bottom x=61440)
    p.push(
      '1 49152 0 49152 6144',
      '1 49152 30720 49152 36864',
      '1 61440 30720 61440 36864',
    );
    p.push(...buildRightActuationPrimitives(67584, options.rightActuation));
    return p;
  }

  // valve_2_2 (two 24576x24576 chambers: 18432..43008 and 43008..67584)
  p.push(
    '1 18432 30720 43008 30720',
    '1 43008 30720 43008 6144',
    '1 43008 6144 18432 6144',
    '1 18432 6144 18432 30720',
    '1 43008 30720 67584 30720',
    '1 67584 30720 67584 6144',
    '1 67584 6144 43008 6144',
    '1 43008 6144 43008 30720',
  );
  if (options.normallyOpen) {
    // NO: Left blocked (T top & bottom), Right open (arrow up)
    p.push(
      '1 30720 6144 30720 12288',
      '1 28672 12288 32768 12288',
      '1 30720 24576 30720 30720',
      '1 28672 24576 32768 24576',
      '1 55296 6144 55296 30720',
      '5 55296 6144 53248 14336 57344 14336 57344 14336 0',
    );
  } else {
    // NC: Left open (arrow up), Right blocked (T top & bottom)
    p.push(
      '1 30720 6144 30720 30720',
      '5 30720 6144 28672 14336 32768 14336 32768 14336 0',
      '1 55296 6144 55296 12288',
      '1 53248 12288 57344 12288',
      '1 55296 24576 55296 30720',
      '1 53248 24576 57344 24576',
    );
  }
  // Port stems on right chamber center (x=55296: port 2 top, port 1 bottom)
  p.push('1 55296 0 55296 6144', '1 55296 30720 55296 36864');
  p.push(...buildRightActuationPrimitives(67584, options.rightActuation));
  return p;
}

// =========================================================================
// FLOW, CHECK, CONDITIONING, VACUUM & MEASURING SYMBOLS
// =========================================================================

/**
 * `DRSV2_pneu` One-way flow control valve (`46080 x 61440`, `45 x 60` * 1024).
 * Vertical main ports: port 2 at top (23040, 0), port 1 at bottom (23040, 61440).
 * Left branch: adjustable throttle (arcs + diagonal arrow). Right branch: bypass check valve (ball + V-seat).
 * Compensates check-valve seat orientation for `rotDeg === 180` so `freeFlowDirection='1_to_2'`
 * always renders free flow UP (meter-out) visually in FluidSIM.
 */
export function buildFlowControlOneWaySym(
  rotDeg = 0,
  freeFlowDirection: '1_to_2' | '2_to_1' = '1_to_2',
): string[] {
  const wantLocalUp = (freeFlowDirection === '1_to_2') !== (rotDeg === 180);
  const checkValveLines = wantLocalUp
    ? [
        '1 33792 12288 33792 25600',
        '1 33792 36864 33792 49152',
        '3 33792 29696 3072 0 2',
        '1 28672 30720 33792 36864',
        '1 38912 30720 33792 36864',
      ]
    : [
        '1 33792 12288 33792 24576',
        '1 33792 35840 33792 49152',
        '3 33792 31744 3072 0 2',
        '1 28672 30720 33792 24576',
        '1 38912 30720 33792 24576',
      ];
  return [
    // Main top & bottom stems + horizontal split rails
    '1 23040 0 23040 12288',
    '1 23040 49152 23040 61440',
    '1 12288 12288 33792 12288',
    '1 12288 49152 33792 49152',
    // Left throttle vertical stem + constriction arcs + diagonal adjustment arrow
    '1 12288 12288 12288 49152',
    '4 4096 30720 6144 317440 51200 0 0 2',
    '4 20480 30720 6144 133120 235520 0 0 2',
    '1 4096 38912 20480 22528',
    '5 20480 22528 16384 24576 18432 26624 18432 26624 0',
    ...checkValveLines,
  ];
}

/**
 * `DRSV2_pneu` Adjustable throttle valve (`46080 x 61440`, `45 x 60` * 1024).
 */
export function buildThrottleValveSym(): string[] {
  return [
    '1 23040 0 23040 61440',
    '4 14848 30720 6144 317440 51200 0 0 2',
    '4 31232 30720 6144 133120 235520 0 0 2',
    '1 14336 38912 31744 22528',
    '5 31744 22528 27648 24576 29696 26624 29696 26624 0',
  ];
}

/**
 * `CheckValveP` & `CheckValveSpringLoadedP` (`12288 x 24576`, `12 x 24` * 1024).
 * Aligned with golden `02_speed_control_throttle.ct` SYM 5 / SYM 6.
 */
export function buildCheckValveSyms(springLoaded: boolean): {
  closed: string[];
  open: string[];
} {
  const springLines = springLoaded
    ? [
        '1 6144 3072 9216 4608',
        '1 9216 4608 3072 6144',
        '1 3072 6144 9216 7680',
        '1 9216 7680 6144 8704',
      ]
    : [];
  return {
    closed: [
      '3 6144 11776 3072 0 2',
      '1 11264 11776 6144 16384',
      '1 1024 11776 6144 16384',
      '1 6144 0 6144 8704',
      '1 6144 16384 6144 24576',
      ...springLines,
    ],
    open: [
      '3 6144 9216 3072 0 2',
      '1 11264 11776 6144 16384',
      '1 1024 11776 6144 16384',
      '1 6144 0 6144 6144',
      '1 6144 16384 6144 24576',
      ...springLines,
    ],
  };
}

/**
 * `FilterP` Standalone air/vacuum filter (`24576 x 24576`, `24 x 24` * 1024).
 * ISO 1219 diamond filter with dashed separator line + left/right port stems.
 */
export function buildFilterSym(): string[] {
  return [
    // Diamond body
    '1 4096 12288 12288 4096',
    '1 12288 4096 20480 12288',
    '1 20480 12288 12288 20480',
    '1 12288 20480 4096 12288',
    // Vertical dashed filter element
    '1 12288 6144 12288 9216',
    '1 12288 11264 12288 13312',
    '1 12288 15360 12288 18432',
    // Left (port 1) & right (port 2) stems
    '1 0 12288 4096 12288',
    '1 20480 12288 24576 12288',
  ];
}

/**
 * `Wartungseinheit2` Air Service Unit / FRL (`122880 x 67584`, `120 x 66` * 1024).
 * ISO 1219 combined Filter + Pressure Regulator w/ Manometer + Lubricator inside dashed frame.
 */
export function buildWartungseinheit2Sym(): string[] {
  return [
    // Outer frame (left=8192, top=6144, right=114688, bottom=61440)
    '1 8192 6144 114688 6144',
    '1 114688 6144 114688 61440',
    '1 114688 61440 8192 61440',
    '1 8192 61440 8192 6144',
    // Inlet port 1 stem (left) & outlet port 2 stem (right) at y=33792
    '1 0 33792 20480 33792',
    '1 45056 33792 55296 33792',
    '1 79872 33792 90112 33792',
    '1 106496 33792 122880 33792',
    // 1. Filter diamond (cx=32768, cy=33792, r=12288)
    '1 20480 33792 32768 21504',
    '1 32768 21504 45056 33792',
    '1 45056 33792 32768 46080',
    '1 32768 46080 20480 33792',
    '1 32768 24576 32768 29696',
    '1 32768 32768 32768 35840',
    '1 32768 38912 32768 43008',
    '1 29696 49152 35840 49152',
    '1 32768 46080 32768 49152',
    // 2. Pressure regulator square (55296..79872, y=21504..46080) + arrow + manometer gauge above
    '1 55296 21504 79872 21504',
    '1 79872 21504 79872 46080',
    '1 79872 46080 55296 46080',
    '1 55296 46080 55296 21504',
    '1 57344 33792 77824 33792',
    '5 77824 33792 71680 31744 71680 35840 71680 35840 0',
    '3 67584 13312 5120 0 2',
    '1 67584 18432 67584 21504',
    '1 65536 15360 70656 10240',
    // 3. Lubricator diamond (cx=98304, cy=33792) + oil drop stem
    '1 90112 33792 98304 25600',
    '1 98304 25600 106496 33792',
    '1 106496 33792 98304 41984',
    '1 98304 41984 90112 33792',
    '1 98304 28672 98304 35840',
  ];
}

/**
 * `PressureReducingValve3WaysAdjustableP` (`24576 x 24576`).
 */
export function buildPressureRegulatorSym(): string[] {
  return [
    '1 4096 4096 20480 4096',
    '1 20480 4096 20480 20480',
    '1 20480 20480 4096 20480',
    '1 4096 20480 4096 4096',
    '1 0 12288 24576 12288',
    '5 20480 12288 15360 10240 15360 14336 15360 14336 0',
  ];
}

/**
 * `PVS3` Shuttle Valve (OR) (`24576 x 18432`).
 */
export function buildShuttleValveOrSym(): string[] {
  return [
    '1 4096 4096 20480 4096',
    '1 20480 4096 20480 16384',
    '1 20480 16384 4096 16384',
    '1 4096 16384 4096 4096',
    '3 12288 10240 3072 0 2',
    '1 0 10240 9216 10240',
    '1 15360 10240 24576 10240',
    '1 12288 0 12288 7168',
  ];
}

/**
 * `DRSV2_pneu` 3-port Dual-Pressure Valve (AND) (`24576 x 18432`).
 */
export function buildDualPressureAndSym(): string[] {
  return [
    '1 4096 4096 20480 4096',
    '1 20480 4096 20480 16384',
    '1 20480 16384 4096 16384',
    '1 4096 16384 4096 4096',
    // H-spool inside
    '1 8192 7168 8192 13312',
    '1 16384 7168 16384 13312',
    '1 8192 10240 16384 10240',
    '1 0 10240 8192 10240',
    '1 16384 10240 24576 10240',
    '1 12288 0 12288 10240',
  ];
}

/**
 * `DV_P1` Quick Exhaust Valve (`24576 x 24576`).
 */
export function buildQuickExhaustSym(): string[] {
  return [
    '1 4096 4096 20480 4096',
    '1 20480 4096 20480 20480',
    '1 20480 20480 4096 20480',
    '1 4096 20480 4096 4096',
    '1 12288 0 12288 24576',
    '1 0 12288 12288 12288',
    '1 8192 12288 16384 16384',
  ];
}

/**
 * `PAV1` Vacuum suction nozzle / Venturi ejector (`36864 x 30720`, `36 x 30` * 1024).
 * Port 1 left (0, 15360), Port 3 right (36864, 15360), Port 1v top (18432, 0).
 */
export function buildVacuumNozzleSym(): string[] {
  return [
    // Outer rectangle
    '1 4096 6144 32768 6144',
    '1 32768 6144 32768 24576',
    '1 32768 24576 4096 24576',
    '1 4096 24576 4096 6144',
    // Venturi converging-diverging nozzle cones
    '1 6144 10240 18432 15360',
    '1 6144 20480 18432 15360',
    '1 18432 15360 30720 10240',
    '1 18432 15360 30720 20480',
    // Port stems: 1 (left), 3 (right), 1v (top)
    '1 0 15360 6144 15360',
    '1 30720 15360 36864 15360',
    '1 18432 0 18432 15360',
  ];
}

/**
 * `PAV1S` Vacuum suction cup / sucker (`24576 x 24576`, `24 x 24` * 1024).
 * Port 1v bottom center (12288, 24576).
 */
export function buildVacuumSuckerSym(): string[] {
  return [
    // Cup lip + concave suction hood
    '1 3072 4096 21504 4096',
    '1 3072 4096 8192 14336',
    '1 21504 4096 16384 14336',
    '1 8192 14336 16384 14336',
    // Stem down to port 1v
    '1 12288 14336 12288 24576',
  ];
}

/**
 * `PSW1` Differential / Vacuum Pressure Switch (`24576 x 24576`, `24 x 24` * 1024).
 * Ports P1 left (0, 12288) and P2 right (24576, 12288).
 */
export function buildPressureSwitchSym(): string[] {
  return [
    // Square housing
    '1 4096 4096 20480 4096',
    '1 20480 4096 20480 20480',
    '1 20480 20480 4096 20480',
    '1 4096 20480 4096 4096',
    // Diagonal p-to-electric divider + switch arrow
    '1 4096 20480 20480 4096',
    '1 7168 12288 12288 9216',
    '1 12288 9216 12288 15360',
    '1 12288 15360 7168 12288',
    // Port stems P1 (left) & P2 (right)
    '1 0 12288 4096 12288',
    '1 20480 12288 24576 12288',
  ];
}
