# Golden Fixtures for Festo FluidSIM Pneumatics 4.5 (`.ct`)

This directory enforces the **Phase 0 Golden Fixture Gate**.

FluidSIM Pneumatics 4.5's `.ct` format is proprietary. To guarantee 100% lossless roundtrip compatibility and zero hallucinated syntax, the native `.ct` parser (`src/codec/ctParser.ts`) and serializer (`src/codec/ctSerializer.ts`) remain gated until the following **6 minimal `.ct` fixtures** exported directly from Festo FluidSIM Pneumatics 4.5 are placed here:

| # | Filename | Required Circuit Contents |
|---|----------|---------------------------|
| 1 | `01_empty.ct` | Blank FluidSIM 4.5 pneumatic sheet (default page size, zero components). |
| 2 | `02_air_source.ct` | Single compressed air supply source placed on the sheet. |
| 3 | `03_direct_3_2_sac.ct` | Compressed air source + air service unit (FRL) + 3/2-way pushbutton valve (NC, spring return) + single-acting cylinder. |
| 4 | `04_indirect_5_2_dac.ct` | Double-acting cylinder with distance rule (`a0` at 0 mm, `a1` at 100 mm) + two one-way flow control valves + 5/2-way double-pilot valve (`14`/`12`) + two 3/2-way valves. |
| 5 | `05_electro_latch.ct` | `+24V` / `0V` rails + NO start pushbutton `S1` + NC stop pushbutton `S2` + relay `K1` self-latching contact + valve solenoid `Y1` + 5/2-way solenoid/spring valve + double-acting cylinder. |
| 6 | `06_logic_timer.ct` | Shuttle valve (OR) + dual-pressure valve (AND) + pneumatic time-delay valve (NC). |

## Verification Workflow After Dropping Fixtures

1. Confirm all 6 files are detected:
   ```bash
   npm run inspect-ct -- --check-golden
   ```
2. Inspect structure, encoding, and headers:
   ```bash
   npm run inspect-ct -- fixtures/golden/01_empty.ct
   npm run inspect-ct -- --diff fixtures/golden/01_empty.ct fixtures/golden/02_air_source.ct
   npm run inspect-ct -- --diff fixtures/golden/02_air_source.ct fixtures/golden/03_direct_3_2_sac.ct
   ```
3. Document verified grammar in `docs/CT_FORMAT_4_5.md`, update `fluidsim45Id` + `fluidsim45IdVerified: true` in `src/catalog/pneumatics45.ts`, and unlock native `.ct` parsing/serialization in `src/codec/ctParser.ts` and `src/codec/ctSerializer.ts`.
