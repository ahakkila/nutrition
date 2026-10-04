#!/usr/bin/env bash
# Validated configuration values intentionally expand locally in SSH commands.
# shellcheck disable=SC2029
set -euo pipefail
cd "$(dirname "$0")/.."
action=${1:?action required}
config=${2:?config path required}
test -f "$config" || { echo "Copy deploy.conf.example to $config and fill in the settings." >&2; exit 1; }
# Read literal KEY=value settings; never execute config contents.
while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    key=${line%%=*}; value=${line#*=}
    case "$key" in ADMIN_HOST|DEPLOY_HOST|DEPLOY_DIR|DOMAIN|CERT_EMAIL) printf -v "$key" '%s' "$value" ;;
        *) echo "Unknown setting: $key" >&2; exit 2;; esac
done < "$config"
: "${ADMIN_HOST:?missing ADMIN_HOST}" "${DEPLOY_HOST:?missing DEPLOY_HOST}" "${DEPLOY_DIR:?missing DEPLOY_DIR}" "${DOMAIN:?missing DOMAIN}" "${CERT_EMAIL:?missing CERT_EMAIL}"
[[ "$ADMIN_HOST" =~ ^([a-z_][a-z0-9_-]*@)?[a-zA-Z0-9.-]+$ ]] || exit 2
[[ "$DEPLOY_HOST" =~ ^[a-z_][a-z0-9_-]*@[a-zA-Z0-9.-]+$ ]] || exit 2
[[ "$DEPLOY_DIR" =~ ^/var/www/[a-zA-Z0-9_-]+$ ]] || exit 2
[[ "$DOMAIN" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,}$ ]] || exit 2
[[ "$CERT_EMAIL" =~ ^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+$ ]] || exit 2
ssh_opts=(-o BatchMode=yes -o ConnectTimeout=10)
activate() {
    ssh "${ssh_opts[@]}" "$DEPLOY_HOST" "bash -s -- '$DEPLOY_DIR' '$1'" < scripts/activate.sh
}
verify() {
    curl --fail --silent --show-error "https://$DOMAIN/" >/dev/null
    curl --fail --silent --show-error -H 'Cache-Control: no-cache' "https://$DOMAIN/version.json"
    echo
}
case "$action" in
    provision)
        # Leave stdin attached to the terminal for sudo; script is passed as data.
        encoded=$(base64 -w0 scripts/provision.sh)
        ssh -t "$ADMIN_HOST" "printf '%s' '$encoded' | base64 -d | bash -s -- '$DEPLOY_DIR' '${DEPLOY_HOST%%@*}' '$DOMAIN' '$CERT_EMAIL'"
        ;;
    deploy)
        make check
        ssh "${ssh_opts[@]}" "$DEPLOY_HOST" "test -d '$DEPLOY_DIR/releases'" || { echo 'Run make provision first.' >&2; exit 1; }
        stage=$(mktemp -d)
        trap 'rm -rf "$stage"' EXIT
        # Explicit public-file allowlist excludes Git, scripts, configs and secrets.
        cp index.html styles.css script.js storage.js sw.js manifest.webmanifest version.json "$stage/"
        cp -R icons "$stage/"
        revision_script="$PWD/revision.js"
        (cd "$stage"; node "$revision_script")
        release="$(date -u +%Y%m%d%H%M%S)-$(git rev-parse --short HEAD)-$RANDOM"
        # A new worker per release guarantees the offline app shell refreshes.
        sed -i "s/^const CACHE_NAME = .*;/const CACHE_NAME = 'rooted-$release';/" "$stage/sw.js"
        ssh "${ssh_opts[@]}" "$DEPLOY_HOST" "mkdir '$DEPLOY_DIR/releases/$release'"
        rsync -rz --chmod=D755,F644 -e 'ssh -o BatchMode=yes -o ConnectTimeout=10' "$stage/" "$DEPLOY_HOST:$DEPLOY_DIR/releases/$release/"
        activate "$release"
        remote=$(curl --fail --silent --show-error -H 'Cache-Control: no-cache' "https://$DOMAIN/version.json")
        if ! diff -u "$stage/version.json" <(printf '%s\n' "$remote"); then
            echo 'Public revision does not match. Inspect DNS/nginx; make rollback restores the previous release.' >&2
            exit 1
        fi
        verify
        ;;
    rollback)
        previous=$(ssh "${ssh_opts[@]}" "$DEPLOY_HOST" "readlink '$DEPLOY_DIR/previous'")
        [[ "$previous" =~ ^releases/[a-zA-Z0-9_-]+$ ]] || { echo 'No valid previous release.' >&2; exit 1; }
        activate "${previous#releases/}"
        verify
        ;;
    verify) verify ;;
    *) echo "Unknown action: $action" >&2; exit 2 ;;
esac
