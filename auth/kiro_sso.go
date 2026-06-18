// Package auth provides authentication and token management for Kiro API Proxy.
//
// kiro_sso.go implements the Kiro browser-based SSO sign-in flow — the same PKCE
// authorization-code flow the Kiro IDE uses. It supports:
//
//   - Social (Google/GitHub): user authenticates at app.kiro.dev/signin, the portal
//     redirects an authorization code back via loopback, and we exchange it at the
//     Kiro social token endpoint.
//
//   - Enterprise / external IdP (e.g. Azure AD): the portal detects the email belongs
//     to an external IdP, returns an IdP descriptor (issuer_url / client_id / scopes),
//     and we OIDC-discover the IdP, build a second authorization URL, exchange the
//     resulting code at the IdP token endpoint (kiro_enterprise.go handles this leg).
//
// Ported from refsources/cli-cache-proxy-api/internal/auth/kiro/social.go.
package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// ── SSO Session Store ──────────────────────────────────────────────────────────

// SsoSession holds in-memory state for a Kiro SSO login attempt.
type SsoSession struct {
	ID          string
	PKCE        *SocialPKCE
	Region      string
	Provider    string // "social", "enterprise"
	CreatedAt   time.Time
	ExpiresAt   time.Time

	// Enterprise leg-2 context
	TokenEndpoint string
	IssuerURL     string
	ClientID      string
	Scopes        string
	CodeVerifier  string
	RedirectURI   string
}

var (
	ssoSessions   = make(map[string]*SsoSession)
	ssoSessionsMu sync.RWMutex
)

// NewSsoSession creates and stores a new SSO login session.
func NewSsoSession(region string) (*SsoSession, error) {
	pkce, err := GenerateSocialPKCE()
	if err != nil {
		return nil, err
	}
	session := &SsoSession{
		ID:        GenerateAccountID(),
		PKCE:      pkce,
		Region:    region,
		CreatedAt: time.Now(),
		ExpiresAt: time.Now().Add(ssoSessionTTL),
	}
	ssoSessionsMu.Lock()
	ssoSessions[session.ID] = session
	ssoSessionsMu.Unlock()
	return session, nil
}

// GetSsoSession retrieves a session by ID.
func GetSsoSession(id string) *SsoSession {
	ssoSessionsMu.RLock()
	defer ssoSessionsMu.RUnlock()
	s := ssoSessions[id]
	if s != nil && time.Now().After(s.ExpiresAt) {
		delete(ssoSessions, id)
		return nil
	}
	return s
}

// SetSsoEnterpriseContext stores leg-2 enterprise context on a session.
func SetSsoEnterpriseContext(sessionID, tokenEndpoint, issuerURL, clientID, scopes, codeVerifier, redirectURI string) {
	ssoSessionsMu.Lock()
	defer ssoSessionsMu.Unlock()
	if s, ok := ssoSessions[sessionID]; ok {
		s.TokenEndpoint = tokenEndpoint
		s.IssuerURL = issuerURL
		s.ClientID = clientID
		s.Scopes = scopes
		s.CodeVerifier = codeVerifier
		s.RedirectURI = redirectURI
		s.Provider = "enterprise"
	}
}

// DeleteSsoSession removes a session (called after login completes/fails).
func DeleteSsoSession(id string) {
	ssoSessionsMu.Lock()
	defer ssoSessionsMu.Unlock()
	delete(ssoSessions, id)
}

const (
	// ssoSessionTTL is how long an SSO login session is valid.
	ssoSessionTTL = 15 * time.Minute

	// socialAuthBase is the Kiro Cognito-backed social auth base URL.
	socialAuthBase = "https://prod.us-east-1.auth.desktop.kiro.dev"

	// socialSignInBaseURL is the Kiro hosted sign-in page opened in the browser.
	socialSignInBaseURL = "https://app.kiro.dev/signin"

	// socialRedirectURI is the loopback redirect the portal validates and redirects to.
	socialRedirectURI = "http://localhost:3128"

	// socialRedirectFrom mirrors the Kiro IDE client tag the portal expects.
	socialRedirectFrom = "KiroIDE"

	// oauthCallbackPath is the path on the loopback for enterprise IdP callbacks.
	oauthCallbackPath = "/oauth/callback"

	// socialLoginTimeout bounds how long we wait for the user to finish browser sign-in.
	socialLoginTimeout = 10 * time.Minute
)

// SocialPKCE holds a PKCE verifier/challenge pair plus the anti-CSRF state token.
type SocialPKCE struct {
	Verifier  string
	Challenge string
	State     string
}

// GenerateSocialPKCE creates a PKCE verifier, its S256 challenge, and a random state.
func GenerateSocialPKCE() (*SocialPKCE, error) {
	verifier, err := randomURLSafe(96)
	if err != nil {
		return nil, fmt.Errorf("kiro sso: failed to generate code verifier: %w", err)
	}
	state, err := randomURLSafe(32)
	if err != nil {
		return nil, fmt.Errorf("kiro sso: failed to generate state: %w", err)
	}
	return &SocialPKCE{Verifier: verifier, Challenge: pkceChallenge(verifier), State: state}, nil
}

// pkceChallenge returns the S256 challenge (base64url, no padding) for a verifier.
func pkceChallenge(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

// randomURLSafe returns n cryptographically random bytes encoded as unpadded base64url.
func randomURLSafe(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// SocialSignInURL builds the Kiro hosted sign-in URL for the given PKCE codes.
func SocialSignInURL(pkce *SocialPKCE) string {
	q := url.Values{}
	q.Set("state", pkce.State)
	q.Set("code_challenge", pkce.Challenge)
	q.Set("code_challenge_method", "S256")
	q.Set("redirect_uri", socialRedirectURI)
	q.Set("redirect_from", socialRedirectFrom)
	return socialSignInBaseURL + "?" + q.Encode()
}

// ExchangeSocialCode exchanges an authorization code (with its PKCE verifier) for Kiro
// tokens at the social token endpoint. Returns accessToken, refreshToken, profileArn, expiresIn.
func ExchangeSocialCode(ctx context.Context, code, codeVerifier string) (accessToken, refreshToken, profileArn string, expiresIn int, err error) {
	code = strings.TrimSpace(code)
	if code == "" {
		return "", "", "", 0, fmt.Errorf("kiro sso: social exchange requires an authorization code")
	}

	endpoint := socialAuthBase + "/oauth/token"
	payload := map[string]any{
		"code":          code,
		"code_verifier": codeVerifier,
		"redirect_uri":  socialRedirectURI,
	}

	body, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(string(body)))
	if err != nil {
		return "", "", "", 0, fmt.Errorf("kiro sso: create exchange request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	resp, err := httpClient().Do(req)
	if err != nil {
		return "", "", "", 0, fmt.Errorf("kiro sso: social exchange request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", "", "", 0, fmt.Errorf("kiro sso: social token exchange failed (status %d): %s", resp.StatusCode, string(respBody))
	}

	var result struct {
		AccessToken  string `json:"accessToken"`
		RefreshToken string `json:"refreshToken"`
		ProfileArn   string `json:"profileArn"`
		ExpiresIn    int    `json:"expiresIn"`
	}
	if err := json.Unmarshal(respBody, &result); err != nil {
		return "", "", "", 0, fmt.Errorf("kiro sso: parse social exchange response: %w", err)
	}
	if result.AccessToken == "" {
		return "", "", "", 0, fmt.Errorf("kiro sso: empty access token in social exchange response")
	}
	if result.ExpiresIn <= 0 {
		result.ExpiresIn = 3600
	}
	return result.AccessToken, result.RefreshToken, result.ProfileArn, result.ExpiresIn, nil
}
