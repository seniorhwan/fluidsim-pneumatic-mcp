# Audit Report: `fluidsim-pneumatic-mcp`

**Target Repository:** `https://github.com/seniorhwan/fluidsim-pneumatic-mcp`  
**Audit Date:** 2026-11-21  
**Environment:** Windows 11 (`win32`), Node.js `v24.13.0`, Festo FluidSIM Pneumatics 4.5 installed at `C:\Program Files (x86)\Didactic\fl_sim_p4.en\`  

---

## 1. Executive Summary: Why Google AI Studio Can't Use It

Empirical testing of the live MCP server, its JSON Schemas, its CLI/packaging, and 263 official Festo FluidSIM 4.5 `.ct` files identified **three primary blockers** preventing Google AI Studio / Gemini from using this MCP server, plus **six major functional & format defects**:

1. **CRITICAL — Gemini Function Calling Schema Rejection (`src/mcp/toolSchemas.ts`):**
   - `circuit_apply_patch` uses `z.discriminatedUnion('op', ...)` and `z.record(z.string(), z.union([z.number(), z.string(), z.boolean()]))`.
   - With Zod v4 (`^4.6.7`), `@modelcontextprotocol/sdk` serializes this into **15 Gemini-incompatible JSON Schema constructs**: `oneOf`, `const`, `propertyNames`, `additionalProperties` as a schema object, and union type arrays `type: ["number", "string", "boolean"]`.
   - Additionally, all 14 tools emit `"$schema": "http://json-schema.org/draft-07/schema#"`.
   - Gemini / Google AI Studio's OpenAPI 3.0 function declaration parser rejects `oneOf`, `const`, `propertyNames`, and type arrays with schema validation errors when registering the MCP toolset.
2. **CRITICAL — `stdio`-Only Transport (`bin/fluidsim-mcp.ts`, `src/mcp/server.ts`):**
   - Google AI Studio (web / hosted Gemini) cannot spawn local `stdio` processes directly; it requires either a **Streamable HTTP / SSE** MCP endpoint (or a local `@google/genai` bridge). Even though `express` (`^4.21.2`) and `@google/genai` (`^2.4.0`) are listed in `package.json`, no HTTP/SSE MCP transport or AI Studio bridge exists.
3. **CRITICAL — Broken `npm install` (`ERESOLVE`) & Uncompiled `.ts` Binary (`package.json`, `bin/fluidsim-mcp.ts`):**
   - `npm install` fails with `ERESOLVE` (`vite@8.3.8` requires `peerOptional esbuild@"^0.27.0 || ^0.28.0"` while `package.json` pins `esbuild: "^0.25.0"`).
   - `package.json` `"bin": { "fluidsim-mcp": "./bin/fluidsim-mcp.ts" }` points to raw TypeScript, `"build"` builds a dead Vite/React template app (`src/App.tsx`) instead of the MCP server, and `print-config` emits `npx tsx ...` which fails when `tsx` is not globally installed or `npx` prompts interactively.

---

## 2. Empirical Test Results Summary

| Test Suite / Check | Result | Details |
| :--- | :--- | :--- |
| `npm install` | **FAIL** | `ERESOLVE` peer conflict (`vite@8.3.8` vs `esbuild@0.25.12`); requires `--legacy-peer-deps`. |
| `npm run typecheck` (`tsc --noEmit`) | **PASS** | Exit code 0. |
| `npm test` (`tsx --test src/tests/*.test.ts`) | **38/39 PASS, 1 FAIL** | `src/tests/mcpProtocol.test.ts:214` fails on Windows: `spawnSync ...\tsx.cmd EINVAL` (Node `>=20.12` CVE-2024-27980). |
| `npm run mcp -- doctor --json` | **PASS** | Reports 34 catalog components (23 verified), 6/6 golden fixtures present. |
| `npm run inspect-ct -- --check-golden` | **PASS** | 6/6 golden fixtures present (`readyForPhase1: true`). |
| `npm run build` | **PASS (Wrong Target)** | Runs `vite build` on dead `src/App.tsx` React template into `dist/`, does not compile MCP server. |
| Nonexistent `--workspace` startup | **CRASH** | Server exits with `Fatal: Workspace directory "..." does not exist.` (`MCP error -32000: Connection closed`). |
| Gemini JSON Schema audit (14 tools) | **14/14 have `$schema`, 1 has 15 blockers** | `circuit_apply_patch` emits `oneOf`, `const`, `propertyNames`, `type: ["number","string","boolean"]`. |
| `circuit_create` (`pneumatic_basic`, `electro_pneumatic_24v`) | **FAIL validation** | Both non-blank templates produce `valid: false` (1 error `OPEN_PNEUMATIC_PORT`, 1 warning `DANGLING_JUNCTION` on `MANIFOLD_1.2`). |
| `circuit_generate_from_spec` matrix (7 valid specs) | **6/7 PASS, 1 FAIL** | `single-acting` + `WAIT:500ms` + `electro-pneumatic-step-chain` fails sequence verification (`expected "B+", observed "A-"`). |
| Official FluidSIM 4.5 `.ct` corpus (`263` files) | **32/263 (12.2%) parse** | **231/263 (87.8%) fail** with `UNRECOGNIZED_CIRCUIT_FORMAT`. Of the 32 parsed, **17/32 (53.1%) fail static validation** with 126 `OPEN_PNEUMATIC_PORT` errors. |

---

## 3. Detailed Weakness & Bug Catalog

### Critical Issues

#### C1. Gemini / AI Studio Incompatible JSON Schemas (`src/mcp/toolSchemas.ts`)
- **Location:** `src/mcp/toolSchemas.ts` lines 32, 38–82 (`componentNodeSchema`, `patchOpSchema`).
- **Root Cause:**
  1. `patchOpSchema = z.discriminatedUnion('op', [...])` (line 38) compiles to JSON Schema `items.oneOf` with `op: { type: "string", const: "..." }`.
  2. `params: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()]))` (lines 32, 48) compiles to `propertyNames` + `additionalProperties: { type: ["number", "string", "boolean"] }`.
  3. Zod v4 + `@modelcontextprotocol/sdk` emits `"$schema": "http://json-schema.org/draft-07/schema#"` on every tool's `inputSchema`.
- **Impact:** Google AI Studio / Gemini Function Calling rejects the schema at tool registration time.
- **Fix:** Replace `z.discriminatedUnion` with a single flat `z.object({ op: z.enum([...]), ... })` where operation-specific fields are optional, replace `z.record(..., z.union(...))` with `z.string().describe('JSON-encoded key/value object')` or an array of `{ key: z.string(), valueString?: z.string(), valueNumber?: number, valueBoolean?: boolean }`, and strip `$schema` / `propertyNames` / `additionalProperties: { ... }` from emitted tool schemas if needed.

#### C2. No Streamable HTTP / SSE Transport for Remote / Web Clients (`bin/fluidsim-mcp.ts`, `src/mcp/server.ts`)
- **Location:** `bin/fluidsim-mcp.ts` lines 104–123; `src/mcp/server.ts` lines 166–177.
- **Root Cause:** Only `StdioServerTransport` is wired up. There is no `--transport http` / Streamable HTTP (`StreamableHTTPServerTransport` from `@modelcontextprotocol/sdk/server/streamableHttp.js`) or SSE endpoint, despite `express` being installed in `package.json`.
- **Impact:** Web-based AI Studio or remote MCP clients cannot connect over HTTP/HTTPS.

#### C3. 87.8% (231/263) of Real FluidSIM 4.5 `.ct` Files Fail Format Detection (`src/codec/ctBinaryCodec.ts`, `src/codec/ctDetector.ts`)
- **Location:** `src/codec/ctBinaryCodec.ts` lines 8–11, 75–78 (`FLUIDSIM_CT_MAGIC_PREFIX`, `isFluidSimCtBuffer`).
- **Empirical Evidence:** Scanning all 263 official `.ct` files in `C:\Program Files (x86)\Didactic\fl_sim_p4.en\ct\` revealed **three** valid FluidSIM 4.x/4.5 container magic headers, all sharing the exact same `50c2e8b3557fcece` marker line (`FLUIDSIM_CT_MARKER_LINE`):
  - `3e6c75423f56daaf205628b0c36c08bb` — 32 files (12.2%) — **currently accepted**
  - `6e33c0a621ce30e820ce6fa953336de9` — 186 files (70.7%) — **currently rejected** (`demo_01.ct`..`demo_07.ct`, `TP101_12.ct`, etc.)
  - `7f8943f87a219c112021f2680b898bcf` — 45 files (17.1%) — **currently rejected** (`TP201_01.ct`, etc.)
- **Impact:** Agents cannot inspect, validate, or patch nearly 9 out of 10 real FluidSIM `.ct` files.

#### C4. `npm install` Fails Out of the Box (`package.json`)
- **Location:** `package.json` lines 20–44.
- **Root Cause:** `vite@^8.3.0` (`vite@8.3.8`) declares `peerOptional esbuild@"^0.27.0 || ^0.28.0"`, conflicting with `devDependencies.esbuild: "^0.25.0"`. Also contains unused web-app template dependencies (`react`, `react-dom`, `lucide-react`, `motion`, `tailwindcss`, `@tailwindcss/vite`, `@vitejs/plugin-react`, `@google/genai`).
- **Impact:** Standard `npm install` aborts with exit code 1 (`ERESOLVE`).

---

### High-Severity Issues

#### H1. Server Crashes on Nonexistent `--workspace` Directory (`src/safety/workspaceGuard.ts`, `bin/fluidsim-mcp.ts`)
- **Location:** `src/safety/workspaceGuard.ts` lines 25–34 (`ensureRootExists`); `src/mcp/server.ts` line 168.
- **Reproduction:** Start server with `--workspace ./new-project-dir`.
- **Actual Result:** Process exits immediately with `Fatal: Workspace directory "..." does not exist.` (`MCP error -32000: Connection closed`).
- **Impact:** Impossible to initialize a brand-new project workspace from scratch without pre-creating the folder externally.

#### H2. `circuit_create` Built-in Templates Produce Invalid Circuits (`src/mcp/tools/authorTools.ts`)
- **Location:** `src/mcp/tools/authorTools.ts` lines 37–83 (`buildTemplateDocument`).
- **Actual Result:** Both `pneumatic_basic` and `electro_pneumatic_24v` add `MANIFOLD_1` (`pneumatic_junction`) with only port `1` connected to `FRL_1.2` and port `2` left open. Calling `circuit_validate` immediately returns `valid: false` (`OPEN_PNEUMATIC_PORT` error + `DANGLING_JUNCTION` warning).
- **Expected Result:** Starter templates should pass `circuit_validate` with `valid: true`, `errorCount: 0` (e.g., either omit the unconnected junction until components are added, or terminate/loop it, or include a minimal valid starter circuit).

#### H3. `circuit_generate_from_spec` Fails on Single-Acting Cylinder + Dwell Timer in `electro-pneumatic-step-chain` (`src/authoring/specGenerator.ts`)
- **Location:** `src/authoring/specGenerator.ts` lines 961–992.
- **Reproduction:** `circuit_generate_from_spec` with `actuators: [{ label: "A", type: "single-acting", throttles: true }, { label: "B", type: "double-acting", throttles: true }]`, `sequence: ["A+", "WAIT:500ms", "B+", "A-B-"]`, `controlMethod: "electro-pneumatic-step-chain"`, `startMode: "continuous"`, `includeEStop: true`.
- **Actual Result:** `sequenceVerification.passed: false` — `Sequence mismatch at step 1: expected "B+", observed "A-".` (`observedSequence: ["A+","A-","A+","A-",...]`).
- **Root Cause:** Single-acting cylinders use a spring-return 3/2 solenoid valve that requires continuous energization across `A+`, `WAIT:500ms`, and `B+`. During the discrete 1-tick step transition (`K1` drops before `K2` picks up, or `K2` -> `K3`), the solenoid briefly de-energizes, causing the 3/2 valve to spring-return and `A` to retract prematurely.

#### H4. Static Validator & Text Codec Produce 126 False `OPEN_PNEUMATIC_PORT` Errors on Official FluidSIM Circuits (`src/codec/ctTextCodec.ts`, `src/simulator/validator.ts`)
- **Empirical Evidence:** Out of the 32 official `.ct` files that did parse, 17 (53.1%) failed `validateCircuitStatic` with:
  - `OPEN_PNEUMATIC_PORT`: 126
  - `MISSING_EXHAUST_TERMINATOR`: 11
  - `UNBOUND_VALVE_SOLENOID`: 8
  - `UNCONNECTED_PILOT_PORT`: 6
  - `MISSING_0V_RAIL`: 2
  - `MISSING_AIR_SOURCE`: 1
  - `UNACTUATED_VALVE`: 1
- **Root Cause:** In real FluidSIM files like `demo_08.ct` and `TP101_06.ct`, `ctTextCodec.ts` fails to reconstruct all `PConnection` wire endpoints (especially rotated components like `PVS4` at `270°`, `PTriconnection` junctions, and multi-segment polylines), leaving valid connected ports marked as unconnected.

#### H5. No Project-From-Scratch or File-Lifecycle Tools (`src/mcp/server.ts`, `src/mcp/tools/authorTools.ts`)
- **Missing Capabilities:** An AI agent starting from an empty workspace has:
  - No `project_create` / `workspace_init` tool (no project manifest `fluidsim-project.json`, no sheet size selection `DIN A4` vs `DIN A3`, no title block metadata, no starter folder scaffolding).
  - No `circuit_delete`, `circuit_clone`, or `circuit_rename` tools for managing multi-circuit projects.

---

### Medium-Severity Issues

#### M1. Windows `npm test` Failure (`src/tests/mcpProtocol.test.ts:214`)
- **Location:** `src/tests/mcpProtocol.test.ts` lines 214–215 (`execFileSync(TSX_BIN, ...)`).
- **Actual Result:** Throws `Error: spawnSync ...\node_modules\.bin\tsx.cmd EINVAL` on Windows Node.js `>=20.12` because `.cmd` batch wrappers cannot be spawned via `execFileSync` without `shell: true` (or invoking `node` on `node_modules/tsx/dist/cli.mjs` directly).

#### M2. Fragile `print-config` & Uncompiled `bin` Entry (`package.json`, `bin/fluidsim-mcp.ts`)
- **Location:** `package.json` line 7 (`"fluidsim-mcp": "./bin/fluidsim-mcp.ts"`); `bin/fluidsim-mcp.ts` lines 23–24.
- **Root Cause:** `buildHostConfigSnippet()` outputs `"command": "npx", "args": ["tsx", ".../bin/fluidsim-mcp.ts", ...]`. If `npx` runs outside the repo or without `tsx` cached, it can prompt or fail; meanwhile `npm run build` builds the unused Vite UI instead of compiling `bin/fluidsim-mcp.ts` + `src/` to `dist/bin/fluidsim-mcp.js`.

#### M3. 11 Unverified Catalog Components (`src/catalog/pneumatics45.ts`)
- 11 of 34 catalog components have `fluidsim45IdVerified: false` and `fluidsim45ClassId: undefined`, causing them to serialize as generic placeholders rather than native FluidSIM 4.5 objects.

---

## 4. Empirical FluidSIM 4.5 Class IDs Extracted from Local `sym/`

By decoding `C:\Program Files (x86)\Didactic\fl_sim_p4.en\sym\` with `ctBinaryCodec`, the following real FluidSIM 4.5 class IDs were observed for the 11 unverified catalog items:

| Catalog `componentType` | Local `sym\` File | Observed FluidSIM 4.5 Class ID |
| :--- | :--- | :--- |
| `valve_4_2` | `pneu\valve\cvalve\cv4.ct` | `WV_4` |
| `valve_5_3` | `pneu\valve\fuvalve\pvalve\pn5.ct` | `WV_5` |
| `quick_exhaust_valve` | `pneu\valve\sfcvalve\sf9.ct` | `DV_P1` |
| `shuttle_valve_or` | `pneu\valve\sfcvalve\sf2.ct` | `PVS3` |
| `dual_pressure_valve_and` | `pneu\valve\sfcvalve\sf4.ct` | `DRSV2_pneu` |
| `pressure_regulator` | `pneu\valve\pcvalve\psf8.ct` | `PressureReducingValve3WaysAdjustableP` |
| `relay_contact_changeover` | `electr\ladder\l6.ct` | `LWechsler` |
| `timer_relay_off_delay` | `electr\ladder\l10.ct` | `LRelaismagnet_abfver` |
| `time_delay_valve` | *(requires decoding `6e33c0a6...` / `7f8943f8...` sym files)* | Pending C3 fix |
| `pressure_sequence_valve` | *(requires decoding `6e33c0a6...` / `7f8943f8...` sym files)* | Pending C3 fix |
| `proximity_switch_magnetic` | *(requires decoding `6e33c0a6...` / `7f8943f8...` sym files)* | Pending C3 fix |

*(Note: Once C3 is fixed to accept all 3 `.ct` magic headers, the remaining 76 `sym/` files in `pneu/` and `electr/` can be decoded immediately to verify the last 3 class IDs as well.)*
