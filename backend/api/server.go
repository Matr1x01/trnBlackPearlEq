package api

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"trncontrol/hidproto"
	"trncontrol/presets"
)

const requestTimeout = 300 * time.Millisecond

type Server struct {
	dev *hidproto.Device
	mux *http.ServeMux

	// presets is the host-side library of saved EQ configurations. It
	// may be nil if the library file could not be opened, in which case
	// the /api/presets endpoints report the failure and the rest of the
	// app keeps working.
	presets *presets.Store

	// activeSlot is echoed back on every PEQ write; the device reports
	// its current slot on every PEQ read, so we track the latest one.
	activeSlot byte
}

func NewServer(dev *hidproto.Device, store *presets.Store) *Server {
	s := &Server{dev: dev, presets: store, mux: http.NewServeMux()}
	s.routes()
	return s
}

func (s *Server) Handler() http.Handler { return s.mux }

func (s *Server) routes() {
	s.mux.HandleFunc("/api/status", s.handleStatus)
	s.mux.HandleFunc("/api/reconnect", s.handleReconnect)
	s.mux.HandleFunc("/api/volume", s.handleVolume)
	s.mux.HandleFunc("/api/mic-gain", s.handleMicGain)
	s.mux.HandleFunc("/api/balance", s.handleBalance)
	s.mux.HandleFunc("/api/registers/", s.handleRegister)
	s.mux.HandleFunc("/api/eq/", s.handleEQBand)
	s.mux.HandleFunc("/api/presets", s.handlePresets)
	s.mux.HandleFunc("/api/presets/", s.handlePreset)
	s.mux.HandleFunc("/api/latch", s.handleLatch)
	s.mux.HandleFunc("/api/flash", s.handleFlash)
	s.mux.HandleFunc("/api/events", s.HandleEvents)
}

func writeJSON(w http.ResponseWriter, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, err error) {
	w.WriteHeader(code)
	writeJSON(w, map[string]string{"error": err.Error()})
}

// --- /api/status ---

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	if !s.dev.IsOpen() {
		writeJSON(w, map[string]any{"connected": false})
		return
	}
	resp, err := s.dev.RequestSync(hidproto.ReadRegisterPacket(hidproto.CmdVersion), "version", requestTimeout)
	if err != nil {
		writeJSON(w, map[string]any{"connected": true, "firmware": nil})
		return
	}
	fw, _ := hidproto.ParseFirmwareVersion(resp)
	writeJSON(w, map[string]any{"connected": true, "firmware": fw})
}

// --- /api/reconnect ---

// handleReconnect makes one immediate attempt to (re)open the DAC --
// background connectLoop already retries every 2s on its own, but a
// user pressing "refresh" after plugging the device back in shouldn't
// have to wait out that interval. It responds with the same shape as
// /api/status either way.
func (s *Server) handleReconnect(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if !s.dev.IsOpen() {
		_ = s.dev.Open() // failure just means still disconnected; handleStatus below reports it
	}
	s.handleStatus(w, r)
}

// --- /api/volume ---

func (s *Server) handleVolume(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		resp, err := s.dev.RequestSync(hidproto.ReadVolumePacket(), "volume", requestTimeout)
		if err != nil {
			writeErr(w, http.StatusGatewayTimeout, err)
			return
		}
		raw, _ := hidproto.ParseVolume(resp)
		writeJSON(w, map[string]any{
			"percent": hidproto.VolumeRawToPercent(raw),
			"db":      hidproto.VolumeRawToDB(raw),
		})
	case http.MethodPut:
		var body struct{ Percent int }
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeErr(w, http.StatusBadRequest, err)
			return
		}
		raw := hidproto.VolumePercentToRaw(body.Percent)
		if err := s.dev.Send(hidproto.WriteVolumePacket(raw)); err != nil {
			writeErr(w, http.StatusBadGateway, err)
			return
		}
		_ = s.dev.Send(hidproto.LatchPacket())
		writeJSON(w, map[string]any{"percent": hidproto.VolumeRawToPercent(raw)})
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

// --- /api/mic-gain ---

func (s *Server) handleMicGain(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		resp, err := s.dev.RequestSync(hidproto.ReadMicGainPacket(), "micgain", requestTimeout)
		if err != nil {
			writeErr(w, http.StatusGatewayTimeout, err)
			return
		}
		g, _ := hidproto.ParseMicGain(resp)
		writeJSON(w, map[string]any{"db": g})
	case http.MethodPut:
		var body struct{ DB int8 }
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeErr(w, http.StatusBadRequest, err)
			return
		}
		if err := s.dev.Send(hidproto.WriteMicGainPacket(body.DB)); err != nil {
			writeErr(w, http.StatusBadGateway, err)
			return
		}
		writeJSON(w, map[string]any{"db": body.DB})
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

// --- /api/balance --- value in [-15, 15], negative = left

func (s *Server) handleBalance(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		lResp, errL := s.dev.RequestSync(hidproto.ReadBalancePacket(true), "balance:l", requestTimeout)
		rResp, errR := s.dev.RequestSync(hidproto.ReadBalancePacket(false), "balance:r", requestTimeout)
		if errL != nil && errR != nil {
			writeErr(w, http.StatusGatewayTimeout, errL)
			return
		}
		l, r1 := 0, 0
		if errL == nil {
			l, _ = hidproto.ParseBalance(lResp, true)
		}
		if errR == nil {
			r1, _ = hidproto.ParseBalance(rResp, false)
		}
		v := l
		if abs(r1) > abs(l) {
			v = r1
		}
		writeJSON(w, map[string]any{"value": v})
	case http.MethodPut:
		var body struct{ Value int }
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeErr(w, http.StatusBadRequest, err)
			return
		}
		if body.Value < -15 || body.Value > 15 {
			writeErr(w, http.StatusBadRequest, errInvalidRange)
			return
		}
		_ = s.dev.Send(hidproto.WriteBalancePacket(true, body.Value))
		time.Sleep(10 * time.Millisecond)
		_ = s.dev.Send(hidproto.WriteBalancePacket(false, body.Value))
		writeJSON(w, map[string]any{"value": body.Value})
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func abs(v int) int {
	if v < 0 {
		return -v
	}
	return v
}

// --- /api/registers/{filter|gain|amp} ---

var registerCmds = map[string]byte{
	"filter": hidproto.CmdFilter,
	"gain":   hidproto.CmdGainMode,
	"amp":    hidproto.CmdAmpMode,
}

var registerNames = map[string]map[byte]string{
	"filter": hidproto.FilterModeNames,
	"gain":   hidproto.GainModeNames,
	"amp":    hidproto.AmpModeNames,
}

func (s *Server) handleRegister(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(r.URL.Path, "/api/registers/")
	cmd, ok := registerCmds[name]
	if !ok {
		writeErr(w, http.StatusNotFound, errUnknownRegister)
		return
	}
	names := registerNames[name]
	invNames := map[string]byte{}
	for k, v := range names {
		invNames[v] = k
	}

	switch r.Method {
	case http.MethodGet:
		resp, err := s.dev.RequestSync(hidproto.ReadRegisterPacket(cmd), cacheKeyForReg(cmd), requestTimeout)
		if err != nil {
			writeErr(w, http.StatusGatewayTimeout, err)
			return
		}
		val, _ := hidproto.ParseByteRegister(resp)
		writeJSON(w, map[string]any{"value": names[val]})
	case http.MethodPut:
		var body struct{ Value string }
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeErr(w, http.StatusBadRequest, err)
			return
		}
		bv, ok := invNames[body.Value]
		if !ok {
			writeErr(w, http.StatusBadRequest, errUnknownValue)
			return
		}
		if err := s.dev.Send(hidproto.WriteRegisterPacket(cmd, bv)); err != nil {
			writeErr(w, http.StatusBadGateway, err)
			return
		}
		writeJSON(w, map[string]any{"value": body.Value})
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func cacheKeyForReg(cmd byte) string {
	return "reg:0x" + strconv.FormatInt(int64(cmd), 16)
}

// --- /api/eq/{0-9} ---

func (s *Server) handleEQBand(w http.ResponseWriter, r *http.Request) {
	idxStr := strings.TrimPrefix(r.URL.Path, "/api/eq/")
	idx, err := strconv.Atoi(idxStr)
	if err != nil || idx < 0 || idx > 9 {
		writeErr(w, http.StatusNotFound, errUnknownBand)
		return
	}

	switch r.Method {
	case http.MethodGet:
		resp, err := s.dev.RequestSync(hidproto.ReadPEQPacket(byte(idx)), peqKey(idx), requestTimeout)
		if err != nil {
			writeErr(w, http.StatusGatewayTimeout, err)
			return
		}
		res, err := hidproto.ParsePEQResponse(resp)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, err)
			return
		}
		s.activeSlot = res.ActiveSlot
		writeJSON(w, bandToJSON(res.Band))
	case http.MethodPut:
		var body eqBandJSON
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeErr(w, http.StatusBadRequest, err)
			return
		}
		band, err := bandJSONToHID(body)
		if err != nil {
			writeErr(w, http.StatusBadRequest, err)
			return
		}
		pkt, err := hidproto.WritePEQPacket(byte(idx), band, s.activeSlot)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, err)
			return
		}
		if err := s.dev.Send(pkt); err != nil {
			writeErr(w, http.StatusBadGateway, err)
			return
		}
		time.Sleep(5 * time.Millisecond)
		_ = s.dev.Send(hidproto.LatchPacket())
		writeJSON(w, body)
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func peqKey(idx int) string { return "peq:" + strconv.Itoa(idx) }

// eqBandJSON is the wire shape of one band. It is an alias for
// presets.Band so a saved preset and a live band edit are the same
// value and need no conversion between the two paths.
type eqBandJSON = presets.Band

func bandToJSON(b hidproto.Band) eqBandJSON {
	return eqBandJSON{Type: b.Type.String(), FreqHz: b.FreqHz, Q: b.Q, GainDB: b.GainDB, Enabled: b.Enabled}
}

func bandJSONToHID(j eqBandJSON) (hidproto.Band, error) {
	ft, err := hidproto.FilterTypeFromString(j.Type)
	if err != nil {
		return hidproto.Band{}, err
	}
	return hidproto.Band{Type: ft, FreqHz: j.FreqHz, Q: j.Q, GainDB: j.GainDB, Enabled: j.Enabled}, nil
}

// --- /api/latch, /api/flash ---

func (s *Server) handleLatch(w http.ResponseWriter, r *http.Request) {
	if err := s.dev.Send(hidproto.LatchPacket()); err != nil {
		writeErr(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

func (s *Server) handleFlash(w http.ResponseWriter, r *http.Request) {
	if err := s.dev.Send(hidproto.FlashSavePacket()); err != nil {
		writeErr(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}
