# SKILL.md — Autonomous Agent Playbook for `fluidsim-pneumatics-mcp`

Use this server to design, validate, simulate, and iteratively self-heal pneumatic and electro-pneumatic circuits without opening Festo FluidSIM.

## Golden Workflow (Minimal Round-Trips)

1. **Discover exact schemas first (never guess component types or port numbers):**
   - Call `catalog_search` with a keyword (e.g. `"5/2"`, `"cylinder"`, `"relay"`, `"throttle"`).
   - Read exact `componentType`, ISO 1219 port names (`1`, `2`, `3`, `4`, `5`, `12`, `14`, `A`, `B`, `A1`, `A2`, `13`, `14`, `11`, `12`), and valid parameter keys.

2. **Prefer declarative one-shot generation for standard actuator sequences:**
   - Call `circuit_generate_from_spec` with `actuators`, `sequence` (e.g. `["A+", "B+", "B-", "A-"]`), `controlMethod` (`"pneumatic-cascade"` or `"electro-pneumatic-step-chain"` for reversing sequences), `startMode`, and `includeEStop`.
   - It automatically builds pneumatic & 24V/0V ladder logic, runs ISO 1219 auto-layout, writes atomically, and returns both static validation and sequence verification in one call.

3. **For custom edits or manual builds, use transactional batch patches:**
   - Start with `circuit_create` (`template: "pneumatic_basic"` or `"electro_pneumatic_24v"`).
   - Batch multiple `add_component`, `connect`, `set_distance_rule`, and `set_label` operations into a single `circuit_apply_patch` call.
   - Never compute coordinates — `layoutRouter` places and routes automatically.

4. **Close the verification loop (`validate -> simulate -> patch`):**
   - Call `circuit_validate` to catch open ports, missing exhaust silencers, cross-domain wiring, orphaned solenoids/sensors, or electrical shorts.
   - Call `circuit_verify_sequence` (or `circuit_simulate`) with scripted button triggers (e.g. `[{ label: "S1", action: "press", atMs: 100, durationMs: 200 }]`).
   - On any failure, inspect `offendingIds`, `code`, and `suggestedFix`, apply a corrective `circuit_apply_patch`, and re-run until `valid: true` and `passed: true`.

5. **Keep context compact:**
   - Use `circuit_inspect` for quick overviews and `circuit_export_netlist` with `format: "compact-text"` instead of raw file dumps.
   - Use `circuit_get_label_map` to audit sensor, relay, and solenoid cross-references.
   - Paginate large component or simulation event lists with `cursor` and `limit`.
