// Package presets implements the on-disk library of named 10-band EQ
// presets. The DAC itself only holds one live PEQ configuration, so
// the library lives host-side: presets are stored as JSON and written
// to the device band-by-band when the user selects one.
package presets

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// BandCount is the number of PEQ bands the hardware exposes. Every
// preset stores exactly this many bands so applying one always writes
// a complete configuration.
const BandCount = 10

var (
	ErrNotFound  = errors.New("preset not found")
	ErrEmptyName = errors.New("preset name must not be empty")
	ErrBandCount = fmt.Errorf("a preset must contain exactly %d bands", BandCount)
)

// Band mirrors the JSON shape the frontend and the /api/eq endpoints
// already use, so presets round-trip without conversion.
type Band struct {
	Type    string  `json:"type"`
	FreqHz  float64 `json:"freqHz"`
	Q       float64 `json:"q"`
	GainDB  float64 `json:"gainDb"`
	Enabled bool    `json:"enabled"`
}

// Preset is one named EQ configuration.
type Preset struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Bands []Band `json:"bands"`
	// Target is the headphone or IEM this tuning was made for. Free text,
	// optional -- the UI shows it on the preset card when set.
	Target    string    `json:"target"`
	Pinned    bool      `json:"pinned"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
	// LastUsedAt is stamped every time the preset is applied to the
	// device. Nil until it has been used at least once, which is what
	// lets the UI sort by "recently used" and show never-used presets.
	LastUsedAt *time.Time `json:"lastUsedAt"`
}

// Patch describes a partial update. A nil field is left untouched, so the
// same call serves renaming, re-tagging, pinning and overwriting bands.
type Patch struct {
	Name   *string
	Bands  []Band
	Target *string
	Pinned *bool
}

// file is the serialized form of the whole library. Versioned so the
// format can change later without silently misreading old files.
type file struct {
	Version int      `json:"version"`
	Presets []Preset `json:"presets"`
}

const fileVersion = 1

// Store is a mutex-guarded, file-backed collection of presets. The
// whole library is small enough that every mutation rewrites the file.
type Store struct {
	mu   sync.RWMutex
	path string
	list []Preset
	seq  int64 // disambiguates IDs created within the same nanosecond
}

// DefaultPath returns the per-user location of the preset library,
// e.g. ~/.config/trncontrol/presets.json on Linux. It falls back to
// the working directory if the user config dir is unavailable.
func DefaultPath() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "presets.json"
	}
	return filepath.Join(dir, "trncontrol", "presets.json")
}

// Open loads the preset library at path, creating an empty one if the
// file does not exist yet. An empty path means DefaultPath().
func Open(path string) (*Store, error) {
	if path == "" {
		path = DefaultPath()
	}
	s := &Store{path: path, list: []Preset{}}
	if err := s.load(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Store) Path() string { return s.path }

func (s *Store) load() error {
	raw, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return nil // first run: start empty, file is created on first save
	}
	if err != nil {
		return fmt.Errorf("read presets: %w", err)
	}
	var f file
	if err := json.Unmarshal(raw, &f); err != nil {
		return fmt.Errorf("parse %s: %w", s.path, err)
	}
	for _, p := range f.Presets {
		if p.ID == "" || len(p.Bands) != BandCount {
			continue // skip entries a hand-edit or older format left malformed
		}
		s.list = append(s.list, p)
	}
	return nil
}

// save rewrites the whole library. Callers must hold the write lock.
// The file is written to a temporary sibling and renamed so a crash
// mid-write cannot truncate an existing library.
func (s *Store) save() error {
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return fmt.Errorf("create preset dir: %w", err)
	}
	blob, err := json.MarshalIndent(file{Version: fileVersion, Presets: s.list}, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(s.path), ".presets-*.tmp")
	if err != nil {
		return fmt.Errorf("create temp file: %w", err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) // no-op once the rename below succeeds

	if _, err := tmp.Write(blob); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpName, s.path); err != nil {
		return fmt.Errorf("replace presets file: %w", err)
	}
	return nil
}

// List returns a copy of every stored preset, oldest first.
func (s *Store) List() []Preset {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Preset, len(s.list))
	for i, p := range s.list {
		out[i] = clone(p)
	}
	return out
}

// Get returns the preset with the given ID.
func (s *Store) Get(id string) (Preset, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	i := s.indexOf(id)
	if i < 0 {
		return Preset{}, ErrNotFound
	}
	return clone(s.list[i]), nil
}

// Create stores a new preset and returns it with its generated ID.
func (s *Store) Create(name, target string, bands []Band) (Preset, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return Preset{}, ErrEmptyName
	}
	normalized, err := NormalizeBands(bands)
	if err != nil {
		return Preset{}, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	now := time.Now().UTC()
	s.seq++
	p := Preset{
		ID:        fmt.Sprintf("p%d-%d", now.UnixNano(), s.seq),
		Name:      s.uniqueName(name, ""),
		Target:    strings.TrimSpace(target),
		Bands:     normalized,
		CreatedAt: now,
		UpdatedAt: now,
	}
	s.list = append(s.list, p)
	if err := s.save(); err != nil {
		s.list = s.list[:len(s.list)-1]
		return Preset{}, err
	}
	return clone(p), nil
}

// Update applies a partial change to an existing preset. Fields left nil
// on the patch keep their current value.
func (s *Store) Update(id string, patch Patch) (Preset, error) {
	var normalized []Band
	if patch.Bands != nil {
		var err error
		if normalized, err = NormalizeBands(patch.Bands); err != nil {
			return Preset{}, err
		}
	}
	var newName string
	if patch.Name != nil {
		newName = strings.TrimSpace(*patch.Name)
		if newName == "" {
			return Preset{}, ErrEmptyName
		}
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	i := s.indexOf(id)
	if i < 0 {
		return Preset{}, ErrNotFound
	}
	prev := clone(s.list[i])
	if patch.Name != nil {
		s.list[i].Name = s.uniqueName(newName, id)
	}
	if normalized != nil {
		s.list[i].Bands = normalized
	}
	if patch.Target != nil {
		s.list[i].Target = strings.TrimSpace(*patch.Target)
	}
	if patch.Pinned != nil {
		s.list[i].Pinned = *patch.Pinned
	}
	// Pinning is bookkeeping, not an edit -- it must not reshuffle a
	// "last modified" ordering.
	if patch.Name != nil || normalized != nil || patch.Target != nil {
		s.list[i].UpdatedAt = time.Now().UTC()
	}
	if err := s.save(); err != nil {
		s.list[i] = prev
		return Preset{}, err
	}
	return clone(s.list[i]), nil
}

// MarkUsed stamps a preset as applied to the device, for "recently used"
// ordering. It leaves UpdatedAt alone: using a preset is not editing it.
func (s *Store) MarkUsed(id string) (Preset, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	i := s.indexOf(id)
	if i < 0 {
		return Preset{}, ErrNotFound
	}
	prev := clone(s.list[i])
	now := time.Now().UTC()
	s.list[i].LastUsedAt = &now
	if err := s.save(); err != nil {
		s.list[i] = prev
		return Preset{}, err
	}
	return clone(s.list[i]), nil
}

// Delete removes a preset by ID.
func (s *Store) Delete(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	i := s.indexOf(id)
	if i < 0 {
		return ErrNotFound
	}
	removed := s.list[i]
	s.list = append(s.list[:i], s.list[i+1:]...)
	if err := s.save(); err != nil {
		s.list = append(s.list, Preset{})
		copy(s.list[i+1:], s.list[i:])
		s.list[i] = removed
		return err
	}
	return nil
}

// indexOf must be called with the lock held.
func (s *Store) indexOf(id string) int {
	for i, p := range s.list {
		if p.ID == id {
			return i
		}
	}
	return -1
}

// uniqueName appends " (2)", " (3)", ... when name already belongs to
// another preset, so the dropdown never shows two identical labels.
// Must be called with the lock held; exceptID is skipped when checking.
func (s *Store) uniqueName(name, exceptID string) string {
	taken := func(candidate string) bool {
		for _, p := range s.list {
			if p.ID != exceptID && strings.EqualFold(p.Name, candidate) {
				return true
			}
		}
		return false
	}
	if !taken(name) {
		return name
	}
	for n := 2; ; n++ {
		candidate := fmt.Sprintf("%s (%d)", name, n)
		if !taken(candidate) {
			return candidate
		}
	}
}

func clone(p Preset) Preset {
	out := p
	out.Bands = append([]Band(nil), p.Bands...)
	// Copy the timestamp too, so a caller cannot reach back into the
	// store's own value through the pointer.
	if p.LastUsedAt != nil {
		t := *p.LastUsedAt
		out.LastUsedAt = &t
	}
	return out
}
