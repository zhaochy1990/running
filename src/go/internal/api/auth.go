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
	// TierAdmin is an administrator presenting a JWT for the separate admin
	// audience. Admin callers are denied by default and explicitly admitted only
	// by routes that define admin behavior.
	TierAdmin
)

// Caller is the authenticated identity attached to a request.
type Caller struct {
	Tier   Tier
	UserID string // JWT sub; set for user and admin JWT callers
}

const callerContextKey = "api.caller"

// ErrUnauthorized is returned by Authenticator when no valid credential is present.
var ErrUnauthorized = errors.New("unauthorized")

// JWTVerifier verifies RS256 end-user tokens against the auth-service public key.
type JWTVerifier struct {
	key           *rsa.PublicKey
	issuer        string
	audience      string
	adminAudience string
}

// NewJWTVerifier loads the RSA public key from a PEM file (ADR 0012: the key is
// public, delivered via config, and must match the in-house auth-service).
func NewJWTVerifier(pemPath, issuer, audience, adminAudience string) (*JWTVerifier, error) {
	pem, err := os.ReadFile(pemPath)
	if err != nil {
		return nil, fmt.Errorf("api: read public key: %w", err)
	}
	key, err := jwt.ParseRSAPublicKeyFromPEM(pem)
	if err != nil {
		return nil, fmt.Errorf("api: parse public key: %w", err)
	}
	return newJWTVerifier(key, issuer, audience, adminAudience)
}

// NewJWTVerifierFromKey builds a verifier from an in-memory key (tests).
func NewJWTVerifierFromKey(key *rsa.PublicKey, issuer, audience string) *JWTVerifier {
	verifier, _ := newJWTVerifier(key, issuer, audience, "")
	return verifier
}

// NewJWTVerifierFromKeyWithAdmin builds a verifier with a separate admin
// audience. Keeping this constructor explicit makes the elevated audience easy
// to spot in tests and prevents it from being enabled accidentally.
func NewJWTVerifierFromKeyWithAdmin(key *rsa.PublicKey, issuer, audience, adminAudience string) (*JWTVerifier, error) {
	return newJWTVerifier(key, issuer, audience, adminAudience)
}

func newJWTVerifier(key *rsa.PublicKey, issuer, audience, adminAudience string) (*JWTVerifier, error) {
	adminAudience = strings.TrimSpace(adminAudience)
	if adminAudience != "" && adminAudience == strings.TrimSpace(audience) {
		return nil, errors.New("api: admin audience must differ from user audience")
	}
	return &JWTVerifier{key: key, issuer: issuer, audience: audience, adminAudience: adminAudience}, nil
}

// Verify checks signature (RS256 only), issuer, an allowed audience, expiry, and
// the non-empty subject. Admin authority is granted only when both the dedicated
// admin audience and role=admin are present; role alone is never sufficient.
func (v *JWTVerifier) Verify(tokenString string) (Caller, error) {
	audiences := []string{v.audience}
	if v.adminAudience != "" && v.adminAudience != v.audience {
		audiences = append(audiences, v.adminAudience)
	}
	token, err := jwt.Parse(
		tokenString,
		func(t *jwt.Token) (any, error) { return v.key, nil },
		jwt.WithValidMethods([]string{"RS256"}),
		jwt.WithIssuer(v.issuer),
		jwt.WithAudience(audiences...),
		jwt.WithExpirationRequired(),
	)
	if err != nil {
		return Caller{}, err
	}
	claims, ok := token.Claims.(jwt.MapClaims)
	if !ok {
		return Caller{}, errors.New("api: unexpected claims type")
	}
	sub, _ := claims["sub"].(string)
	if sub == "" {
		return Caller{}, errors.New("api: token missing sub")
	}
	tier := TierUser
	if v.adminAudience != "" {
		claimAudiences, claimErr := claims.GetAudience()
		if claimErr != nil {
			return Caller{}, claimErr
		}
		if containsString(claimAudiences, v.adminAudience) {
			role, _ := claims["role"].(string)
			if role != "admin" {
				return Caller{}, errors.New("api: admin audience requires admin role")
			}
			tier = TierAdmin
		}
	}
	return Caller{Tier: tier, UserID: sub}, nil
}

func containsString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
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
		caller, err := a.verifier.Verify(strings.TrimPrefix(auth, prefix))
		if err != nil {
			return Caller{}, ErrUnauthorized
		}
		return caller, nil
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

// rejectAdminCaller keeps the admin-dashboard identity out of existing user and
// internal routes. A route that supports TierAdmin must be mounted directly on
// the parent authenticated group instead of the default-deny child group.
func rejectAdminCaller(c *gin.Context) {
	if callerFrom(c).Tier == TierAdmin {
		c.AbortWithStatusJSON(403, errorResponse{Error: "forbidden"})
		return
	}
	c.Next()
}

// callerFrom returns the authenticated caller stored by the middleware.
func callerFrom(c *gin.Context) Caller {
	v, _ := c.Get(callerContextKey)
	caller, _ := v.(Caller)
	return caller
}
