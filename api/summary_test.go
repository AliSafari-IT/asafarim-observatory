package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func summaryRequest(h http.Handler, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest("POST", "/api/summary", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-Observatory-Request", "generate-summary")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestSummaryConfigurationAndReadOnlyGET(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "")
	h := handler(t, testConfig(t))
	w := request(h, "GET", "/api/summary")
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"configured":false`) || !strings.Contains(w.Body.String(), `"summary":null`) {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	if w := summaryRequest(h, "{}"); w.Code != 503 || !strings.Contains(w.Body.String(), "ai_not_configured") {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	if w := request(h, "POST", "/api/summary"); w.Code != 400 {
		t.Fatalf("unmarked POST accepted: %d", w.Code)
	}
	if w := request(h, "OPTIONS", "/api/summary"); w.Code != 405 {
		t.Fatalf("cross-origin preflight accepted: %d", w.Code)
	}
	for _, body := range []string{`null`, `{"model":"other"}`, `{} {}`, strings.Repeat("x", 2000)} {
		if w := summaryRequest(h, body); w.Code != 400 {
			t.Fatalf("invalid body accepted: %q %d", body, w.Code)
		}
	}
}

func TestSummaryGenerationCacheAndPreservation(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "dummy-for-local-fixture")
	config := testConfig(t)
	seed(t, config)
	config.Analyzer = filepath.Join(t.TempDir(), "fixture.py")
	valid := `{"schema_version":1,"provider":"openai","headline":"Fixture summary","snapshot_count":1,"findings":[]}`
	if err := os.WriteFile(config.Analyzer, []byte("print("+strconvQuote(valid)+")"), 0600); err != nil {
		t.Fatal(err)
	}
	h := handler(t, config)
	w := summaryRequest(h, "{}")
	if w.Code != 200 || !strings.Contains(w.Body.String(), "Fixture summary") {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	// Changing the script to fail proves GET does not execute it and POST failures preserve cache.
	if err := os.WriteFile(config.Analyzer, []byte("raise SystemExit(1)"), 0600); err != nil {
		t.Fatal(err)
	}
	if w := request(h, "GET", "/api/summary"); w.Code != 200 || !strings.Contains(w.Body.String(), "Fixture summary") {
		t.Fatalf("GET lost cache: %s", w.Body)
	}
	if w := summaryRequest(h, "{}"); w.Code != 502 {
		t.Fatalf("failed provider accepted: %d", w.Code)
	}
	if w := request(h, "GET", "/api/summary"); !json.Valid(w.Body.Bytes()) || !strings.Contains(w.Body.String(), "Fixture summary") {
		t.Fatal("failure cleared cache")
	}
}

func TestSummaryTimeout(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "dummy-for-local-fixture")
	config := testConfig(t)
	seed(t, config)
	config.SummaryTimeout = 100 * time.Millisecond
	config.Analyzer = filepath.Join(t.TempDir(), "slow.py")
	if err := os.WriteFile(config.Analyzer, []byte("import time; time.sleep(10)"), 0600); err != nil {
		t.Fatal(err)
	}
	w := summaryRequest(handler(t, config), "{}")
	if w.Code != 504 {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
}
