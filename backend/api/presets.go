package api

import (
	"encoding/json"
	"errors"
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
		if err := s.dev.Send(hidproto.FlashSavePacket()); err != nil {
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
	writeJSON(w, map[string]any{"ok": true, "flashed": body.Flash, "preset": p})
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
