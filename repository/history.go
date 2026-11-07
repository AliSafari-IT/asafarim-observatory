package repository

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Save writes a snapshot atomically, with private file permissions. Each workspace
// root has separate history. Scans with repository errors are retained as evidence.
func Save(directory string, snapshot Snapshot) (string, error) {
	if err := validateSnapshot(snapshot); err != nil {
		return "", err
	}
	directory = workspaceHistory(directory, snapshot.Root)
	if err := os.MkdirAll(directory, 0700); err != nil {
		return "", err
	}
	file, err := os.CreateTemp(directory, ".snapshot-*.tmp")
	if err != nil {
		return "", err
	}
	defer os.Remove(file.Name())
	encoder := json.NewEncoder(file)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(snapshot); err != nil {
		file.Close()
		return "", err
	}
	if err := file.Close(); err != nil {
		return "", err
	}
	suffix := strings.TrimSuffix(strings.TrimPrefix(filepath.Base(file.Name()), ".snapshot-"), ".tmp")
	name := "snapshot-" + snapshot.ScannedAt.UTC().Format("20060102T150405.000000000Z") + "-" + suffix + ".json"
	path := filepath.Join(directory, name)
	if err := os.Rename(file.Name(), path); err != nil {
		return "", err
	}
	return path, nil
}

// Latest loads the newest saved scan for root. Missing history returns
// os.ErrNotExist; malformed history returns an error rather than a false baseline.
func Latest(directory, root string) (Snapshot, error) {
	entries, err := os.ReadDir(workspaceHistory(directory, root))
	if err != nil {
		return Snapshot{}, err
	}
	for i := len(entries) - 1; i >= 0; i-- {
		entry := entries[i]
		if entry.IsDir() || !strings.HasPrefix(entry.Name(), "snapshot-") || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		file, err := os.Open(filepath.Join(workspaceHistory(directory, root), entry.Name()))
		if err != nil {
			return Snapshot{}, err
		}
		var snapshot Snapshot
		decoder := json.NewDecoder(file)
		err = decoder.Decode(&snapshot)
		if err == nil {
			var extra any
			if trailing := decoder.Decode(&extra); trailing != io.EOF {
				err = errors.New("snapshot contains trailing data")
			}
		}
		file.Close()
		if err != nil {
			return Snapshot{}, fmt.Errorf("read snapshot %s: %w", entry.Name(), err)
		}
		if err := validateSnapshot(snapshot); err != nil {
			return Snapshot{}, err
		}
		if snapshot.Root != root {
			return Snapshot{}, errors.New("snapshot workspace root does not match")
		}
		return snapshot, nil
	}
	return Snapshot{}, os.ErrNotExist
}

func workspaceHistory(directory, root string) string {
	return filepath.Join(directory, fmt.Sprintf("%x", sha256.Sum256([]byte(root))))
}

func validateSnapshot(snapshot Snapshot) error {
	if snapshot.SchemaVersion != 1 || snapshot.ScannedAt.IsZero() || !filepath.IsAbs(snapshot.Root) || snapshot.Repositories == nil {
		return errors.New("unsupported or incomplete snapshot")
	}
	seen := make(map[string]bool)
	for _, repo := range snapshot.Repositories {
		if repo.Name == "" || repo.Name == "." || repo.Name == ".." || filepath.Base(repo.Name) != repo.Name || seen[repo.Name] || repo.ChangedFiles < 0 || repo.Path != filepath.Join(snapshot.Root, repo.Name) || (repo.Error == "" && repo.Branch == "") {
			return errors.New("invalid or duplicate repository in snapshot")
		}
		seen[repo.Name] = true
	}
	return nil
}

// Change retains both observations so downstream tools can explain the delta.
// Unavailable results must not be interpreted as zero changed files.
type Change struct {
	Name   string      `json:"name"`
	Kind   string      `json:"kind"`
	Before *Repository `json:"before,omitempty"`
	After  *Repository `json:"after,omitempty"`
}

type Comparison struct {
	PreviousScan time.Time `json:"previous_scan"`
	CurrentScan  time.Time `json:"current_scan"`
	Changes      []Change  `json:"changes"`
}

// Compare reports observed branch, count and availability changes, not file
// content changes. Equal file counts do not imply identical working trees.
func Compare(before, after Snapshot) (Comparison, error) {
	for _, snapshot := range []Snapshot{before, after} {
		if err := validateSnapshot(snapshot); err != nil {
			return Comparison{}, err
		}
	}
	if before.Root != after.Root {
		return Comparison{}, errors.New("cannot compare different workspace roots")
	}
	previous := make(map[string]Repository)
	current := make(map[string]Repository)
	names := make(map[string]bool)
	for _, repo := range before.Repositories {
		previous[repo.Name] = repo
		names[repo.Name] = true
	}
	for _, repo := range after.Repositories {
		current[repo.Name] = repo
		names[repo.Name] = true
	}
	ordered := make([]string, 0, len(names))
	for name := range names {
		ordered = append(ordered, name)
	}
	sort.Strings(ordered)
	result := Comparison{PreviousScan: before.ScannedAt, CurrentScan: after.ScannedAt, Changes: []Change{}}
	for _, name := range ordered {
		old, existed := previous[name]
		now, exists := current[name]
		change := Change{Name: name}
		if existed {
			change.Before = &old
		}
		if exists {
			change.After = &now
		}
		switch {
		case !exists:
			change.Kind = "removed"
		case now.Error != "":
			change.Kind = "unavailable"
		case !existed:
			change.Kind = "added"
		case old.Error != "":
			change.Kind = "recovered"
		case old.Branch != now.Branch || old.Detached != now.Detached || old.ChangedFiles != now.ChangedFiles:
			change.Kind = "updated"
		default:
			continue
		}
		result.Changes = append(result.Changes, change)
	}
	return result, nil
}
