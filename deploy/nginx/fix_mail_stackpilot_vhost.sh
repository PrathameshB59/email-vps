#!/usr/bin/env bash
set -euo pipefail

MAIL_HOST="mail.stackpilot.in"
UPSTREAM="http://127.0.0.1:8081"
REPO_CONF="/home/devuser/dev/email-vps/deploy/nginx/mail.stackpilot.in.conf"
NGINX_AVAIL_DIR="/etc/nginx/sites-available"
NGINX_ENAB_DIR="/etc/nginx/sites-enabled"
DEFAULT_SITE="${NGINX_AVAIL_DIR}/default"
MAIL_SITE="${NGINX_AVAIL_DIR}/mail.stackpilot.in"
STAMP="$(date +%Y%m%d%H%M%S)"
BACKUP_DIR="/root/nginx-backups-${STAMP}"

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo bash $0"
  exit 1
fi

if [[ ! -f "$REPO_CONF" ]]; then
  echo "Missing repo config: $REPO_CONF"
  exit 1
fi

# Ensure backup directory exists outside sites-enabled include path.
mkdir -p "$BACKUP_DIR"

# 1) Backups
cp -a "$DEFAULT_SITE" "${BACKUP_DIR}/default"
if [[ -e "${NGINX_ENAB_DIR}/default" ]]; then
  cp -a "${NGINX_ENAB_DIR}/default" "${BACKUP_DIR}/sites-enabled-default-link"
fi
if [[ -e "$MAIL_SITE" ]]; then
  cp -a "$MAIL_SITE" "${BACKUP_DIR}/mail.stackpilot.in"
fi

# 2) Install dedicated mail site from repo
cp "$REPO_CONF" "$MAIL_SITE"

# 3) Ensure upstream target is correct
if ! grep -q "proxy_pass ${UPSTREAM};" "$MAIL_SITE"; then
  echo "WARNING: ${MAIL_SITE} does not point to ${UPSTREAM}."
  echo "Check file before continuing."
fi

# 4) Enable dedicated mail site symlink
ln -sfn "$MAIL_SITE" "${NGINX_ENAB_DIR}/mail.stackpilot.in"

# 4.1) Remove stale backup symlinks accidentally left in sites-enabled by previous runs.
find "$NGINX_ENAB_DIR" -maxdepth 1 -type l -name '*.bak-*' -print -delete || true

# 5) Remove Certbot-added mail host blocks from default site (full server blocks)
TMP_FILE="$(mktemp)"
awk '
function countchar(str, ch,  i, c) {
  c=0
  for (i=1; i<=length(str); i++) if (substr(str,i,1)==ch) c++
  return c
}
BEGIN { inserver=0; depth=0; block=""; hasmail=0 }
{
  if (!inserver) {
    if ($0 ~ /^[[:space:]]*server[[:space:]]*\{/) {
      inserver=1
      depth=0
      block=""
      hasmail=0
    } else {
      print $0
      next
    }
  }

  block = block $0 ORS
  if ($0 ~ /server_name[[:space:]]+mail\.stackpilot\.in/) hasmail=1

  depth += countchar($0, "{") - countchar($0, "}")

  if (depth == 0) {
    if (!hasmail) printf "%s", block
    inserver=0
    block=""
    hasmail=0
  }
}
END {
  if (inserver && !hasmail) printf "%s", block
}
' "$DEFAULT_SITE" > "$TMP_FILE"
cat "$TMP_FILE" > "$DEFAULT_SITE"
rm -f "$TMP_FILE"

# 6) Validate single authoritative server_name for mail host
MATCHES="$(grep -R --line-number "server_name[[:space:]]\\+${MAIL_HOST}" "$NGINX_ENAB_DIR" || true)"
if [[ -z "$MATCHES" ]]; then
  echo "ERROR: no server_name ${MAIL_HOST} found after changes"
  exit 1
fi

echo "server_name matches:"
echo "$MATCHES"

# 7) Test and reload nginx
nginx -t
systemctl reload nginx

# 8) Quick live checks
echo
echo "HTTP -> HTTPS check"
curl -I "http://${MAIL_HOST}/login" || true
echo
echo "HTTPS route check"
curl -I "https://${MAIL_HOST}/login" || true

echo
echo "Done."
echo "Backup folder: $BACKUP_DIR"
