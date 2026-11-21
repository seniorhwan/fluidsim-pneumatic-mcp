# Recreation Failure & Weakness Audit: Festo MPS-C Distributing Station Pneumatic

**Source Schematic:** `Distribution station pneumatic.pdf` (Festo Didactic MPS-C Station Verteilen Pneumatik / Distributing Station Pneumatic, DIN A3, `11.04.05`, `MBEL`)  
**Tested Against:** `fluidsim-pneumatic-mcp` (`origin/main`) over live `stdio` MCP (`authoring` mode)  
**Ground-Truth Verification:** 350 DPI visual inspection + local Festo FluidSIM Pneumatics 4.5 `sym\` library (`C:\Program Files (x86)\Didactic\fl_sim_p4.en\sym\`)  

---

## 1. Executive Verdict

**Cannot be faithfully recreated today.** While a **37-component, 47-connection** substituted approximation (`docs/audit/attempts/distribution_station_attempt.ct` and `.fsim.json`) can be forced to pass `circuit_validate` by adding a dummy 24V electrical sheet and replacing 8 missing components with generic valves/cylinders, **none of the three station branches (`-1V1`, `-2V1`, `-3V1`) can be modeled accurately** in `fluidsim-pneumatic-mcp`.

---

## 2. Verified Schematic BOM vs. `fluidsim-pneumatic-mcp` Catalog & Features

| Schematic Tag | Real Component in `Distribution station pneumatic.pdf` | MCP Status | Exact Gap / Failure Point |
| :--- | :--- | :--- | :--- |
| **`-0V1`** | CPV10 Valve Terminal manifold frame + 5 shared internal buses (`1`, `11`, `3/5`, `12/14`, `82/84`) + blind plugs (`\|—`) on right | **MISSING / PARTIAL** | No manifold/sub-circuit grouping, no busbars, no `blind_plug` terminator (`ex_type` only emits `EX0`/`EX3`), `pneumatic_junction` has only 3 ports (`1,2,3`) requiring chained `J_BUS1..4` & `J_EX1..5`. |
| **`-1V1` (`-1M1`)** | `5/2-way` single-solenoid valve. Left: manual override `\|=` + solenoid `[ / ]` + pilot `▷`. Right: pneumatic spring (`112`). Port `2` crosses left to `-1A1` cap end (extended at rest). | **PARTIAL** | `valve_5_2` exists, but `leftActuation`/`rightActuation` only allow **one** `ValveActuationType` (cannot combine manual override + solenoid + internal pilot), and there is **no `pneumatic_spring`** (`PNEU_SPRING_R` is never emitted; using `pneumatic_pilot` fails with `UNCONNECTED_PILOT_PORT`). |
| **`-1V2`, `-1V3`** | One-way flow control valves (`180°` meter-out exhaust throttling) | **PARTIAL** | `flow_control_one_way` exists, but `rotationDeg` cannot be set (`UNKNOWN_PARAMETER`, hardcoded to `0` in `layoutRouter.ts:130,172`). |
| **`-1A1` (`-1B1`, `-1B2`)** | Double-acting ejecting cylinder with proximity sensors `-1B1`/`-1B2` | **WORKS (w/ caveat)** | `cylinder_double_acting` + `set_distance_rule` work, though `proximity_switch_magnetic` is unverified in FluidSIM 4.5 IDs. |
| **`-2M1`, `-2M2`** | Two `2/2-way` **Normally Closed** valves (`-2M1`: manual+solenoid+pilot vs spring+pneumatic spring `10`; `-2M2`: manual+solenoid+pilot vs pneumatic spring `110`) | **MISSING** | **No `valve_2_2` in catalog** (`PREFLIGHT_UNKNOWN_COMPONENT_TYPE`). Must be poorly substituted with `valve_3_2`, which adds a nonexistent exhaust port `3`. |
| **`-2V1` (Venturi)** | Vacuum suction nozzle (Venturi ejector) inside slice `E` | **MISSING** | **No Venturi / vacuum generator** in catalog (`catalog_search("vacuum")` & `("venturi")` return 0 results). |
| **`-2V2`** | Spring-loaded check valve (non-return valve, `0°` vertical) | **MISSING** | **No standalone check valve** in catalog (`catalog_search("non-return")` returns 0 results). |
| **`-2V3`** | One-way flow control valve (`0°`, blow-off throttle) | **PARTIAL** | `flow_control_one_way` exists (no `0°`/`180°` orientation control). |
| **`-2Z1`** | Air filter (`90°` vertical, between vacuum line and sucker) | **MISSING** | **No standalone `air_filter`** (`FilterP`) in catalog; only `air_service_unit` (FRL) exists. |
| **`-2B1`** | Adjustable vacuum / pressure switch | **MISSING** | **No pneumatic-to-electrical pressure/vacuum switch** (`PEW`) in catalog. |
| **`-2A1`** | Vacuum suction cup (Sucker) | **MISSING** | **No sucker / vacuum cup** in catalog (`catalog_search("sucker")` returns 0 results). |
| **`-3M1`, `-3M2`** | Two `3/2-way` **Normally Open** valves (Left: manual+solenoid+pilot; Right: pneumatic spring `14`/`112`) | **BROKEN** | `valve_3_2` exists, **but has no `normallyOpen` / `initialPosition` parameter** (`UNKNOWN_PARAMETER`), so it can only simulate/serialize as Normally Closed! |
| **`-3V2`, `-3V3`** | One-way flow control valves (`180°` meter-out) | **PARTIAL** | Same rotation limitation (`rotationDeg` ignored). |
| **`-3A1` (`-3S1`, `-3S2`)** | Semi-rotary / swivel drive (`180°`) with end-position sensors `-3S1` (Magazine) & `-3S2` (Downstream) | **MISSING** | **No rotary / swivel actuator** in catalog (`catalog_search("swivel")` & `("rotary")` return 0 results). |
| **Sheet / Annotations** | DIN A3 Landscape (`420 × 297 mm`), ISO 1219 frame, text labels, pneumatic-only sheet (electrical ladder on separate sheets) | **BROKEN / MISSING** | `circuit_validate` rejects pneumatic-only sheets with `UNBOUND_VALVE_SOLENOID`; `layoutRouter.ts` expanded the attempt sheet to `760 × 230 mm`; `ctTextCodec.ts:949` hardcodes `sheetWidthMm: 297` on `.ct` parse. |

---

## 3. Empirical Failure Points Observed During Live MCP Recreation

### 3.1 Catalog & Preflight Rejections
- `add_component` with `type: "valve_2_2"` -> `PREFLIGHT_UNKNOWN_COMPONENT_TYPE: Patch op[0] (add_component) references unknown catalog type "valve_2_2".`
- `add_component` with `type: "vacuum_nozzle"` -> `PREFLIGHT_UNKNOWN_COMPONENT_TYPE: Patch op[0] (add_component) references unknown catalog type "vacuum_nozzle".`
- `add_component` with `rightActuation: { type: "pneumatic_spring" }` -> Zod schema validation failure (not in `ValveActuationType` enum).

### 3.2 Unrecognized Parameters on Existing Components
- `valve_3_2` with `params: { normallyOpen: true }` -> `[warning] UNKNOWN_PARAMETER: Component "V3" (valve_3_2) has unrecognized parameter "normallyOpen".`
- `flow_control_one_way` with `params: { rotationDeg: 180 }` -> `[warning] UNKNOWN_PARAMETER: Component "FC1" (flow_control_one_way) has unrecognized parameter "rotationDeg".`

### 3.3 Validator Blockers on Real-World Pneumatic Schematics
Testing a clean pneumatic-only `-1V1` + `-1A1` branch (without an electrical 24V ladder on the same sheet) failed `circuit_validate` (`valid: false`, 2 errors):
- `[error] UNCONNECTED_PILOT_PORT`: `Valve V52 has rightActuation="pneumatic_pilot" but pilot port "12" is unconnected.` (`src/simulator/validator.ts:254-261`) — because there is no `pneumatic_spring` / internal pilot (`12/14` bus) mode.
- `[error] UNBOUND_VALVE_SOLENOID`: `Valve(s) V52 reference solenoid "-1M1", but no electrical valve_solenoid "-1M1" exists.` (`src/simulator/validator.ts:554`) — prevents authoring standalone pneumatic sheets whose electrical ladder lives in another sheet/file.

### 3.4 Layout & `.ct` Fidelity Weaknesses on the 37-Component Attempt
- **Sheet Overflow (`760 × 230 mm`):** `layoutRouter` placed components from `X=20..720 mm`, overflowing DIN A3 (`420 × 297 mm`) by +340 mm horizontally (`src/authoring/layoutRouter.ts:235`).
- **Hardcoded `0°` Rotation:** `layoutRouter.ts:130, 172` overwrites `rotationDeg: 0` on all components.
- **Hardcoded `297 mm` Sheet Width on `.ct` Parse:** `ctTextCodec.ts:949` hardcodes `sheetWidthMm: 297` when parsing `.ct` files, losing A3 dimensions.
- **Actuation Props in `.ct`:** `ctTextCodec.ts:983` (`getFluidSimActuationProps`) cannot emit `PNEU_SPRING_R S TRUE`, `SWITCHED_POS_L` (Normally Open), or combined `ACTUATION_L_MA` + `ACTUATION_L_EL_PN`.
- **Simulation Result on Attempt:** `-1A1` correctly began extending at `t=0` (due to `-1V1.2 -> -1A1.A` crossover) and retracted when `S_1M1` was pressed at `t=400ms`, reaching `0 mm` (`1B1`), confirming the solver's basic crossover behavior works when dummy 24V coils are added.

---

## 4. Ground-Truth FluidSIM 4.5 `sym/` Class IDs for Missing Components

Extracted directly from `C:\Program Files (x86)\Didactic\fl_sim_p4.en\sym\` (and verified against FluidSIM 4.5 `.ct` ASTs):

| Needed Component | FluidSIM 4.5 Class ID | Source `sym\` File | Key Verified `.ct` Properties |
| :--- | :--- | :--- | :--- |
| **`2/2-way` valve (`-2M1`, `-2M2`)** | `WV_2` | `pneu\valve\cvalve\cv2.ct` | `PNEU_SPRING_R`, `SPRING_L`, `SPRING_R`, `SWITCHED_POS_R`, `ACTUATION_R_EL_PN`, `ACTUATION_R_ME` |
| **`3/2-way` NO valve (`-3M1`, `-3M2`)** | `WV_3` | `pneu\valve\cvalve\cv3.ct` | Configurable `SWITCHED_POS_L`/`SWITCHED_POS_R` + `PNEU_SPRING_R S TRUE` |
| **`5/2-way` valve (`-1V1`)** | `WV_5` | `pneu\valve\cvalve\cv5.ct` | `PNEU_SPRING_R`, `SPRING_R`, `ACTUATION_R_EL_PN`, `ACTUATION_R_MA` |
| **Air filter (`-2Z1`)** | `FilterP` | `pneu\supply\psup7.ct` | `NN_FLOW F 1000`, ports `1`, `2` (`PConnection`) |
| **Vacuum / Differential pressure switch (`-2B1`)** | `PEW` | `pneu\sensor\ps2.ct` | `P_SOLL F 3`, ports `P1`, `P2` (`PConnection`) |
| **Check valve (spring-loaded / pilot)** | `CheckValvePilotOperatedSpringLoadedP` | `pneu\valve\sfcvalve\sf5d.ct` | `NN_FLOW`, `P_V`, ports `1`, `2` (`PConnection`) |
| **Blind plug / Exhaust terminators** | `PConnection` (`ex_type`) | `TP101_06.ct` / `ctTextCodec.ts` | `ex_type`: `EX0` (open), `EX3` (silencer); blind plug / exhaust triangles use `EX1`/`EX2`/`EX4` |
| **Venturi / Sucker / Swivel Drive** | *(in `6e33c0a6...` / `7f8943f8...` `sym/` files)* | `sym\pneu\...` | Pending C3 multi-magic `.ct` decoder fix to extract exact class names |
