# Commit the generated Swagger docs package

**Status:** accepted — supersedes the "generate-at-build, do not commit" sub-decision of ADR 0012.

ADR 0012 generated the `cmd/api/docs` Swagger package at build and git-ignored it. That left `go mod tidy` broken on a fresh checkout: tidy analyses the import graph under **all** build tags, and under `-tags swagger` the tagged `internal/api/swagger.go` imports `github.com/zhaochy1990/stride/cmd/api/docs`, which does not exist until `swag init` runs — so tidy fails with `cannot find module providing package .../cmd/api/docs`, even though plain `go build`/`go test` (which compile the `!swagger` stub) are fine. We now **commit** the generated `cmd/api/docs/` package.

## Consequences

- `go mod tidy`, `go build -tags swagger ./cmd/api`, and IDE/module analysis all work on a fresh checkout with no `swag init` prestep.
- The generated code now lives in the tree and can drift from the handler `// @...` annotations. Mitigation: `make swagger` stays the single regenerator, and CI should run it and fail on a non-empty `git diff` — the drift-check ADR 0012 named as the explicit trade-off of committing. Regenerate after changing any handler annotation.
