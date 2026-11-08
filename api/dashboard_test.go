package api

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDashboardAndAPISameOrigin(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte("<h1>Dashboard fixture</h1>"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "assets"), 0700); err != nil {
		t.Fatal(err)
	}
	secret := filepath.Join(t.TempDir(), "secret.txt")
	if err := os.WriteFile(secret, []byte("outside-root"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(secret, filepath.Join(dir, "escape.txt")); err != nil {
		t.Fatal(err)
	}
	backend := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("api fixture")) })
	h, close, err := WithDashboard(backend, dir)
	if err != nil {
		t.Fatal(err)
	}
	defer close()
	for _, path := range []string{"/", "/healthz", "/api/snapshot"} {
		w := request(h, "GET", path)
		if w.Code != 200 {
			t.Errorf("%s: %d", path, w.Code)
		}
	}
	for _, path := range []string{"/assets/", "/missing", "/escape.txt", "/.env.prod"} {
		w := request(h, "GET", path)
		if w.Code != 404 || strings.Contains(w.Body.String(), "outside-root") {
			t.Errorf("%s: %d %s", path, w.Code, w.Body)
		}
	}
	if w := request(h, "POST", "/"); w.Code != 405 {
		t.Fatal("static POST accepted")
	}
	if _, _, err := WithDashboard(backend, t.TempDir()); err == nil {
		t.Fatal("missing dashboard accepted")
	}
}
