# Golden Festo FluidSIM `.ct` Fixtures

These 6 real Festo FluidSIM Pneumatics `.ct` circuit files were used to empirically reverse-engineer, implement, and regression-test the lossless native `.ct` codec documented in `/docs/CT_FORMAT_4_5.md`.

| Fixture | Compression Profile | Key Verified Coverage |
|---|---|---|
| `01_direct_indirect_cylinders.ct` | Extended (`W=2048`, `maxLen=16`) | `PPE1`, `PPE2`, `CompressorFixedP`, `CylDGPPAB` (both SAC & DAC), `WV_3` manual/pilot, `WV_5` pilot, `PConnection` `EX3` silencers, `CON PLine` |
| `02_speed_control_throttle.ct` | Extended (`W=2048`, `maxLen=16`) | `DV_P1` throttle / flow control, `CheckValveP`, `CylDGPPAB`, `WV_3`, `WV_5`, large multi-circuit sheet (82 KB decompressed) |
| `03_pneumatic_abba_sequence.ct` | Extended (`W=2048`, `maxLen=16`) | Pure pneumatic `A+ B+ B- A-` sequence, `R_SCHALT` distance rules, `UMConnection` roller labels, `WV_3` mechanical roller (`AL_ME2`), `WV_5` double-pilot |
| `04_electro_pneumatic_abba.ct` | Extended (`W=2048`, `maxLen=16`) | Electro-pneumatic `A+ B+ B- A-`, `pol2` (+24V), `pol1` (0V), `E_S011`, `E_S012`, `E_K001`, `E_S001`, `E_S002`, `E_Y001`, `UEConnection` solenoid bindings, `ETriconnection`, `PTriconnection`, `CON ELine` |
| `05_timer_counter_electro.ct` | Extended (`W=2048`, `maxLen=16`) | `E_K008` ON-delay timer relay, `E_P010` preset counter relay, `lampe`, `R_SCHALT`, electro-pneumatic control |
| `06_electrical_latch_legacy.ct` | Compact (`W=512`, `maxLen=64`) | Compact FluidSIM 3.6/4.x compression profile, `BEGIN_FSPREVIEW`..`END_FSPREVIEW`, legacy `line A B` connection syntax, electrical self-holding latch |

Run the roundtrip verification suite at any time:

```bash
npm test
```

Inspect any `.ct` file's header, compression profile, and decompressed circuit text:

```bash
npm run inspect-ct -- fixtures/golden/04_electro_pneumatic_abba.ct
```
