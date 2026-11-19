# AGENTS.md — Operating & Contributing Guide for `fluidsim-pneumatics-mcp`

## Core Architecture Rules
1. **100% Headless & Cross-Platform:** Never add GUI launchers, Windows COM/DDE/OPC bridges, SVG renderers, or OS-specific native binaries. Everything must run in pure Node.js 20+ / TypeScript over `stdio`.
2. **Stdio Protocol Purity:** Never call `console.log` inside MCP server paths. All diagnostics and startup banners MUST write exclusively to `process.stderr`.
3. **Phase 0 Golden Fixture Gate (No Hallucinated `.ct` Syntax):**
   - Native FluidSIM Pneumatics 4.5 `.ct` parsing and serialization are intentionally gated until the 6 real golden `.ct` fixtures exist in `fixtures/golden/` and have been inspected via `npm run inspect-ct`.
   - Use `.fsim.json` semantic IR files for offline authoring, validation, simulation, and MCP protocol verification until Phase 1 unlocks native `.ct`.
4. **Zero Coordinate Burden:** Never require callers/agents to calculate 2D pixel/mm coordinates. All schematic geometry and orthogonal wire routing live in `src/authoring/layoutRouter.ts`.
5. **Transactional Write Safety:** Every mutating tool MUST pass:
   - `enforceToolPolicy` (`authoring` mode required)
   - `WorkspaceGuard` path jail & atomic temp-file rename
   - `runWritePreflight`
   - `verifyWrittenCircuitPostcondition` (re-parse + static validation)

## Verification Commands
```bash
npm run typecheck
npm test
npm run mcp -- doctor --json
npm run inspect-ct -- --check-golden
```
