package auth

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// KiroCliCredentials holds credentials found in kiro-cli SQLite.
type KiroCliCredentials struct {
	RefreshToken string
	AccessToken  string
	ClientID     string
	ClientSecret string
	Region       string
	ProfileArn   string
}

// SSOCacheCredentials holds credentials found in ~/.aws/sso/cache.
type SSOCacheCredentials struct {
	RefreshToken string
	Source       string
}

// ImportKiroCli scans the kiro-cli SQLite database(s) for stored credentials and profileArn.
// Returns the first valid set found.
func ImportKiroCli() (*KiroCliCredentials, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, fmt.Errorf("home dir: %w", err)
	}

	// Candidates: Linux/macOS SQLite, Windows SQLite
	candidates := []string{
		filepath.Join(home, ".local", "share", "kiro-cli", "data.sqlite3"),
	}
	if appData := os.Getenv("APPDATA"); appData != "" {
		candidates = append(candidates, filepath.Join(appData, "kiro", "storage.db"))
	}

	for _, dbPath := range candidates {
		creds, err := readKiroCliSQLite(dbPath)
		if err == nil && creds != nil && creds.RefreshToken != "" {
			return creds, nil
		}
	}
	return nil, fmt.Errorf("no kiro-cli credentials found")
}

// readKiroCliSQLite reads a single kiro-cli SQLite database file.
func readKiroCliSQLite(dbPath string) (*KiroCliCredentials, error) {
	stat, err := os.Stat(dbPath)
	if err != nil || stat.IsDir() {
		return nil, fmt.Errorf("not found: %s", dbPath)
	}

	// Read entire file and do basic string search — the database is small.
	data, err := os.ReadFile(dbPath)
	if err != nil {
		return nil, err
	}
	content := string(data)

	// For a full SQLite parser we'd need CGO or a Go SQLite driver. Since SuperKiro
	// doesn't bundle one, we use a pragmatic text-scan approach: kiro-cli stores
	// JSON values as text blobs.

	creds := &KiroCliCredentials{}

	// Try to find refresh_token in JSON blobs keyed by "kirocli:oidc:token"
	creds.RefreshToken = extractJSONField(content, "kirocli:oidc:token", "refresh_token")
	if creds.RefreshToken == "" {
		creds.RefreshToken = extractJSONField(content, "kirocli:odic:token", "refresh_token")
	}
	if creds.RefreshToken == "" {
		creds.RefreshToken = extractJSONField(content, "kiro:auth:token", "refresh_token")
	}
	if creds.RefreshToken == "" {
		return nil, fmt.Errorf("no refresh token found in %s", dbPath)
	}

	// Access token
	creds.AccessToken = extractJSONField(content, "kirocli:oidc:token", "access_token")
	if creds.AccessToken == "" {
		creds.AccessToken = extractJSONField(content, "kiro:auth:token", "access_token")
	}

	// Client registration
	clientID := extractJSONField(content, "kirocli:oidc:device-registration", "client_id")
	if clientID == "" {
		clientID = extractJSONField(content, "kirocli:odic:device-registration", "client_id")
	}
	clientSecret := extractJSONField(content, "kirocli:oidc:device-registration", "client_secret")
	if clientSecret == "" {
		clientSecret = extractJSONField(content, "kirocli:odic:device-registration", "client_secret")
	}
	creds.ClientID = clientID
	creds.ClientSecret = clientSecret

	// Profile ARN from state/api.codewhisperer.profile
	creds.ProfileArn = extractJSONField(content, "api.codewhisperer.profile", "arn")
	if creds.ProfileArn == "" {
		creds.ProfileArn = extractJSONField(content, "api.codewhisperer.profile", "profileArn")
	}

	// Region from token data
	creds.Region = extractJSONField(content, "kirocli:oidc:token", "region")
	if creds.Region == "" {
		creds.Region = "us-east-1"
	}

	return creds, nil
}

// extractJSONField searches raw content for a JSON string value by key pattern.
// It looks for: <keyMarker>... "fieldName":"value" ... close>
func extractJSONField(content, keyMarker, fieldName string) string {
	// Find the key marker in content
	idx := strings.Index(content, keyMarker)
	if idx < 0 {
		return ""
	}

	// Find the JSON object containing this value — it's often escaped in a SQLite blob.
	// Look for `"` followed by fieldName and extract value.
	// Search within reasonable range after the marker.
	searchEnd := idx + 1024
	if searchEnd > len(content) {
		searchEnd = len(content)
	}
	slice := content[idx:searchEnd]

	// Look for `"fieldName":"value"` pattern
	quoteField := `"` + fieldName + `"`
	fIdx := strings.Index(slice, quoteField)
	if fIdx < 0 {
		// Try unquoted fieldName: "value"
		return extractQuotedAfter(slice, fieldName)
	}
	afterField := slice[fIdx+len(quoteField):]

	// Find colon after field name
	colonIdx := strings.Index(afterField, ":")
	if colonIdx < 0 {
		return ""
	}
	afterColon := strings.TrimSpace(afterField[colonIdx+1:])

	// Extract the JSON string value
	if len(afterColon) == 0 {
		return ""
	}
	if afterColon[0] == '"' {
		end := strings.IndexByte(afterColon[1:], '"')
		if end < 0 {
			return ""
		}
		return afterColon[1 : 1+end]
	}
	// Fallback: treat until comma/whitespace as value
	end := strings.IndexAny(afterColon, ", }\n\r")
	if end < 0 {
		end = len(afterColon)
	}
	return strings.TrimSpace(afterColon[:end])
}

// extractQuotedAfter tries to find `"fieldName": "value"` pattern.
func extractQuotedAfter(s, fieldName string) string {
	start := strings.Index(s, fieldName)
	if start < 0 {
		return ""
	}
	after := s[start+len(fieldName):]
	colonIdx := strings.Index(after, ":")
	if colonIdx < 0 {
		return ""
	}
	afterColon := strings.TrimSpace(after[colonIdx+1:])
	if len(afterColon) == 0 || afterColon[0] != '"' {
		return ""
	}
	end := strings.IndexByte(afterColon[1:], '"')
	if end < 0 {
		return ""
	}
	return afterColon[1 : 1+end]
}

// ImportSSOCache scans ~/.aws/sso/cache/ for Kiro/AWS SSO token files.
// Returns the first valid refresh token found.
func ImportSSOCache() (*SSOCacheCredentials, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, fmt.Errorf("home dir: %w", err)
	}
	cacheDir := filepath.Join(home, ".aws", "sso", "cache")

	entries, err := os.ReadDir(cacheDir)
	if err != nil {
		return nil, fmt.Errorf("read sso cache: %w", err)
	}

	// Prefer named files: kiro-auth-token.json, amazon-q-auth-token.json
	preferred := map[string]bool{
		"kiro-auth-token.json":     true,
		"amazon-q-auth-token.json": true,
	}

	var best string
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		if _, ok := preferred[entry.Name()]; ok {
			best = filepath.Join(cacheDir, entry.Name())
			break
		}
		if best == "" {
			best = filepath.Join(cacheDir, entry.Name())
		}
	}
	if best == "" {
		return nil, fmt.Errorf("no token files found in %s", cacheDir)
	}

	data, err := os.ReadFile(best)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", best, err)
	}
	var raw map[string]interface{}
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("parse %s: %w", best, err)
	}

	rt, _ := raw["refreshToken"].(string)
	if rt == "" || !strings.HasPrefix(rt, "aorAAAAAG") {
		return nil, fmt.Errorf("no valid refresh token in %s", best)
	}

	return &SSOCacheCredentials{
		RefreshToken: rt,
		Source:       best,
	}, nil
}
