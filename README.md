# `fluidsim-pneumatics-mcp`

100% headless, cross-platform, agent-native **Model Context Protocol (MCP)** server over `stdio` for **Festo FluidSIM Pneumatics 4.5** circuits.

## Key Capabilities
- **Zero GUI / Zero OS Dependencies:** Pure Node.js 20+ / TypeScript. Runs identically on Linux, WSL, macOS, and Windows.
- **Semantic Topology Authoring:** Agents specify ISO 1219 components, ports, labels (`Y1`, `K1`, `a0`, `a1`), and logical connections — `layoutRouter` computes clean non-overlapping FluidSIM layouts and orthogonal wires automatically.
- **Closed-Loop Verification:** Built-in static pneumatic/electrical linter (`validator.ts`) and deterministic coupled discrete-time simulator (`electricalSolver.ts` + `pneumaticSolver.ts` + `sequenceVerifier.ts`) returning structured `offendingIds` and `suggestedFix` diagnostics.
- **Hardened Boundaries:** `read-only` vs `authoring` access modes, strict workspace path jail, atomic writes with optional `.bak` backups, preflight/postcondition checks, cursor pagination, and payload byte budgets.
- **Phase 0 Golden Fixture Gate:** Native FluidSIM 4.5 `.ct` parsing/serialization is strictly gated until the 6 real `.ct` fixtures are placed in `fixtures/golden/` (see `fixtures/golden/README.md`). Semantic `.fsim.json` IR works end-to-end immediately.

## CLI Usage

```bash
# Run headless diagnostics
npm run mcp -- doctor --json

# Check Phase 0 golden .ct fixtures
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
