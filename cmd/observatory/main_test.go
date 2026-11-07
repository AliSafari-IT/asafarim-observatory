package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/AliSafari-IT/asafarim-observatory/repository"
)

func TestJSONOutput(t *testing.T) {
	var out, errOut bytes.Buffer
	code := run(context.Background(), []string{"-root", t.TempDir(), "-format", "json"}, &out, &errOut)
	var result struct {
		SchemaVersion int   `json:"schema_version"`
		Repositories  []any `json:"repositories"`
	}
	if code != 0 || json.Unmarshal(out.Bytes(), &result) != nil || result.SchemaVersion != 1 || result.Repositories == nil {
		t.Fatalf("code=%d output=%s stderr=%s", code, &out, &errOut)
	}
}

func TestSaveCompareLifecycle(t *testing.T) {
	root, history := t.TempDir(), t.TempDir()
	invoke := func(extra ...string) (int, string, string) {
		t.Helper()
		var out, errOut bytes.Buffer
		args := append([]string{"-root", root, "-history", history, "-format", "json"}, extra...)
		code := run(context.Background(), args, &out, &errOut)
		return code, out.String(), errOut.String()
	}
	code, output, stderr := invoke("-save", "-compare")
	if code != 0 || !strings.Contains(stderr, "No previous snapshot") || !strings.Contains(stderr, "Saved snapshot:") {
		t.Fatalf("first baseline: %d %s %s", code, output, stderr)
	}
	var first struct {
		Comparison *repository.Comparison `json:"comparison"`
	}
	if err := json.Unmarshal([]byte(output), &first); err != nil || first.Comparison != nil {
		t.Fatalf("baseline JSON: %s %v", output, err)
	}
	// Seed a previous observation and confirm comparison precedes saving.
	previous := repository.Snapshot{SchemaVersion: 1, Root: root, ScannedAt: time.Now().UTC(), Repositories: []repository.Repository{
		{Name: "removed", Path: filepath.Join(root, "removed"), Branch: "main"},
	}}
	if _, err := repository.Save(history, previous); err != nil {
		t.Fatal(err)
	}
	code, output, stderr = invoke("-compare", "-save")
	var result struct {
		Comparison repository.Comparison `json:"comparison"`
	}
	if err := json.Unmarshal([]byte(output), &result); err != nil || code != 0 || len(result.Comparison.Changes) != 1 || result.Comparison.Changes[0].Kind != "removed" {
		t.Fatalf("compare before save: %d %s %s (%v)", code, output, stderr, err)
	}
	code, output, stderr = invoke("-compare")
	if err := json.Unmarshal([]byte(output), &result); err != nil || code != 0 || len(result.Comparison.Changes) != 0 {
		t.Fatalf("latest baseline: %d %s %s (%v)", code, output, stderr, err)
	}
}

func TestInvalidHistoryDoesNotAdvanceBaseline(t *testing.T) {
	root, history := t.TempDir(), t.TempDir()
	snapshot := repository.Snapshot{SchemaVersion: 1, Root: root, ScannedAt: time.Now().UTC(), Repositories: []repository.Repository{}}
	path, err := repository.Save(history, snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("not JSON"), 0600); err != nil {
		t.Fatal(err)
	}
	var out, errOut bytes.Buffer
	code := run(context.Background(), []string{"-root", root, "-history", history, "-save", "-compare"}, &out, &errOut)
	entries, err := os.ReadDir(filepath.Dir(path))
	if err != nil || code != 1 || len(entries) != 1 || out.Len() != 0 || !strings.Contains(errOut.String(), "load history") {
		t.Fatalf("invalid history advanced: code=%d entries=%v out=%s stderr=%s err=%v", code, entries, &out, &errOut, err)
	}
}

func TestFailedSaveReturnsError(t *testing.T) {
	root := t.TempDir()
	history := filepath.Join(t.TempDir(), "not-a-directory")
	if err := os.WriteFile(history, []byte("existing file"), 0600); err != nil {
		t.Fatal(err)
	}
	var out, errOut bytes.Buffer
	code := run(context.Background(), []string{"-root", root, "-history", history, "-save"}, &out, &errOut)
	if code != 1 || !strings.Contains(errOut.String(), "save snapshot") {
		t.Fatalf("failed save: %d %s", code, &errOut)
	}
}

func TestExitCodes(t *testing.T) {
	root := t.TempDir()
	broken := filepath.Join(root, "broken")
	if err := os.MkdirAll(filepath.Join(broken, ".git"), 0700); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		args []string
		code int
	}{
		{[]string{"-help"}, 0},
		{[]string{"-version"}, 0},
		{[]string{"-format", "xml"}, 2},
		{[]string{"-timeout", "0"}, 2},
		{[]string{"unexpected"}, 2},
		{[]string{"-root", filepath.Join(root, "missing")}, 1},
		{[]string{"-root", root}, 1},
	} {
		var out, errOut bytes.Buffer
		if code := run(context.Background(), tc.args, &out, &errOut); code != tc.code {
			t.Errorf("%v: code=%d expected=%d stderr=%s", tc.args, code, tc.code, &errOut)
		}
		if len(tc.args) == 2 && tc.args[0] == "-root" && tc.args[1] == root && !strings.Contains(out.String(), "?") {
			t.Error("failed scan displayed a known change count")
		}
	}
}
