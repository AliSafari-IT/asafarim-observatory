#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
unformatted=$(gofmt -l cmd repository api)
if [ -n "$unformatted" ]; then
    printf 'Run gofmt on:\n%s\n' "$unformatted" >&2
    exit 1
fi
go vet ./...
go test ./...
go build -o bin/observatory ./cmd/observatory
go build -o bin/observatory-api ./cmd/observatory-api
go build -o bin/observatory-receive ./cmd/observatory-receive
go build -o bin/observatory-upload ./cmd/observatory-upload
python3 -m unittest discover -s analysis/tests -v
