# Makefile for the Go async-job worker + HTTP API (src/go).

SWAG_VERSION := v1.16.6

.PHONY: build build-api swagger test vet fmt

# Default build: worker + api (no Swagger UI compiled in).
build:
	go build ./...

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
