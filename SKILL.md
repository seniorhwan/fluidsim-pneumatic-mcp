# SKILL.md — Autonomous Agent Playbook for `fluidsim-pneumatics-mcp`

Use this server to design, inspect, validate, simulate, and iteratively self-heal Festo FluidSIM Pneumatics 4.5 (`.ct` and `.fsim.json`) circuits completely headlessly.

## Golden Workflow (Minimal Round-Trips)

1. **Discover exact schemas first (never guess component types or port numbers):**
   - Call `catalog_search` with a keyword (e.g. `"5/2"`, `"cylinder"`, `"relay"`, `"throttle"`).
   - Read exact `componentType`, ISO 1219 port names (`1`, `2`, `3`, `4`, `5`, `12`, `14`, `A`, `B`, `A1`, `A2`, `13`, `14`, `11`, `12`), and valid parameter ranges.

2. **Prefer declarative one-shot generation for standard actuator sequences:**
   - Call `circuit_generate_from_spec` targeting either `.ct` (native FluidSIM 4.5) or `.fsim.json` with:
     - `actuators` (supports `type: "double-acting" | "single-acting"`, `strokeMm`, `throttles`, `throttleOpeningPct`),
     - `sequence` (supports single motions `"A+"`, simultaneous motions `"A+B+"`, and dwell timers `"WAIT:500ms"`),
     - `controlMethod` (`"direct"`, `"pneumatic-cascade"`, `"electro-pneumatic-step-chain"`, or `"electro-pneumatic-latch"`),
     - `startMode` (`"single-cycle"` or `"continuous"` — continuous mode automatically verifies 2+ repeating cycles),
     - `includeEStop` (automatically verifies mid-cycle E-stop halt).
   - It builds the pneumatic & 24V/0V ladder topology, runs zero-overlap ISO 1219 auto-layout, writes atomically with postcondition verification, and returns static validation + sequence verification in one call.

3. **For custom edits or manual builds, use transactional batch patches:**
   - Start with `circuit_create` (`template: "pneumatic_basic"` or `"electro_pneumatic_24v"`).
   - Batch multiple `add_component`, `connect`, `set_distance_rule`, and `set_label` operations into a single `circuit_apply_patch` call.
   - Pass `dryRun: true` when you want to preview preflight + static validation without modifying disk.
   - Never compute 2D coordinates — `layoutRouter` places and routes automatically with guaranteed zero overlap.

4. **Close the verification loop (`inspect -> validate -> simulate -> patch`):**
   - Call `circuit_inspect` on existing `.ct` files to read actuators, valves, `detectedInputs` (button/detent labels like `START`, `STOP`, `S1`, `ESTOP`), and validation summary in one shot.
   - Call `circuit_validate` to catch open ports, missing exhaust silencers, unactuated valves, cylinder chamber shorts, cross-domain wiring, orphaned solenoids/sensors, or electrical shorts.
   - Call `circuit_verify_sequence` (with `allowRepeatCycles: true` for continuous circuits) or `circuit_simulate` with scripted triggers (`[{ label: "S1", action: "press", atMs: 100, durationMs: 200 }]`).
   - On any failure (`OPPOSING_PILOT_SIGNAL`, `EXHAUST_BLOCKED`, `ACTUATOR_STALLED_OVERLOAD`, `RELAY_OSCILLATION_CHATTER`, `LIVE_SHORT_CIRCUIT`), inspect `offendingIds`, `code`, and `suggestedFix`, apply a corrective `circuit_apply_patch`, and re-run until `valid: true` and `passed: true`.

5. **Keep context compact:**
   - Use `circuit_inspect` for quick overviews and `circuit_export_netlist` with `format: "compact-text"` instead of raw file dumps.
   - Use `circuit_get_label_map` to audit sensor, relay, and solenoid cross-references.
   - Keep `includeSamples: false` on `circuit_simulate` unless needed (or pass `sampleLimit` + `cursor`/`limit`).
