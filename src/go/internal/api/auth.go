package api

import (
	"crypto/rsa"
	"crypto/subtle"
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
)

// Tier is which authenticated caller class made a request.
type Tier int

const (
	// TierInternal is a trusted server-to-server caller (X-Internal-Token).
	TierInternal Tier = iota
	// TierUser is an end user presenting an RS256 JWT (direct-browser tier).
	TierUser
)

// Caller is the authenticated identity attached to a request.
type Caller struct {
	Tier   Tier
	UserID string // JWT sub; set only for TierUser
}

const callerContextKey = "api.caller"

// ErrUnauthorized is returned by Authenticator when no valid credential is present.
var ErrUnauthorized = errors.New("unauthorized")

// JWTVerifier verifies RS256 end-user tokens against the auth-service public key.
type JWTVerifier struct {
	key      *rsa.PublicKey
	issuer   string
	audience string
}

// NewJWTVerifier loads the RSA public key from a PEM file (ADR 0012: the key is
// public, delivered via config, and must match the in-house auth-service).
func NewJWTVerifier(pemPath, issuer, audience string) (*JWTVerifier, error) {
	pem, err := os.ReadFile(pemPath)
	if err != nil {
		return nil, fmt.Errorf("api: read public key: %w", err)
	}
	key, err := jwt.ParseRSAPublicKeyFromPEM(pem)
	if err != nil {
		return nil, fmt.Errorf("api: parse public key: %w", err)
	}
	return NewJWTVerifierFromKey(key, issuer, audience), nil
}

// NewJWTVerifierFromKey builds a verifier from an in-memory key (tests).
func NewJWTVerifierFromKey(key *rsa.PublicKey, issuer, audience string) *JWTVerifier {
	return &JWTVerifier{key: key, issuer: issuer, audience: audience}
}

// Verify checks signature (RS256 only), issuer, audience and expiry, and returns
// the non-empty subject (user id) claim.
func (v *JWTVerifier) Verify(tokenString string) (string, error) {
	token, err := jwt.Parse(
		tokenString,
		func(t *jwt.Token) (any, error) { return v.key, nil },
		jwt.WithValidMethods([]string{"RS256"}),
		jwt.WithIssuer(v.issuer),
		jwt.WithAudience(v.audience),
		jwt.WithExpirationRequired(),
	)
	if err != nil {
		return "", err
	}
	claims, ok := token.Claims.(jwt.MapClaims)
	if !ok {
		return "", errors.New("api: unexpected claims type")
	}
	sub, _ := claims["sub"].(string)
	if sub == "" {
		return "", errors.New("api: token missing sub")
	}
	return sub, nil
}

// Authenticator resolves the tier of a request. The internal tier is a shared
// secret (X-Internal-Token); the user tier is an RS256 Bearer JWT. Verifier may
// be nil to disable the user tier (internal-only deployments / tests).
type Authenticator struct {
	internalToken string
	verifier      *JWTVerifier
}

// NewAuthenticator wires an Authenticator.
func NewAuthenticator(internalToken string, verifier *JWTVerifier) *Authenticator {
	return &Authenticator{internalToken: internalToken, verifier: verifier}
}

// authenticate inspects the request headers and returns the caller, or
// ErrUnauthorized. X-Internal-Token wins over a Bearer token if both are set.
func (a *Authenticator) authenticate(c *gin.Context) (Caller, error) {
	if tok := c.GetHeader("X-Internal-Token"); tok != "" {
		if a.internalToken != "" && subtle.ConstantTimeCompare([]byte(tok), []byte(a.internalToken)) == 1 {
			return Caller{Tier: TierInternal}, nil
		}
		return Caller{}, ErrUnauthorized
	}
	const prefix = "Bearer "
	if auth := c.GetHeader("Authorization"); strings.HasPrefix(auth, prefix) {
		if a.verifier == nil {
			return Caller{}, ErrUnauthorized
		}
		sub, err := a.verifier.Verify(strings.TrimPrefix(auth, prefix))
		if err != nil {
			return Caller{}, ErrUnauthorized
		}
		return Caller{Tier: TierUser, UserID: sub}, nil
	}
	return Caller{}, ErrUnauthorized
}

// middleware authenticates the request, aborting 401 on failure and otherwise
// stashing the Caller in the gin context.
func (a *Authenticator) middleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		caller, err := a.authenticate(c)
		if err != nil {
			c.AbortWithStatusJSON(401, errorResponse{Error: "unauthorized"})
			return
		}
		c.Set(callerContextKey, caller)
		c.Next()
	}
}

// callerFrom returns the authenticated caller stored by the middleware.
func callerFrom(c *gin.Context) Caller {
	v, _ := c.Get(callerContextKey)
	caller, _ := v.(Caller)
	return caller
}
