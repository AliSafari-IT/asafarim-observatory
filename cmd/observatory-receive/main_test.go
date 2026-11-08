package main

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/AliSafari-IT/asafarim-observatory/repository"
)

func TestReceiverInputAndAcknowledgement(t *testing.T) {
	root, history := t.TempDir(), t.TempDir()
	snapshot := repository.Snapshot{SchemaVersion: 1, Root: root, ScannedAt: time.Now().UTC(), Repositories: []repository.Repository{}}
	data, _ := json.Marshal(snapshot)
	for i := 0; i < 2; i++ {
		var out, errOut bytes.Buffer
		code := run([]string{"-root", root, "-history", history}, bytes.NewReader(data), &out, &errOut)
		var ack struct {
			Status    string `json:"status"`
			Duplicate bool   `json:"duplicate"`
		}
		if code != 0 || json.Unmarshal(out.Bytes(), &ack) != nil || ack.Status != "saved" || ack.Duplicate != (i == 1) {
			t.Fatalf("%d %s %s", code, &out, &errOut)
		}
	}
	var out, errOut bytes.Buffer
	if code := run([]string{"-root", root, "-history", history}, strings.NewReader("bad"), &out, &errOut); code != 1 {
		t.Fatal("invalid input accepted")
	}
}
