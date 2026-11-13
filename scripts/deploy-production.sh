#!/usr/bin/env bash
set -Eeuo pipefail

image_tag="${1:-}"
if [[ ! "$image_tag" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Expected a 40-character lowercase commit SHA." >&2
  exit 2
fi

runtime_dir="/opt/asafarim-observatory/runtime"
compose_file="$runtime_dir/compose.yml"
archive="/tmp/observatory-$image_tag.tar.gz"
image="asafarim-observatory:$image_tag"
deployment_started=0

if [[ ! -r "$compose_file" ]]; then
  echo "Production Compose file is unavailable: $compose_file" >&2
  exit 1
fi
if [[ ! -s "$archive" ]]; then
  echo "Production image archive is missing or empty: $archive" >&2
  exit 1
fi

previous_image="$(docker inspect --format '{{.Config.Image}}' observatory-gateway)"
if [[ ! "$previous_image" =~ ^asafarim-observatory:[A-Za-z0-9._-]+$ ]]; then
  echo "Unexpected current Observatory image reference; refusing deployment." >&2
  exit 1
fi
docker image inspect "$previous_image" >/dev/null

override_file="$(mktemp /tmp/observatory-compose-XXXXXX.yml)"
compose() {
  docker compose \
    --project-directory "$runtime_dir" \
    --project-name asafarim-observatory \
    --file "$compose_file" \
    --file "$override_file" \
    "$@"
}

cleanup() {
  result=$?
  trap - EXIT
  if (( result != 0 && deployment_started == 1 )); then
    printf 'services:\n  app:\n    image: "%s"\n' "$previous_image" > "$override_file"
    if compose up --detach --force-recreate --no-deps app; then
      echo "Deployment failed; restored $previous_image." >&2
    else
      echo "Deployment failed and automatic rollback to $previous_image also failed." >&2
    fi
  fi
  rm -f -- "$archive" "$override_file" "$0"
  exit "$result"
}
trap cleanup EXIT

gzip --decompress --stdout "$archive" | docker load
docker image inspect "$image" >/dev/null
printf 'services:\n  app:\n    image: "%s"\n' "$image" > "$override_file"

deployment_started=1
compose up --detach --force-recreate --no-deps app

healthy=0
for attempt in $(seq 1 30); do
  if docker exec observatory-gateway node --input-type=module -e '
    const expected = process.argv[1];
    const response = await fetch("http://127.0.0.1:8080/healthz");
    const health = await response.json();
    if (!response.ok || health.status !== "ok" || health.revision !== expected) {
      console.error("The gateway did not report the expected healthy revision.");
      process.exit(1);
    }
  ' "$image_tag"; then
    healthy=1
    break
  fi
  sleep 2
done

if (( healthy != 1 )); then
  echo "Production gateway did not become healthy on revision $image_tag." >&2
  exit 1
fi

actual_image="$(docker inspect --format '{{.Config.Image}}' observatory-gateway)"
if [[ "$actual_image" != "$image" ]]; then
  echo "Production is running $actual_image instead of $image." >&2
  exit 1
fi

deployment_started=0
echo "Deployed and verified $image."
