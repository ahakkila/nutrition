#!/usr/bin/env bash
# Runs as the deploy account. Releases are immutable once activated.
set -euo pipefail
root=$1
release=$2
[[ "$root" =~ ^/[-a-zA-Z0-9_/]+$ && "$release" =~ ^[a-zA-Z0-9_-]+$ ]] || exit 2
cd "$root"
exec 9> .deploy.lock
flock -n 9 || { echo 'Another deployment is activating.' >&2; exit 1; }
test -f "releases/$release/index.html"
test -f "releases/$release/version.json"
old=$(readlink current || true)
if [[ "$old" == "releases/$release" ]]; then exit 0; fi
if [[ -n "$old" ]]; then
    ln -s "$old" "previous.$$"
    mv -Tf "previous.$$" previous
fi
ln -s "releases/$release" "current.$$"
mv -Tf "current.$$" current
echo "Activated $release (previous: ${old:-none})"
