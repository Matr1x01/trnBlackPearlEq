package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"strings"
	"time"

	"trncontrol/hidproto"
	"trncontrol/presets"
)

// interBandDelay spaces out consecutive PEQ writes. The device drops
// reports if they arrive back-to-back, so the single-band path already
// pauses before latching; applying a whole preset needs the same
// courtesy between bands.
const interBandDelay = 8 * time.Millisecond

// flashSettle is how long the device is left alone after a flash command
// before we read from it again. The reference implementation waits 200ms for
// the physical write; we allow a little more, since being slow here only
// delays a button the user pressed deliberately.
const flashSettle = 250 * time.Millisecond

// Tolerances for comparing a read-back band against what we asked the device
// to store. Values make a round trip through float32 biquad coefficients and
// fixed-point freq/Q/gain fields, so exact equality is the wrong test --
// these match the frontend's bandsEqual.
const (
	freqToleranceHz = 0.5
	qTolerance      = 0.005
	gainToleranceDB = 0.05
)

// --- /api/presets ---

func (s *Server) handlePresets(w http.ResponseWriter, r *http.Request) {
	if s.presets == nil {
		writeErr(w, http.StatusServiceUnavailable, errNoPresetStore)
		return
	}
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, map[string]any{"presets": s.presets.List()})
	case http.MethodPost:
		var body struct {
			Name   string         `json:"name"`
			Target string         `json:"target"`
			Bands  []presets.Band `json:"bands"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeErr(w, http.StatusBadRequest, err)
			return
		}
		p, err := s.presets.Create(body.Name, body.Target, body.Bands)
		if err != nil {
			writeErr(w, presetErrStatus(err), err)
			return
		}
		w.WriteHeader(http.StatusCreated)
		writeJSON(w, p)
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

// --- /api/presets/{id} and /api/presets/{id}/apply ---

func (s *Server) handlePreset(w http.ResponseWriter, r *http.Request) {
	if s.presets == nil {
		writeErr(w, http.StatusServiceUnavailable, errNoPresetStore)
		return
	}
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/presets/"), "/")
	if rest == "" {
		s.handlePresets(w, r)
		return
	}
	id, action, _ := strings.Cut(rest, "/")

	switch action {
	case "":
		s.handlePresetCRUD(w, r, id)
	case "apply":
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		s.handlePresetApply(w, r, id)
	default:
		writeErr(w, http.StatusNotFound, errUnknownPresetAction)
	}
}

func (s *Server) handlePresetCRUD(w http.ResponseWriter, r *http.Request, id string) {
	switch r.Method {
	case http.MethodGet:
		p, err := s.presets.Get(id)
		if err != nil {
			writeErr(w, presetErrStatus(err), err)
			return
		}
		writeJSON(w, p)
	case http.MethodPut:
		// Every field is nil-able so a request can rename, re-tag, pin or
		// overwrite bands independently of the others.
		var body struct {
			Name   *string        `json:"name"`
			Target *string        `json:"target"`
			Pinned *bool          `json:"pinned"`
			Bands  []presets.Band `json:"bands"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeErr(w, http.StatusBadRequest, err)
			return
		}
		p, err := s.presets.Update(id, presets.Patch{
			Name:   body.Name,
			Target: body.Target,
			Pinned: body.Pinned,
			Bands:  body.Bands,
		})
		if err != nil {
			writeErr(w, presetErrStatus(err), err)
			return
		}
		writeJSON(w, p)
	case http.MethodDelete:
		if err := s.presets.Delete(id); err != nil {
			writeErr(w, presetErrStatus(err), err)
			return
		}
		writeJSON(w, map[string]bool{"ok": true})
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

// handlePresetApply writes all ten bands of a preset to the device and
// latches them live. With {"flash": true} it also persists the result,
// which is what makes the preset survive a power cycle.
func (s *Server) handlePresetApply(w http.ResponseWriter, r *http.Request, id string) {
	p, err := s.presets.Get(id)
	if err != nil {
		writeErr(w, presetErrStatus(err), err)
		return
	}
	var body struct {
		Flash bool `json:"flash"`
	}
	// An empty body is a valid "apply live, don't flash" request.
	_ = json.NewDecoder(r.Body).Decode(&body)

	if !s.dev.IsOpen() {
		writeErr(w, http.StatusServiceUnavailable, hidproto.ErrNotConnected)
		return
	}
	if err := s.applyBands(p.Bands); err != nil {
		writeErr(w, http.StatusBadGateway, err)
		return
	}
	if body.Flash {
		// Verify against the preset itself: at this point we know exactly
		// what the device was told to hold, so the read-back can check the
		// values rather than just that it answered.
		if err := s.flashAndVerify(p.Bands); err != nil {
			writeErr(w, http.StatusBadGateway, err)
			return
		}
	}
	// Stamp usage only once the write actually landed, so a failed apply
	// does not promote the preset in "recently used" order. A failure to
	// record it is not worth failing the request over.
	if used, err := s.presets.MarkUsed(id); err == nil {
		p = used
	}
	writeJSON(w, map[string]any{"ok": true, "flashed": body.Flash, "verified": body.Flash, "preset": p})
}

// flashAndVerify persists the device's current buffer and then confirms the
// result by reading it back.
//
// The device sends no response to the flash command -- the reference
// implementation fires it and sleeps, and nothing in its dispatch table
// handles a reply (see docs/pyblackpearl-findings.md §3). So a successful
// hid.Write proves only that bytes reached the kernel; it says nothing about
// the device. Instead we let the write settle and then read all ten bands
// back over HID, which does prove two things:
//
//   - the DAC survived the flash write and is answering again (a device that
//     was unplugged mid-write, or wedged by it, fails here);
//   - its live buffer holds the values we asked it to persist.
//
// What it cannot prove is that the flash cells were burned: that only shows
// up after a power cycle, and no host-side check can substitute for one.
// Callers should describe success as "the device confirmed the state", which
// is what was actually observed. Pass nil for expect to skip the value
// comparison and check liveness only.
func (s *Server) flashAndVerify(expect []presets.Band) error {
	if err := s.dev.Send(hidproto.FlashSavePacket()); err != nil {
		return err
	}
	time.Sleep(flashSettle)

	for idx := 0; idx < presets.BandCount; idx++ {
		resp, err := s.dev.RequestSync(hidproto.ReadPEQPacket(byte(idx)), peqKey(idx), requestTimeout)
		if err != nil {
			return fmt.Errorf("flash save unconfirmed: device stopped responding after the write (band %d): %w", idx, err)
		}
		res, err := hidproto.ParsePEQResponse(resp)
		if err != nil {
			return fmt.Errorf("flash save unconfirmed: unreadable response for band %d: %w", idx, err)
		}
		s.activeSlot = res.ActiveSlot
		if expect == nil {
			continue
		}
		if err := bandMatches(expect[idx], res.Band); err != nil {
			return fmt.Errorf("flash save unconfirmed: band %d %w", idx+1, err)
		}
	}
	return nil
}

// bandMatches reports whether the device is holding the band we sent it.
// Disabled bands are written with their gain forced to zero (see
// hidproto.WritePEQPacket), so that is what must come back -- and since a
// zero-gain band is inaudible whatever its frequency, only the gain is
// checked for those.
func bandMatches(want presets.Band, got hidproto.Band) error {
	wantGain := want.GainDB
	if !want.Enabled {
		wantGain = 0
	}
	// The device snaps sub-0.25 dB gains to zero on read; treat anything we
	// asked for below that threshold as zero too, or the comparison would
	// fail on a value the hardware cannot report back.
	if math.Abs(wantGain) < 0.25 {
		wantGain = 0
	}
	if math.Abs(got.GainDB-wantGain) > gainToleranceDB {
		return fmt.Errorf("reads back at %.2f dB, expected %.2f dB", got.GainDB, wantGain)
	}
	if wantGain == 0 {
		return nil
	}
	if got.Type.String() != want.Type {
		return fmt.Errorf("reads back as %s, expected %s", got.Type, want.Type)
	}
	if math.Abs(got.FreqHz-want.FreqHz) > freqToleranceHz {
		return fmt.Errorf("reads back at %.0f Hz, expected %.0f Hz", got.FreqHz, want.FreqHz)
	}
	if math.Abs(got.Q-want.Q) > qTolerance {
		return fmt.Errorf("reads back at Q %.3f, expected Q %.3f", got.Q, want.Q)
	}
	return nil
}

// applyBands pushes a full band set to the hardware. It refreshes the
// cached active slot first: the slot is only learned from PEQ reads,
// and a preset can be applied before the UI has read any band (e.g.
// right after the sidecar restarts).
func (s *Server) applyBands(bands []presets.Band) error {
	s.refreshActiveSlot()

	for idx, pb := range bands {
		band, err := bandJSONToHID(eqBandJSON(pb))
		if err != nil {
			return err
		}
		pkt, err := hidproto.WritePEQPacket(byte(idx), band, s.activeSlot)
		if err != nil {
			return err
		}
		if err := s.dev.Send(pkt); err != nil {
			return err
		}
		time.Sleep(interBandDelay)
	}
	return s.dev.Send(hidproto.LatchPacket())
}

// refreshActiveSlot re-reads band 0 purely to learn the slot value the
// device wants echoed back on writes. Failure is not fatal -- we fall
// back to the last known slot.
func (s *Server) refreshActiveSlot() {
	resp, err := s.dev.RequestSync(hidproto.ReadPEQPacket(0), peqKey(0), requestTimeout)
	if err != nil {
		return
	}
	if res, err := hidproto.ParsePEQResponse(resp); err == nil {
		s.activeSlot = res.ActiveSlot
	}
}

func presetErrStatus(err error) int {
	switch {
	case errors.Is(err, presets.ErrNotFound):
		return http.StatusNotFound
	case errors.Is(err, presets.ErrEmptyName), errors.Is(err, presets.ErrBandCount):
		return http.StatusBadRequest
	default:
		// Validation errors from NormalizeBands are plain fmt errors.
		if strings.HasPrefix(err.Error(), "band ") {
			return http.StatusBadRequest
		}
		return http.StatusInternalServerError
	}
}
