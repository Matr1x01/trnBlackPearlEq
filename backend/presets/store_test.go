package presets

import (
	"os"
	"path/filepath"
	"testing"
)

func flatBands() []Band {
	freqs := []float64{32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000}
	out := make([]Band, BandCount)
	for i, f := range freqs {
		out[i] = Band{Type: "PK", FreqHz: f, Q: 0.71}
	}
	return out
}

func newTestStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "presets.json"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	return s
}

func TestCreateAndReload(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "presets.json")
	s, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	p, err := s.Create("  Bass Boost  ", flatBands())
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if p.Name != "Bass Boost" {
		t.Errorf("name not trimmed: %q", p.Name)
	}
	if p.ID == "" {
		t.Error("expected a generated ID")
	}

	reopened, err := Open(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	list := reopened.List()
	if len(list) != 1 || list[0].ID != p.ID || len(list[0].Bands) != BandCount {
		t.Fatalf("preset did not survive a reload: %+v", list)
	}
}

func TestCreateRejectsBadInput(t *testing.T) {
	s := newTestStore(t)

	if _, err := s.Create("   ", flatBands()); err != ErrEmptyName {
		t.Errorf("empty name: got %v, want ErrEmptyName", err)
	}
	if _, err := s.Create("short", flatBands()[:3]); err != ErrBandCount {
		t.Errorf("short band list: got %v, want ErrBandCount", err)
	}
	bad := flatBands()
	bad[2].Type = "XX"
	if _, err := s.Create("bad type", bad); err == nil {
		t.Error("expected an error for an unknown filter type")
	}
	if got := len(s.List()); got != 0 {
		t.Errorf("rejected presets were stored: %d", got)
	}
}

func TestCreateClampsOutOfRangeValues(t *testing.T) {
	s := newTestStore(t)
	b := flatBands()
	b[0].FreqHz = 5
	b[1].FreqHz = 44100
	b[2].Q = 0
	b[3].GainDB = 500

	p, err := s.Create("clamped", b)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if p.Bands[0].FreqHz != MinFreqHz || p.Bands[1].FreqHz != MaxFreqHz {
		t.Errorf("frequency not clamped: %v, %v", p.Bands[0].FreqHz, p.Bands[1].FreqHz)
	}
	if p.Bands[2].Q != defaultQ {
		t.Errorf("zero Q not defaulted: %v", p.Bands[2].Q)
	}
	if p.Bands[3].GainDB != MaxGainDB {
		t.Errorf("gain not clamped: %v", p.Bands[3].GainDB)
	}
}

func TestDuplicateNamesAreDisambiguated(t *testing.T) {
	s := newTestStore(t)
	if _, err := s.Create("Vocal", flatBands()); err != nil {
		t.Fatal(err)
	}
	second, err := s.Create("vocal", flatBands())
	if err != nil {
		t.Fatal(err)
	}
	if second.Name != "vocal (2)" {
		t.Errorf("got %q, want %q", second.Name, "vocal (2)")
	}
}

func TestUpdateRenameAndOverwrite(t *testing.T) {
	s := newTestStore(t)
	p, err := s.Create("Original", flatBands())
	if err != nil {
		t.Fatal(err)
	}

	name := "Renamed"
	renamed, err := s.Update(p.ID, &name, nil)
	if err != nil {
		t.Fatalf("rename: %v", err)
	}
	if renamed.Name != "Renamed" || renamed.Bands[0].FreqHz != 32 {
		t.Errorf("rename changed the wrong fields: %+v", renamed)
	}

	b := flatBands()
	b[0].GainDB = 6
	b[0].Enabled = true
	overwritten, err := s.Update(p.ID, nil, b)
	if err != nil {
		t.Fatalf("overwrite: %v", err)
	}
	if overwritten.Name != "Renamed" || overwritten.Bands[0].GainDB != 6 {
		t.Errorf("overwrite changed the wrong fields: %+v", overwritten)
	}

	if _, err := s.Update("nope", &name, nil); err != ErrNotFound {
		t.Errorf("unknown id: got %v, want ErrNotFound", err)
	}
}

func TestDelete(t *testing.T) {
	s := newTestStore(t)
	a, _ := s.Create("A", flatBands())
	b, _ := s.Create("B", flatBands())

	if err := s.Delete(a.ID); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	list := s.List()
	if len(list) != 1 || list[0].ID != b.ID {
		t.Fatalf("wrong preset removed: %+v", list)
	}
	if err := s.Delete(a.ID); err != ErrNotFound {
		t.Errorf("second delete: got %v, want ErrNotFound", err)
	}
}

func TestLoadSkipsMalformedEntries(t *testing.T) {
	path := filepath.Join(t.TempDir(), "presets.json")
	blob := `{"version":1,"presets":[
		{"id":"","name":"no id","bands":[]},
		{"id":"ok","name":"good","bands":[
			{"type":"PK","freqHz":32,"q":0.71,"gainDb":0,"enabled":false},
			{"type":"PK","freqHz":64,"q":0.71,"gainDb":0,"enabled":false},
			{"type":"PK","freqHz":125,"q":0.71,"gainDb":0,"enabled":false},
			{"type":"PK","freqHz":250,"q":0.71,"gainDb":0,"enabled":false},
			{"type":"PK","freqHz":500,"q":0.71,"gainDb":0,"enabled":false},
			{"type":"PK","freqHz":1000,"q":0.71,"gainDb":0,"enabled":false},
			{"type":"PK","freqHz":2000,"q":0.71,"gainDb":0,"enabled":false},
			{"type":"PK","freqHz":4000,"q":0.71,"gainDb":0,"enabled":false},
			{"type":"PK","freqHz":8000,"q":0.71,"gainDb":0,"enabled":false},
			{"type":"PK","freqHz":16000,"q":0.71,"gainDb":0,"enabled":false}
		]}
	]}`
	if err := os.WriteFile(path, []byte(blob), 0o644); err != nil {
		t.Fatal(err)
	}
	s, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	list := s.List()
	if len(list) != 1 || list[0].ID != "ok" {
		t.Fatalf("malformed entry not skipped: %+v", list)
	}
}

func TestListReturnsCopies(t *testing.T) {
	s := newTestStore(t)
	if _, err := s.Create("A", flatBands()); err != nil {
		t.Fatal(err)
	}
	s.List()[0].Bands[0].GainDB = 99
	if s.List()[0].Bands[0].GainDB != 0 {
		t.Error("List() exposed the store's own band slice")
	}
}
