//go:build !swagger

package api

import "github.com/gin-gonic/gin"

// mountSwagger is a no-op in the default build. The Swagger UI + generated docs
// package are compiled in only with `-tags swagger` (after `swag init` has run),
// so plain `go build`/`go test` never need the generated code (ADR 0012).
func mountSwagger(_ *gin.Engine, _ bool) {}
