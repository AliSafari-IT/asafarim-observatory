package repository

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func testGit(t *testing.T, path string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", path}, args...)...)
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=Test", "GIT_AUTHOR_EMAIL=test@example.invalid", "GIT_COMMITTER_NAME=Test", "GIT_COMMITTER_EMAIL=test@example.invalid", "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL="+os.DevNull)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v: %s", args, err, output)
	}
}

func writeFile(t *testing.T, path, value string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(value), 0600); err != nil {
		t.Fatal(err)
	}
}

func newRepo(t *testing.T, root, name string) string {
	t.Helper()
	path := filepath.Join(root, name)
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	testGit(t, path, "init", "-b", "main")
	return path
}

func TestScanRealCheckouts(t *testing.T) {
	root := t.TempDir()
	newRepo(t, root, "empty")
	active := newRepo(t, root, "active")
	writeFile(t, filepath.Join(active, "tracked"), "original")
	writeFile(t, filepath.Join(active, ".gitignore"), "ignored\n")
	testGit(t, active, "add", ".")
	testGit(t, active, "commit", "-m", "fixture")
	testGit(t, active, "mv", "tracked", "renamed")
	writeFile(t, filepath.Join(active, "renamed"), "staged rename plus unstaged edit")
	writeFile(t, filepath.Join(active, "new\nfile"), "untracked")
	writeFile(t, filepath.Join(active, "ignored"), "excluded")
	worktree := filepath.Join(root, "linked")
	testGit(t, active, "worktree", "add", "--detach", worktree)
	if err := os.Mkdir(filepath.Join(root, "ordinary-folder"), 0700); err != nil {
		t.Fatal(err)
	}
	broken := filepath.Join(root, "broken")
	if err := os.Mkdir(broken, 0700); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(broken, ".git"), "gitdir: missing\n")

	// A caller's Git environment must not redirect collection.
	t.Setenv("GIT_DIR", filepath.Join(root, "nonexistent"))
	snapshot, err := Scan(context.Background(), root, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Repositories) != 4 {
		t.Fatalf("expected four repositories, got %+v", snapshot.Repositories)
	}
	groups := map[string]string{}
	for _, repo := range snapshot.Repositories {
		groups[repo.Name] = repo.WorktreeGroup
		switch repo.Name {
		case "active":
			if repo.Branch != "main" || repo.ChangedFiles != 2 || repo.Error != "" {
				t.Errorf("rename and newline filename: %+v", repo)
			}
		case "empty":
			if repo.Branch != "main" || repo.ChangedFiles != 0 || repo.Error != "" {
				t.Errorf("empty repository: %+v", repo)
			}
		case "linked":
			if !repo.Detached || repo.ChangedFiles != 0 || repo.Error != "" {
				t.Errorf("detached worktree: %+v", repo)
			}
		case "broken":
			if repo.Error == "" {
				t.Errorf("broken .git marker reported as clean: %+v", repo)
			}
		}
	}
	if groups["active"] == "" || groups["active"] != groups["linked"] || groups["active"] == groups["empty"] || groups["broken"] != "" {
		t.Fatalf("incorrect linked-worktree identities: %+v", groups)
	}
}

func TestScanEmptyAndInvalidRoots(t *testing.T) {
	root := t.TempDir()
	snapshot, err := Scan(context.Background(), root, time.Second)
	if err != nil || snapshot.Repositories == nil || len(snapshot.Repositories) != 0 {
		t.Fatalf("empty workspace: %+v, %v", snapshot, err)
	}
	if _, err := Scan(context.Background(), filepath.Join(root, "missing"), time.Second); err == nil {
		t.Fatal("missing root accepted")
	}
	if _, err := Scan(context.Background(), root, 0); err == nil {
		t.Fatal("zero timeout accepted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := Scan(ctx, root, time.Second); err == nil {
		t.Fatal("cancellation ignored")
	}
}
