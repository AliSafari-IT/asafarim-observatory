#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
unformatted=$(gofmt -l cmd repository)
if [ -n "$unformatted" ]; then
    printf 'Run gofmt on:\n%s\n' "$unformatted" >&2
    exit 1
fi
go vet ./...
go test ./...
go build -o bin/observatory ./cmd/observatory
