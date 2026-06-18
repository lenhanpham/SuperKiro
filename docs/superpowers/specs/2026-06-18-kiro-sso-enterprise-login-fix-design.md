# Kiro SSO Enterprise Login Fix — Design Spec

**Date**: 2026-06-18
**Status**: Draft
**Problem**: Enterprise SSO login ("Login via your Organization") fails at the token exchange step with Azure AD scope error.

## Error Evidence

```
AADSTS700054: The app instance '81704597-0f0e-4035-9a56-5415b3378180' 
requested scope 'codewhisperer:completions codewhisperer:analysis 
codewhisperer:conversations offline_access' is not in the list of 
registered scopes.
```

The Azure AD enterprise app does not have Kiro Cognito scopes registered. Enterprise apps expect scopes like `api://<app-id>/codewhisperer:conversations offline_access`.

## Root Cause Analysis

### Primary Issue: Wrong Scopes in Token Exchange

The Kiro portal sends enterprise-specific scopes in the `/signin/callback` descriptor. These must be used verbatim for the IdP token exchange. The error shows Kiro Cognito scopes being sent instead.

**Possible causes**:
1. Portal sends different scopes depending on tenant configuration
2. User pasting the wrong URL (enterprise descriptor vs IdP callback)
3. Scope extraction failing silently (URL encoding issue)

### Secondary Issues (All Must Be Fixed)

| # | Issue | Severity | Reference Location | SuperKiro Location |
|---|-------|----------|-------------------|-------------------|
| 1 | Missing `login_hint` in IdP auth URL | CRITICAL | `social.go:238-252` | `kiro_enterprise.go:111` |
| 2 | Missing `login_hint` extraction from callback | CRITICAL | `social.go:432` | `handler.go:4991-4994` |
| 3 | Missing headers in ListAvailableProfiles | HIGH | `kiro.go:559-569` | `oidc.go:186-192` |
| 4 | Wrong User-Agent format (no machine ID) | HIGH | `constants.go:147` | `oidc.go:261` |
| 5 | Missing `TokenType: EXTERNAL_IDP` in DiscoverProfileArn | HIGH | `kiro.go:572-574` | `oidc.go:165-228` |
| 6 | Wrong ListProfiles endpoint URL | MEDIUM | `constants.go:121` | `oidc.go:175-179` |
| 7 | No loopback listener (manual URL paste) | UX | `social.go:391-564` | N/A |
| 8 | Wrong Accept header in ListProfiles | MEDIUM | `kiro.go:560` | `oidc.go:190` |
| 9 | No state validation in exchange | LOW | `social.go:489` | `handler.go:5052` |
| 10 | Session expiry race (15min TTL) | LOW | N/A | `kiro_sso.go:69` |

## Detailed Differences

### 1. Missing `login_hint` (CRITICAL)

**Reference** (`social.go:238-252`):
```go
func ExternalIdpAuthorizeURL(authEndpoint, clientID, redirectURI, scopes, challenge, state, loginHint string) string {
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
        q.Set("login_hint", loginHint)
    }
    return authEndpoint + "?" + q.Encode()
}
```

**SuperKiro** (`kiro_enterprise.go:111`):
```go
func BuildExternalIdpAuthorizeURL(authEndpoint, clientID, redirectURI, scopes, challenge, state string) string {
    q := url.Values{}
    q.Set("client_id", clientID)
    q.Set("response_type", "code")
    q.Set("redirect_uri", redirectURI)
    q.Set("scope", scopes)
    q.Set("code_challenge", challenge)
    q.Set("code_challenge_method", "S256")
    q.Set("response_mode", "query")
    q.Set("state", state)
    return authEndpoint + "?" + q.Encode()
}
```

**Missing**: `loginHint` parameter not accepted, not extracted from callback URL, not sent to IdP.

**Impact**: Microsoft may prompt for email selection, show wrong tenant, or fail MFA flow.

### 2. Missing Headers in ListAvailableProfiles

**Reference** sends these headers that SuperKiro does not:
```
amz-sdk-invocation-id: <machine-id-hash>
amz-sdk-request: attempt=1; max=1
x-amzn-kiro-agent-mode: vibe
x-amzn-codewhisperer-optout: true
x-amz-user-agent: aws-sdk-js/1.0.0 KiroIDE-0.10.32-<machine-id>
User-Agent: aws-sdk-js/1.0.0 ua/2.1 os/windows#10.0.26200 lang/js md/nodejs#22.21.1 api/codewhispererruntime#1.0.0 m/N,E KiroIDE-0.10.32-<machine-id>
```

**SuperKiro** sends:
```
User-Agent: aws-sdk-js/1.0.0 KiroIDE-0.10.32
```

**Impact**: CodeWhisperer may reject requests or return empty profiles, blocking profileArn resolution.

### 3. Wrong Endpoint URL

**Reference**: `https://codewhisperer.{region}.amazonaws.com/` (root path, routing via X-Amz-Target)

**SuperKiro**:
- us-east-1: `https://codewhisperer.us-east-1.amazonaws.com/ListAvailableProfiles`
- Other: `https://q.{region}.amazonaws.com/ListAvailableProfiles`

**Impact**: Wrong host for non-us-east-1 regions; path-based routing may not work.

### 4. Missing `TokenType: EXTERNAL_IDP` in DiscoverProfileArn

**Reference**: Sets `TokenType: EXTERNAL_IDP` for enterprise tokens in `ListAvailableProfiles`.

**SuperKiro**: `DiscoverProfileArn` does not accept `externalIdp` parameter. Enterprise tokens silently get empty profile lists.

## Fix Plan

### Phase 1: Scope Investigation & Logging (Immediate)

**Goal**: Determine why wrong scopes are being sent.

1. **Add scope logging** in `apiKiroEnterpriseStart`:
   ```go
   log.Printf("[SSO-Enterprise] scopes from callback: %q", scopes)
   ```
2. **Add scope logging** in `ExchangeExternalIdpCode`:
   ```go
   log.Printf("[SSO-Enterprise] exchanging with scopes: %q", scopes)
   ```
3. **Test**: Reproduce the error and check logs to see what scopes the portal actually sends.

### Phase 2: Critical Fixes

**Files to modify**:
- `auth/kiro_enterprise.go`
- `auth/oidc.go`
- `proxy/handler.go`

#### Fix 1: Add `login_hint` to enterprise flow

`auth/kiro_enterprise.go`:
```go
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
        q.Set("login_hint", loginHint)
    }
    return authEndpoint + "?" + q.Encode()
}
```

`proxy/handler.go` in `apiKiroEnterpriseStart`:
```go
loginHint := strings.TrimSpace(q.Get("login_hint"))
// ...
idpAuthURL := auth.BuildExternalIdpAuthorizeURL(authEndpoint, clientID2, redirectURI, scopes, pkce2.Challenge, pkce2.State, loginHint)
```

#### Fix 2: Fix ListProfiles headers

`auth/oidc.go` in `ListProfiles`:
```go
func ListProfiles(accessToken, region string, externalIdp bool) string {
    // ... existing code ...
    
    machineID := deriveMachineID(accessToken, region)
    
    req.Header.Set("Content-Type", "application/x-amz-json-1.0")
    req.Header.Set("Accept", "application/x-amz-json-1.0")
    req.Header.Set("x-amz-target", "AmazonCodeWhispererService.ListAvailableProfiles")
    req.Header.Set("Authorization", "Bearer "+accessToken)
    req.Header.Set("amz-sdk-invocation-id", machineID)
    req.Header.Set("amz-sdk-request", "attempt=1; max=1")
    req.Header.Set("x-amzn-kiro-agent-mode", "vibe")
    req.Header.Set("x-amzn-codewhisperer-optout", "true")
    req.Header.Set("User-Agent", fmt.Sprintf("aws-sdk-js/1.0.0 ua/2.1 os/windows#10.0.26200 lang/js md/nodejs#22.21.1 api/codewhispererruntime#1.0.0 m/N,E KiroIDE-0.10.32-%s", machineID))
    req.Header.Set("x-amz-user-agent", fmt.Sprintf("aws-sdk-js/1.0.0 KiroIDE-0.10.32-%s", machineID))
    if externalIdp {
        req.Header.Set("TokenType", "EXTERNAL_IDP")
    }
    // ... rest of function ...
}
```

#### Fix 3: Fix ListProfiles endpoint URL

`auth/oidc.go`:
```go
func listProfilesHost(region string) string {
    if region == "" {
        region = "us-east-1"
    }
    return fmt.Sprintf("https://codewhisperer.%s.amazonaws.com", strings.ToLower(region))
}
```

Update `ListProfiles` and `DiscoverProfileArn` to use `listProfilesHost(region) + "/"` instead of path-based routing.

#### Fix 4: Add `TokenType: EXTERNAL_IDP` to DiscoverProfileArn

`auth/oidc.go`:
```go
func DiscoverProfileArn(accessToken, region string, externalIdp bool) string {
    // ... add externalIdp parameter ...
    // ... set TokenType header when externalIdp is true ...
}
```

Update all callers to pass the `externalIdp` parameter.

#### Fix 5: Add state validation

`proxy/handler.go` in `apiKiroSsoExchange`:
```go
state := strings.TrimSpace(q.Get("state"))
if state != "" && session.PKCE != nil && state != session.PKCE.State {
    // State mismatch — possible CSRF
    w.WriteHeader(400)
    json.NewEncoder(w).Encode(map[string]string{"error": "State mismatch"})
    return
}
```

### Phase 3: Loopback Listener (Optional Enhancement)

**Goal**: Eliminate manual URL paste for better UX.

Create `auth/kiro_listener.go`:
- Bind `127.0.0.1:3128` and `[::1]:3128`
- Handle `/signin/callback` → extract enterprise descriptor, auto-redirect to IdP
- Handle `/oauth/callback` → extract code, auto-exchange
- Handle `/?code=...` → social code exchange
- Use session store for state management
- Return result via channel

This matches the reference implementation's `StartKiroLoginListener`.

## Testing

1. **Scope investigation**: Reproduce error, check logs for actual scopes sent
2. **Enterprise login**: Complete full enterprise SSO flow after fixes
3. **Social login**: Verify Google/GitHub SSO still works
4. **BuilderID login**: Verify BuilderID login still works
5. **Token refresh**: Verify enterprise token refresh works
6. **ProfileArn resolution**: Verify enterprise accounts get profileArn

## Risk Assessment

- **Scope issue**: May be a Kiro portal configuration issue, not a SuperKiro bug. Need investigation first.
- **login_hint**: High confidence this fixes Microsoft MFA flow.
- **Headers**: May be needed for CodeWhisperer to accept requests.
- **Endpoint URL**: May cause failures for non-us-east-1 regions.
