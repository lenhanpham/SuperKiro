package proxy

import (
	"bytes"
	"encoding/json"
	"fmt"
	"superkiro/config"
	"superkiro/logger"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"time"
)

// comboRotationEntry tracks round-robin state for a single combo.
type comboRotationEntry struct {
	mu          sync.Mutex
	currentIdx  int
	stickyCount int
}

var comboRotationMap sync.Map // key: comboName -> *comboRotationEntry

// resolveComboModels returns (comboName, models, true) if modelStr is a known combo name.
// Returns ("", nil, false) if modelStr contains "/" (provider/model) or is not found.
func resolveComboModels(modelStr string) (string, []string, bool) {
	if strings.Contains(modelStr, "/") {
		return "", nil, false
	}
	entry := config.GetComboByName(modelStr)
	if entry == nil || len(entry.Models) < 2 {
		return "", nil, false
	}
	return entry.Name, entry.Models, true
}

// getRotatedModels returns the model list in execution order.
// For "fallback" strategy the order is unchanged.
// For "round-robin" strategy the list is rotated so a different model starts each turn.
func getRotatedModels(models []string, comboName, strategy string, stickyLimit int) []string {
	if strategy != "round-robin" || len(models) == 0 {
		return models
	}
	raw, _ := comboRotationMap.LoadOrStore(comboName, &comboRotationEntry{})
	entry := raw.(*comboRotationEntry)
	entry.mu.Lock()
	idx := entry.currentIdx
	entry.stickyCount++
	if entry.stickyCount >= stickyLimit {
		entry.stickyCount = 0
		entry.currentIdx = (entry.currentIdx + 1) % len(models)
	}
	entry.mu.Unlock()

	rotated := make([]string, len(models))
	for i := range models {
		rotated[i] = models[(idx+i)%len(models)]
	}
	return rotated
}

// isComboFallbackEligible reports whether an error should trigger fallback to the next model.
// Mirrors 9router's checkFallbackError logic.
func isComboFallbackEligible(status int, errMsg string) bool {
	lower := strings.ToLower(errMsg)
	switch {
	case status == 401 || status == 403:
		return false
	case strings.Contains(lower, "unauthorized") ||
		strings.Contains(lower, "forbidden") ||
		strings.Contains(lower, "authentication failed") ||
		strings.Contains(lower, "token invalid"):
		return false
	case status == 429 || strings.Contains(lower, "quota") || strings.Contains(lower, "rate limit"):
		return true
	case status == 402 || strings.Contains(lower, "overage"):
		return true
	case status == 502 || status == 503 || status == 504:
		return true
	default:
		return true
	}
}

// bufferingResponseWriter captures the response before committing it to the real writer.
type bufferingResponseWriter struct {
	recorder *httptest.ResponseRecorder
}

func newBufferingResponseWriter() *bufferingResponseWriter {
	return &bufferingResponseWriter{recorder: httptest.NewRecorder()}
}

func (b *bufferingResponseWriter) Header() http.Header {
	return b.recorder.Header()
}

func (b *bufferingResponseWriter) Write(p []byte) (int, error) {
	return b.recorder.Write(p)
}

func (b *bufferingResponseWriter) WriteHeader(code int) {
	b.recorder.WriteHeader(code)
}

func (b *bufferingResponseWriter) Flush() {
	// no-op: buffered — we flush to real writer only on success
}

func (b *bufferingResponseWriter) status() int {
	return b.recorder.Code
}

// flushTo copies the buffered response to the real ResponseWriter.
func (b *bufferingResponseWriter) flushTo(w http.ResponseWriter) {
	for k, vs := range b.recorder.Header() {
		for _, v := range vs {
			w.Header().Set(k, v)
		}
	}
	w.WriteHeader(b.recorder.Code)
	w.Write(b.recorder.Body.Bytes()) //nolint:errcheck
}

// handleComboRequest is the combo execution engine.
// It tries each model in the combo chain until one succeeds or all fail.
//
// format must be "claude" or "openai".
// originalBody is the raw JSON request body (used to rebuild per-model requests).
func (h *Handler) handleComboRequest(
	w http.ResponseWriter,
	r *http.Request,
	comboName string,
	models []string,
	originalBody []byte,
	format string,
) {
	strategy := config.GetComboStrategy()
	// Per-combo strategy override.
	if entry := config.GetComboByName(comboName); entry != nil && entry.Strategy != "" {
		strategy = entry.Strategy
	}
	stickyLimit := config.GetComboStickyRoundRobinLimit()
	rotated := getRotatedModels(models, comboName, strategy, stickyLimit)

	var lastStatus int
	var lastErrMsg string

	logger.Infof("[COMBO] %s starting — strategy=%s models=%d", comboName, strategy, len(rotated))

	for i, modelStr := range rotated {
		logger.Infof("[COMBO] %s attempt %d/%d model=%s", comboName, i+1, len(rotated), modelStr)

		// Patch the model name in the request body for this attempt.
		patchedBody, err := patchModelInBody(originalBody, modelStr, format)
		if err != nil {
			logger.Warnf("[COMBO] %s model=%s body patch failed: %v", comboName, modelStr, err)
			lastErrMsg = err.Error()
			lastStatus = 500
			continue
		}

		// Build a fresh *http.Request with the patched body.
		newReq, err := rebuildRequest(r, patchedBody)
		if err != nil {
			logger.Warnf("[COMBO] %s model=%s rebuild request failed: %v", comboName, modelStr, err)
			lastErrMsg = err.Error()
			lastStatus = 500
			continue
		}

		buf := newBufferingResponseWriter()

		switch format {
		case "claude":
			h.handleClaudeMessages(buf, newReq)
		case "openai":
			h.handleOpenAIChat(buf, newReq)
		}

		status := buf.status()
		if status == 0 {
			status = 500
		}

		if status >= 200 && status < 300 {
			logger.Infof("[COMBO] %s model=%s succeeded status=%d", comboName, modelStr, status)
			buf.flushTo(w)
			return
		}

		// Extract error message from buffered body.
		errMsg := extractErrorMessage(buf.recorder.Body.Bytes())
		if errMsg == "" {
			errMsg = fmt.Sprintf("HTTP %d", status)
		}

		logger.Warnf("[COMBO] %s model=%s failed status=%d error=%s", comboName, modelStr, status, truncateStr(errMsg, 200))

		if lastStatus == 0 {
			lastStatus = status
		}
		lastErrMsg = errMsg

		if !isComboFallbackEligible(status, errMsg) {
			logger.Warnf("[COMBO] %s model=%s error not fallback-eligible, aborting chain", comboName, modelStr)
			buf.flushTo(w)
			return
		}

		// Brief wait for transient upstream errors before trying the next model.
		if (status == 502 || status == 503 || status == 504) && i < len(rotated)-1 {
			time.Sleep(300 * time.Millisecond)
		}
	}

	// All models exhausted.
	if lastStatus == 0 {
		lastStatus = 503
	}
	logger.Warnf("[COMBO] %s all models failed — lastStatus=%d lastError=%s", comboName, lastStatus, truncateStr(lastErrMsg, 200))

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(lastStatus)
	errResp := map[string]interface{}{
		"error": map[string]string{
			"type":    "combo_exhausted",
			"message": "All combo models failed: " + lastErrMsg,
		},
	}
	json.NewEncoder(w).Encode(errResp) //nolint:errcheck
}

// patchModelInBody replaces the "model" field in the JSON request body.
func patchModelInBody(body []byte, modelStr, format string) ([]byte, error) {
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(body, &obj); err != nil {
		return nil, fmt.Errorf("unmarshal: %w", err)
	}
	modelJSON, err := json.Marshal(modelStr)
	if err != nil {
		return nil, err
	}
	obj["model"] = modelJSON
	return json.Marshal(obj)
}

// rebuildRequest creates a new *http.Request with a fresh body from patchedBody.
func rebuildRequest(r *http.Request, patchedBody []byte) (*http.Request, error) {
	newReq, err := http.NewRequestWithContext(r.Context(), r.Method, r.URL.String(), bytes.NewReader(patchedBody))
	if err != nil {
		return nil, err
	}
	// Copy headers.
	newReq.Header = r.Header.Clone()
	newReq.ContentLength = int64(len(patchedBody))
	return newReq, nil
}

// extractErrorMessage pulls a human-readable error string from a JSON response body.
func extractErrorMessage(body []byte) string {
	body = bytes.TrimSpace(body)
	if len(body) == 0 {
		return ""
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(body, &obj); err != nil {
		return string(body)
	}
	// Claude style: {"type":"error","error":{"message":"..."}}
	if errRaw, ok := obj["error"]; ok {
		var errObj map[string]json.RawMessage
		if err := json.Unmarshal(errRaw, &errObj); err == nil {
			if msgRaw, ok := errObj["message"]; ok {
				var msg string
				if json.Unmarshal(msgRaw, &msg) == nil {
					return msg
				}
			}
		}
		// error might be a plain string
		var errStr string
		if json.Unmarshal(errRaw, &errStr) == nil {
			return errStr
		}
	}
	// Try top-level "message".
	if msgRaw, ok := obj["message"]; ok {
		var msg string
		if json.Unmarshal(msgRaw, &msg) == nil {
			return msg
		}
	}
	return string(body)
}

// truncateStr shortens s to at most n runes.
func truncateStr(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}
