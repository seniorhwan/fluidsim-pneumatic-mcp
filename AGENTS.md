# AGENTS.md — Operating & Contributing Guide for `fluidsim-pneumatics-mcp`

## Core Architecture Rules
1. **100% Headless & Cross-Platform:** Never add GUI launchers, Windows COM/DDE/OPC bridges, SVG renderers, or OS-specific native binaries. Everything must run in pure Node.js 20+ / TypeScript over `stdio`.
2. **Stdio Protocol Purity:** Never call `console.log` inside MCP server paths. All diagnostics and startup banners MUST write exclusively to `process.stderr`.
3. **Empirical `.ct` Fidelity (No Hallucinated Syntax):**
   - Native FluidSIM Pneumatics 4.5 `.ct` binary decompression/compression and plain-text AST parsing/serialization (`src/codec/ctBinaryCodec.ts`, `src/codec/ctTextCodec.ts`) are empirically verified against the 6 real golden `.ct` fixtures in `fixtures/golden/` (see `docs/CT_FORMAT_4_5.md`).
   - Only mark catalog entries `fluidsim45IdVerified: true` after observing them in real FluidSIM `.ct` files (23/34 verified; remaining 11 stay `fluidsim45IdVerified: false` and roundtrip losslessly via `_MCP_TYPE`/`_MCP_PARAMS`).
   - All untouched `.ct` container sections (headers, WMF preview, `BEGIN_FSPREVIEW`, `BEGINDSD`, `BEGINSYM`, decorative objects) MUST survive parse -> serialize -> re-parse untouched.
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
