package api

import (
	"errors"
	"io/fs"
	"net/http"
	"os"
	"strings"
)

// WithDashboard serves a built dashboard from the same origin as the API.
// os.Root confines asset access even when a symlink points outside the build.
// Missing files and directories never produce directory listings or SPA fallbacks.
func WithDashboard(api http.Handler, directory string) (http.Handler, func() error, error) {
	root, err := os.OpenRoot(directory)
	if err != nil {
		return nil, nil, err
	}
	public := root.FS()
	info, err := fs.Stat(public, "index.html")
	if err != nil || !info.Mode().IsRegular() {
		root.Close()
		return nil, nil, errors.New("dashboard directory must contain index.html")
	}
	files := http.FileServerFS(public)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/healthz" || strings.HasPrefix(r.URL.Path, "/api/") {
			api.ServeHTTP(w, r)
			return
		}
		if r.Method != "GET" && r.Method != "HEAD" {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "Method not allowed", 405)
			return
		}
		path := strings.TrimPrefix(r.URL.Path, "/")
		if path == "" {
			path = "index.html"
		}
		if !fs.ValidPath(path) {
			http.NotFound(w, r)
			return
		}
		info, err := fs.Stat(public, path)
		if err != nil || !info.Mode().IsRegular() {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cache-Control", "no-cache")
		files.ServeHTTP(w, r)
	}), root.Close, nil
}
