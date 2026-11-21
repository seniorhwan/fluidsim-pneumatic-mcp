# Prompt for AI in Google AI Studio: Fix `fluidsim-pneumatics-mcp` & Add Project-From-Scratch Support

Copy and paste everything below the line into Google AI Studio:

---

You are maintaining `fluidsim-pneumatics-mcp` (a 100% headless TypeScript/Node.js MCP server for Festo FluidSIM Pneumatics 4.5). An empirical audit against Google AI Studio, Windows Node.js `v24`, and 263 official Festo FluidSIM 4.5 `.ct` files uncovered critical compatibility blockers, codec/simulator bugs, and missing project-creation capabilities.

Fix **all** issues below in priority order while preserving all existing passing tests and headless/stdio purity (`console.log` must never be used in MCP server paths).

---

## Part 1: Fix Google AI Studio / Gemini Compatibility Blockers (CRITICAL)

### 1.1 Make All 14+ MCP Tool JSON Schemas 100% Gemini Function-Calling Compatible (`src/mcp/toolSchemas.ts`, `src/mcp/server.ts`)
**Problem:**
- `patchOpSchema` in `src/mcp/toolSchemas.ts` uses `z.discriminatedUnion('op', [...])`, which Zod v4 serializes to `oneOf` + `const`.
- `componentNodeSchema.params` and `update_component.patch.params` use `z.record(z.string(), z.union([z.number(), z.string(), z.boolean()]))`, which serializes to `propertyNames` + `additionalProperties: { type: ["number", "string", "boolean"] }`.
- Every tool's `inputSchema` emits `"$schema": "http://json-schema.org/draft-07/schema#"`.
- Google AI Studio / Gemini Function Calling rejects `oneOf`, `anyOf`, `allOf`, `const`, `propertyNames`, `additionalProperties` as an object schema, and union `type` arrays.

**Required Fix:**
1. Replace `patchOpSchema` (`z.discriminatedUnion`) with a **single flat `z.object`** where `op` is `z.enum(['add_component', 'update_component', 'remove_component', 'connect', 'disconnect', 'set_distance_rule', 'set_label'])` and operation-specific fields (`component`, `id`, `patch`, `removeConnectedEdges`, `from`, `to`, `edgeId`, `componentId`, `markers`, `label`, `side`) are optional properties. Validate required fields per `op` in `applyCircuitPatch` / `handleCircuitApplyPatch` with clear `EngineeringError` messages.
2. Replace `z.record(z.string(), z.union([z.number(), z.string(), z.boolean()]))` with either:
   - `paramsJson: z.string().optional().describe('JSON object string of component parameters, e.g. {"strokeMm":100}')` OR
   - `params: z.array(z.object({ key: z.string(), valueString: z.string().optional(), valueNumber: z.number().optional(), valueBoolean: z.boolean().optional() })).optional()`
   (You may still accept plain objects internally in `applyCircuitPatch`, but the exposed MCP Zod schema MUST NOT emit `propertyNames` or `type: [...]` arrays.)
3. Add a unit test in `src/tests/mcpProtocol.test.ts` that calls `client.listTools()` and asserts **zero** occurrences of `$schema`, `oneOf`, `anyOf`, `allOf`, `const`, `propertyNames`, or array `type` values across every tool's `inputSchema` (Note: if `@modelcontextprotocol/sdk` injects `$schema` on `tools/list`, intercept/sanitize the schema or register via a helper that strips unsupported keywords).

### 1.2 Add Streamable HTTP / SSE MCP Transport (`bin/fluidsim-mcp.ts`, `src/mcp/server.ts`)
**Problem:** Only `StdioServerTransport` is implemented, so web-based AI Studio / remote Gemini clients cannot connect.
**Required Fix:**
- Add `--transport stdio|http` (default `stdio`) and `--port <number>` (default `3000`) / `--host <addr>` (default `127.0.0.1`) to `bin/fluidsim-mcp.ts serve`.
- Wire `StreamableHTTPServerTransport` (from `@modelcontextprotocol/sdk/server/streamableHttp.js`) over `express` (already in `package.json`) on `POST /mcp`, `GET /mcp`, `DELETE /mcp`, plus a `GET /health` endpoint returning `{ ok: true, serverVersion, accessMode }`.
- Keep `stdio` mode 100% intact for CLI/IDE hosts.

### 1.3 Fix `npm install` `ERESOLVE` & Build/Bin Packaging (`package.json`, `bin/fluidsim-mcp.ts`)
**Problem:**
- `npm install` fails with `ERESOLVE` (`vite@8.3.8` vs `esbuild@^0.25.0`).
- `package.json` `"bin"` points to `.ts` (`./bin/fluidsim-mcp.ts`), `"build"` runs `vite build` on an unused React template, and `print-config` outputs fragile `npx tsx ...`.
**Required Fix:**
- Remove unused Vite/React template dependencies (`react`, `react-dom`, `vite`, `@vitejs/plugin-react`, `@tailwindcss/vite`, `tailwindcss`, `autoprefixer`, `lucide-react`, `motion`) OR align `esbuild` to `^0.27.0` if keeping any web UI.
- Add a real TypeScript build (`tsc -p tsconfig.build.json` or `esbuild` bundle) producing `dist/bin/fluidsim-mcp.js` and point `"bin": { "fluidsim-mcp": "./dist/bin/fluidsim-mcp.js" }`, with `print-config` preferring `node <dist/bin/fluidsim-mcp.js>` when built (or `node <repo>/node_modules/tsx/dist/cli.mjs` as fallback instead of `npx tsx`).

---

## Part 2: Add "Create New Project From Scratch" Feature Set (HIGH)

Agents need to initialize brand-new FluidSIM projects from an empty or nonexistent directory and manage multi-circuit projects cleanly.

### 2.1 Auto-Create Nonexistent Workspace Root (`src/safety/workspaceGuard.ts`, `bin/fluidsim-mcp.ts`)
- Currently `WorkspaceGuard.ensureRootExists()` throws `WORKSPACE_NOT_FOUND` and crashes the server if `--workspace` points to a new directory.
- Add `--init-workspace` (or default to creating the directory with `fs.mkdirSync(this.root, { recursive: true })` in `authoring` mode when the parent exists, while still rejecting if `this.root` exists as a non-directory file).

### 2.2 New Tool: `project_create` (`src/mcp/tools/workspaceTools.ts` or `authorTools.ts`, `src/mcp/toolSchemas.ts`, `src/mcp/server.ts`)
Create a new authoring tool `project_create` (requires `authoring` mode in `TOOL_POLICIES`):
- **Flat Gemini-compatible Zod input shape:**
  ```ts
  export const projectCreateInputShape = {
    projectDir: z.string().default('.').describe('Relative directory inside workspace (use "." for workspace root).'),
    name: z.string().min(1).describe('Project name (e.g. "Pick and Place Station").'),
    description: z.string().optional().describe('Optional engineering description.'),
    sheetSize: z.enum(['DIN_A4_LANDSCAPE', 'DIN_A3_LANDSCAPE', 'DIN_A4_PORTRAIT']).default('DIN_A3_LANDSCAPE'),
    author: z.string().optional(),
    starterCircuit: z.enum(['none', 'blank', 'pneumatic_basic', 'electro_pneumatic_24v']).default('pneumatic_basic'),
    starterFileName: z.string().default('main.ct').describe('Filename inside <projectDir>/circuits/ (e.g. "main.ct" or "main.fsim.json").'),
    overwrite: z.boolean().default(false),
  };
  ```
- **Behavior:**
  1. Resolve `projectDir` safely inside `WorkspaceGuard` jail (reject `..` traversal or symlink escapes).
  2. Create `<projectDir>/circuits/` and write `<projectDir>/fluidsim-project.json` (manifest containing `schemaVersion: "1.0"`, `name`, `description`, `author`, `sheetSize`, `createdAt`, `circuits: [...]`).
  3. Write `<projectDir>/README.md` summarizing the project and sheet standard.
  4. If `starterCircuit !== 'none'`, generate `<projectDir>/circuits/<starterFileName>` with matching sheet dimensions (`DIN_A4_LANDSCAPE`: 297×210 mm, `DIN_A3_LANDSCAPE`: 420×297 mm, `DIN_A4_PORTRAIT`: 210×297 mm) and verify it passes `circuit_validate` (`valid: true, errorCount: 0`).
  5. Return `{ projectDir, manifestPath, starterCircuitPath, validation }`.

### 2.3 Fix `circuit_create` Templates (`src/mcp/tools/authorTools.ts`)
- Currently `pneumatic_basic` and `electro_pneumatic_24v` create `MANIFOLD_1` (`pneumatic_junction`) with port `2` unconnected, which immediately fails `circuit_validate` (`OPEN_PNEUMATIC_PORT` error + `DANGLING_JUNCTION` warning).
- Fix both templates so they pass `circuit_validate` with **`valid: true, errorCount: 0, warningCount: 0`** (e.g., either remove the dangling `MANIFOLD_1` until components are added, or include a complete minimal valid branch such as `3/2` valve + silencer + single-acting cylinder).
- Add optional `sheetSize` (`DIN_A4_LANDSCAPE` | `DIN_A3_LANDSCAPE` | `DIN_A4_PORTRAIT`) to `circuitCreateInputShape` and `circuitGenerateFromSpecInputShape` (defaulting to `DIN_A3_LANDSCAPE` 420×297 mm or `DIN_A4_LANDSCAPE` 297×210 mm).

### 2.4 Add Circuit File Lifecycle Tools (`src/mcp/tools/authorTools.ts`, `src/mcp/toolSchemas.ts`, `src/mcp/server.ts`, `src/safety/policyCatalog.ts`)
Add three authoring-mode tools with full `WorkspaceGuard` jail checks:
- `circuit_clone`: `{ sourcePath, targetPath, overwrite?: boolean, newTitle?: string }` — clones an existing `.ct` or `.fsim.json` (and can convert between `.ct` and `.fsim.json`!), re-validates postcondition.
- `circuit_rename`: `{ fromPath, toPath, overwrite?: boolean }` — atomic move/rename inside workspace jail.
- `circuit_delete`: `{ path, confirm: z.boolean() }` — deletes a circuit file inside workspace jail (requires `confirm: true`).

---

## Part 3: Fix Codec, Spec Generator & Windows Test Bugs (HIGH / MEDIUM)

### 3.1 Support All 3 FluidSIM 4.x/4.5 `.ct` Magic Headers (`src/codec/ctBinaryCodec.ts`, `src/codec/ctDetector.ts`)
**Empirical Finding:** Out of 263 official `.ct` files in `C:\Program Files (x86)\Didactic\fl_sim_p4.en\ct\`, **231 (87.8%)** failed with `UNRECOGNIZED_CIRCUIT_FORMAT` because `isFluidSimCtBuffer()` only checks `3e6c75423f56daaf205628b0c36c08bb`.
All three official variants share the exact same `FLUIDSIM_CT_MARKER_LINE` (`50c2e8b3557fcece`):
- `3e6c75423f56daaf205628b0c36c08bb` (32 files)
- `6e33c0a621ce30e820ce6fa953336de9` (186 files)
- `7f8943f87a219c112021f2680b898bcf` (45 files)
Update `isFluidSimCtBuffer()` to recognize all three prefixes (and verify `FLUIDSIM_CT_MARKER_LINE` is present in the header lines).

### 3.2 Fix `ctTextCodec.ts` Wire/Junction Parsing on Real FluidSIM `.ct` Files
**Empirical Finding:** 17/32 parsed official FluidSIM circuits fail `validateCircuitStatic` with 126 `OPEN_PNEUMATIC_PORT` errors because `ctTextCodec.ts` misses wire connections on rotated components (e.g. `PVS4` at `270°`), `PTriconnection` junctions, and multi-segment polylines (`L ...`). Fix coordinate/port matching for rotated components and `PTriconnection` nodes.

### 3.3 Fix `circuit_generate_from_spec` for Single-Acting + Dwell in `electro-pneumatic-step-chain` (`src/authoring/specGenerator.ts`)
**Empirical Finding:** `actuators: [{ label: "A", type: "single-acting", throttles: true }, { label: "B", type: "double-acting", throttles: true }]` with `sequence: ["A+", "WAIT:500ms", "B+", "A-B-"]` and `controlMethod: "electro-pneumatic-step-chain"` fails `sequenceVerification` (`expected "B+", observed "A-"`).
**Fix:** Ensure the solenoid holding a single-acting actuator extended across multiple steps/dwells does not drop for 1 tick during relay step handoff (`K1 -> K2 -> K3`), or use a memory-latch relay (`K_HOLD_A`) set on `A+` and reset on `A-`.

### 3.4 Verify Remaining Catalog Class IDs (`src/catalog/pneumatics45.ts`)
Update `fluidsim45ClassId` and `fluidsim45IdVerified: true` for the empirically verified FluidSIM 4.5 symbols:
- `valve_4_2` -> `WV_4`
- `valve_5_3` -> `WV_5`
- `quick_exhaust_valve` -> `DV_P1`
- `shuttle_valve_or` -> `PVS3`
- `dual_pressure_valve_and` -> `DRSV2_pneu`
- `pressure_regulator` -> `PressureReducingValve3WaysAdjustableP`
- `relay_contact_changeover` -> `LWechsler`
- `timer_relay_off_delay` -> `LRelaismagnet_abfver`

### 3.5 Fix Windows `spawnSync tsx.cmd EINVAL` in Tests (`src/tests/mcpProtocol.test.ts:214`)
Replace `execFileSync(TSX_BIN, ...)` with `execFileSync(process.execPath, [path.join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs'), ...])` so tests pass cleanly on Windows Node.js `>=20.12`.

---

## Part 4: Real-World Industrial Festo MPS / Distributing Station Support (HIGH)

Attempting to recreate `Distribution station pneumatic.pdf` (Festo MPS-C Distributing Station) exposed 8 missing components and 5 modeling/validation limitations. Add support for:

### 4.1 Add Missing Industrial Pneumatic Components (`src/catalog/pneumatics45.ts`, `src/codec/ctTextCodec.ts`, `src/simulator/pneumaticSolver.ts`)
Using the empirically verified FluidSIM 4.5 class IDs from `sym/`:
- `valve_2_2` -> FluidSIM class `WV_2` (`2/2-Way Directional Control Valve`, ports `1`, `2`, `10`/`12`, supports `normallyOpen?: boolean`).
- `air_filter` -> FluidSIM class `FilterP` (`Air Filter`, ports `1`, `2`).
- `check_valve_spring` -> FluidSIM class `CheckValvePilotOperatedSpringLoadedP` or standard spring-loaded check valve (ports `1`, `2`).
- `pressure_switch_differential` -> FluidSIM class `PEW` (`Differential / Vacuum Pressure Switch`, pneumatic ports `P1`, `P2` + threshold `pressureBar` + electrical contact binding).
- `blind_plug` -> Terminator on `PConnection` (`ex_type` blind plug) so capped manifold ports (`1`, `11`, `3/5`, `12/14`, `82/84`) pass validation without open-port errors.
- `vacuum_suction_nozzle` (Venturi ejector), `vacuum_sucker` (suction cup), and `swivel_drive` (`180°` semi-rotary actuator) — extract exact class IDs from `C:\Program Files (x86)\Didactic\fl_sim_p4.en\sym\` once Part 3.1 (multi-magic `.ct` decoder) is complete.

### 4.2 Composite Valve Actuation & Normally Open Support (`src/contracts/circuit.ts`, `src/codec/ctTextCodec.ts`, `src/simulator/validator.ts`)
- Extend `ValveActuationType` to include `pneumatic_spring` (`PNEU_SPRING_R S TRUE` — internal air-spring `[─<|]`, does NOT require an external wired `12`/`14` port!).
- Allow optional `manualOverride?: boolean` and `internalPilot?: boolean` on `ValveActuationSide` so valves like `-1M1`, `-2M1`, `-2M2`, `-3M1`, `-3M2` can represent `[manual_override + solenoid + internal_pilot]` on the left and `[spring + pneumatic_spring]` on the right.
- Add `normallyOpen?: boolean` parameter to `valve_3_2` and `valve_2_2` (and emit the corresponding `SWITCHED_POS_L`/`SWITCHED_POS_R` in `ctTextCodec.ts` and initial flow state in `pneumaticSolver.ts`).

### 4.3 Component Orientation, DIN A3 Sheet Preservation & Pneumatic-Only Sheets
- Allow `rotationDeg?: 0 | 90 | 180 | 270` on components (do not overwrite with `0` in `src/authoring/layoutRouter.ts:130, 172`), so meter-out throttles (`180°`) and vertical filters (`90°`) preserve orientation.
- Preserve DIN A3 (`420 × 297 mm`) sheet bounds in `layoutRouter.ts` and `ctTextCodec.ts:949` (do not hardcode `297` on `.ct` parse or expand horizontally to `760 mm` unnecessarily).
- Add an optional `allowExternalElectricalSheet?: boolean` (or `sheetDomain: 'pneumatic-only' | 'electro-pneumatic'`) metadata/validation option so standalone pneumatic schematics with solenoid tags (`-1M1`..`-3M2`) can validate without `UNBOUND_VALVE_SOLENOID` errors when the electrical ladder is on a separate sheet.

---

## Part 5: Real FluidSIM 4.5 `.ct` Open/Crash Fixes (Proven Against `fl_sim_p.exe`) (CRITICAL)

Testing `v0.2.0`-generated `.ct` files directly in **Festo FluidSIM Pneumatics 4.5 (`fl_sim_p.exe`)** proved that FluidSIM crashes (`0xC0000005` / `-1073741819`) or throws `Error Code 2755 in Module 97098` / `Unknown file format.` due to two bugs:

### 5.1 Fix Linear Ring-Buffer Bounds in `compressCtPayload` (`src/codec/ctBinaryCodec.ts:390-422`)
- **Root Cause:** `compressCtPayload` uses `% ringLimit` (`ring[(ref + mlen) % ringLimit]`), emitting matches where `ref + mlen > ringLimit` (and `ref + mlen > maxFilled` before first wrap). FluidSIM 4.5's C++ decompressor reads `ring[ref .. ref + len - 1]` linearly without modulo wrap-around, causing out-of-bounds reads (`0xC0000005` / `Error 2755`).
- **Fix:** Track `maxFilled` (initially `initRpos`) and `wrapped = false`. In the LZ match search (`lines 390-409`), set `searchLimit = wrapped ? ringLimit : maxFilled`, iterate `for (let ref = 0; ref <= searchLimit - 3; ref++)`, clamp `avail = Math.min(maxAllowedMatch, searchLimit - ref)`, and compare `ring[ref + mlen]` **without `% ringLimit`**. Assert in tests that `ref + len <= ringLimit` for every emitted token.

### 5.2 Replace `PTriconnection` Placeholders & Mismatched Class IDs (`src/codec/ctTextCodec.ts`, `src/catalog/pneumatics45.ts`)
- **Root Cause:** `v0.2.0` serializes `vacuum_sucker`, `vacuum_suction_nozzle`, and `swivel_drive` as `PTriconnection` placeholders with `< 4` gates (`1`, `2`, `3`), which crashes `fl_sim_p.exe` (`0xC0000005`). It also maps `flow_control_one_way` to `DV_P1` (Quick Exhaust) and `check_valve_spring` to `CheckValvePilotOperatedSpringLoadedP` (3-port).
- **Fix (Verified Against Real Working `distributing station.ct`):**
  - `vacuum_sucker` -> **`PAV1S`** (1 `PConnection` port `1v`)
  - `vacuum_suction_nozzle` -> **`PAV1`** (3 `PConnection` ports `1`, `3`, `1v`; `S FLIPPED I 1`)
  - `swivel_drive` -> **`PAR1b`** (2 `PConnection` ports `A`, `B`; `S ALPHA F 180`, `S l1`, `S l2`)
  - `flow_control_one_way` -> **`DRSV2_pneu`** (`S LEVEL F <openingPct>`)
  - `check_valve_spring` -> **`CheckValveSpringLoadedP`** (2 `PConnection` ports `1`, `2`)
  - `pressure_switch_differential` -> **`PEW`** (2 ports `P1`, `P2`) or **`PSW1`** (1 port)
  - Never emit `PTriconnection` with `< 4` `gate` entries.

### 5.3 Remaining `v0.2.0` Simulator & Official-Corpus Issues
- Fix `circuit_generate_from_spec` when `single-acting` + `WAIT:500ms` + `electro-pneumatic-step-chain` runs (`seqPassed: false`: `expected "B+", observed "A-"`).
- Fix `ctTextCodec.ts` connection/junction/electrical-rung parsing so the 157/261 official FluidSIM 4.5 `.ct` files in `fl_sim_p4.en\ct\` do not produce false `OPEN_PNEUMATIC_PORT` / `UNREACHABLE_ELECTRICAL_RUNG` errors.

---

## Part 6: FluidSIM 4.5 Visual Rendering (`BEGINSYM`), Unified Scale, Rotated Ports & Clean ISO 1219 Layout (CRITICAL)

Opening `distribution_station_recreated.ct` (generated by commit `cac0ba8`) in Festo FluidSIM Pneumatics 4.5 (`fl_sim_p.exe`) proved that although the file no longer crashes, **it renders as an unusable visual mess** (see `docs/audit/VISUAL_RENDERING_FAILURE_AUDIT.md`). Fix the following 5 visual/codec/layout root causes:

### 6.1 Generate `BEGINSYM .. ENDSYM` + `dxf_prim_list` Vector Symbols for Fresh `.ct` Files (`src/codec/ctTextCodec.ts`, `src/codec/ctBinaryCodec.ts`, new `src/codec/ctSymbolLibrary.ts`)
- **Root Cause:** FluidSIM 4.5 does **not** have hardcoded GDI graphics for `WV_5`, `WV_3`, `WV_2`, `WV_4`, `CylDGPPAB`, `DRSV2_pneu`, `FilterP`, `CheckValveSpringLoadedP`, or `Wartungseinheit2`. It draws them using `S dxf_prim_list V <symIdx>` (and `dxf_prim_list2`/`3`) pointing to `SYM <symIdx>` vector blocks inside `BEGINSYM ... ENDSYM` in `trailerText`. Currently `ctBinaryCodec.ts:718` emits an empty `BEGINSYM\nENDSYM`, making almost every valve, cylinder, throttle, filter, and check valve **completely invisible** (only floating port circles appear).
- **Fix:**
  1. Extract clean canonical `SYM` vector primitive templates (for `CylDGPPAB`, `DRSV2_pneu`, `WV_5`, `WV_3`, `WV_2`, `WV_4`, `FilterP`, `CheckValveSpringLoadedP`, `Wartungseinheit2`, plus `PConnection` port stem `L` lines) from the repo's verified golden fixtures (`fixtures/golden/01..05.ct`).
  2. When serializing a freshly authored `.ct` (`!hasPreservedCt`), dynamically emit sequential `SYM 0`, `SYM 1`, ... inside `trailerText` (`BEGINSYM ... ENDSYM`) and emit the matching `S dxf_prim_list V <n>` / `dxf_prim_list2` properties on each object (including dynamic actuator left/right graphics for solenoids, manual overrides, pilot air, springs).
  3. Add a separate `S enum` / visible `text` label object cleanly offset next to components (like real FluidSIM `-1A1`, `-1V2`, `-2V1`, `-2Z1`, `-2B1`, `-2A1`), matching FluidSIM's `text` object schema instead of relying solely on `S label`.

### 6.2 Unify Coordinate Scale & Bounding Boxes (`src/catalog/pneumatics45.ts`, `src/authoring/layoutRouter.ts`, `src/codec/ctTextCodec.ts`)
- **Root Cause:** `pneumatics45.ts` defines small `defaultSize` boxes (`~20–46`) for `layoutRouter`, while `ctTextCodec.ts` serializes FluidSIM boxes 2×–3× wider (`WV_5` = `110592×36864`, real FluidSIM `129024×36864`; `WV_3` = `86016×36864`; `WV_2` = `73728×36864`; `DRSV2_pneu` = `46080×61440` in real FluidSIM). As a result, `WV_3` and `WV_2` overlap neighboring valves by `32k–45k` units even when `layoutRouter` reports zero overlaps. Also FluidSIM sheet coordinates use `~1050 × 600` (`× 1024`) for a clean A3 schematic (with `1 mm ≈ 3072` units, or A3 printable workspace `1290240 × 912384` units; use matching sheet header lines from an A3 golden template!).
- **Fix:**
  1. Align `catalog` `defaultSize`, `ports[].offset`, and `ctTextCodec.ts` `x2 - x1` / `y2 - y1` bounding boxes to **100% match real FluidSIM 4.5 dimensions** (`126×36` for `WV_5`, `102×36` for `WV_3`/`WV_2`, `56×32` for `CylDGPPAB`, `45×60` for `DRSV2_pneu`, `30×39` for `PAR1b`, `120×66` for `Wartungseinheit2`, `10×10` for `PConnection`).
  2. Enforce a strict test asserting **zero overlapping FluidSIM bounding boxes** directly on the **decoded `.ct` AST `RawCtObject` coordinates** (`x1, y1, x2, y2`), not just on IR `layout`.

### 6.3 Fix Valve `UEConnection`/`UMConnection` Positions & Port Rotations (`src/codec/ctTextCodec.ts`)
- **Root Cause:**
  1. `addPortObj(8..11, 'UEConnection' | 'UMConnection', undefined, ...)` falls back to `offX = gateNum * 3072` (`24576..33792`), stamping 4 ugly circles (`ooo`) directly across the middle of every valve label (`-1M1`, `2M2`, `2M1`, `3M1`, `3M2`) and colliding with pneumatic ports `4` and `2`.
  2. `addPortObj` uses unrotated `portDef.offset.x / y`, ignoring `comp.rotationDeg` (`90°`, `180°`, `270°`), and emits `4096×4096` `PConnection` hitboxes instead of `10240×10240`.
- **Fix:**
  1. Place `UEConnection` / `UMConnection` at the true left/right actuation ends of the valve (e.g., `x1 - 5120` and `x2 - 5120`, matching real FluidSIM `WV_5`/`WV_3`/`WV_2` offsets), with `S label` formatted cleanly (or empty when unused).
  2. Apply the same `rotatePortOffset(...)` transform in `ctTextCodec.ts` that `layoutRouter.ts` uses so rotated throttles (`180°`), filters (`90°`), and Venturi nozzles (`180°`) emit accurate FluidSIM `PConnection` centers (`10240×10240` hitbox + `con_descr` offsets).

### 6.4 Fix Mis-Mapped FluidSIM Classes (`exhaust_silencer`, `air_service_unit`, `pressure_switch_differential`)
- **Root Cause:**
  - `exhaust_silencer` maps to `PSW1` (which draws `|>` Pressure Indicator!).
  - `air_service_unit` maps to `PPE2` (simplified upside-down block) instead of `Wartungseinheit2` (real FRL with `SYM`).
  - `pressure_switch_differential` maps to `PEW` (broken `]` fragment without `SYM`), whereas `PSW1` renders a clean pneumatic switch/indicator natively.
- **Fix:** Embed `exhaust_silencer` onto connected `PConnection` ports as `S ex_type S EX3` for manifold/valve/nozzle ports (do not render `PSW1` for silencers!), serialize `air_service_unit` as `Wartungseinheit2` with its FRL `SYM`s, and map `pressure_switch_differential` (`-2B1`) to `PSW1` (or provide complete `SYM` primitives for `PEW`).

### 6.5 Eliminate Negative-Y `R_SCHALT`, Title Collisions & Branch Spaghetti (`src/authoring/layoutRouter.ts`, `src/codec/ctTextCodec.ts`)
- **Fix:**
  1. Reserve a top sheet header margin (`y >= 45` for Layer 0 actuators so `R_SCHALT` at `y1 - 24576` stays strictly `>= 20`, never negative Y and never touching the title `text` at top-left `y = 8..22`).
  2. Support **branch/column grouping** (and keep `pneumatic_junction` in the layer of its upstream neighbors instead of dumping all junctions into Layer 3 at the bottom!) so multi-branch schematics like Festo MPS-C Distributing Station lay out left-to-right in clean parallel columns (Branch 1 Ejector | Branch 2 Vacuum & Filter | Branch 3 Swivel Drive) above the horizontal `BUS_1`/`BUS_EXH` bus and `PPE1 -> Wartungseinheit2` supply at bottom-left — zero crossed vertical spaghetti lines.
  3. Add a test in `distributionStation.test.ts` verifying:
     - `BEGINSYM` has `>= 10` `SYM` blocks and every `CylDGPPAB`/`WV_*/DRSV2_pneu`/`FilterP`/`CheckValveSpringLoadedP` has `dxf_prim_list`.
     - **Every** object `x1, y1` in decoded `.ct` AST is `> 0`, `>= 20 * 1024` below title text, and **zero pairs of components or `R_SCHALT`/`text` objects overlap** in FluidSIM coordinates.

---

## Part 7: Post-`308a1e4` MCP `circuit_apply_patch` Regression & Visual Polish (CRITICAL)

Testing commit `308a1e4` end-to-end via MCP stdio and capturing a live FluidSIM 4.5 (`fl_sim_p.exe`) screenshot shows a **major improvement** (valves, throttles, filter, check valve, pressure switch, and cylinder barrel now render ISO 1219 symbols via `BEGINSYM`!), **but uncovered 1 critical MCP authoring regression and 6 visual/codec defects** compared against the real `distributing station.ct`:

### 7.1 CRITICAL REGRESSION: `circuit_apply_patch` Fails on Newly Created `.ct` Files (`ROUNDTRIP_RAW_AST_LOST`)
- **Repro:** `circuit_create` (`template: 'blank'`, `path: 'distribution_station_recreated.ct'`) followed by `circuit_apply_patch` adding components fails with:
  `PostconditionFailed / ROUNDTRIP_RAW_AST_LOST: Lossless rawAst preservation failed during roundtrip`
  and rolls back the entire write!
- **Root Cause (`src/codec/ctRoundtripGuard.ts:26`):**
  `checkRawAstPreserved` unconditionally checks `if (repSec.trailerText !== expSec.trailerText) return false;`. When patching a blank `.ct` (whose initial `trailerText` has `0` `SYM` blocks), `ctTextCodec` generates new `SYM 0..N` blocks in `trailerText`. Because `trailerText` grew, line 26 rejects every semantic patch to `.ct`!
- **Fix:** Move `if (repSec.trailerText !== expSec.trailerText) return false;` **inside** the unchanged-document branch (`if (expSec.originalSemanticFingerprint && computeSemanticFingerprint(expected) === expSec.originalSemanticFingerprint)`). When the document WAS semantically modified, only verify that `repSec.trailerText` contains `ENDCT` + `BEGINSYM` + `ENDSYM`. Add an explicit MCP end-to-end test: `circuit_create(blank, 'fresh.ct')` -> `circuit_apply_patch(add cylinder + 5/2 valve + throttles)` -> assert succeeds!

### 7.2 Fix DIN A3 Landscape Sheet Margin Header (`src/codec/ctBinaryCodec.ts:63-72`)
- **Root Cause:** In `DEFAULT_CT_A3_HEADER_LINES_HEX`, line index 4 is still `'1c201c2057821c205749a72082'` (`"0 0 210 297 1"` = **DIN A4 Portrait**!). In FluidSIM 4.5, the red page border cuts straight down between Branch 2 and Branch 3, leaving Branch 3 (`-3A1`, `-3V2`, `-3V3`, `-3M1`, `-3M2`) completely outside the printable sheet! Meanwhile `PPE1` + `Wartungseinheit2` sit at `y = 752640..820224`, overflowing the bottom of the sheet.
- **Fix:**
  1. Set `DEFAULT_CT_A3_HEADER_LINES_HEX[4]` to DIN A3 Landscape (`"0 0 420 297 1"` -> `'1c201c20a8571c205749a72082'`, or use the exact verified A3 sheet header lines from `distributing station.ct`).
  2. Tighten vertical band heights in `layoutRouter.ts` so the entire circuit (`R_SCHALT` top through `Wartungseinheit2` bottom) stays inside `y = 90k..580k` (matching real `distributing station.ct`'s `y = 130k..580k`), fitting comfortably inside the red A3 border with zero bottom overflow.

### 7.3 Fix `PAV1` (`-2V1`), `PAV1S` (`-2A1`), `PAR1b` (`-3A1`), and `CylDGPPAB` Piston Rod (`src/codec/ctTextCodec.ts`)
Verified directly against `distributing station.ct`:
- **`PAV1` (`vacuum_suction_nozzle` `-2V1`) & `PAV1S` (`vacuum_sucker` `-2A1`) currently render INVISIBLE** because they were given `dxf_prim_list` + flags `3527683` (`...3`). In FluidSIM 4.5, BOTH use built-in native GDI rendering:
  - `PAV1`: flags **`4495368`** (ends in `8`), size **`61440 × 30720`**, `rot = 180`, `S FLIPPED I 1`, **NO `dxf_prim_list`**, 2 `PConnection` gates (integrated exhaust arrow!).
  - `PAV1S`: flags **`4894728`** (ends in `8`), size **`24575 × 21504`**, **NO `dxf_prim_list`**, 1 `PConnection` gate.
- **`PAR1b` (`swivel_drive` `-3A1`) currently renders tilted with an empty `R_SCHALT` comb (`||||||`) + floating `>` arrow:**
  - Emit `PAR1b` with `rot = 90`, size `30720 × 39935`, flags `4628483`, **NO `dxf_prim_list`**, **NO separate `R_SCHALT` object**, and emit its distance-rule sensor tags as **STRING** properties `S l1 S -3B1` and `S l2 S -3B2` (NOT `S l1 F 0` / `S l2 F 0`!).
- **`CylDGPPAB` (`-1A1`) is missing its piston rod extending right:**
  - Emit FluidSIM's native piston properties (`S piston_FEST B T`, `S piston S CP_CA`, `F piston x_pos I 0`, `F piston y_pos I -8`, `F piston stroke I 38`, `F piston length I 74`, `S DAMPING_ADJ_R B T`, `S DAMPING_ADJ_L B T`, `S SENSING B T`) so FluidSIM draws the full piston rod and cushioning arrows.

### 7.4 Fix Looped `DRSV2_pneu` (`180°`) Wiring, Valve Label Collisions & Branch 2 Horizontal Spaghetti (`src/authoring/layoutRouter.ts`, `src/codec/ctTextCodec.ts`)
- **Looped flow-control wires (`-1V2`, `-1V3`, `-3V2`, `-3V3`):** When `DRSV2_pneu` is rotated `180°`, Port `1` sits on top and Port `2` sits on bottom, causing wires from the valve below to loop up over the top of the throttle and wires to the cylinder to loop down around the outside. Swap/align rotated port placement (or route bottom-to-top cleanly) so valve lines enter the bottom port and cylinder lines exit the top port straight up.
- **Overlapping text labels:**
  - Valve component labels (`-1V1`, `-2M1`, `-2M2`, `-3M1`, `-3M2`) currently sit directly **on top of the right pneumatic spring (`-|<`)**. Offset valve `text` labels cleanly **above** the valve body (`y1 - 24576`), and give left solenoid labels (`-1M1`..`-3M2`) extra left padding (`-12mm`) so they don't touch the solenoid rectangle.
  - Offset `-2B1` label cleanly below/right of `PSW1` instead of on top of its box.
- **Branch 2 (Vacuum) horizontal wire crossing:** Lay out Branch 2 vertically in two clean sub-columns matching ISO 1219 flow (Sub-col A: `-2M1` -> `-2V1` -> `-2V2`; Sub-col B: `-2M2` -> `-2V3`; Sub-col C: `-2A1` <- `-2Z1` -> `-2B1`) instead of packing all 5 components onto one horizontal row `y=245760`.

---

## Verification Checklist
After making all changes, run and verify all pass with exit code 0:
1. `npm install` (must succeed cleanly without `--legacy-peer-deps`)
2. `npm run typecheck`
3. `npm test` (all tests pass on Windows & Linux, including `circuit_create(blank, '.ct') -> circuit_apply_patch` roundtrip test, `BEGINSYM` symbol checks, decoded `.ct` zero-overlap/positive-Y geometry checks, A3 landscape header check, Gemini schema checks, and `Distribution station pneumatic` visual layout assertions)
4. `npm run build` (compiles MCP server to `dist/`)
5. `npm run mcp -- doctor --json`
6. `npm run inspect-ct -- --check-golden`
7. End-to-end test: start server against a **nonexistent** `--workspace ./fresh-project`, call `project_create`, `circuit_create` (`blank` `.ct`) + `circuit_apply_patch` (full Distributing Station), `circuit_generate_from_spec` (including single-acting + `WAIT:500ms`), `circuit_validate`, and `circuit_verify_sequence`, confirm 0 errors, and open the generated `.ct` in FluidSIM 4.5 (`fl_sim_p.exe`) to visually confirm ALL symbols (`-1A1` piston rod, `-2V1`, `-2A1`, `-3A1` with `-3B1/-3B2`), clean labels, zero loops/crossings, and all 3 branches inside the red A3 landscape border.
