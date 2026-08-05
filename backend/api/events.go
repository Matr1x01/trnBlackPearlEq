package api

import (
	"encoding/json"
	"log"
	"net/http"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	// Sidecar only ever talks to the app's own webview on localhost.
	CheckOrigin: func(r *http.Request) bool { return true },
}

// HandleEvents upgrades to a WebSocket and streams VolumeEvents (and
// future push event types) as they occur, e.g. when the user presses
// a physical volume button on the DAC itself.
func (s *Server) HandleEvents(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("ws upgrade failed: %v", err)
		return
	}
	defer conn.Close()

	sub := s.dev.Subscribe()
	for ev := range sub {
		msg := map[string]any{
			"type":    "volume",
			"percent": ev.Percent,
			"db":      float64(ev.RawVolume) / 256.0,
		}
		b, _ := json.Marshal(msg)
		if err := conn.WriteMessage(websocket.TextMessage, b); err != nil {
			return
		}
	}
}
