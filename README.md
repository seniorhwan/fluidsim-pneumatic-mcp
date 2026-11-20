# `fluidsim-pneumatics-mcp`

100% headless, cross-platform, agent-native **Model Context Protocol (MCP)** server over `stdio` for **Festo FluidSIM Pneumatics 4.5** (`.ct` and `.fsim.json` circuits).

## Key Capabilities
- **Zero GUI / Zero OS Dependencies:** Pure Node.js 20+ / TypeScript over `stdio`. Runs identically on Linux, WSL, macOS, and Windows.
- **Native FluidSIM 4.5 `.ct` Codec (Empirically Verified):** Full binary container codec (`XOR 0x9A` + LZ/RLE profiles `W=2048` & `W=512`), 0-based gate/connection AST parser, lossless roundtrip preservation, catalog-accurate port coordinates, orthogonal `L` polyline wire geometry, and 23/34 empirically verified FluidSIM 4.5 class IDs validated against 6 real golden `.ct` fixtures (`docs/CT_FORMAT_4_5.md`).
- **Semantic Topology Authoring & Declarative Spec Generator:** Agents specify ISO 1219 components, ports, labels (`Y1`, `K1`, `a0`, `a1`), and logical connections — `layoutRouter` enforces topology-aware column alignment, guaranteed zero-overlap fixed-point placement, and corridor-aware orthogonal routing. `circuit_generate_from_spec` supports single-acting & double-acting actuators, simultaneous motions (`"A+B+"`), dwell timers (`"WAIT:500ms"`), 2–4+ group cascades, electro-pneumatic step-chains, continuous auto-repeat verification, and E-stop checks.
- **Closed-Loop Verification & Coupled Simulator:** Static pneumatic/electrical linter (`validator.ts`) and deterministic coupled discrete-time simulator (`electricalSolver.ts` + `pneumaticSolver.ts` + `sequenceVerifier.ts`) detecting opposing pilots, exhaust blockage, actuator overload stall, live shorts, and relay chatter with machine-readable `offendingIds` and `suggestedFix`.
- **Hardened Boundaries:** `read-only` vs `authoring` access modes, strict workspace path & symlink jail, atomic temp-file writes with transactional rollback on postcondition failure, `dryRun` patch previews, cursor pagination, and operator-capped payload byte budgets.

## CLI Usage

```bash
# Run headless diagnostics (checks golden fixtures, codec status, catalog counts)
npm run mcp -- doctor --json

# Inspect and verify all 6 golden FluidSIM 4.5 .ct fixtures
npm run inspect-ct -- --check-golden

# Start stdio MCP server in authoring mode
npm run mcp -- serve --workspace ./workspace --mode authoring

# Generate ready-to-paste MCP client configuration
npm run mcp -- print-config --client vscode --workspace ./workspace
npm run mcp -- print-config --client antigravity --workspace ./workspace
npm run mcp -- print-config --client gemini-cli --workspace ./workspace
npm run mcp -- print-config --client claude --workspace ./workspace
npm run mcp -- print-config --client codex --workspace ./workspace
```

## Development & Tests

```bash
npm run typecheck
npm test
```
