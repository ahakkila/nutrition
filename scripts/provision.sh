#!/usr/bin/env bash
# One-time nginx setup on the shared VPS; run through make provision.
set -euo pipefail
root=$1; user=$2; domain=$3; email=$4
command -v nginx >/dev/null
command -v certbot >/dev/null
getent passwd "$user" >/dev/null
getent ahosts "$domain" >/dev/null || { echo "Create DNS for $domain pointing to this VPS first." >&2; exit 1; }
sudo -v
sudo install -d -m 755 -o "$user" -g "$(id -gn "$user")" "$root" "$root/releases"
sudo install -d -m 755 /var/www/letsencrypt/.well-known/acme-challenge
target=/etc/nginx/sites-available/nutrition
link=/etc/nginx/sites-enabled/nutrition
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
if sudo test -e "$target"; then
    # Redirect into the local user's temporary directory, not a privileged file.
    # shellcheck disable=SC2024
    sudo cat "$target" > "$tmp/old"
fi
had_link=0
[[ -L "$link" ]] && had_link=1
install_config() {
    sudo install -m 644 "$tmp/site" "$target"
    sudo ln -sfn "$target" "$link"
    if ! sudo nginx -t; then
        if [[ -f "$tmp/old" ]]; then sudo install -m 644 "$tmp/old" "$target"; else sudo rm -f "$target"; fi
        if [[ "$had_link" == 0 ]]; then sudo rm -f "$link"; fi
        echo 'nginx rejected configuration; restored previous files.' >&2
        exit 1
    fi
    sudo systemctl reload nginx
}
http_config() {
    cat <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $domain;
    location ^~ /.well-known/acme-challenge/ { root /var/www/letsencrypt; }
    location / { return 301 https://$domain\$request_uri; }
}
EOF
}
cert=/etc/letsencrypt/live/$domain
if ! sudo test -f "$cert/fullchain.pem"; then
    http_config > "$tmp/site"
    install_config
    sudo certbot certonly --webroot -w /var/www/letsencrypt -d "$domain" \
        --cert-name "$domain" --email "$email" --non-interactive --agree-tos \
        --deploy-hook 'systemctl reload nginx'
fi
http_config > "$tmp/site"
cat >> "$tmp/site" <<EOF
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name $domain;
    ssl_certificate $cert/fullchain.pem;
    ssl_certificate_key $cert/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    root $root/current;
    index index.html;
    add_header Cache-Control "no-cache" always;
    add_header X-Content-Type-Options "nosniff" always;
    location = /version.json {
        add_header Cache-Control "no-store" always;
        try_files \$uri =404;
    }
    location = /sw.js {
        add_header Cache-Control "no-cache" always;
        add_header Service-Worker-Allowed "/" always;
        try_files \$uri =404;
    }
    location / { try_files \$uri \$uri/ =404; }
}
EOF
install_config
sudo systemctl enable --now certbot.timer
echo "Provisioned $domain. Run make deploy."
