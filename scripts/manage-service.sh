#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="space-gpu-runner"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
NODE_BIN="$(command -v node || echo "/usr/bin/node")"
PORT_VAL="${PORT:-4300}"
PW_VAL="${RUNNER_PASSWORD:-cycy}"
USER_SYSTEMD_DIR="${HOME}/.config/systemd/user"
UNIT_FILE="${USER_SYSTEMD_DIR}/${SERVICE_NAME}.service"

ACTION="${1:-status}"

case "${ACTION}" in
  install)
    mkdir -p "${USER_SYSTEMD_DIR}"
    cat > "${UNIT_FILE}" <<EOF
[Unit]
Description=SPACE Multi-Site GPU Auto-Allocator & Admin Run-Approval Daemon
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
Environment=PORT=${PORT_VAL}
Environment=RUNNER_PASSWORD=${PW_VAL}
ExecStart=${NODE_BIN} ${APP_DIR}/server.mjs
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable --now "${SERVICE_NAME}.service"
    loginctl enable-linger "${USER}" 2>/dev/null || true
    echo "[OK] ${SERVICE_NAME}.service installed and started (Port ${PORT_VAL})."
    systemctl --user status "${SERVICE_NAME}.service" --no-pager || true
    ;;
  restart)
    systemctl --user restart "${SERVICE_NAME}.service"
    systemctl --user status "${SERVICE_NAME}.service" --no-pager || true
    ;;
  status)
    systemctl --user status "${SERVICE_NAME}.service" --no-pager
    ;;
  logs)
    journalctl --user -u "${SERVICE_NAME}.service" -n 100 -f
    ;;
  uninstall)
    systemctl --user disable --now "${SERVICE_NAME}.service" 2>/dev/null || true
    rm -f "${UNIT_FILE}"
    systemctl --user daemon-reload
    echo "[OK] ${SERVICE_NAME}.service uninstalled."
    ;;
  *)
    echo "Usage: $0 {install|status|restart|logs|uninstall}"
    exit 1
    ;;
esac
