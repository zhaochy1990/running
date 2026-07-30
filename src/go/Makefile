# Makefile for the unified STRIDE Go binary (src/go). One `stride` executable
# bundles every service as a cobra subcommand (`stride worker`, `stride api`,
# `stride reconcile`, `stride watch ...`); containers just set the entrypoint.

SWAG_VERSION := v1.16.6

.PHONY: build build-stride build-stride-swagger swagger test vet fmt

# Compile-check every package (no output binary emitted to out/).
build:
	go build ./...

# Build the single binary to out/stride (WITHOUT the Swagger UI). Use
# `make build-stride-swagger` for the Swagger-enabled build.
build-stride:
	go build -o out/stride ./cmd/stride

# Generate the OpenAPI/Swagger docs (cmd/stride/docs). Committed (ADR 0014) and
# regenerated here; the general API info lives on cmd/stride/main.go.
swagger:
	go run github.com/swaggo/swag/cmd/swag@$(SWAG_VERSION) init -g cmd/stride/main.go -o cmd/stride/docs --parseInternal

# Build the binary with the Swagger UI compiled in (requires `make swagger`).
# The UI is served by `stride api` when api.swagger-enabled is true.
build-stride-swagger: swagger
	go build -tags swagger -o out/stride ./cmd/stride

test:
	go test ./...

vet:
	go vet ./...

fmt:
	gofmt -w .
