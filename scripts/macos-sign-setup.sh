#!/usr/bin/env bash
# 配置本机 macOS 发布签名 / 公证凭据（密钥永不进仓库）。
#
# 用法:
#   scripts/macos-sign-setup.sh              # 检查现况 + 交互写入
#   scripts/macos-sign-setup.sh --check      # 只检查，不写入
#   scripts/macos-sign-setup.sh --notary-api # 用 App Store Connect API Key 存 notary 配置
#   scripts/macos-sign-setup.sh --notary-apple-id  # 用 Apple ID + App 专用密码
#
# 产出:
#   release/signing.env          — APPLE_SIGNING_IDENTITY / TEAM / 公证方式（gitignored）
#   钥匙串 profile「notary」     — notarytool 用（推荐）
set -euo pipefail
cd "$(dirname "$0")/.."

PROFILE="${NOTARY_PROFILE:-notary}"
ENV_FILE="release/signing.env"
MODE="setup"
while [ $# -gt 0 ]; do
  case "$1" in
    --check) MODE="check" ;;
    --notary-api) MODE="notary-api" ;;
    --notary-apple-id) MODE="notary-apple-id" ;;
    -h|--help)
      sed -n '2,14p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

mkdir -p release

have_identity() {
  security find-identity -v -p codesigning 2>/dev/null | grep -q 'Developer ID Application'
}

print_identities() {
  echo "==> 本机 Developer ID Application 身份："
  security find-identity -v -p codesigning 2>/dev/null | grep 'Developer ID Application' || {
    echo "   （无）请到 https://developer.apple.com/account/resources/certificates/list"
    echo "   创建「Developer ID Application」，导出 .p12 后双击导入登录钥匙串。"
    return 1
  }
}

have_notary() {
  xcrun notarytool history --keychain-profile "${PROFILE}" >/dev/null 2>&1
}

check() {
  local ok=0
  if print_identities; then ok=1; else ok=0; fi
  echo
  if have_notary; then
    echo "==> notarytool profile「${PROFILE}」: 可用"
  else
    echo "==> notarytool profile「${PROFILE}」: 缺失"
    echo "   运行: scripts/macos-sign-setup.sh --notary-api"
    echo "   或:   scripts/macos-sign-setup.sh --notary-apple-id"
    ok=0
  fi
  echo
  if [ -f "${ENV_FILE}" ]; then
    echo "==> ${ENV_FILE} 已存在"
    # 不打印可能含路径的敏感行以外的说明
    grep -E '^(APPLE_SIGNING_IDENTITY|APPLE_TEAM_ID|NOTARY_PROFILE|NOTARY_AUTH)=' "${ENV_FILE}" || true
  else
    echo "==> ${ENV_FILE} 尚未创建"
    ok=0
  fi
  [ "$ok" = 1 ] && echo && echo "就绪：可运行 scripts/macos-release.sh"
}

write_env() {
  local identity="$1" team="${2:-}" auth="$3"
  umask 077
  cat >"${ENV_FILE}" <<EOF
# 本机签名配置 — 勿提交（release/ 已在 .gitignore）
APPLE_SIGNING_IDENTITY=$identity
APPLE_TEAM_ID=$team
NOTARY_PROFILE=${PROFILE}
NOTARY_AUTH=$auth
EOF
  echo "已写入 ${ENV_FILE}"
}

pick_identity() {
  local line id
  line=$(security find-identity -v -p codesigning 2>/dev/null | grep 'Developer ID Application' | head -1) || return 1
  # 行形如: 1) AABBCC "Developer ID Application: Name (TEAM)"
  id=$(sed -n 's/.*"\(Developer ID Application: .*\)"/\1/p' <<<"$line")
  [ -n "$id" ] || return 1
  printf '%s' "$id"
}

team_from_identity() {
  # … (TEAMID)" 末尾括号
  sed -n 's/.*(\([A-Z0-9]\{10\}\))$/\1/p' <<<"$1"
}

store_notary_api() {
  local key_id issuer key_path identity team
  identity=$(pick_identity) || { echo "先导入 Developer ID Application 证书" >&2; exit 1; }
  team=$(team_from_identity "$identity")
  echo "签名身份: $identity"
  echo "在 App Store Connect › Users and Access › Integrations › Team Keys 创建 Key（Developer 权限），"
  echo "下载 AuthKey_<KEY_ID>.p8（只可下一次）。"
  read -r -p "APPLE_API_KEY (Key ID): " key_id
  read -r -p "APPLE_API_ISSUER (Issuer ID): " issuer
  read -r -p "APPLE_API_KEY_PATH (.p8 绝对路径): " key_path
  [ -f "$key_path" ] || { echo "找不到 $key_path" >&2; exit 1; }
  xcrun notarytool store-credentials "${PROFILE}" \
    --key "$key_path" \
    --key-id "$key_id" \
    --issuer "$issuer"
  write_env "$identity" "${team:-}" "api"
  # Tauri 内建公证也可读这些变量；写一份本机旁路文件（仍在 release/）
  umask 077
  cat >release/apple-api.env <<EOF
APPLE_API_KEY=$key_id
APPLE_API_ISSUER=$issuer
APPLE_API_KEY_PATH=$key_path
EOF
  echo "notary profile「${PROFILE}」已保存；Tauri 环境见 release/apple-api.env"
}

store_notary_apple_id() {
  local apple_id team password identity
  identity=$(pick_identity) || { echo "先导入 Developer ID Application 证书" >&2; exit 1; }
  team=$(team_from_identity "$identity")
  echo "签名身份: $identity"
  echo "App 专用密码: https://appleid.apple.com/account/manage → App-Specific Passwords"
  read -r -p "APPLE_ID (邮箱): " apple_id
  read -r -p "APPLE_TEAM_ID [${team:-必填}]: " team_in
  team="${team_in:-$team}"
  [ -n "$team" ] || { echo "需要 Team ID" >&2; exit 1; }
  read -r -s -p "APPLE_PASSWORD (App 专用密码): " password
  echo
  xcrun notarytool store-credentials "${PROFILE}" \
    --apple-id "$apple_id" \
    --team-id "$team" \
    --password "$password"
  write_env "$identity" "$team" "apple-id"
  echo "notary profile「${PROFILE}」已保存（密码只在钥匙串，不落盘）"
}

case "$MODE" in
  check) check ;;
  notary-api) store_notary_api; check ;;
  notary-apple-id) store_notary_apple_id; check ;;
  setup)
    check
    if ! have_identity; then
      echo
      echo "下一步：导入 Developer ID Application 证书后再跑本脚本。"
      exit 1
    fi
    if ! have_notary; then
      echo
      echo "下一步任选其一："
      echo "  scripts/macos-sign-setup.sh --notary-api"
      echo "  scripts/macos-sign-setup.sh --notary-apple-id"
      exit 1
    fi
    if [ ! -f "${ENV_FILE}" ]; then
      id=$(pick_identity)
      write_env "$id" "$(team_from_identity "$id")" "keychain"
    fi
    ;;
esac
