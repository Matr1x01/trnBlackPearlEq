# Black Pearl device behaviour — notes from pyBlackPearl

Source: [cheesyserg/pyBlackPearl](https://github.com/cheesyserg/pyBlackPearl) (`app.py`,
read at commit fetched 2026-08-10). It is the other known implementation of the TE-C HID
protocol and the reverse-engineering our device layer is based on.

These are observations about **what the hardware does**, recorded so the decisions they
drive in this codebase can be re-checked later. Where a claim is inferred from the
reference implementation rather than from a datasheet, it says so.

---

## 1. Volume is a gain in the same domain as the EQ

```python
VOL_MIN_RAW, VOL_MAX_RAW, UNITS_PER_DB = -9472, 6440, 256
```

`raw / 256 == dB`, so the master spans **−37.0 dB … +25.16 dB**. We already mirror these
constants in `hidproto/protocol.go` and `dsp/headroom.ts`.

The important part is how the reference treats `VOL_MAX_RAW`:

```python
def _check_headroom(self, auto_level=False):
    ceiling_db = (VOL_MAX_RAW - self.last_raw_vol) / UNITS_PER_DB
    self.graph.headroom_db = ceiling_db
    ...
    safe_max = VOL_MAX_RAW - int(max(0, max_db) * UNITS_PER_DB)
    is_clipping = self.last_raw_vol > safe_max
```

`max_db` there is the peak boost of the EQ curve. Rearranged, the clipping condition is:

```
volume_dB + peak_EQ_boost_dB > VOL_MAX_RAW / 256   (= 25.16 dB)
```

**Master volume and EQ gain are summed against one shared maximum.** `VOL_MAX_RAW` is not
just the top of the volume slider — it is the largest gain the output stage can represent,
and EQ boost eats into it. That is the single most useful fact in the repository, and it
settles a question `dsp/headroom.ts` previously had to leave open (its old comment
declined to sum volume into the headroom figure because it was unknown whether the volume
stage was digital, analogue, or placed after the EQ).

Note this is **inference from a working implementation**, not from vendor documentation.
It is consistent, it is what the only other implementation ships, and it degrades safely:
at low volume the ceiling is large and nothing is flagged, at high volume boost is flagged
exactly when the sum crosses the device maximum.

### Consequences adopted here

* `ceilingDb = 25.16 − volumeDb` — how much EQ boost still fits at the current volume.
* Clipping when `peakEqBoostDb > ceilingDb`. A flat EQ never clips, at any volume.
* The old "positive master volume escalates the warning one step" heuristic is gone; it
  was a stand-in for exactly this calculation.

## 2. How the EQ graph represents level

* The plotted curve is `preamp + Σ biquad_response(band, f)` — the y axis is **EQ gain
  relative to unity**, not absolute output level. Master volume is *not* baked into the
  curve.
* Volume appears instead as a separate horizontal dashed line at `ceiling_db`, drawn in
  the same dB axis and labelled "Digital Ceiling":

  ```python
  hy = int(self._db_to_y(self.headroom_db))
  painter.setPen(QPen(QColor(255, 165, 0, 200), 2, Qt.DashLine))
  painter.drawLine(0, hy, w, hy)
  ```

* When the sum clips, the whole curve is redrawn in red (`#ff4d4d`).

This is the concept worth adapting, and the reason is that it stays technically honest.
Adding volume to the curve itself would misrepresent the filter response, but the ceiling
line lives in the same units as the curve, so "curve crosses the line" *is* the clipping
condition — the graph shows the relationship rather than asserting a number.

Our adaptation (`components/EQGraph.tsx`):

* The ceiling is a line plus a tinted region above it, so the unusable area is visible
  rather than implied.
* Only the part of the curve that is actually over the ceiling turns red (via an SVG
  clip), instead of recolouring the whole curve. Same signal, but it also shows *which
  bands* are responsible.
* The ceiling is only in range when volume is above ~76% (`ceilingDb ≤ 15 dB`, the graph's
  scale). Below that it is off-screen, which is correct: there is nothing to warn about.

The reference also draws band control points at `gain + preamp`. We have no per-preset
preamp field, so that part does not apply.

## 3. Flash save is not acknowledged by the device

```python
def _commit_to_flash(self):
    def run_save():
        ...
        # CMD_FLASH_EQ (0x01) saves the Volume + EQ buffer permanently
        report.send([REPORT_ID, WRITE, CMD_FLASH_EQ, 0x01, END] + [0x00]*59)
        time.sleep(0.2)   # Give the hardware a moment to process the physical write
    Thread(target=run_save, daemon=True).start()
```

Findings:

* The command is `0x01` with a payload length of `0x01` — identical to our
  `FlashSavePacket()`. The packet is correct.
* **The device sends no response.** The reference fires and forgets, then sleeps 200 ms.
  There is no handler for a `0x01` reply anywhere in `on_data`.
* Flash persists the **volume + EQ buffer**, i.e. whatever was last latched — not a
  specific preset. Flashing is only meaningful after the intended state has been written
  and latched.

So there is no ack to wait for, and any implementation claiming "the DAC confirmed the
flash" from the write call alone is claiming something it did not observe.

### What we do instead

`api.handleFlash` now sends the packet, waits for the device to settle, then **reads the
state back over HID and compares it to what was meant to be persisted**. See
`flashAndVerify` in `backend/api/presets.go`. That proves:

* the device survived the write and is answering again (a wedged or unplugged DAC fails);
* its live buffer holds the values we asked it to persist.

It does not prove the flash cells were burned — only a power cycle proves that, and no
implementation can do better without one. The API reports `verified: true` for what was
actually checked, and the UI's success toast means precisely that.

## 4. Preset identification is by EQ content, not by ID

The DAC does not report which preset is loaded, so `_identify_preset` compares the live
band set against every saved preset:

* gain compared with a **0.1 dB** tolerance;
* a band disabled in the saved preset counts as **gain 0.0**;
* frequency (±1 Hz), Q (±0.05) and type are compared **only for bands whose gain is
  non-zero** — a band at 0 dB is inaudible, so its parked frequency is irrelevant;
* first match wins; `-1` when nothing matches, and the UI then falls back to a "None"
  slot rather than picking something arbitrary.

Our `presets/fingerprint.ts` keeps the semantics and swaps the linear scan for a hash:
inert bands are canonicalised away, and the remaining values are quantised to the
device's own resolution (integer Hz, Q and gain in 1/256 steps, gains under 0.25 dB
snapped to zero — which is what `ParsePEQResponse` already does) before hashing. Same
matching rule, but it survives reordering and works as a lookup instead of an O(presets)
comparison.

## 5. Smaller details worth knowing

* **Latch bitmask.** The reference latches with `0xFF 0xFF 0xFF 0xFF` and comments that
  this forces volume *and* EQ out to the output stage together. `LatchPacket()` already
  matches.
* **Snap-to-zero on read.** Gains below 0.25 dB are treated as zero on the read path, to
  kill ghost values from the float round-trip. `ParsePEQResponse` already does this; the
  fingerprint has to apply the same rule or local and device data never agree.
* **Inter-packet delay.** The reference sleeps 10 ms between the two balance writes and
  serialises all USB traffic behind one lock. Our 8 ms `interBandDelay` is the same idea.
* **`active_slot`** is echoed back unchanged on PEQ writes, exactly as we do.
* **Auto-flash timer.** The reference flashes automatically 3 s after any change. We do
  not, deliberately — flash has a finite write-cycle life and `README.md` documents the
  explicit-action choice. No reason to revisit it.
