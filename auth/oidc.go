package auth

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"superkiro/config"
	"net/http"
	"strings"
	"time"
)

// oidcTokenURL builds the idc/builderId refresh endpoint. Replacable in tests.
var oidcTokenURL = func(region string) string {
	return fmt.Sprintf("https://oidc.%s.amazonaws.com/token", region)
}

// socialTokenURL builds the social refresh endpoint. Replacable in tests.
var socialTokenURL = func() string {
	return "https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken"
}

// socialDeviceAuthURL is the social device authorization endpoint. Replacable in tests.
var socialDeviceAuthURL = func() string {
	return "https://prod.us-east-1.auth.desktop.kiro.dev/oauth/device/authorization"
}

// socialDevicePollURL is the social device poll endpoint. Replacable in tests.
var socialDevicePollURL = func() string {
	return "https://prod.us-east-1.auth.desktop.kiro.dev/oauth/device/poll"
}

// SocialDeviceSession stores state for a social device-code login.
type SocialDeviceSession struct {
	DeviceCode string
	UserCode   string
	VerifyURL  string
	Interval   int
	ExpiresAt  time.Time
	Provider   string
}

// StartSocialLogin initiates a Google/GitHub social device-code login.
// Returns session with deviceCode, userCode, verification URL, and poll interval.
func StartSocialLogin(provider string) (*SocialDeviceSession, error) {
	idp := "Google"
	if provider == "github" {
		idp = "Github"
	}

	payload := map[string]string{
		"clientId":      "kiro-cli",
		"loginProvider": idp,
	}
	body, _ := json.Marshal(payload)

	req, err := http.NewRequest("POST", socialDeviceAuthURL(), bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("create request failed: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := httpClient().Do(req)
	if err != nil {
		return nil, fmt.Errorf("device authorization failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		respBody, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("device authorization failed: %d %s", resp.StatusCode, string(respBody))
	}

	var result struct {
		DeviceCode              string `json:"deviceCode"`
		UserCode                string `json:"userCode"`
		VerificationUriComplete string `json:"verificationUriComplete"`
		IntervalMS              int    `json:"intervalInMilliseconds"`
		ExpiresInMS             int    `json:"expiresInMilliseconds"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("parse response failed: %w", err)
	}

	interval := result.IntervalMS / 1000
	if interval < 1 {
		interval = 5
	}
	expiresIn := result.ExpiresInMS / 1000
	if expiresIn < 1 {
		expiresIn = 300
	}

	return &SocialDeviceSession{
		DeviceCode: result.DeviceCode,
		UserCode:   result.UserCode,
		VerifyURL:  result.VerificationUriComplete,
		Interval:   interval,
		ExpiresAt:  time.Now().Add(time.Duration(expiresIn) * time.Second),
		Provider:   provider,
	}, nil
}

// PollSocialLogin polls the social device-code flow for tokens.
// Returns accessToken, refreshToken, profileArn, expiresIn, error.
// profileArn comes directly from the kiro.dev response.
func PollSocialLogin(deviceCode, provider string) (accessToken, refreshToken, profileArn string, expiresIn int, err error) {
	payload := map[string]string{
		"deviceCode": deviceCode,
		"clientId":   "kiro-cli",
	}
	body, _ := json.Marshal(payload)

	req, err := http.NewRequest("POST", socialDevicePollURL(), bytes.NewReader(body))
	if err != nil {
		return "", "", "", 0, fmt.Errorf("create request failed: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := httpClient().Do(req)
	if err != nil {
		return "", "", "", 0, fmt.Errorf("poll request failed: %w", err)
	}
	defer resp.Body.Close()

	// kiro.dev returns 400 with {error:"authorization_pending"} when pending.
	// 200 only comes when tokens are ready.
	var result struct {
		AccessToken  string `json:"accessToken"`
		RefreshToken string `json:"refreshToken"`
		ProfileArn   string `json:"profileArn"`
		ExpiresIn    int    `json:"expiresIn"`
		Error        string `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", "", "", 0, fmt.Errorf("parse response failed: %w", err)
	}

	if result.Error == "authorization_pending" || result.Error == "slow_down" || result.Error == "no_tokens" {
		return "", "", "", 0, fmt.Errorf(result.Error)
	}
	if result.Error != "" {
		return "", "", "", 0, fmt.Errorf("authorization error: %s", result.Error)
	}
	if result.AccessToken == "" && resp.StatusCode != 200 {
		return "", "", "", 0, fmt.Errorf("authorization_pending")
	}
	if result.AccessToken == "" {
		return "", "", "", 0, fmt.Errorf("authorization_pending")
	}

	if result.ExpiresIn <= 0 {
		result.ExpiresIn = 3600
	}

	return result.AccessToken, result.RefreshToken, result.ProfileArn, result.ExpiresIn, nil
}

// DiscoverProfileArn discovers the CodeWhisperer/Kiro profile ARN for a newly-authenticated
// account by calling ListAvailableProfiles on the region-matched Amazon Q endpoint. Prefers a
// profile whose ARN contains the token's region, then falls back to the first profile returned.
// Builder ID accounts legitimately have none and return "" without error.
// Mirrors OmniRoute's postExchange pattern exactly.
func DiscoverProfileArn(accessToken, region string) string {
	if accessToken == "" {
		return ""
	}
	if region == "" {
		region = "us-east-1"
	}
	region = strings.ToLower(region)

	var runtimeHost string
	if region == "us-east-1" {
		runtimeHost = "https://codewhisperer.us-east-1.amazonaws.com"
	} else {
		runtimeHost = fmt.Sprintf("https://q.%s.amazonaws.com", region)
	}

	payload := map[string]int{"maxResults": 10}
	body, _ := json.Marshal(payload)

	req, err := http.NewRequest("POST", runtimeHost+"/ListAvailableProfiles", bytes.NewReader(body))
	if err != nil {
		return ""
	}
	req.Header.Set("Content-Type", "application/x-amz-json-1.0")
	req.Header.Set("x-amz-target", "AmazonCodeWhispererService.ListAvailableProfiles")
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Accept", "application/json")

	client := httpClient()
	resp, err := client.Do(req)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return ""
	}

	var result struct {
		Profiles []struct {
			Arn string `json:"arn"`
		} `json:"profiles"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return ""
	}

	// Prefer region-matched profile (OmniRoute pattern).
	normalizedRegion := strings.ToLower(region)
	var fallback string
	for _, profile := range result.Profiles {
		arn := strings.TrimSpace(profile.Arn)
		if arn == "" {
			continue
		}
		if strings.Contains(strings.ToLower(arn), ":"+normalizedRegion+":") {
			return arn
		}
		if fallback == "" {
			fallback = arn
		}
	}
	return fallback
}

// RefreshToken refreshes the access token
// Returns: accessToken, refreshToken, expiresAt, profileArn, error
func RefreshToken(account *config.Account) (string, string, int64, string, error) {
	// Resolve per-account proxy: account.ProxyURL > global config
	proxyURL := account.ProxyURL
	if proxyURL == "" {
		proxyURL = config.GetProxyURL()
	}
	client := GetAuthClientForProxy(proxyURL)

	if account.AuthMethod == "social" {
		return refreshSocialToken(account.RefreshToken, client)
	}
	return refreshOIDCToken(account.RefreshToken, account.ClientID, account.ClientSecret, account.Region, client)
}

// refreshOIDCToken refreshes IdC/Builder ID token
func refreshOIDCToken(refreshToken, clientID, clientSecret, region string, client *http.Client) (string, string, int64, string, error) {
	if clientID == "" || clientSecret == "" {
		return "", "", 0, "", fmt.Errorf("OIDC refresh requires clientId and clientSecret")
	}
	if region == "" {
		region = "us-east-1"
	}

	url := oidcTokenURL(region)

	payload := map[string]string{
		"clientId":     clientID,
		"clientSecret": clientSecret,
		"refreshToken": refreshToken,
		"grantType":    "refresh_token",
	}

	body, _ := json.Marshal(payload)
	req, _ := http.NewRequest("POST", url, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return "", "", 0, "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		respBody, _ := io.ReadAll(resp.Body)
		return "", "", 0, "", fmt.Errorf("refresh failed: %d %s", resp.StatusCode, string(respBody))
	}

	var result struct {
		AccessToken  string `json:"accessToken"`
		RefreshToken string `json:"refreshToken"`
		ExpiresIn    int    `json:"expiresIn"`
		ProfileArn   string `json:"profileArn"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", "", 0, "", err
	}

	expiresAt := time.Now().Unix() + int64(result.ExpiresIn)
	return result.AccessToken, result.RefreshToken, expiresAt, result.ProfileArn, nil
}

// refreshSocialToken refreshes Social (GitHub/Google) token
func refreshSocialToken(refreshToken string, client *http.Client) (string, string, int64, string, error) {
	url := socialTokenURL()

	payload := map[string]string{
		"refreshToken": refreshToken,
	}

	body, _ := json.Marshal(payload)
	req, _ := http.NewRequest("POST", url, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return "", "", 0, "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		respBody, _ := io.ReadAll(resp.Body)
		return "", "", 0, "", fmt.Errorf("refresh failed: %d %s", resp.StatusCode, string(respBody))
	}

	var result struct {
		AccessToken  string `json:"accessToken"`
		RefreshToken string `json:"refreshToken"`
		ExpiresIn    int    `json:"expiresIn"`
		ProfileArn   string `json:"profileArn"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", "", 0, "", err
	}

	expiresAt := time.Now().Unix() + int64(result.ExpiresIn)
	return result.AccessToken, result.RefreshToken, expiresAt, result.ProfileArn, nil
}
