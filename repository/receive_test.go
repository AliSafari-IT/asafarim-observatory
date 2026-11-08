package repository

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestReceiveRoundTripAndConcurrentRetries(t *testing.T) {
	root := filepath.Join(t.TempDir(), "sender-root-not-present-on-server")
	history := t.TempDir()
	snapshot := Snapshot{1, time.Now().UTC(), root, []Repository{{Name: "app", Path: filepath.Join(root, "app"), Branch: "main", ChangedFiles: 2}}}
	data, _ := json.Marshal(snapshot)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := Receive(bytes.NewReader(data), root, history); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	entries, err := os.ReadDir(workspaceHistory(history, root))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("retries inflated history: %d files", len(entries))
	}
	info, err := os.Stat(filepath.Join(workspaceHistory(history, root), entries[0].Name()))
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("import permissions are not private")
	}
	saved, err := Latest(history, root)
	if err != nil || saved.Repositories[0].ChangedFiles != 2 {
		t.Fatalf("imported snapshot: %+v %v", saved, err)
	}
	duplicate, err := Receive(bytes.NewReader(data), root, history)
	if err != nil || !duplicate {
		t.Fatalf("retry not recognized: %v %v", duplicate, err)
	}
}

func TestRejectSnapshotBeforeWriting(t *testing.T) {
	root := t.TempDir()
	valid := Snapshot{1, time.Now().UTC(), root, []Repository{}}
	data, _ := json.Marshal(valid)
	cases := []string{`null`, `{}`, string(data) + `{}`, strings.Repeat("x", MaxSnapshotBytes+1), strings.Replace(string(data), `"schema_version":1`, `"schema_version":2`, 1), strings.Replace(string(data), `"schema_version":1`, `"unknown":true,"schema_version":1`, 1)}
	future := valid
	future.ScannedAt = time.Now().Add(time.Hour)
	futureData, _ := json.Marshal(future)
	cases = append(cases, string(futureData))
	invalid := valid
	invalid.Repositories = []Repository{{Name: "../escape", Path: filepath.Join(root, "../escape"), Branch: "main"}}
	invalidData, _ := json.Marshal(invalid)
	cases = append(cases, string(invalidData))
	for i, payload := range cases {
		history := t.TempDir()
		if _, err := Receive(strings.NewReader(payload), root, history); err == nil {
			t.Errorf("case %d accepted", i)
		}
		entries, _ := os.ReadDir(history)
		if len(entries) != 0 {
			t.Errorf("case %d wrote rejected data", i)
		}
	}
	if _, err := Receive(bytes.NewReader(data), t.TempDir(), t.TempDir()); err == nil {
		t.Fatal("foreign root accepted")
	}
}
