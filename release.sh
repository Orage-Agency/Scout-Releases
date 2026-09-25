#!/usr/bin/env bash
set -euo pipefail
set -f

REPO="Orage-Agency/Scout-Releases"
WORKFLOW="desktop-build.yml"
RELEASES_REF="main"
SOURCE_REF="${SCOUT_DESKTOP_REF:-main}"

usage() {
  cat <<'USAGE'
Dispatch a Scout desktop release build.

Usage:
  ./release.sh <version> <os...>

Examples:
  ./release.sh 5.8.8 mac
  ./release.sh 5.8.8 mac windows
  ./release.sh 5.8.8 '[mac, windows, linux]'

OS values: mac, windows, linux (macOS is also accepted).
Supported selections follow the existing workflow:
  mac
  windows
  linux
  mac + windows
  mac + linux
  windows + linux
  mac + windows + linux

The workflow creates a prerelease. Successful runs that include Mac or
Windows update the beta channel and may commit updates/*.json to main; Linux
remains manual download only. stable.json is only changed by the separate
"Release to everyone" workflow. Set SCOUT_DESKTOP_REF to build another
Scout-Desktop branch, tag, or full commit SHA. A failed run may leave files
on its prerelease; rerun for only the missing OS values. Existing requested
files are never overwritten.
USAGE
}

fail() {
  printf 'Error: %s\n' "$1" >&2
  exit 1
}

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  usage
  exit 0
fi

if [ "$#" -lt 2 ]; then
  usage >&2
  exit 2
fi

version="$1"
shift
version="${version#v}"
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ ]]; then
  fail "version must look like 5.8.8 or 5.8.8-beta.1"
fi
tag="v$version"
if [[ ! "$SOURCE_REF" =~ ^[A-Za-z0-9][A-Za-z0-9._/+~-]*$ ]]; then
  fail "SCOUT_DESKTOP_REF contains unsupported characters"
fi

selected_os=" "
mac=0
windows=0
linux=0

# Accept regular shell arguments (mac windows) and one quoted list
# ('[mac, windows]') while normalizing both to the workflow's choice input.
for argument in "$@"; do
  argument="${argument#\[}"
  argument="${argument%\]}"
  argument="$(printf '%s' "$argument" | tr ',' ' ')"

  for os in $argument; do
    case "$os" in
      macos) os="mac" ;;
      mac|windows|linux) ;;
      *) fail "unsupported OS '$os'; choose mac, windows, or linux" ;;
    esac

    case "$selected_os" in
      *" $os "*) fail "OS '$os' was provided more than once" ;;
    esac
    selected_os="${selected_os}${os} "

    case "$os" in
      mac) mac=1 ;;
      windows) windows=1 ;;
      linux) linux=1 ;;
    esac
  done
done

case "$mac$windows$linux" in
  100) platforms="mac only" ;;
  010) platforms="windows only" ;;
  001) platforms="linux only" ;;
  110) platforms="mac and windows" ;;
  111) platforms="mac, windows and linux" ;;
  101) platforms="mac and linux" ;;
  011) platforms="windows and linux" ;;
  *) fail "provide at least one supported OS" ;;
esac

requested_assets=""
if [ "$mac" = 1 ]; then
  requested_assets="$requested_assets scout-macos.dmg scout-macos.zip"
fi
if [ "$windows" = 1 ]; then
  requested_assets="$requested_assets scout-windows-setup.exe scout-windows-x64.zip"
fi
if [ "$linux" = 1 ]; then
  requested_assets="$requested_assets scout-linux-x64.tar.gz"
fi

command -v gh >/dev/null 2>&1 || fail "GitHub CLI (gh) is required"
gh auth status --hostname github.com >/dev/null 2>&1 \
  || fail "authenticate GitHub CLI first with 'gh auth login'"

if existing_release="$(gh release view "$tag" --repo "$REPO" \
  --json isPrerelease,isDraft,assets \
  --jq '[.isPrerelease, .isDraft, ([.assets[].name] | join(" "))] | @tsv' 2>/dev/null)"; then
  IFS=$'\t' read -r existing_is_prerelease existing_is_draft existing_assets <<EOF
$existing_release
EOF
  [ "$existing_is_prerelease" = "true" ] \
    || fail "$tag already exists as a stable release; refusing to add prerelease assets"
  [ "$existing_is_draft" = "false" ] \
    || fail "$tag is a draft release; publish or remove it before using this script"
  for asset in $requested_assets; do
    case " $existing_assets " in
      *" $asset "*) fail "$tag already contains $asset; refusing to overwrite it" ;;
    esac
  done
  printf 'Continuing existing prerelease %s with requested files that are still missing.\n' "$tag"
fi

active_runs="$(gh run list \
  --repo "$REPO" \
  --workflow "$WORKFLOW" \
  --event workflow_dispatch \
  --limit 100 \
  --json databaseId,status,displayTitle,url \
  --jq '.[] | select(.status != "completed") | "\(.databaseId) [\(.status)] \(.displayTitle) \(.url)"')"
if [ -n "$active_runs" ]; then
  printf 'A desktop release workflow is already active:\n%s\n' "$active_runs" >&2
  fail "wait for it to finish before starting another release"
fi

printf 'Dispatching Scout %s from Scout-Desktop ref %s for: %s\n' \
  "$tag" "$SOURCE_REF" "$platforms"
gh workflow run "$WORKFLOW" \
  --repo "$REPO" \
  --ref "$RELEASES_REF" \
  --raw-field "ref=$SOURCE_REF" \
  --raw-field "tag=$tag" \
  --raw-field "platforms=$platforms" \
  --raw-field "replace_existing=false"

printf '\nTrack the build: https://github.com/%s/actions/workflows/%s\n' "$REPO" "$WORKFLOW"
printf 'Release page: https://github.com/%s/releases/tag/%s\n' "$REPO" "$tag"
