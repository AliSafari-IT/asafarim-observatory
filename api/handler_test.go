package api

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/AliSafari-IT/asafarim-observatory/repository"
)

func testConfig(t *testing.T) Config {
	t.Helper()
	analyzer, err := filepath.Abs("../analysis/analyze.py")
	if err != nil {
		t.Fatal(err)
	}
	return Config{Root: t.TempDir(), History: t.TempDir(), Analyzer: analyzer, Python: "python3", Timeout: 10 * time.Second}
}

func seed(t *testing.T, config Config) string {
	t.Helper()
	path, err := repository.Save(config.History, repository.Snapshot{
		SchemaVersion: 1, Root: config.Root, ScannedAt: time.Now().UTC(),
		Repositories: []repository.Repository{{Name: "app", Path: filepath.Join(config.Root, "app"), Branch: "main", ChangedFiles: 2}},
	})
	if err != nil {
		t.Fatal(err)
	}
	return path
}

func handler(t *testing.T, config Config) http.Handler {
	t.Helper()
	h, err := New(config)
	if err != nil {
		t.Fatal(err)
	}
	return h
}

func request(h http.Handler, method, path string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(method, path, nil))
	return w
}

func TestEndpointsWithRealPython(t *testing.T) {
	config := testConfig(t)
	seed(t, config)
	h := handler(t, config)
	for _, path := range []string{"/healthz", "/api/snapshot", "/api/analysis"} {
		w := request(h, "GET", path)
		if w.Code != 200 || !json.Valid(w.Body.Bytes()) || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("%s: %d %s", path, w.Code, w.Body)
		}
		if path == "/api/analysis" {
			var report struct {
				SnapshotCount int `json:"snapshot_count"`
				Repositories  []struct {
					Latest int `json:"latest_changed_files"`
				} `json:"repositories"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &report); err != nil || report.SnapshotCount != 1 || len(report.Repositories) != 1 || report.Repositories[0].Latest != 2 {
				t.Fatalf("Python analysis: %s (%v)", w.Body, err)
			}
		}
	}
	// Client parameters cannot redirect the configured workspace.
	w := request(h, "GET", "/api/snapshot?root=/another/workspace")
	if !strings.Contains(w.Body.String(), config.Root) {
		t.Fatal("request changed configured root")
	}
	if w := request(h, "POST", "/api/snapshot"); w.Code != 405 || w.Header().Get("Allow") != "GET, HEAD" {
		t.Fatalf("write method: %d", w.Code)
	}
	if w := request(h, "GET", "/unknown"); w.Code != 404 || !json.Valid(w.Body.Bytes()) {
		t.Fatalf("unknown route: %d %s", w.Code, w.Body)
	}
}

func TestMissingAndCorruptHistory(t *testing.T) {
	config := testConfig(t)
	h := handler(t, config)
	for _, path := range []string{"/api/snapshot", "/api/analysis"} {
		if w := request(h, "GET", path); w.Code != 404 || !strings.Contains(w.Body.String(), "no_snapshots") {
			t.Fatalf("missing history: %d %s", w.Code, w.Body)
		}
	}
	path := seed(t, config)
	if err := os.WriteFile(path, []byte("{"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, endpoint := range []string{"/api/snapshot", "/api/analysis"} {
		if w := request(h, "GET", endpoint); w.Code != 500 || !strings.Contains(w.Body.String(), "invalid_history") {
			t.Fatalf("corrupt history: %d %s", w.Code, w.Body)
		}
	}
	if w := request(h, "GET", "/healthz"); w.Code != 200 {
		t.Fatal("health depends on saved history")
	}
}

func TestAnalysisFailureAndTimeout(t *testing.T) {
	for _, tc := range []struct {
		name, script string
		status       int
		timeout      time.Duration
	}{
		{"process failure", "raise SystemExit(1)", 500, 5 * time.Second},
		{"invalid JSON", "print('not JSON')", 500, 5 * time.Second},
		{"unexpected report", "print('{}')", 500, 5 * time.Second},
		{"timeout", "import time; time.sleep(10)", 504, 100 * time.Millisecond},
	} {
		t.Run(tc.name, func(t *testing.T) {
			config := testConfig(t)
			seed(t, config)
			config.Timeout = tc.timeout
			config.Analyzer = filepath.Join(t.TempDir(), "fake.py")
			if err := os.WriteFile(config.Analyzer, []byte(tc.script), 0600); err != nil {
				t.Fatal(err)
			}
			w := request(handler(t, config), "GET", "/api/analysis")
			if w.Code != tc.status || !json.Valid(w.Body.Bytes()) {
				t.Fatalf("%d %s", w.Code, w.Body)
			}
		})
	}
}

func TestBusyAndCancellation(t *testing.T) {
	config := testConfig(t)
	seed(t, config)
	dir := t.TempDir()
	started := filepath.Join(dir, "started")
	config.Analyzer = filepath.Join(dir, "slow.py")
	script := "import pathlib, time\npathlib.Path(" + strconvQuote(started) + ").touch()\ntime.sleep(30)\n"
	if err := os.WriteFile(config.Analyzer, []byte(script), 0600); err != nil {
		t.Fatal(err)
	}
	h := handler(t, config)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() {
		defer close(done)
		h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/api/analysis", nil).WithContext(ctx))
	}()
	deadline := time.Now().Add(3 * time.Second)
	for {
		if _, err := os.Stat(started); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("Python did not start")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if w := request(h, "GET", "/api/analysis"); w.Code != 503 || w.Header().Get("Retry-After") != "1" {
		t.Fatalf("concurrent process not bounded: %d %s", w.Code, w.Body)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("Python did not stop after request cancellation")
	}
}

func strconvQuote(value string) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}

func TestConfigAndOutputLimits(t *testing.T) {
	config := testConfig(t)
	config.Timeout = 0
	if _, err := New(config); err == nil {
		t.Fatal("zero timeout accepted")
	}
	buffer := limitedBuffer{limit: 4}
	if _, err := buffer.Write([]byte("12345")); err == nil || buffer.Len() != 0 {
		t.Fatal("output limit ignored")
	}
	// exec copies stdout through io.Copy; that path must enforce the same cap.
	if _, err := io.Copy(&buffer, io.LimitReader(strings.NewReader("12345"), 5)); err == nil || buffer.Len() != 0 {
		t.Fatal("streaming output bypassed the limit")
	}
}
