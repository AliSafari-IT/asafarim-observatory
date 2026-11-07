package api

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

type summaryRecord struct {
	SchemaVersion int             `json:"schema_version"`
	Root          string          `json:"root"`
	Summary       json.RawMessage `json:"summary"`
}

func summaryPath(config Config) string {
	return filepath.Join(config.History, ".summaries", fmt.Sprintf("%x.json", sha256.Sum256([]byte(config.Root))))
}

func loadSummary(config Config) (json.RawMessage, error) {
	file, err := os.Open(summaryPath(config))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, errors.New("cannot open saved summary")
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, (8<<20)+1))
	if err != nil || len(data) > 8<<20 {
		return nil, errors.New("cannot read saved summary or record exceeds limit")
	}
	var record summaryRecord
	if json.Unmarshal(data, &record) != nil || record.SchemaVersion != 1 || record.Root != config.Root || !validSummary(record.Summary) {
		return nil, errors.New("saved summary is invalid or belongs to a different workspace")
	}
	return record.Summary, nil
}

func saveSummary(config Config, result json.RawMessage) error {
	path := summaryPath(config)
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".summary-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	defer file.Close()
	if err := json.NewEncoder(file).Encode(summaryRecord{1, config.Root, result}); err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return os.Rename(file.Name(), path)
}

func validSummary(result []byte) bool {
	var report struct {
		SchemaVersion int               `json:"schema_version"`
		Provider      string            `json:"provider"`
		Headline      string            `json:"headline"`
		SnapshotCount int               `json:"snapshot_count"`
		Findings      []json.RawMessage `json:"findings"`
	}
	return json.Unmarshal(result, &report) == nil && report.SchemaVersion == 1 && report.Provider == "openai" && report.Headline != "" && report.SnapshotCount > 0 && report.Findings != nil
}
