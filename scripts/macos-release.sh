#!/usr/bin/env bash
# 构建已签名 + 已公证的 macOS 安装包（.app / .dmg）。
#
# 用法:
#   scripts/macos-release.sh              # 本机架构（通常 aarch64）
#   scripts/macos-release.sh --universal  # Apple Silicon + Intel 各打一份
#   scripts/macos-release.sh --skip-notarize  # 只签名，不公证（调试）
#
# 需要（先跑 scripts/macos-sign-setup.sh）:
#   - 登录钥匙串里的 Developer ID Application
#   - notarytool keychain profile「notary」（默认）
#   - release/signing.env
#
# 产物: release/<version>/Subpodcast_<ver>_<arch>.dmg（已 staple）
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"

TMP_DIRS=()
cleanup() {
  for d in "${TMP_DIRS[@]:-}"; do
    [ -n "$d" ] && [ -d "$d" ] && rm -rf "$d"
  done
}
trap cleanup EXIT
mk_tmp() {
  local d
  d="$(mktemp -d)"
  TMP_DIRS+=("$d")
  printf '%s' "$d"
}

UNIVERSAL=0
SKIP_NOTARIZE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --universal) UNIVERSAL=1 ;;
    --skip-notarize) SKIP_NOTARIZE=1 ;;
    -h|--help)
      sed -n '2,16p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

ENV_FILE="release/signing.env"
if [ ! -f "${ENV_FILE}" ]; then
  echo "缺少 ${ENV_FILE} — 先运行 scripts/macos-sign-setup.sh" >&2
  exit 1
fi
# shellcheck disable=SC1090
set -a; source "${ENV_FILE}"; set +a

IDENTITY="${APPLE_SIGNING_IDENTITY:?APPLE_SIGNING_IDENTITY 未设置}"
PROFILE="${NOTARY_PROFILE:-notary}"
VERSION=$(node -p 'require("./src-tauri/tauri.conf.json").version')
OUT="release/${VERSION}"
PRODUCT="Subpodcast"
mkdir -p "${OUT}"

if ! security find-identity -v -p codesigning 2>/dev/null | grep -F "${IDENTITY}" >/dev/null; then
  echo "钥匙串里找不到身份: ${IDENTITY}" >&2
  echo "运行: security find-identity -v -p codesigning" >&2
  exit 1
fi

if [ "$SKIP_NOTARIZE" = 0 ]; then
  if ! xcrun notarytool history --keychain-profile "${PROFILE}" >/dev/null 2>&1; then
    echo "notarytool profile「${PROFILE}」不可用 — 运行 scripts/macos-sign-setup.sh" >&2
    exit 1
  fi
fi

# Tauri 内建公证：若有 API env 则一并导出，构建时自动 notarize+staple
if [ -f release/apple-api.env ] && [ "$SKIP_NOTARIZE" = 0 ]; then
  set -a; source release/apple-api.env; set +a
fi

notarize_file() {
  local file="$1" out
  echo "==> notarize $(basename "$file")"
  out=$(xcrun notarytool submit "$file" --keychain-profile "${PROFILE}" --wait 2>&1) || true
  printf '%s\n' "$out" >&2
  grep -q "status: Accepted" <<<"$out"
}

build_one() {
  local target="$1"
  local arch
  arch=$([ "$target" = aarch64-apple-darwin ] && echo aarch64 || echo x64)

  echo "==> build $target"
  rustup target add "$target" >/dev/null
  export APPLE_SIGNING_IDENTITY="${IDENTITY}"
  export MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-11.0}"

  # 有 APPLE_API_* / APPLE_ID 时，Tauri 会在 bundle 阶段公证 DMG；
  # 否则我们只让 Tauri 签名，再手动 notarytool。
  local bundles="app,dmg"
  if [ "$SKIP_NOTARIZE" = 1 ]; then
    # 清掉公证相关变量，避免半吊子提交
    unset APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_PATH || true
  fi

  npm run tauri build -- --target "$target" --bundles "$bundles"

  local app="src-tauri/target/$target/release/bundle/macos/${PRODUCT}.app"
  local dmg_list dmg_src
  dmg_list=$(find "src-tauri/target/$target/release/bundle/dmg" -maxdepth 1 -name "${PRODUCT}_${VERSION}_*.dmg" 2>/dev/null || true)
  if [ -z "$dmg_list" ]; then
    dmg_list=$(find "src-tauri/target/$target/release/bundle/dmg" -maxdepth 1 -name "${PRODUCT}_*.dmg" 2>/dev/null || true)
  fi
  dmg_src=$(printf '%s\n' "$dmg_list" | head -1)

  [ -d "$app" ] || { echo "找不到 $app" >&2; exit 1; }
  codesign --verify --deep --strict "$app"
  codesign -dv --verbose=2 "$app" 2>&1 | grep -E 'Authority=|Signature=' || true

  local dmg="${OUT}/${PRODUCT}_${VERSION}_${arch}.dmg"

  if [ "$SKIP_NOTARIZE" = 1 ]; then
    if [ -n "${dmg_src:-}" ] && [ -f "$dmg_src" ]; then
      cp "$dmg_src" "$dmg"
    else
      echo "无 DMG，跳过复制" >&2
    fi
    echo "已签名（未公证）→ ${OUT}"
    return
  fi

  # 若 Tauri 已公证并 staple，直接收口；否则手动走 notarytool
  if [ -n "${dmg_src:-}" ] && [ -f "$dmg_src" ]; then
    cp "$dmg_src" "$dmg"
    if xcrun stapler validate "$dmg" >/dev/null 2>&1; then
      echo "==> DMG 已 staple（Tauri 内建公证）"
    else
      # 可能只签了未公证：补公证
      if ! xcrun stapler validate "$app" >/dev/null 2>&1; then
        local zip
        zip="$(mk_tmp)/${PRODUCT}.zip"
        ditto -c -k --keepParent "$app" "$zip"
        notarize_file "$zip"
        xcrun stapler staple "$app"
      fi
      # 重新打 DMG 再公证（装订后的 .app）
      local stage
      stage="$(mk_tmp)"
      cp -R "$app" "$stage/"
      ln -s /Applications "$stage/Applications"
      rm -f "$dmg"
      hdiutil create -volname "${PRODUCT}" -srcfolder "$stage" -ov -format UDZO "$dmg" >/dev/null
      codesign --sign "${IDENTITY}" --timestamp "$dmg"
      notarize_file "$dmg"
      xcrun stapler staple "$dmg"
    fi
  else
    echo "Tauri 未产出 DMG，从 .app 自制" >&2
    local stage
    stage="$(mk_tmp)"
    if ! xcrun stapler validate "$app" >/dev/null 2>&1; then
      local zip
      zip="$(mk_tmp)/${PRODUCT}.zip"
      ditto -c -k --keepParent "$app" "$zip"
      notarize_file "$zip"
      xcrun stapler staple "$app"
    fi
    cp -R "$app" "$stage/"
    ln -s /Applications "$stage/Applications"
    rm -f "$dmg"
    hdiutil create -volname "${PRODUCT}" -srcfolder "$stage" -ov -format UDZO "$dmg" >/dev/null
    codesign --sign "${IDENTITY}" --timestamp "$dmg"
    notarize_file "$dmg"
    xcrun stapler staple "$dmg"
  fi

  spctl -a -t open --context context:primary-signature -v "$dmg"
  echo "==> $dmg"
}

TARGETS=( "$(rustc -vV | sed -n 's/^host: //p')" )
if [ "$UNIVERSAL" = 1 ]; then
  TARGETS=( aarch64-apple-darwin x86_64-apple-darwin )
fi

for t in "${TARGETS[@]}"; do
  build_one "$t"
done

echo
echo "完成。安装包在 ${OUT}/"
ls -lh "${OUT}"/*.dmg 2>/dev/null || true
echo
echo "验证: spctl -a -t open --context context:primary-signature -v ${OUT}/${PRODUCT}_${VERSION}_*.dmg"
echo "期望: accepted / source=Notarized Developer ID"
