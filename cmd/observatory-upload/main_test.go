package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/AliSafari-IT/asafarim-observatory/repository"
)

func TestSSHArgumentsAndShellQuoting(t *testing.T) {
	for _, host := range []string{"-oProxyCommand=bad", "vps;bad", "user@host", "vps\nnext"} {
		if _, err := uploadArgs(host, "/bin/receive", "/root", "/data"); err == nil {
			t.Errorf("host accepted: %q", host)
		}
	}
	for _, value := range []string{"/path with spaces", "/path'quoted", "/path/$(echo injected);`date`"} {
		output, err := exec.Command("sh", "-c", "printf '%s' "+quote(value)).Output()
		if err != nil || string(output) != value {
			t.Fatalf("shell quote: %q %q %v", value, output, err)
		}
	}
	args, err := uploadArgs("vps", "/bin/receive", "/sender/root", "/private/history")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.Join(args, " "), "StrictHostKeyChecking=yes") {
		t.Fatal("host key verification disabled")
	}
}

func TestUploadStreamsOnlySnapshotToSSH(t *testing.T) {
	root, history, bin := t.TempDir(), t.TempDir(), t.TempDir()
	snapshot := repository.Snapshot{SchemaVersion: 1, Root: root, ScannedAt: time.Now().UTC(), Repositories: []repository.Repository{}}
	if _, err := repository.Save(history, snapshot); err != nil {
		t.Fatal(err)
	}
	capture := filepath.Join(t.TempDir(), "capture.json")
	script := "#!/bin/sh\ncat > \"$OBSERVATORY_TEST_CAPTURE\"\nprintf '%s' '{\"status\":\"saved\",\"duplicate\":false}'\n"
	if err := os.WriteFile(filepath.Join(bin, "ssh"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("OBSERVATORY_TEST_CAPTURE", capture)
	args := []string{"-root", root, "-history", history, "-host", "vps", "-receiver", "/bin/receive", "-remote-history", "/data/history"}
	var out, errOut bytes.Buffer
	if code := run(context.Background(), args, &out, &errOut); code != 0 {
		t.Fatalf("%d %s", code, &errOut)
	}
	data, err := os.ReadFile(capture)
	if err != nil {
		t.Fatal(err)
	}
	var received repository.Snapshot
	if json.Unmarshal(data, &received) != nil || received.Root != root {
		t.Fatal("wrong transfer payload")
	}
	if err := os.WriteFile(filepath.Join(bin, "ssh"), []byte("#!/bin/sh\nexit 0\n"), 0700); err != nil {
		t.Fatal(err)
	}
	if code := run(context.Background(), args, &out, &errOut); code != 1 {
		t.Fatal("missing acknowledgement accepted")
	}
	if err := os.WriteFile(filepath.Join(bin, "ssh"), []byte("#!/bin/sh\nexit 1\n"), 0700); err != nil {
		t.Fatal(err)
	}
	if code := run(context.Background(), args, &out, &errOut); code != 1 {
		t.Fatalf("failed transport returned %d", code)
	}
}
