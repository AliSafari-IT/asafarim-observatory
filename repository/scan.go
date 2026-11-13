// Package repository collects read-only Git metadata for local workspaces.
package repository

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// Snapshot is one scan of a directory's immediate repository children.
type Snapshot struct {
	SchemaVersion int          `json:"schema_version"`
	ScannedAt     time.Time    `json:"scanned_at"`
	Root          string       `json:"root"`
	Repositories  []Repository `json:"repositories"`
}

// Repository describes a checkout, including empty and detached checkouts.
// ChangedFiles counts each tracked change or untracked file once. A staged
// rename counts as one change. Ignored files are excluded.
// An Error means the other fields must not be treated as a complete result.
type Repository struct {
	Name          string `json:"name"`
	Path          string `json:"path"`
	Branch        string `json:"branch"`
	Detached      bool   `json:"detached"`
	ChangedFiles  int    `json:"changed_files"`
	Error         string `json:"error,omitempty"`
	WorktreeGroup string `json:"worktree_group,omitempty"`
}

// Scan inspects only direct children with a .git directory or worktree file.
// Each repository has its own timeout; a failed checkout remains in the result
// so callers can distinguish an incomplete scan from a clean workspace.
func Scan(ctx context.Context, root string, timeout time.Duration) (Snapshot, error) {
	if timeout <= 0 {
		return Snapshot{}, errors.New("repository timeout must be positive")
	}
	absolute, err := filepath.Abs(root)
	if err != nil {
		return Snapshot{}, err
	}
	entries, err := os.ReadDir(absolute)
	if err != nil {
		return Snapshot{}, fmt.Errorf("read workspace: %w", err)
	}
	if _, err := exec.LookPath("git"); err != nil {
		return Snapshot{}, errors.New("git is required on PATH")
	}
	snapshot := Snapshot{SchemaVersion: 1, ScannedAt: time.Now().UTC(), Root: absolute, Repositories: []Repository{}}
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return Snapshot{}, err
		}
		if !entry.IsDir() {
			continue
		}
		path := filepath.Join(absolute, entry.Name())
		if _, err := os.Lstat(filepath.Join(path, ".git")); errors.Is(err, os.ErrNotExist) {
			continue
		} else if err != nil {
			snapshot.Repositories = append(snapshot.Repositories, Repository{Name: entry.Name(), Path: path, Error: "cannot inspect .git marker"})
			continue
		}
		repoCtx, cancel := context.WithTimeout(ctx, timeout)
		repo := inspect(repoCtx, path, entry.Name())
		cancel()
		snapshot.Repositories = append(snapshot.Repositories, repo)
	}
	return snapshot, ctx.Err()
}

func inspect(ctx context.Context, path, name string) Repository {
	repo := Repository{Name: name, Path: path}
	branch, err := git(ctx, path, "symbolic-ref", "--quiet", "--short", "HEAD")
	if err != nil {
		var exitErr *exec.ExitError
		if !errors.As(err, &exitErr) || exitErr.ExitCode() != 1 {
			repo.Error = commandError(ctx, "read branch")
			return repo
		}
		repo.Detached = true
		repo.Branch = "(detached)"
	} else {
		repo.Branch = strings.TrimSpace(string(branch))
	}
	// The common Git directory identifies linked worktrees without transmitting its path.
	if common, err := git(ctx, path, "rev-parse", "--git-common-dir"); err == nil {
		commonPath := strings.TrimSpace(string(common))
		if !filepath.IsAbs(commonPath) {
			commonPath = filepath.Join(path, commonPath)
		}
		if resolved, err := filepath.EvalSymlinks(commonPath); err == nil {
			repo.WorktreeGroup = fmt.Sprintf("%x", sha256.Sum256([]byte(resolved)))
		}
	}
	status, err := git(ctx, path, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none")
	if err != nil {
		repo.Error = commandError(ctx, "read status")
		return repo
	}
	repo.ChangedFiles, err = countChanges(status)
	if err != nil {
		repo.Error = err.Error()
	}
	return repo
}

func commandError(ctx context.Context, operation string) string {
	if err := ctx.Err(); err != nil {
		return operation + ": " + err.Error()
	}
	return operation + ": git failed"
}

func git(ctx context.Context, path string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", path}, args...)...)
	// Parent Git invocations must not redirect the scan to another worktree.
	for _, value := range os.Environ() {
		if !strings.HasPrefix(value, "GIT_") {
			cmd.Env = append(cmd.Env, value)
		}
	}
	cmd.Env = append(cmd.Env, "GIT_OPTIONAL_LOCKS=0", "GIT_TERMINAL_PROMPT=0")
	return cmd.Output()
}

func countChanges(status []byte) (int, error) {
	count := 0
	for len(status) > 0 {
		end := bytes.IndexByte(status, 0)
		if end < 3 {
			return 0, errors.New("invalid git status record")
		}
		record := status[:end]
		status = status[end+1:]
		count++
		// With -z, rename/copy records include a second NUL-delimited path.
		if record[0] == 'R' || record[0] == 'C' || record[1] == 'R' || record[1] == 'C' {
			end = bytes.IndexByte(status, 0)
			if end < 0 {
				return 0, errors.New("invalid git rename record")
			}
			status = status[end+1:]
		}
	}
	return count, nil
}
