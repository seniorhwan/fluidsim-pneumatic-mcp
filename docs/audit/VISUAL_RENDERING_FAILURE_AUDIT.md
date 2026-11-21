# FluidSIM 4.5 Visual Rendering & Layout Failure Audit (`v0.2.0` Post-Fix)

**Date:** 2026-11-21  
**Commit Audited:** `cac0ba8` (`feat: upgrade project creation and codec reliability`)  
**Artifact Inspected:** `docs/audit/attempts/distribution_station_recreated.ct` (opened directly in Festo FluidSIM Pneumatics 4.5 `fl_sim_p.exe`)  
**Golden Reference Compared:** `C:\Users\jethr\OneDrive\Dokumen\Reading material\TA\dokumen ta mps\everything for pneumatics\distributing station.ct` and `fixtures/golden/*.ct`

---

## Executive Summary

After commit `cac0ba8`, generated `.ct` files **no longer crash `fl_sim_p.exe`** and open cleanly (`0xC0000005` fixed).  
However, opening `distribution_station_recreated.ct` in FluidSIM 4.5 reveals that **the generated schematic is visually broken and unreadable**:
- Most components (**5/2, 3/2, 2/2 valves, double-acting cylinder, one-way flow controls, throttle, air filter, check valve**) render **completely invisible** (only floating port circles `o` and text labels appear).
- Overlapping bounding boxes cause valves, actuators, junctions, manifolds, and text labels to collide on top of each other.
- Valve solenoid/manual pilot pins (`UEConnection` / `UMConnection`) draw tiny `ooo` circles stamped straight over the valve labels (`-1M1`, `2M2`, `2M1`, `3M1`, `3M2`).
- Distance rules (`R_SCHALT`) clip into negative Y (`-9216`) and overlap the sheet title text.
- Exhaust silencers render as `|>` (`PSW1` Pressure Indicator) and vacuum junctions pull top-branch tubing all the way down through the valve row into a tangled spaghetti web.

**Why unit tests didn't catch this:**  
All 45 tests in `npm test` either check **existing golden `.ct` files** (which already carry their own preserved `BEGINSYM .. ENDSYM` vector blocks!) or validate the **TypeScript IR graph** — never verifying that freshly generated `.ct` bodies contain vector symbols, non-overlapping FluidSIM object boxes, or valid port geometry.

---

## Empirical Root Causes (Verified Against Real `distributing station.ct`)

### Root Cause 1 (CRITICAL): Missing `BEGINSYM .. ENDSYM` + `dxf_prim_list` Vector Primitives
When FluidSIM 4.5 opens a `.ct` file, components like `CylDGPPAB`, `WV_5`, `WV_3`, `WV_2`, `WV_4`, `DRSV2_pneu`, `FilterP`, `CheckValveSpringLoadedP`, and `Wartungseinheit2` do **not** render built-in ISO 1219 icons automatically. They render vector linework/boxes/arrows/solenoids/springs referenced via:
1. Object property `S dxf_prim_list V <symIdx>` (and `dxf_prim_list2 V <symIdx>`, `dxf_prim_list3 V <symIdx>`)
2. Corresponding `SYM <symIdx>` records inside `BEGINSYM ... ENDSYM` in the `.ct` trailer!

Empirical comparison across all real `.ct` files:
| File | `dxf_prim_list` refs | `SYM <n>` blocks | `trailerText` bytes |
| --- | --- | --- | --- |
| `distributing station.ct` (real) | **23** | **23** | **15,247** |
| `01_direct_indirect_cylinders.ct` | **20** | **20** | **7,902** |
| `02_speed_control_throttle.ct` | **38** | **38** | **12,470** |
| `03_pneumatic_abba_sequence.ct` | **13** | **13** | **6,919** |
| `distribution_station_recreated.ct` (generated) | **0** | **0** | **38 (`BEGINSYM\nENDSYM`)** |

**Symptom in FluidSIM 4.5 UI:**
- `-1V1` (`WV_5`), `-2M1`/`-2M2` (`WV_2`), `-3M1`/`-3M2` (`WV_3`): **No boxes, no arrows, no solenoids, no springs** — only port circles and labels.
- `-1A1` (`CylDGPPAB`): **No cylinder barrel, no piston, no rod** — only 2 floating port circles and `-1B1`/`-1B2`.
- `-1V2`, `-1V3`, `-3V2`, `-3V3`, `-2V3` (`DRSV2_pneu`): **Invisible** — only two empty circles.
- `-2Z1` (`FilterP`), `-2V2` (`CheckValveSpringLoadedP`): **Invisible**.

---

### Root Cause 2 (HIGH): Catalog Size vs FluidSIM Bounding-Box Mismatch (`pneumatics45.ts` vs `ctTextCodec.ts`)
`layoutRouter.ts` checks zero-overlap using `defaultSize` from `src/catalog/pneumatics45.ts`, whereas `ctTextCodec.ts` serializes FluidSIM bounding boxes **2×–3× wider**:

| Component | Catalog `defaultSize` (`layoutRouter`) | Emitted `ctTextCodec.ts` Box (`×1024`) | Real `distributing station.ct` Box (`×1024`) |
| --- | --- | --- | --- |
| `valve_5_2` (`WV_5`) | `~36 × 18` | `108 × 36` (`110592 × 36864`) | **`126 × 36`** (`129024 × 36864`) |
| `valve_3_2` (`WV_3`) | `~32 × 18` | `84 × 36` (`86016 × 36864`) | **`102 × 36`** (`104448 × 36864`) |
| `valve_2_2` (`WV_2`) | `~28 × 18` | `72 × 36` (`73728 × 36864`) | **`102 × 36`** (`104448 × 36864`) |
| `cylinder_double_acting` (`CylDGPPAB`) | `46 × 18` | `56 × 32` (`57344 × 32768`) | **`56 × 32`** (`57344 × 32768`) |
| `swivel_drive` (`PAR1b`) | `32 × 22` | `40 × 32` (`40960 × 32768`) | **`30 × 39`** (`30720 × 39935`) |
| `flow_control_one_way` (`DRSV2_pneu`) | `~14 × 18` | `15 × 42` (`15360 × 43008`) | **`45 × 60`** (`46080 × 61440`) |
| `air_service_unit` | `20 × 16` | `24 × 24` (`PPE2`) | **`120 × 66`** (`Wartungseinheit2`) |

**Actual measured overlaps in `gen_body.txt`:**
- `WV_3 O107` (`x=122880..208896`) collides directly with `WV_3 O117` (`x=163840..249856`) — **45,056 units overlap!**
- `WV_2 O68` (`x=286720..360448`) collides directly with `WV_2 O59` (`x=327680..401408`) — **32,768 units overlap!**
- `PTriconnection O89` (`J_VAC_1`), `PTriconnection O97` (`J_VAC_2`), `PSW1 O81` (`EX_2V1`), `WV_3 O107/O117`, `BUS_1`, `BUS_EXH` are all placed on the **exact same Y row (`y = 158720`)**!

---

### Root Cause 3 (HIGH): Misplaced `UEConnection`/`UMConnection`, Unrotated Ports, and Tiny `PConnection` Hitboxes
1. **Valve pilot/solenoid circles stamp over labels (`ooo` bug):**  
   In `ctTextCodec.ts` (`valve_2_2`, `valve_3_2`, `valve_4_2`, `valve_5_2`), `UEConnection` and `UMConnection` pass `portName = undefined` into `addPortObj(...)`, falling back to:
   `offX = gateNum * 3072` (`gateNum = 8..11 -> 24576..33792`, `offY = 0`).  
   This drops **4 tiny circles directly across the top-center of the valve** (overlapping ports `4`/`2` and the solenoid text label `-1M1`, `2M2`, `2M1`, `3M1`, `3M2`).  
   In real FluidSIM `WV_5`/`WV_3`/`WV_2`, `UEConnection`/`UMConnection` belong on the **left and right actuation ends** (`x1 - 5120` and `x2 + 5120`, vertically centered at `y1 + 19456` / `y1 + 6144`), NOT on `gateNum * 3072`!
2. **Ports ignore `rotationDeg`:**  
   `addPortObj` reads `portDef.offset.x / y` **without rotating by `comp.rotationDeg`**. Rotated components (`-1V2`, `-1V3`, `-3V2`, `-3V3` at `180°`, `-2Z1` at `90°`, `-2V1` at `180°`) keep unrotated port coordinates, twisting wires across bodies.
3. **`PConnection` box size:**  
   Emitted as `4096 × 4096` instead of FluidSIM's standard `10240 × 10240`.

---

### Root Cause 4 (MEDIUM-HIGH): Wrong Class Mappings (`exhaust_silencer`, `air_service_unit`, `pressure_switch_differential`)
- `exhaust_silencer` (`EX_MAIN`, `EX_2V1`) is mapped in `nativeFallbackMap` to **`PSW1`** — which in FluidSIM 4.5 is a **Pneumatic Indicator / Pressure Switch (`|>`)**, NOT an exhaust silencer! Silencers on ports belong on the port itself via `S ex_type S EX3`, or if standalone, should never emit `PSW1`.
- `air_service_unit` (`-0Z1`) is mapped to `PPE2` (`24×24`, visually upside-down/clipped next to `SRC_1`) instead of `Wartungseinheit2` (`120×66` with ISO 1219 FRL `SYM` blocks). And `layoutRouter` placed `FRL_0Z1` **to the left** of `SRC_1` (`x=285` vs `x=320`) with `SRC_1` port pointing upwards and overlapping text.
- `pressure_switch_differential` (`-2B1`) is mapped to `PEW` (renders as floating `]` bracket with missing body symbol), whereas real `distributing station.ct` uses `PSW1` (with `-2B1` text label) or needs `PEW` `dxf_prim_list` `SYM` geometry.

---

### Root Cause 5 (MEDIUM): Negative-Y `R_SCHALT`, Title Overlap, and Inverted / Spaghetti Layout
1. **Negative Y coordinates & Title Collision:**  
   Layer 0 sits at `y = 15`, `ctTextCodec` places `R_SCHALT` at `y1 - 24576 = -9216..3072` (off the top of the sheet!), colliding right into the sheet title `text O137` (`y = 6144..18432`) and top-left `PAV1S` (`CUP_2A1` placed at `15, 15`).
2. **Spaghetti Branch Crossing (`autoLayoutCircuit`):**
   - `CUP_2A1` (`vacuum_sucker`) was placed at far top-left `(15, 15)` next to `-1A1`, instead of in **Branch 2 (middle column)** above `-2Z1`!
   - `SWIVEL_3A1` (`-3A1`) was packed closely to `-1A1`, colliding `-3B1` with `-1B2`.
   - `J_VAC_1`, `J_VAC_2` (`pneumatic_junction`) and `EX_2V1` defaulted to `layoutLayer: 3` (bottom manifold row), pulling Branch 2 vacuum lines **all the way down through the valve row and back up**.
   - `BUS_1` and `BUS_EXH` use `PTriconnection` which FluidSIM draws as giant filled black dots clustered at `y=158720` right next to `WV_3` valves.
