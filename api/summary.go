package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"os"
	"strings"
	"sync"

	"github.com/AliSafari-IT/asafarim-observatory/repository"
)

// Reading the summary never calls a model. Generation is an explicit POST and
// the latest successful result is persisted before replacing the memory cache.
func newSummaryHandler(config Config, slot chan struct{}) (http.Handler, error) {
	var mu sync.RWMutex
	cached, err := loadSummary(config)
	if err != nil {
		return nil, err
	}
	state := func(w http.ResponseWriter) {
		mu.RLock()
		defer mu.RUnlock()
		writeJSON(w, struct {
			Configured bool            `json:"configured"`
			Summary    json.RawMessage `json:"summary"`
		}{strings.TrimSpace(os.Getenv("OPENAI_API_KEY")) != "", cached})
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet || r.Method == http.MethodHead {
			state(w)
			return
		}
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", "GET, HEAD, POST")
			writeError(w, 405, "method_not_allowed", "Use GET to read or POST to generate a summary.")
			return
		}
		// Browsers cannot send this custom header cross-origin without a preflight.
		// OPTIONS is deliberately unsupported; form submissions cannot trigger spend.
		mediaType, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if mediaType != "application/json" || r.Header.Get("X-Observatory-Request") != "generate-summary" {
			writeError(w, 400, "invalid_request", "Use the dashboard Generate summary action.")
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 1024)
		var body *struct{}
		decoder := json.NewDecoder(r.Body)
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&body); err != nil || body == nil {
			writeError(w, 400, "invalid_request", "Expected an empty JSON object.")
			return
		}
		if err := decoder.Decode(&body); err != io.EOF {
			writeError(w, 400, "invalid_request", "Unexpected request data.")
			return
		}
		if strings.TrimSpace(os.Getenv("OPENAI_API_KEY")) == "" {
			writeError(w, 503, "ai_not_configured", "Set OPENAI_API_KEY in the API server environment and restart it.")
			return
		}
		if _, err := repository.Latest(config.History, config.Root); err != nil {
			if errors.Is(err, os.ErrNotExist) {
				writeError(w, 404, "no_snapshots", "Save a snapshot before generating a summary.")
			} else {
				writeError(w, 500, "invalid_history", "Cannot read saved snapshot history.")
			}
			return
		}
		select {
		case slot <- struct{}{}:
			defer func() { <-slot }()
		default:
			writeError(w, 503, "analysis_busy", "Analysis is busy. Try generating again shortly.")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), config.SummaryTimeout)
		defer cancel()
		result, err := runPython(ctx, config, "--ai-summary")
		if err != nil {
			if ctx.Err() != nil {
				writeError(w, 504, "summary_timeout", "Summary generation timed out. Its outcome at the provider is unknown.")
			} else {
				writeError(w, 502, "summary_failed", "OpenAI summary failed. Check the server credentials, model access and quota; the previous summary is preserved.")
			}
			return
		}
		if !validSummary(result) {
			writeError(w, 502, "invalid_summary", "The analyzer returned an invalid summary. The previous summary is preserved.")
			return
		}
		if err := saveSummary(config, result); err != nil {
			writeError(w, 500, "summary_storage_failed", "Cannot save the generated summary. Previous summary preserved; provider usage may have been charged.")
			return
		}
		mu.Lock()
		cached = append(json.RawMessage(nil), result...)
		mu.Unlock()
		state(w)
	}), nil
}
