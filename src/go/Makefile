# Makefile for the Go async-job worker + HTTP API (src/go).

SWAG_VERSION := v1.16.6

.PHONY: build build-all build-worker build-reconcile build-stride-sync build-api swagger test vet fmt

# Compile-check every package (no output binaries emitted to out/).
build:
	go build ./...

# Build every binary to out/. The api is built WITHOUT the Swagger UI; use
# `make build-api` for the Swagger-enabled api binary.
build-all: build-worker build-reconcile build-stride-sync
	go build -o out/api ./cmd/api

# Individual binaries -> out/<name>.
build-worker:
	go build -o out/worker ./cmd/worker

build-reconcile:
	go build -o out/reconcile ./cmd/reconcile

build-stride-sync:
	go build -o out/stride-sync ./cmd/stride-sync

# Generate the OpenAPI/Swagger docs for cmd/api. Output (cmd/api/docs) is
# git-ignored and produced at build time, never committed (ADR 0012).
swagger:
	go run github.com/swaggo/swag/cmd/swag@$(SWAG_VERSION) init -g cmd/api/main.go -o cmd/api/docs --parseInternal

# Build the api binary with the Swagger UI compiled in (requires `make swagger`).
build-api: swagger
	go build -tags swagger -o out/api ./cmd/api

test:
	go test ./...

vet:
	go vet ./...

fmt:
	gofmt -w .
