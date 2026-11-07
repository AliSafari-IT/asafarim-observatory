package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
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
