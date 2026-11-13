// Package api serves saved workspace observations and Python analysis as JSON.
package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"github.com/AliSafari-IT/asafarim-observatory/repository"
)

const Version = "0.2.3"

type Config struct {
	Root           string
	History        string
	Analyzer       string
	Python         string
	Timeout        time.Duration
	SummaryTimeout time.Duration
}

// New pins all file paths at startup. HTTP requests cannot choose workspaces,
// scripts or commands. Snapshot endpoints read saved state without rescanning.
func New(config Config) (http.Handler, error) {
	if config.Timeout <= 0 {
		return nil, errors.New("analysis timeout must be positive")
	}
	if config.SummaryTimeout == 0 {
		config.SummaryTimeout = 60 * time.Second
	}
	if config.SummaryTimeout < 0 {
		return nil, errors.New("summary timeout must be positive")
	}
	for _, path := range []*string{&config.Root, &config.History, &config.Analyzer} {
		absolute, err := filepath.Abs(*path)
		if err != nil {
			return nil, err
		}
		*path = absolute
	}
	python, err := exec.LookPath(config.Python)
	if err != nil {
		return nil, fmt.Errorf("find Python: %w", err)
	}
	config.Python, err = filepath.Abs(python)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(config.Analyzer)
	if err != nil {
		return nil, fmt.Errorf("find analyzer: %w", err)
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("analyzer must be a file")
	}
	// Bound concurrent Python processes; the dashboard can retry a busy response.
	analysisSlot := make(chan struct{}, 1)
	summary, err := newSummaryHandler(config, analysisSlot)
	if err != nil {
		return nil, err
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		if r.URL.Path == "/api/summary" {
			summary.ServeHTTP(w, r)
			return
		}
		if r.URL.Path != "/healthz" && r.URL.Path != "/api/snapshot" && r.URL.Path != "/api/analysis" {
			writeError(w, http.StatusNotFound, "not_found", "Unknown endpoint.")
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "Use GET or HEAD.")
			return
		}
		if r.URL.Path == "/healthz" {
			writeJSON(w, map[string]string{"status": "ok", "version": Version})
			return
		}
		snapshot, err := repository.Latest(config.History, config.Root)
		if errors.Is(err, os.ErrNotExist) {
			writeError(w, http.StatusNotFound, "no_snapshots", "No saved snapshot. Run Observatory with -save first.")
			return
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, "invalid_history", "Cannot read saved snapshot history.")
			return
		}
		if r.URL.Path == "/api/snapshot" {
			writeJSON(w, snapshot)
			return
		}
		select {
		case analysisSlot <- struct{}{}:
			defer func() { <-analysisSlot }()
		default:
			w.Header().Set("Retry-After", "1")
			writeError(w, http.StatusServiceUnavailable, "analysis_busy", "Analysis is busy. Retry shortly.")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), config.Timeout)
		defer cancel()
		result, err := runAnalysis(ctx, config)
		if err != nil {
			if ctx.Err() != nil {
				writeError(w, http.StatusGatewayTimeout, "analysis_timeout", "Analysis did not complete before its deadline.")
			} else {
				writeError(w, http.StatusInternalServerError, "analysis_failed", "Python analysis failed or returned invalid output.")
			}
			return
		}
		writeJSON(w, result)
	}), nil
}

func runAnalysis(ctx context.Context, config Config) (json.RawMessage, error) {
	output, err := runPython(ctx, config)
	if err != nil {
		return nil, err
	}
	var report struct {
		SchemaVersion int             `json:"schema_version"`
		Root          string          `json:"root"`
		SnapshotCount int             `json:"snapshot_count"`
		Repositories  json.RawMessage `json:"repositories"`
	}
	if err := json.Unmarshal(output, &report); err != nil {
		return nil, err
	}
	if report.SchemaVersion != 1 || report.Root != config.Root || report.SnapshotCount < 1 || len(report.Repositories) == 0 || report.Repositories[0] != '[' {
		return nil, errors.New("unexpected analysis report")
	}
	return json.RawMessage(output), nil
}

func runPython(ctx context.Context, config Config, extra ...string) ([]byte, error) {
	args := append([]string{config.Analyzer, "--root", config.Root, "--history", config.History, "--format", "json"}, extra...)
	cmd := exec.CommandContext(ctx, config.Python, args...)
	cmd.WaitDelay = time.Second
	output := &limitedBuffer{limit: 8 << 20}
	cmd.Stdout = output
	if err := cmd.Run(); err != nil {
		return nil, err
	}
	return output.Bytes(), nil
}

type limitedBuffer struct {
	data  bytes.Buffer
	limit int
}

func (b *limitedBuffer) Bytes() []byte { return b.data.Bytes() }

func (b *limitedBuffer) Len() int { return b.data.Len() }

func (b *limitedBuffer) Write(p []byte) (int, error) {
	if len(p) > b.limit-b.Len() {
		return 0, errors.New("analysis output too large")
	}
	return b.data.Write(p)
}

func writeJSON(w http.ResponseWriter, value any) {
	json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	w.WriteHeader(status)
	writeJSON(w, map[string]any{"error": map[string]string{"code": code, "message": message}})
}
