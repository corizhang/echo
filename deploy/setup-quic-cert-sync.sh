#!/usr/bin/env bash
set -Eeuo pipefail

CONFIG_FILE=/etc/echo-quic-cert-sync.conf
SCRIPT_DEST=/usr/local/sbin/echo-quic-cert-sync
SERVICE_FILE=/etc/systemd/system/echo-quic-cert-sync.service
TIMER_FILE=/etc/systemd/system/echo-quic-cert-sync.timer

die() { echo "ERROR: $*" >&2; exit 1; }

install_sync() {
  local domain=${1:-} project_dir=${2:-$PWD} data_dir=${3:-}
  [[ $EUID -eq 0 ]] || die "请使用 sudo 运行此脚本。"
  [[ $domain =~ ^[A-Za-z0-9.-]+$ ]] || die "请提供有效域名，例如 echo.example.com。"
  [[ -f "$project_dir/docker-compose.yml" && -f "$project_dir/.env" ]] || die "项目目录必须包含 docker-compose.yml 和 .env。"

  if [[ -z $data_dir ]]; then
    local caddy_home
    caddy_home=$(getent passwd caddy | cut -d: -f6 || true)
    for candidate in \
      /var/lib/caddy/.local/share/caddy \
      "${caddy_home:+$caddy_home/.local/share/caddy}" \
      /root/.local/share/caddy; do
      if [[ -d "$candidate/certificates" ]]; then data_dir=$candidate; break; fi
    done
  fi
  [[ -n $data_dir && -d "$data_dir/certificates" ]] || die "找不到 Caddy 证书存储目录。请传入该目录作为第三个参数。"
  data_dir=$(cd "$data_dir" && pwd)
  project_dir=$(cd "$project_dir" && pwd)

  install -o root -g root -m 755 "$0" "$SCRIPT_DEST"
  {
    printf 'QUIC_DOMAIN=%q\n' "$domain"
    printf 'ECHO_PROJECT_DIR=%q\n' "$project_dir"
    printf 'CADDY_DATA_DIR=%q\n' "$data_dir"
  } > "$CONFIG_FILE"
  chmod 600 "$CONFIG_FILE"

  cat > "$SERVICE_FILE" <<'UNIT'
[Unit]
Description=Sync renewed Caddy certificate to Echo QUIC relay
After=caddy.service docker.service

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/echo-quic-cert-sync
UNIT

  cat > "$TIMER_FILE" <<'UNIT'
[Unit]
Description=Check Caddy certificate for Echo QUIC relay

[Timer]
OnCalendar=daily
RandomizedDelaySec=15m
Persistent=true

[Install]
WantedBy=timers.target
UNIT

  chmod 644 "$SERVICE_FILE" "$TIMER_FILE"
  systemctl daemon-reload
  systemctl enable --now echo-quic-cert-sync.timer
  "$SCRIPT_DEST" --deploy
  echo "已配置 QUIC 证书同步及每日检查。固定证书路径：/opt/echo/quic-certs/echo.crt 和 echo.key"
  echo "还需在云安全组及系统防火墙开放 UDP 40000。"
}

sync_certificate() {
  [[ $EUID -eq 0 ]] || die "证书同步服务需要 root 权限。"
  [[ -f $CONFIG_FILE ]] || die "未找到配置文件，请先运行安装模式。"
  # shellcheck disable=SC1090
  source "$CONFIG_FILE"

  local cert_root="$CADDY_DATA_DIR/certificates"
  local source_cert= source_key= best_expiry=0 candidate expiry expiry_text
  while IFS= read -r -d '' candidate; do
    [[ -f ${candidate%.crt}.key ]] || continue
    openssl x509 -in "$candidate" -noout -checkhost "$QUIC_DOMAIN" >/dev/null 2>&1 || continue
    # Ignore expired certificates and certificates that expire within a day.
    openssl x509 -in "$candidate" -noout -checkend 86400 >/dev/null 2>&1 || continue
    expiry_text=$(openssl x509 -in "$candidate" -noout -enddate | cut -d= -f2)
    expiry=$(date -d "$expiry_text" +%s 2>/dev/null || echo 0)
    if [[ $expiry =~ ^[0-9]+$ ]] && (( expiry > best_expiry )); then
      source_cert=$candidate
      source_key=${candidate%.crt}.key
      best_expiry=$expiry
    fi
  done < <(find "$cert_root" -type f -path "*/$QUIC_DOMAIN/$QUIC_DOMAIN.crt" -print0 2>/dev/null)
  [[ -n $source_cert && -n $source_key ]] || die "Caddy 中找不到域名 $QUIC_DOMAIN 的有效证书/私钥。"

  local cert_pub key_pub
  cert_pub=$(openssl x509 -in "$source_cert" -pubkey -noout | openssl pkey -pubin -outform DER 2>/dev/null | sha256sum | cut -d' ' -f1)
  key_pub=$(openssl pkey -in "$source_key" -pubout -outform DER 2>/dev/null | sha256sum | cut -d' ' -f1)
  [[ -n $cert_pub && $cert_pub == "$key_pub" ]] || die "Caddy 证书和私钥不匹配。"

  local target_dir=/opt/echo/quic-certs target_cert=/opt/echo/quic-certs/echo.crt target_key=/opt/echo/quic-certs/echo.key old_fingerprint new_fingerprint tmpdir
  mkdir -p "$target_dir"
  chown root:10001 "$target_dir"
  chmod 750 "$target_dir"
  old_fingerprint=$(openssl x509 -in "$target_cert" -noout -fingerprint -sha256 2>/dev/null || true)
  new_fingerprint=$(openssl x509 -in "$source_cert" -noout -fingerprint -sha256)

  if [[ $old_fingerprint != "$new_fingerprint" ]]; then
    tmpdir=$(mktemp -d "$target_dir/.sync.XXXXXX")
    trap 'rm -rf "$tmpdir"' EXIT
    install -o root -g 10001 -m 640 "$source_cert" "$tmpdir/echo.crt"
    install -o root -g 10001 -m 640 "$source_key" "$tmpdir/echo.key"
    mv -f "$tmpdir/echo.crt" "$target_cert"
    mv -f "$tmpdir/echo.key" "$target_key"
    rmdir "$tmpdir"
    trap - EXIT
    update_compose_env "$ECHO_PROJECT_DIR/.env"
    echo "Caddy 证书已更新，重建 QUIC relay 容器证书挂载。"
  elif [[ ${1:-} != --deploy ]]; then
    echo "Caddy 证书未变化，无需重启 QUIC relay。"
    return 0
  fi

  local -a compose_args=(compose --profile quic up -d --force-recreate)
  [[ ${1:-} == --deploy ]] && compose_args+=(--build)
  (cd "$ECHO_PROJECT_DIR" && docker "${compose_args[@]}" game-quic-relay)
}

update_compose_env() {
  local env_file=$1 tmp mode owner
  [[ -f $env_file ]] || die "找不到 $env_file。"
  tmp=$(mktemp "${env_file}.XXXXXX")
  mode=$(stat -c '%a' "$env_file")
  owner=$(stat -c '%u:%g' "$env_file")
  awk '
    BEGIN { cert=0; key=0 }
    /^ECHO_QUIC_CERT_FILE=/ { print "ECHO_QUIC_CERT_FILE=/opt/echo/quic-certs/echo.crt"; cert=1; next }
    /^ECHO_QUIC_KEY_FILE=/ { print "ECHO_QUIC_KEY_FILE=/opt/echo/quic-certs/echo.key"; key=1; next }
    { print }
    END {
      if (!cert) print "ECHO_QUIC_CERT_FILE=/opt/echo/quic-certs/echo.crt"
      if (!key) print "ECHO_QUIC_KEY_FILE=/opt/echo/quic-certs/echo.key"
    }
  ' "$env_file" > "$tmp"
  chmod "$mode" "$tmp"
  chown "$owner" "$tmp"
  mv -f "$tmp" "$env_file"
}

if [[ ${1:-} == --install ]]; then
  shift
  install_sync "$@"
elif [[ $# -gt 0 && ${1:-} != --deploy ]]; then
  install_sync "$@"
else
  sync_certificate "${1:-}"
fi
