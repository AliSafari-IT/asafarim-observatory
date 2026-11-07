package api

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const storedFixture = `{"schema_version":1,"provider":"openai","headline":"Saved fixture","snapshot_count":1,"findings":[]}`

func TestSummarySurvivesRestartWithoutProvider(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "local-fixture")
	config := testConfig(t)
	seed(t, config)
	config.Analyzer = filepath.Join(t.TempDir(), "fixture.py")
	if err := os.WriteFile(config.Analyzer, []byte("print("+strconvQuote(storedFixture)+")"), 0600); err != nil {
		t.Fatal(err)
	}
	if w := summaryRequest(handler(t, config), "{}"); w.Code != 200 {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	info, err := os.Stat(summaryPath(config))
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("private storage: %v %v", info, err)
	}
	// A new handler restores storage even without credentials; it cannot call OpenAI.
	t.Setenv("OPENAI_API_KEY", "")
	w := request(handler(t, config), "GET", "/api/summary")
	if w.Code != 200 || !strings.Contains(w.Body.String(), "Saved fixture") || !strings.Contains(w.Body.String(), `"configured":false`) {
		t.Fatalf("restart: %d %s", w.Code, w.Body)
	}
}

func TestSummaryStorageIsolationAndCorruption(t *testing.T) {
	config := testConfig(t)
	if err := saveSummary(config, json.RawMessage(storedFixture)); err != nil {
		t.Fatal(err)
	}
	other := config
	other.Root = t.TempDir()
	if data, err := loadSummary(other); err != nil || data != nil {
		t.Fatalf("workspace isolation: %s %v", data, err)
	}
	// Copying a record to another root's location cannot bypass the root check.
	data, err := os.ReadFile(summaryPath(config))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(summaryPath(other), data, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadSummary(other); err == nil {
		t.Fatal("wrong root accepted")
	}
	if err := os.WriteFile(summaryPath(config), []byte("{"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := New(config); err == nil {
		t.Fatal("corrupt storage silently ignored")
	}
}

func TestSummaryWriteFailureDoesNotUpdateCache(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "local-fixture")
	config := testConfig(t)
	seed(t, config)
	config.Analyzer = filepath.Join(t.TempDir(), "fixture.py")
	if err := os.WriteFile(config.Analyzer, []byte("print("+strconvQuote(storedFixture)+")"), 0600); err != nil {
		t.Fatal(err)
	}
	h := handler(t, config)
	// A regular file blocks creation of the summary directory without relying on permissions.
	if err := os.WriteFile(filepath.Dir(summaryPath(config)), []byte("blocked"), 0600); err != nil {
		t.Fatal(err)
	}
	if w := summaryRequest(h, "{}"); w.Code != 500 || !strings.Contains(w.Body.String(), "summary_storage_failed") {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	if w := request(h, "GET", "/api/summary"); !strings.Contains(w.Body.String(), `"summary":null`) {
		t.Fatal("unsaved summary became visible")
	}
}
