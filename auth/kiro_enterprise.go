// kiro_enterprise.go implements the enterprise (external IdP) leg of the Kiro browser
// SSO flow. When the Kiro portal detects the user's email belongs to an external identity
// provider (e.g. an Azure AD tenant), it returns an IdP descriptor instead of a social
// authorization code. This file handles OIDC discovery of the IdP's authorization and token
// endpoints, then exchanges the resulting authorization code for tokens at the IdP's token
// endpoint.
//
// Ported from refsources/cli-cache-proxy-api/internal/auth/kiro/social.go.
package auth

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
)

// allowedExternalIdpIssuerSuffixes restricts which IdP hosts the enterprise leg will
// discover and redirect to. The issuer arrives in an attacker-influenceable portal
// callback query, so it is constrained to known enterprise IdP hosts. The leading dot
// anchors each suffix to a real subdomain boundary.
var allowedExternalIdpIssuerSuffixes = []string{
	".microsoftonline.com",
	".microsoftonline.us",
	".microsoftonline.cn",
}

// validateExternalIdpEndpoint verifies rawURL is an https URL whose host is an allow-listed
// enterprise IdP host (no IP literals).
func validateExternalIdpEndpoint(rawURL string) error {
	u, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil {
		return fmt.Errorf("kiro enterprise: invalid URL: %w", err)
	}
	if !strings.EqualFold(u.Scheme, "https") {
		return fmt.Errorf("kiro enterprise: URL must be https")
	}
	host := strings.ToLower(u.Hostname())
	if host == "" {
		return fmt.Errorf("kiro enterprise: URL has no host")
	}
	if net.ParseIP(host) != nil {
		return fmt.Errorf("kiro enterprise: host must not be an IP literal")
	}
	for _, suffix := range allowedExternalIdpIssuerSuffixes {
		if strings.HasSuffix(host, suffix) {
			return nil
		}
	}
	return fmt.Errorf("kiro enterprise: host %q is not allow-listed", host)
}

// ExternalIdpDiscover fetches the OpenID Connect discovery document for issuerURL and
// returns its authorization and token endpoints. Both endpoints are validated against
// the IdP host allow-list; redirects are NOT followed.
func ExternalIdpDiscover(ctx context.Context, issuerURL string) (authEndpoint, tokenEndpoint string, err error) {
	if err := validateExternalIdpEndpoint(issuerURL); err != nil {
		return "", "", err
	}

	docURL := strings.TrimRight(strings.TrimSpace(issuerURL), "/") + "/.well-known/openid-configuration"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, docURL, nil)
	if err != nil {
		return "", "", fmt.Errorf("kiro enterprise: build discovery request: %w", err)
	}
	req.Header.Set("Accept", "application/json")

	client := httpClient()
	// Do not follow redirects: the allow-listed issuer must answer directly.
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }

	resp, err := client.Do(req)
	if err != nil {
		return "", "", fmt.Errorf("kiro enterprise: discovery request failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return "", "", fmt.Errorf("kiro enterprise: read discovery response: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", "", fmt.Errorf("kiro enterprise: discovery failed (status %d)", resp.StatusCode)
	}

	var doc struct {
		AuthorizationEndpoint string `json:"authorization_endpoint"`
		TokenEndpoint         string `json:"token_endpoint"`
	}
	if err := json.Unmarshal(body, &doc); err != nil {
		return "", "", fmt.Errorf("kiro enterprise: parse discovery document: %w", err)
	}
	if doc.AuthorizationEndpoint == "" || doc.TokenEndpoint == "" {
		return "", "", fmt.Errorf("kiro enterprise: discovery document missing authorization_endpoint or token_endpoint")
	}
	if err := validateExternalIdpEndpoint(doc.AuthorizationEndpoint); err != nil {
		return "", "", fmt.Errorf("kiro enterprise: discovered authorization_endpoint rejected: %w", err)
	}
	if err := validateExternalIdpEndpoint(doc.TokenEndpoint); err != nil {
		return "", "", fmt.Errorf("kiro enterprise: discovered token_endpoint rejected: %w", err)
	}
	return doc.AuthorizationEndpoint, doc.TokenEndpoint, nil
}

// BuildExternalIdpAuthorizeURL builds the IdP authorization-code+PKCE URL the browser
// is redirected to for the enterprise leg. loginHint is optional; when non-empty it is
// included so the IdP knows which user to authenticate (critical for Microsoft Entra).
func BuildExternalIdpAuthorizeURL(authEndpoint, clientID, redirectURI, scopes, challenge, state, loginHint string) string {
	q := url.Values{}
	q.Set("client_id", clientID)
	q.Set("response_type", "code")
	q.Set("redirect_uri", redirectURI)
	q.Set("scope", scopes)
	q.Set("code_challenge", challenge)
	q.Set("code_challenge_method", "S256")
	q.Set("response_mode", "query")
	q.Set("state", state)
	if strings.TrimSpace(loginHint) != "" {
		q.Set("login_hint", strings.TrimSpace(loginHint))
	}
	return authEndpoint + "?" + q.Encode()
}

// ExchangeExternalIdpCode exchanges an IdP authorization code (with its PKCE verifier)
// for IdP tokens at the discovered token endpoint. Returns accessToken, refreshToken, expiresIn
// from the snake_case OAuth2 response.
func ExchangeExternalIdpCode(ctx context.Context, tokenEndpoint, clientID, code, codeVerifier, redirectURI, scopes string) (accessToken, refreshToken string, expiresIn int, err error) {
	code = strings.TrimSpace(code)
	if code == "" {
		return "", "", 0, fmt.Errorf("kiro enterprise: exchange requires an authorization code")
	}

	form := url.Values{}
	form.Set("client_id", clientID)
	form.Set("grant_type", "authorization_code")
	form.Set("code", code)
	form.Set("redirect_uri", redirectURI)
	form.Set("code_verifier", codeVerifier)
	if strings.TrimSpace(scopes) != "" {
		form.Set("scope", scopes)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, tokenEndpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return "", "", 0, fmt.Errorf("kiro enterprise: build token request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")

	resp, err := httpClient().Do(req)
	if err != nil {
		return "", "", 0, fmt.Errorf("kiro enterprise: token request failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", "", 0, fmt.Errorf("kiro enterprise: read token response: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", "", 0, fmt.Errorf("kiro enterprise: token exchange failed (status %d): %s", resp.StatusCode, string(body))
	}

	var result struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    int    `json:"expires_in"`
		Error        string `json:"error"`
	}
	_ = json.Unmarshal(body, &result)
	if result.AccessToken == "" {
		if result.Error != "" {
			return "", "", 0, fmt.Errorf("kiro enterprise: token exchange error: %s", result.Error)
		}
		return "", "", 0, fmt.Errorf("kiro enterprise: empty access token")
	}
	if result.ExpiresIn <= 0 {
		result.ExpiresIn = 3600
	}
	return result.AccessToken, result.RefreshToken, result.ExpiresIn, nil
}
