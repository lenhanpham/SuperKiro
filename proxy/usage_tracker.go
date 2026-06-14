package proxy

import (
	"encoding/json"
	"os"
	"path/filepath"
	"superkiro/config"
	"superkiro/logger"
	"sync"
	"time"
)

// RequestRecord is a single usage event captured during a proxy request.
type RequestRecord struct {
	Timestamp       string  `json:"timestamp"`
	Model           string  `json:"model"`
	Provider        string  `json:"provider"`
	AccountID       string  `json:"accountId"`
	AccountName     string  `json:"accountName"`
	InputTokens     int     `json:"inputTokens"`
	OutputTokens    int     `json:"outputTokens"`
	Cost            float64 `json:"cost"`
	Status          string  `json:"status"`
	Endpoint        string  `json:"endpoint"`
	APIKeyID        string  `json:"apiKeyId,omitempty"`
}

// PeriodSummary holds aggregated stats for a single time bucket.
type PeriodSummary struct {
	Requests          int     `json:"requests"`
	PromptTokens      int     `json:"promptTokens"`
	CompletionTokens  int     `json:"completionTokens"`
	Cost              float64 `json:"cost"`
}

// UsageStats holds the full response for the usage stats endpoint.
type UsageStats struct {
	TotalRequests         int                      `json:"totalRequests"`
	TotalPromptTokens     int                      `json:"totalPromptTokens"`
	TotalCompletionTokens int                      `json:"totalCompletionTokens"`
	TotalCost             float64                  `json:"totalCost"`
	ActiveRequests        []ActiveRequest          `json:"activeRequests"`
	RecentRequests        []RequestRecord          `json:"recentRequests"`
	ByModel               map[string]*PeriodSummary `json:"byModel"`
	ByAccount             map[string]*PeriodSummary `json:"byAccount"`
	ByAPIKey              map[string]*PeriodSummary `json:"byApiKey"`
	ByEndpoint            map[string]*PeriodSummary `json:"byEndpoint"`
	ErrorProvider         string                   `json:"errorProvider"`
	AccountNames          map[string]string        `json:"accountNames"`
}

// ActiveRequest represents an in-flight request for the topology.
type ActiveRequest struct {
	Provider  string `json:"provider"`
	Model     string `json:"model"`
	AccountID string `json:"accountId"`
}

// ChartDataPoint is a single bucket in the time-series chart.
type ChartDataPoint struct {
	Label  string  `json:"label"`
	Tokens int     `json:"tokens"`
	Cost   float64 `json:"cost"`
}

// UsageTracker collects per-request usage data in memory.
type UsageTracker struct {
	mu           sync.RWMutex
	ring         []RequestRecord
	ringCap      int
	ringIdx      int
	ringFull     bool
	activeReqs   map[string]ActiveRequest // accountID → request
	dailyData    map[string]*PeriodSummary
	dirty        bool
	historyPath  string
	dailyPath    string
}

var globalTracker *UsageTracker
var trackerOnce sync.Once

func GetUsageTracker() *UsageTracker {
	trackerOnce.Do(func() {
		dataDir := config.GetConfigDir()
		globalTracker = &UsageTracker{
			ringCap:    500,
			ring:       make([]RequestRecord, 500),
			activeReqs: make(map[string]ActiveRequest),
			dailyData:  make(map[string]*PeriodSummary),
			historyPath: filepath.Join(dataDir, "usage_history.json"),
			dailyPath:   filepath.Join(dataDir, "usage_daily.json"),
		}
		globalTracker.loadFromDisk()
		// Periodically flush to disk
		go globalTracker.periodicFlush()
	})
	return globalTracker
}

func (t *UsageTracker) loadFromDisk() {
	// Load ring history
	if data, err := os.ReadFile(t.historyPath); err == nil {
		var records []RequestRecord
		if json.Unmarshal(data, &records) == nil {
			for _, r := range records {
				t.pushToRing(r)
			}
		}
	}
	// Load daily aggregations
	if data, err := os.ReadFile(t.dailyPath); err == nil {
		json.Unmarshal(data, &t.dailyData)
	}
}

func (t *UsageTracker) periodicFlush() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		t.mu.RLock()
		dirty := t.dirty
		t.mu.RUnlock()
		if dirty {
			t.flushToDisk()
		}
	}
}

func (t *UsageTracker) flushToDisk() {
	t.mu.RLock()
	defer t.mu.RUnlock()

	// Flush ring buffer
	records := make([]RequestRecord, 0, t.ringCap)
	if t.ringFull {
		for i := t.ringIdx; i < t.ringCap; i++ {
			records = append(records, t.ring[i])
		}
	}
	for i := 0; i < t.ringIdx; i++ {
		records = append(records, t.ring[i])
	}

	data, _ := json.MarshalIndent(records, "", "  ")
	os.WriteFile(t.historyPath, data, 0644)

	dailyData, _ := json.MarshalIndent(t.dailyData, "", "  ")
	os.WriteFile(t.dailyPath, dailyData, 0644)

	t.dirty = false
}

func (t *UsageTracker) pushToRing(r RequestRecord) {
	t.ring[t.ringIdx] = r
	t.ringIdx++
	if t.ringIdx >= t.ringCap {
		t.ringIdx = 0
		t.ringFull = true
	}
}

// Append records a completed request and pushes SSE updates.
func (t *UsageTracker) Append(r RequestRecord) {
	t.mu.Lock()
	defer t.mu.Unlock()

	r.Timestamp = time.Now().UTC().Format(time.RFC3339)
	t.pushToRing(r)
	t.dirty = true

	// Update daily aggregation
	dateKey := time.Now().UTC().Format("2006-01-02")
	day, ok := t.dailyData[dateKey]
	if !ok {
		day = &PeriodSummary{}
		t.dailyData[dateKey] = day
	}
	day.Requests++
	day.PromptTokens += r.InputTokens
	day.CompletionTokens += r.OutputTokens
	day.Cost += r.Cost

	// Remove from active requests
	delete(t.activeReqs, r.AccountID)

	// Push SSE to all listeners (already holding lock, pass data directly)
	activeSnapshot := make([]ActiveRequest, 0, len(t.activeReqs))
	for _, ar := range t.activeReqs {
		activeSnapshot = append(activeSnapshot, ar)
	}
	recentSnapshot := t.getRecentRequestsLocked(time.Now().Add(-5 * time.Minute))
	go func(active []ActiveRequest, recent []RequestRecord) {
		payload := map[string]interface{}{
			"activeRequests": active,
			"recentRequests": recent,
		}
		if data, err := json.Marshal(payload); err == nil {
			broadcastSSEUnsafe(data)
		}
	}(activeSnapshot, recentSnapshot)
}

// TrackActive marks a request as in-flight.
func (t *UsageTracker) TrackActive(accountID, provider, model string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.activeReqs[accountID] = ActiveRequest{
		Provider:  provider,
		Model:     model,
		AccountID: accountID,
	}
}

// RemoveActive removes an active request (on failure).
func (t *UsageTracker) RemoveActive(accountID string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.activeReqs, accountID)
}

// GetStats compiles usage statistics for a given period.
func (t *UsageTracker) GetStats(period string) *UsageStats {
	t.mu.RLock()
	defer t.mu.RUnlock()

	cutoff := getPeriodCutoff(period)

	stats := &UsageStats{
		ByModel:    make(map[string]*PeriodSummary),
		ByAccount:  make(map[string]*PeriodSummary),
		ByAPIKey:   make(map[string]*PeriodSummary),
		ByEndpoint: make(map[string]*PeriodSummary),
	}

	// Collect recent requests from ring buffer
	stats.RecentRequests = t.getRecentRequestsLocked(cutoff)

	// Aggregate by dimensions
	for _, rec := range stats.RecentRequests {
		stats.TotalRequests++
		stats.TotalPromptTokens += rec.InputTokens
		stats.TotalCompletionTokens += rec.OutputTokens
		stats.TotalCost += rec.Cost

		// By model
		t.addToSummary(stats.ByModel, rec.Model, rec.InputTokens, rec.OutputTokens, rec.Cost)
		// By account
		t.addToSummary(stats.ByAccount, rec.AccountID, rec.InputTokens, rec.OutputTokens, rec.Cost)
		// By API key
		if rec.APIKeyID != "" {
			t.addToSummary(stats.ByAPIKey, rec.APIKeyID, rec.InputTokens, rec.OutputTokens, rec.Cost)
		}
		// By endpoint
		if rec.Endpoint != "" {
			t.addToSummary(stats.ByEndpoint, rec.Endpoint, rec.InputTokens, rec.OutputTokens, rec.Cost)
		}
	}

	// Active requests
	stats.ActiveRequests = make([]ActiveRequest, 0, len(t.activeReqs))
	for _, ar := range t.activeReqs {
		stats.ActiveRequests = append(stats.ActiveRequests, ar)
	}

	// Build account name map from recent requests + config accounts
	stats.AccountNames = make(map[string]string)
	for _, rec := range stats.RecentRequests {
		if rec.AccountName != "" && rec.AccountID != "" {
			if _, exists := stats.AccountNames[rec.AccountID]; !exists {
				stats.AccountNames[rec.AccountID] = rec.AccountName
			}
		}
	}
	// Also populate names from config for accounts that have no recent requests
	for _, a := range config.GetAccounts() {
		if _, exists := stats.AccountNames[a.ID]; !exists {
			name := ""
			if a.Nickname != "" {
				name = a.Nickname
			} else if a.Email != "" {
				name = a.Email
			} else if len(a.ID) >= 8 {
				name = a.ID[:8]
			} else {
				name = a.ID
			}
			stats.AccountNames[a.ID] = name
		}
	}

	return stats
}

// GetChartData produces time-bucketed chart data.
func (t *UsageTracker) GetChartData(period string) []ChartDataPoint {
	t.mu.RLock()
	defer t.mu.RUnlock()

	now := time.Now()
	switch period {
	case "today":
		return t.bucketByHour(now, true)
	case "24h":
		return t.bucketByHour(now, false)
	case "7d":
		return t.bucketByDay(now, 7)
	case "30d":
		return t.bucketByDay(now, 30)
	default:
		return t.bucketByDay(now, 7)
	}
}

func (t *UsageTracker) bucketByHour(now time.Time, today bool) []ChartDataPoint {
	buckets := 24
	if today {
		now = time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	}
	startTime := now.Add(-time.Duration(buckets) * time.Hour)
	points := make([]ChartDataPoint, buckets)
	for i := 0; i < buckets; i++ {
		ts := startTime.Add(time.Duration(i) * time.Hour)
		points[i].Label = ts.Format("15:04")
	}

	records := t.getAllRecordsLocked()
	for _, rec := range records {
		recTime, err := time.Parse(time.RFC3339, rec.Timestamp)
		if err != nil {
			continue
		}
		if recTime.Before(startTime) || recTime.After(now) {
			continue
		}
		idx := int(recTime.Sub(startTime).Hours())
		if idx >= 0 && idx < buckets {
			points[idx].Tokens += rec.InputTokens + rec.OutputTokens
			points[idx].Cost += rec.Cost
		}
	}
	return points
}

func (t *UsageTracker) bucketByDay(now time.Time, days int) []ChartDataPoint {
	points := make([]ChartDataPoint, days)
	for i := 0; i < days; i++ {
		d := now.Add(-time.Duration(days-1-i) * 24 * time.Hour)
		dateKey := d.Format("2006-01-02")
		points[i].Label = d.Format("Jan 2")
		if day, ok := t.dailyData[dateKey]; ok {
			points[i].Tokens = day.PromptTokens + day.CompletionTokens
			points[i].Cost = day.Cost
		}
	}
	return points
}

func (t *UsageTracker) getRecentRequestsLocked(cutoff time.Time) []RequestRecord {
	var result []RequestRecord
	if t.ringFull {
		for i := t.ringIdx; i < t.ringCap; i++ {
			if r := t.ring[i]; r.Timestamp != "" {
				if rt, err := time.Parse(time.RFC3339, r.Timestamp); err == nil && rt.After(cutoff) {
					result = append(result, r)
				}
			}
		}
	}
	for i := 0; i < t.ringIdx; i++ {
		if r := t.ring[i]; r.Timestamp != "" {
			if rt, err := time.Parse(time.RFC3339, r.Timestamp); err == nil && rt.After(cutoff) {
				result = append(result, r)
			}
		}
	}
	// Reverse to show newest first
	for i, j := 0, len(result)-1; i < j; i, j = i+1, j-1 {
		result[i], result[j] = result[j], result[i]
	}
	return result
}

func (t *UsageTracker) getAllRecordsLocked() []RequestRecord {
	var result []RequestRecord
	if t.ringFull {
		result = append(result, t.ring[t.ringIdx:]...)
	}
	result = append(result, t.ring[:t.ringIdx]...)
	return result
}

func (t *UsageTracker) addToSummary(m map[string]*PeriodSummary, key string, prompt, completion int, cost float64) {
	s, ok := m[key]
	if !ok {
		s = &PeriodSummary{}
		m[key] = s
	}
	s.Requests++
	s.PromptTokens += prompt
	s.CompletionTokens += completion
	s.Cost += cost
}

// SSE broadcasting
type sseListener struct {
	ch chan []byte
}

var (
	sseListeners   []*sseListener
	sseListenersMu sync.RWMutex
)

func broadcastSSEUnsafe(data []byte) {
	sseListenersMu.RLock()
	for _, l := range sseListeners {
		select {
		case l.ch <- data:
		default:
		}
	}
	sseListenersMu.RUnlock()
}

func (t *UsageTracker) broadcastStats() {
	stats := t.buildQuickStats()
	data, err := json.Marshal(stats)
	if err != nil {
		return
	}
	broadcastSSEUnsafe(data)
}

func (t *UsageTracker) buildQuickStats() map[string]interface{} {
	t.mu.RLock()
	defer t.mu.RUnlock()

	activeReqs := make([]ActiveRequest, 0, len(t.activeReqs))
	for _, ar := range t.activeReqs {
		activeReqs = append(activeReqs, ar)
	}

	recent := t.getRecentRequestsLocked(time.Now().Add(-5 * time.Minute))

	return map[string]interface{}{
		"activeRequests": activeReqs,
		"recentRequests": recent,
	}
}

func (t *UsageTracker) SubscribeSSE() *sseListener {
	l := &sseListener{ch: make(chan []byte, 16)}
	sseListenersMu.Lock()
	sseListeners = append(sseListeners, l)
	sseListenersMu.Unlock()
	return l
}

func (t *UsageTracker) UnsubscribeSSE(l *sseListener) {
	sseListenersMu.Lock()
	defer sseListenersMu.Unlock()
	for i, ls := range sseListeners {
		if ls == l {
			sseListeners = append(sseListeners[:i], sseListeners[i+1:]...)
			break
		}
	}
}

func getPeriodCutoff(period string) time.Time {
	now := time.Now()
	switch period {
	case "all":
		return time.Time{} // zero time includes all records
	case "today":
		return time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	case "24h":
		return now.Add(-24 * time.Hour)
	case "7d":
		return now.Add(-7 * 24 * time.Hour)
	case "30d":
		return now.Add(-30 * 24 * time.Hour)
	case "60d":
		return now.Add(-60 * 24 * time.Hour)
	default:
		return now.Add(-24 * time.Hour)
	}
}

// Ensure tracker reference is accessible from handler
var trackerInstance *UsageTracker

func InitUsageTracker() {
	trackerInstance = GetUsageTracker()
}

func GetTracker() *UsageTracker {
	return trackerInstance
}

// SetTrackerErrorProvider sets the error provider name for the topology.
func (t *UsageTracker) SetErrorProvider(provider string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	// Just store for SSE broadcast; handled in buildQuickStats via recent requests
	logger.Debugf("[Usage] Error provider: %s", provider)
}
