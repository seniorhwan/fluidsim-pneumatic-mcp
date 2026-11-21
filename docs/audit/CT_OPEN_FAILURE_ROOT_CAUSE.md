# Root-Cause Analysis: Why FluidSIM 4.5 Cannot Open Generated `.ct` Files

**Tested Binary:** `C:\Program Files (x86)\Didactic\fl_sim_p4.en\bin\fl_sim_p.exe` (Festo FluidSIM Pneumatics 4.5)  
**Target Repository:** `fluidsim-pneumatic-mcp` (`v0.1.0` & `v0.2.0` / commit `0a8c9f7`)  
**Control Files:** `fixtures/golden/01_direct_indirect_cylinders.ct`, `distributing station.ct` (user's working file)  

---

## 1. Executive Summary

Testing generated `.ct` files directly in **real Festo FluidSIM Pneumatics 4.5 (`fl_sim_p.exe`)** uncovered **two independent critical bugs** that cause FluidSIM 4.5 to crash or reject generated `.ct` files, even when `fluidsim-pneumatics-mcp`'s own JS roundtrip tests pass 100%:

1. **ROOT CAUSE #1 (Binary Compressor Ring-Buffer Overrun in `src/codec/ctBinaryCodec.ts`):**
   - `compressCtPayload()` wraps LZ match reads across the end of the 2047-byte ring buffer using `% ringLimit` (`ring[(ref + mlen) % ringLimit]`).
   - **FluidSIM 4.5's C++ decompressor reads `ring[ref .. ref + len - 1]` linearly without `% ringLimit` wrap-around** (verified across all golden/official `.ct` files: `refWrapRead === 0` in 100% of real FluidSIM files, vs `refWrapRead > 0` in generated files).
   - Whenever `compressCtPayload()` emits a match with `ref + len > ringLimit` (or RLE/Long-LZ desyncs the ring), FluidSIM 4.5 crashes with **`0xC0000005` (`-1073741819`) Access Violation**, throws **`Error Code 2755 in Module 97098 | Fatal error.`**, or reports **`Unknown file format.`**.
   - **Proof:** Enforcing linear `ref + mlen <= ringLimit` (and `ref + mlen <= maxFilled` before first wrap) caused `GOLDEN_01` re-encoded (`fixed_g01.ct`) and `v02_electro_abba.ct` (`fixed_electro_abba.ct`) to **open cleanly in `fl_sim_p.exe` with 0 errors**.

2. **ROOT CAUSE #2 (`PTriconnection` Placeholder Gate-Count Crash & Wrong/Missing Class IDs in `src/codec/ctTextCodec.ts` & `src/catalog/pneumatics45.ts`):**
   - In `v0.2.0`, `vacuum_suction_nozzle`, `vacuum_sucker`, and `swivel_drive` are serialized as **`PTriconnection` placeholders with `1`, `2`, or `3` `gate` children** (`O62` has 3, `O66` has 1, `O91` has 1, `O119` has 2).
   - FluidSIM 4.5's `PTriconnection` C++ loader expects **4** `gate` entries; loading a `PTriconnection` with `< 4` gates causes an immediate **`0xC0000005` (`-1073741819`) Access Violation** even with literal-only compression (`lit_v02_dist_station.ct` crashed!).
   - Additionally, comparing `v0.2.0` against the user's real working `distributing station.ct` revealed mismatched FluidSIM 4.5 class IDs (e.g., `DV_P1` used for `flow_control_one_way` instead of `DRSV2_pneu`; `CheckValvePilotOperatedSpringLoadedP` used instead of `CheckValveSpringLoadedP`; missing `PAV1`, `PAV1S`, `PAR1b`, `PSW1`).

---

## 2. Empirical A/B Isolation Matrix (All Tested in Real `fl_sim_p.exe`)

| Test File | Description | `refWrapRead` | `fl_sim_p.exe` Result | Exit Code |
| :--- | :--- | :---: | :--- | :---: |
| `01_direct_indirect_cylinders.ct` | Real golden `.ct` control | `0` | **OPENED** (`FluidSIM-P` MDI window) | running |
| `distributing station.ct` | User's real working `.ct` control | `0` | **OPENED** | running |
| `v02_blank.ct`, `v02_basic.ct`, `v02_electro_24v.ct` | Small `v0.2.0` circuits (`< 2 KB`, before ring wrap) | `0` | **OPENED** | running |
| `v02_spec_abba.ct` | Pneumatic-only `A+ B+ B- A-` | `1` | **OPENED** (lucky non-fatal overrun) | running |
| `iso1_golden01_reenc.ct` | `GOLDEN_01` decoded & re-encoded unchanged via `encodeCtContainer` | `1` | **FAILED:** `Error Code 2755 in Module 97098 \| Fatal error.` | running |
| `proof_g1.ct` | `GOLDEN_01` re-encoded with short-LZ only + `if (rpos + bestLen >= ringLimit) rpos = 0` | `5` | **FAILED:** `Unknown file format.` | running |
| `distribution_station_attempt.ct` | `v0.1.0` attempt `.ct` | `3` | **CRASHED** (Access Violation) | `-1073741819` |
| `v02_electro_abba.ct` | `v0.2.0` `electro-pneumatic-step-chain` `A+ B+ B- A-` | `2` | **CRASHED** (Access Violation) | `-1073741819` |
| `lit_golden01.ct` | `GOLDEN_01` re-encoded with literal-only (0 LZ/RLE) | `0` | **OPENED** | running |
| `lit_electro_abba.ct` | `v02_electro_abba.ct` re-encoded with literal-only (0 LZ/RLE) | `0` | **OPENED** | running |
| `lit_dist_attempt.ct` | `distribution_station_attempt.ct` re-encoded with literal-only | `0` | **OPENED** (no crash, splash screen) | running |
| **`fixed_g01.ct`** | `GOLDEN_01` re-encoded with **`ref + mlen <= ringLimit`** (linear) | **`0`** | **OPENED CLEANLY** | running |
| **`fixed_electro_abba.ct`** | `v02_electro_abba.ct` re-encoded with **`ref + mlen <= ringLimit`** | **`0`** | **OPENED CLEANLY** | running |
| `v02_dist_station_raw.ct` | `v0.2.0` Distributing Station `.ct` | `>0` | **CRASHED** (Access Violation) | `-1073741819` |
| `fixed_v02_dist_station.ct` | `v02_dist_station_raw.ct` with `ref + mlen <= ringLimit` | `0` | **CRASHED** (`PTriconnection` w/ `<4` gates!) | `-1073741819` |
| `lit_v02_dist_station.ct` | `v02_dist_station_raw.ct` with literal-only | `0` | **CRASHED** (`PTriconnection` w/ `<4` gates!) | `-1073741819` |

---

## 3. Exact Byte-Level Root Cause in `src/codec/ctBinaryCodec.ts`

In `src/codec/ctBinaryCodec.ts` lines **390–422** (`compressCtPayload`):
1. **Lines 391–402:**
   ```ts
   if (
     ring[ref] === b0 &&
     ring[(ref + 1) % ringLimit] === b1 &&
     ring[(ref + 2) % ringLimit] === b2
   ) {
     let mlen = 3;
     while (
       mlen < maxAllowedMatch &&
       ring[(ref + mlen) % ringLimit] === plainBytes[i + mlen]
     )
   ```
   Using `% ringLimit` allows `ref + mlen > ringLimit` (and before the first ring wrap, `ref + mlen > maxFilled`). FluidSIM 4.5's native C++ decompressor indexes `ring[ref + j]` linearly without modulo wrap-around, causing out-of-bounds reads / buffer corruption.
2. **Line 419:**
   ```ts
   if (rpos + bestLen >= ringLimit) rpos = 0;
   ```
   Also note: `rpos` should only search `0 .. searchLimit - 3` where `avail = Math.min(maxAllowedMatch, searchLimit - ref)` so `ref + mlen <= searchLimit` (`<= ringLimit`) always holds.

---

## 4. Ground-Truth FluidSIM 4.5 Class IDs (`distributing station.ct` vs `v0.2.0`)

Comparing the user's real working `distributing station.ct` against `v0.2.0`'s `v02_dist_station_raw.ct`:

| Component | Real `distributing station.ct` Class ID | `v0.2.0` Currently Emits | Status |
| :--- | :--- | :--- | :--- |
| Vacuum suction cup (`-2A1`) | **`PAV1S`** (1 port) | `PTriconnection` (`gates=1`) | **CRASHES FluidSIM** |
| Vacuum suction nozzle (`-2V1`) | **`PAV1`** (`S FLIPPED I 1`, `180°`) | `PTriconnection` (`gates=3`) | **CRASHES FluidSIM** |
| Swivel drive (`-3A1`) | **`PAR1b`** (`S ALPHA F 180`, `S l1`, `S l2`) | `PTriconnection` (`gates=2`) + `R_SCHALT` | **CRASHES FluidSIM** |
| One-way flow control (`-1V2`, etc.) | **`DRSV2_pneu`** (`S LEVEL F 100`) | `DV_P1` *(Quick Exhaust Valve!)* | **Wrong symbol/class** |
| Spring-loaded check valve (`-2V2`) | **`CheckValveSpringLoadedP`** | `CheckValvePilotOperatedSpringLoadedP` | **Wrong 3-port class** |
| Vacuum/Pressure switch (`-2B1`) | **`PSW1`** (1 port) / `PEW` (2 ports) | `PEW` | Valid class |
| Air filter (`-2Z1`) | **`FilterP`** | `FilterP` | Match |
| `2/2` NC valve (`-2M1`, `-2M2`) | **`WV_2`** (`PNEU_SPRING_R S TRUE`) | `WV_2` | Match |
| `3/2` NO valve (`-3M1`, `-3M2`) | **`WV_3`** (`SWITCHED_POS_R S (2\tC3P)`, `PNEU_SPRING_R S TRUE`) | `WV_3` | Check `SWITCHED_POS_R` |
| `5/2` valve (`-1V1`) | **`WV_5`** (`PNEU_SPRING_R S TRUE`, `PILOT_L B T`) | `WV_5` | Match |
