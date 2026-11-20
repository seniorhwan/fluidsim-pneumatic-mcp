# Festo FluidSIM Pneumatics 4.5 (`.ct`) Binary & Text Grammar Specification

> Empirically reverse-engineered and verified against 10 real Festo FluidSIM `.ct` circuit files (including the 6 golden fixtures in `fixtures/golden/`). Zero fields in this specification were guessed.

---

## 1. File Container Layout

A native Festo FluidSIM `.ct` file is a CRLF-delimited (`0x0D 0x0A`) sequence of lines:

1. **Obfuscated Header Lines (`0 .. N-1`):**
   - Line `0` begins with the 20-byte FluidSIM Pneumatics signature:
     ```hex
     3e 6c 75 42 3f 56 da af 20 56 28 b0 c3 6c 08 bb b4 65 42 92
     ```
     followed by version suffix, save date, and save timestamp (byte-substituted; spaces `0x20` and CRLF are preserved).
   - Lines `1 .. N-2` encode sheet geometry (e.g., A4 dimensions), zoom/viewport, grid, layers, and document flags.
   - Line `N-1` (immediately preceding the compressed payload) is always the exact 8-byte boundary marker:
     ```hex
     50 c2 e8 b3 55 7f ce ce
     ```
   - For **100% lossless roundtrip**, all header lines `0 .. N-1` are stored verbatim as raw bytes in `rawAst.preservedSections.ctContainer.headerLinesB64` and re-emitted identically.

2. **Compressed Payload Line (`N`, final segment after marker + `\r\n`):**
   - Every byte in this segment is XOR-masked with `0x9A`:
     ```ts
     decoded[i] = rawPayload[i] ^ 0x9a;
     ```
   - After XOR unmasking, the stream begins with a little-endian `uint16` compression header followed immediately by an LZ + RLE token stream.

---

## 2. Compression Header & Token Stream

Two empirically verified compression header profiles exist across FluidSIM 3.6–4.5 `.ct` files:

### Profile A — Extended 16-Byte Header (FluidSIM 4.2 / 4.5, default for authoring)
Unmasked header bytes (`uint16` little-endian):
```text
Offset  Hex     Value   Meaning
0..1    01 00   1       Format version flag
2..3    00 00   0       Extended header discriminator
4..5    0e 00   14      Initial ring write position (initRpos = 14)
6..7    00 08   2048    Window size W (ringLimit = W - 1 = 2047)
8..9    10 00   16      Short-match / RLE-ring max length (maxLen = 16)
10..11  0b 00   11      Index bit width (shift = 11 - 8 = 3)
12..13  9a 00   154     Stream parameter / XOR key marker (0x9A)
14..15  30 00   48      Stream flags
```
- Before decoding begins, `ring[0..13]` is pre-seeded with `"       PREVIEW"` (`ring[7..13] = "PREVIEW"`), and `rpos = 14`.

### Profile B — Compact 8-Byte Header (FluidSIM 3.6 / Legacy 4.x)
Unmasked header bytes (`uint16` little-endian):
```text
Offset  Hex     Value   Meaning
0..1    01 00   1       Format version flag
2..3    00 02   512     Window size W (ringLimit = W - 1 = 511)
4..5    40 00   64      Max match / RLE-ring length (maxLen = 64)
6..7    0c 00   12      Initial ring write position (initRpos = 12)
```
- `shift = 1` (9-bit ring index), `rpos = 12`, `ring` zero-initialized.

### Token Framing
Let `shift = indexBits - 8`, `mask = (1 << shift) - 1`, `rleMax = 1 << shift`, `longMax = 2 << shift`, `ringLimit = W - 1`.

| Leading Byte `b` | Token Type | Wire Length | Semantics |
|---|---|---|---|
| `b >= 0x80` | **LITERAL** | `1 + (b - 0x80)` | Copy next `n = b - 0x80` bytes verbatim to output and ring (`ring[rpos++] = c; if (rpos >= ringLimit) rpos = 0;`). |
| `0 <= b < rleMax` | **RLE** | `3` bytes `[b0, b1, val]` | Emit `val` repeated `count = ((b0 & mask) << 8) | b1` times. Update ring **only if** `count <= maxLen && rpos + count < ringLimit`. |
| `rleMax <= b < longMax` | **LONG LZ** | `3` bytes `[b0, b1, len]` | Read `len` bytes from `ring[(ref + j) % ringLimit]` into a snapshot buffer (`ref = ((b0 & mask) << 8) | b1`), then if `rpos + len >= ringLimit` reset `rpos = 0`, and write snapshot to output & ring. |
| `longMax <= b < 0x80` | **SHORT LZ** | `2` bytes `[b0, b1]` | Same as LONG LZ with `len = (b0 >> shift) + 1`, `ref = ((b0 & mask) << 8) | b1`. |

> **Critical implementation invariant:** LZ back-references MUST snapshot `ring[(ref + j) % ringLimit]` *before* writing into `ring[rpos++]` because overlapping copies (`ref < rpos`) reference prior ring content rather than self-repeating.

---

## 3. Decompressed Payload Sections

Decompressing the payload yields a Latin-1 / ASCII document composed of 4 sequential sections:

1. **WMF Preview Bitmap (`" 2142\n"` .. `"ENDPREVIEW\n"`):**
   - Begins with ASCII byte-length header (`" 2142\n"`), a 4-byte LE `uint32` length (`2142`), and a 2142-byte Windows Metafile (`WMF`) thumbnail, terminated by `"ENDPREVIEW\n"`.
2. **Optional Vector Preview (`"BEGIN_FSPREVIEW\n"` .. `"END_FSPREVIEW\n"`):**
   - Present in compact/legacy `.ct` files; preserved verbatim on roundtrip.
3. **Circuit Definition Body (`<objects & links>` .. `"ENDCT\n"`):**
   - Plain-text schematic objects, parameters, port bindings, and line connections.
4. **Trailers (`"BEGINDSD\n...ENDDSD\n"` and `"BEGINSYM\n...ENDSYM\n"`):**
   - State diagram definitions (`DSD`) and custom vector symbol primitives (`SYM`). Preserved verbatim on roundtrip.

---

## 4. Circuit Text Grammar (`... ENDCT`)

### 4.1 Object Declarations
```text
<ClassName> O<objId> <x1> <y1> <x2> <y2> <rotDeg> <flipOrOffset> <flags>
```
- Coordinates `<x1> <y1> <x2> <y2>` are in **FluidSIM sub-millimeter units** (`1 mm = 1024` units, e.g., `263168 / 1024 = 257 mm`).
- Indented child lines belong to the immediately preceding object:
  - ` S <key> <typeTag> <value>` — typed scalar property (`B T`/`B F` boolean, `I` integer, `INT` integer, `F` float, `S` string, `V` symbol index)
  - ` F <group> <key> <typeTag> <value>` — grouped visual/label property (e.g., `F con_descr1 x_offset I 0`, `F label_pos x_offset I 0`)
  - `L <dx1> <dy1> <dx2> <dy2>` — port/connection stub geometry

### 4.2 Port Bindings & Connections
- **Component-to-Port Ownership:**
  ```text
  gate<N> # <parentDeclIdx> <portDeclIdx>
  ```
  Binds port object at 0-based declaration index `<portDeclIdx>` (`PConnection`, `EConnection`, `UEConnection`, or `UMConnection`) to parent object at 0-based declaration index `<parentDeclIdx>` as 1-indexed gate `<N>`. Note: indices are **0-based positional indices** in the object declaration list, NOT the persistent `O<id>` handle (which can diverge after objects are deleted/re-inserted in FluidSIM).
- **Pneumatic & Electrical Edges:**
  - FluidSIM 4.2/4.5:
    ```text
    CON PLine <portDeclIdxA> <portDeclIdxB>
    CON ELine <portDeclIdxA> <portDeclIdxB>
    ```
    (optionally followed by indented ` S COLOR I ...` or `L ...` lines).
  - Legacy compact `.ct`:
    ```text
    line <portDeclIdxA> <portDeclIdxB>
    ```

---

## 5. Empirically Verified FluidSIM 4.5 Class IDs & Gate Mappings

| FluidSIM Class | Catalog `type` | Gate-to-Port Mapping & Key Properties |
|---|---|---|
| `PPE1` | `air_source` | `gate1` → `"1"` (`P_LIM` bar, `FLOW` L/min). Also reads `CompressorFixedP`. |
| `PPE2` | `air_service_unit` | `gate1` → `"1"`, `gate2` → `"2"` (`P_SOLL` bar, `NN_FLOW` L/min). |
| `PTriconnection` | `pneumatic_junction` | `gate1..4` → `"1".."4"`. |
| `PConnection` (`ex_type S EX3`) | `exhaust_silencer` | Embedded silencer on unconnected valve exhaust ports (`EX0`=open, `EX3`=silencer, `EX4`=plug). |
| `CylDGPPAB` | `cylinder_single_acting` / `cylinder_double_acting` | `SPRING_R B T` (or 1 `PConnection`) = SAC (`gate1` → `"A"`); 2 `PConnection` = DAC (`gate1` → `"A"`, `gate2` → `"B"`). `HUB` = stroke mm, `A_K` = bore area cm², `A_R` = ring area cm². |
| `R_SCHALT` | `distanceRule` on nearest cylinder | `label0/pos0`, `label1/pos1`, ... (`mm`). |
| `WV_3` | `valve_3_2` | `gate1`→`"2"`, `gate2`→`"1"`, `gate3`→`"3"`, `gate4`→`"12"`, `gate5`→`"10"`, `gate6..7`=`UEConnection` (solenoid labels), `gate8..9`=`UMConnection` (roller labels). `SPRING_R S TRUE`, `ACTUATION_L_MA` (`AL_MA3`/`AL_MA4F`/`AL_MA5`), `ACTUATION_L_ME` (`AL_ME2`), `ACTUATION_L_EL_PN` (`AL_PE1`=solenoid, `AL_PE2`=pilot). |
| `WV_5` | `valve_5_2` | `gate1`→`"4"`, `gate2`→`"2"`, `gate3`→`"5"`, `gate4`→`"1"`, `gate5`→`"3"`, `gate6`→`"14"`, `gate7`→`"12"`, `gate8..9`=`UEConnection`, `gate10..11`=`UMConnection`. |
| `DV_P1` | `flow_control_one_way` | `gate1`→`"1"`, `gate2`→`"2"` (`LEVEL` = opening %, `NN_FLOW` L/min). |
| `pol2` | `power_24v` | `gate1` → `"OUT"`. |
| `pol1` | `power_0v` | `gate1` → `"IN"`. |
| `ETriconnection` | `electrical_junction` | `gate1..4` → `"1".."4"`. |
| `E_S011` / `E_S031` | `pushbutton_no` | `gate1`→`"13"`, `gate2`→`"14"` (`E_S031` = `detent: true`, `label`). |
| `E_S012` | `pushbutton_nc` | `gate1`→`"11"`, `gate2`→`"12"` (`label`). |
| `E_S001` | `relay_contact_no` / `limit_switch_no` | `gate1`→`"13"`, `gate2`→`"14"` (`SWITCH_TYPE I 1` or cylinder marker label → `limit_switch_no`; `SWITCH_TYPE I 0` → `relay_contact_no`). |
| `E_S002` | `relay_contact_nc` / `limit_switch_nc` | `gate1`→`"11"`, `gate2`→`"12"` (`SWITCH_TYPE I 1` → `limit_switch_nc`). |
| `E_K001` | `relay_coil` | `gate1`→`"A1"`, `gate2`→`"A2"` (`label`). |
| `E_K008` | `timer_relay_on_delay` | `gate1`→`"A1"`, `gate2`→`"A2"` (`DELAY_TIME` s → `delayMs`, `label`). |
| `E_P010` | `electrical_counter` | `gate1`→`"A1"`, `gate2`→`"A2"`, `gate3`→`"R1"`, `gate4`→`"R2"` (`N` → `presetCount`, `label`). |
| `E_Y001` | `valve_solenoid` | `gate1`→`"A1"`, `gate2`→`"A2"` (`label`). |
| `lampe` | `indicator_lamp` | `gate1`→`"X1"`, `gate2`→`"X2"` (`sig_color`). |

Decorative or auxiliary FluidSIM classes (`CAD_RECT`, `text`, `CheckValveP`, `hupe`) are preserved verbatim in `rawAst.preservedSections` so they survive parse → patch → serialize roundtrips with zero data loss.
