package repository

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func historyFixture(root string) Snapshot {
	return Snapshot{SchemaVersion: 1, ScannedAt: time.Date(2026, 11, 7, 20, 0, 0, 0, time.UTC), Root: root, Repositories: []Repository{}}
}

func TestHistoryRoundTripAndIsolation(t *testing.T) {
	dir := t.TempDir()
	first := historyFixture(t.TempDir())
	if _, err := Latest(dir, first.Root); !os.IsNotExist(err) {
		t.Fatalf("expected missing baseline: %v", err)
	}
	second := first
	second.ScannedAt = first.ScannedAt.Add(time.Second)
	second.Repositories = []Repository{{Name: "app", Path: filepath.Join(first.Root, "app"), Branch: "main", ChangedFiles: 2}}
	// Save out of time order: latest means scan time, not write order.
	path, err := Save(dir, second)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Save(dir, first); err != nil {
		t.Fatal(err)
	}
	loaded, err := Latest(dir, first.Root)
	if err != nil || !reflect.DeepEqual(loaded, second) {
		t.Fatalf("round trip: %+v, %v", loaded, err)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("snapshot permissions: %v, %v", info, err)
	}
	other := historyFixture(t.TempDir())
	if _, err := Save(dir, other); err != nil {
		t.Fatal(err)
	}
	loaded, err = Latest(dir, first.Root)
	if err != nil || loaded.Root != first.Root {
		t.Fatalf("history mixed workspace roots: %+v, %v", loaded, err)
	}
	// Temporary files never become a visible baseline.
	if err := os.WriteFile(filepath.Join(filepath.Dir(path), ".snapshot-incomplete.tmp"), []byte("{"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := Latest(dir, first.Root); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("{"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := Latest(dir, first.Root); err == nil {
		t.Fatal("corrupt newest snapshot was silently ignored")
	}
}

func TestCompareChangesAndFailures(t *testing.T) {
	before := historyFixture(t.TempDir())
	repo := func(name, branch string, count int, failure string) Repository {
		return Repository{Name: name, Path: filepath.Join(before.Root, name), Branch: branch, ChangedFiles: count, Error: failure}
	}
	before.Repositories = []Repository{
		repo("branch", "main", 0, ""), repo("count", "main", 1, ""), repo("removed", "main", 0, ""),
		repo("failed", "main", 5, ""), repo("recovered", "", 0, "git failed"), repo("same", "main", 1, ""),
	}
	after := before
	after.ScannedAt = before.ScannedAt.Add(time.Minute)
	after.Repositories = []Repository{
		repo("branch", "feature", 0, ""), repo("count", "main", 0, ""), repo("added", "main", 0, ""),
		repo("failed", "", 0, "git failed"), repo("recovered", "main", 0, ""), repo("same", "main", 1, ""),
	}
	comparison, err := Compare(before, after)
	if err != nil {
		t.Fatal(err)
	}
	got := []string{}
	for _, change := range comparison.Changes {
		got = append(got, change.Name+":"+change.Kind)
	}
	want := []string{"added:added", "branch:updated", "count:updated", "failed:unavailable", "recovered:recovered", "removed:removed"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("changes: %v, want %v", got, want)
	}
	if comparison.Changes[3].Before.ChangedFiles != 5 || comparison.Changes[3].After.Error == "" {
		t.Fatal("failed observation lost its evidence")
	}
	if _, err := Compare(before, historyFixture(t.TempDir())); err == nil {
		t.Fatal("different workspaces accepted")
	}
	unchanged, err := Compare(before, before)
	if err != nil || len(unchanged.Changes) != 1 || unchanged.Changes[0].Kind != "unavailable" {
		t.Fatalf("repeated failure hidden: %+v %v", unchanged, err)
	}
}

func TestRejectInvalidSnapshots(t *testing.T) {
	valid := historyFixture(t.TempDir())
	for _, payload := range []string{
		`{}`, `{"schema_version":2}`, `null`,
	} {
		dir := t.TempDir()
		path, err := Save(dir, valid)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(payload), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := Latest(dir, valid.Root); err == nil {
			t.Fatalf("invalid snapshot accepted: %s", payload)
		}
	}
	invalid := valid
	invalid.SchemaVersion = 2
	if _, err := Save(t.TempDir(), invalid); err == nil || !strings.Contains(err.Error(), "snapshot") {
		t.Fatalf("unsupported schema saved: %v", err)
	}
}
