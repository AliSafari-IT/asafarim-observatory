package repository

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"
)

const MaxSnapshotBytes = 8 << 20

// Receive accepts one bounded snapshot from an authenticated transport. The
// receiver chooses history and expectedRoot; neither comes from a remote path.
// Retrying the same observation is idempotent and does not inflate history.
func Receive(reader io.Reader, expectedRoot, history string) (duplicate bool, err error) {
	if !filepath.IsAbs(expectedRoot) || filepath.Clean(expectedRoot) != expectedRoot {
		return false, errors.New("expected root must be an absolute clean path")
	}
	data, err := io.ReadAll(io.LimitReader(reader, MaxSnapshotBytes+1))
	if err != nil || len(data) > MaxSnapshotBytes {
		return false, errors.New("cannot read snapshot or snapshot exceeds size limit")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var snapshot Snapshot
	if decoder.Decode(&snapshot) != nil {
		return false, errors.New("invalid snapshot JSON")
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return false, errors.New("snapshot contains trailing data")
	}
	if snapshot.Root != expectedRoot {
		return false, errors.New("snapshot workspace root does not match receiver configuration")
	}
	if err := validateSnapshot(snapshot); err != nil {
		return false, err
	}
	if snapshot.ScannedAt.After(time.Now().Add(5 * time.Minute)) {
		return false, errors.New("snapshot time is too far in the future")
	}
	snapshot.ScannedAt = snapshot.ScannedAt.UTC()
	canonical, err := json.Marshal(snapshot)
	if err != nil {
		return false, err
	}
	dir := workspaceHistory(history, expectedRoot)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return false, err
	}
	name := fmt.Sprintf("snapshot-%s-%x.json", snapshot.ScannedAt.Format("20060102T150405.000000000Z"), sha256.Sum256(canonical))
	file, err := os.CreateTemp(dir, ".receive-*.tmp")
	if err != nil {
		return false, err
	}
	defer os.Remove(file.Name())
	defer file.Close()
	if _, err := file.Write(canonical); err != nil {
		return false, err
	}
	if err := file.Sync(); err != nil {
		return false, err
	}
	if err := file.Close(); err != nil {
		return false, err
	}
	// Link creates the final name atomically without replacing another import.
	if err := os.Link(file.Name(), filepath.Join(dir, name)); err != nil {
		if errors.Is(err, os.ErrExist) {
			existingFile, openErr := os.Open(filepath.Join(dir, name))
			if openErr != nil {
				return false, openErr
			}
			existing, readErr := io.ReadAll(io.LimitReader(existingFile, MaxSnapshotBytes+1))
			existingFile.Close()
			if readErr != nil || !bytes.Equal(existing, canonical) {
				return false, errors.New("existing imported snapshot does not match")
			}
			return true, nil
		}
		return false, err
	}
	return false, nil
}
