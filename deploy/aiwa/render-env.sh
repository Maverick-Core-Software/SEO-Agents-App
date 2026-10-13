#!/usr/bin/env bash
# render-env.sh [--no-perm-check] [--check-paths] [ENV_FILE]
#
# Validates a PC-built .env for the AIWA SEO host (decision D2). Nothing here fetches or
# writes secrets: the file is built on the PC and shipped through the Orca release path.
# Prints NAMES only, never values.
#
# Checks:
#   1. every name listed in deploy/aiwa/env.required is present and non-empty
#   2. TZ=America/Chicago
#   3. the pins the runbook relies on carry an allowed value (F10): GBP_POSTER (api|playwright),
#      SEO_PIPELINE (legacy|shadow|new), MAV_BRIDGE_GBP (on|off), SEO_AUTO_APPROVE (0|1),
#      FB_BOOST_API (0|1); MAV_BRIDGE_BIND is not an unspecified address (0.0.0.0 / ::)
#   4. --check-paths: directory names point at existing directories and file names at
#      existing files (binaries may also be bare names on PATH). seo-weekly-run.service runs
#      this as ExecStartPre, so a missing path fails the unit before anything launches.
#   5. mode 600 and owner seo (skip with --no-perm-check for Windows or dev dry runs only)
#
# Exit: 0 valid, 1 validation failed (problems listed), 2 usage or read error.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REQUIRED_FILE="$SCRIPT_DIR/env.required"
ENV_FILE="/opt/seo/.env"
PERM_CHECK=1
PATH_CHECK=0

for arg in "$@"; do
  case "$arg" in
    --no-perm-check) PERM_CHECK=0 ;;
    --check-paths) PATH_CHECK=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    -*) echo "unknown option: $arg" >&2; exit 2 ;;
    *) ENV_FILE="$arg" ;;
  esac
done

[ -r "$ENV_FILE" ] || { echo "cannot read env file: $ENV_FILE" >&2; exit 2; }
[ -r "$REQUIRED_FILE" ] || { echo "cannot read $REQUIRED_FILE" >&2; exit 2; }

# Parse KEY=VALUE lines (last occurrence wins, like dotenv). Values are held in memory only.
declare -A VALS=()
while IFS= read -r line || [ -n "$line" ]; do
  line="${line%$'\r'}"
  case "$line" in
    ''|'#'*) continue ;;
    'export '*) line="${line#export }" ;;
  esac
  case "$line" in *=*) ;; *) continue ;; esac
  key="${line%%=*}"
  key="${key//[[:space:]]/}"
  val="${line#*=}"
  case "$val" in
    \"*\") val="${val#\"}"; val="${val%\"}" ;;
    \'*\') val="${val#\'}"; val="${val%\'}" ;;
  esac
  VALS["$key"]="$val"
done < "$ENV_FILE"

# Read the required names (comments after '#' are stripped).
REQUIRED=()
while IFS= read -r line || [ -n "$line" ]; do
  line="${line%$'\r'}"
  line="${line%%#*}"
  line="$(printf '%s' "$line" | tr -d '[:space:]')"
  [ -n "$line" ] && REQUIRED+=("$line")
done < "$REQUIRED_FILE"

problems=()
missing=()
for name in "${REQUIRED[@]}"; do
  if [ -z "${VALS[$name]:-}" ]; then
    missing+=("$name")
  fi
done
if [ "${#missing[@]}" -gt 0 ]; then
  problems+=("missing or empty names: ${missing[*]}")
fi

in_missing() {
  local n
  for n in "${missing[@]}"; do [ "$n" = "$1" ] && return 0; done
  return 1
}

# allowed NAME value...: the name must be present (it is in env.required) and hold one of the values.
allowed() {
  local name="$1"; shift
  in_missing "$name" && return 0   # already reported as missing
  local v="${VALS[$name]:-}" ok=0 cand
  for cand in "$@"; do [ "$v" = "$cand" ] && ok=1; done
  [ "$ok" -eq 1 ] || problems+=("$name must be set to one of: $*")
}

if [ "${VALS[TZ]:-}" != "America/Chicago" ]; then
  problems+=("TZ must be exactly America/Chicago")
fi

allowed GBP_POSTER api playwright
allowed SEO_PIPELINE legacy shadow new
allowed MAV_BRIDGE_GBP on off
allowed SEO_AUTO_APPROVE 0 1
allowed FB_BOOST_API 0 1

case "${VALS[MAV_BRIDGE_BIND]:-}" in
  0.0.0.0|::|'[::]'|'*') problems+=("MAV_BRIDGE_BIND must be one LXC address, not an unspecified address (the bridge refuses it; RUNBOOK 3a)") ;;
esac

# --check-paths: every path-valued name resolves on this host.
if [ "$PATH_CHECK" -eq 1 ]; then
  DIR_NAMES=(GBP_WORKBOOK_DIR GBP_ARCHIVE_FOLDER GBP_PHOTOS_FOLDER GBP_PHOTOS_LOCAL_CACHE)
  FILE_NAMES=(GBP_WORKBOOK_PATH GBP_CLIENT_SECRET GBP_TOKEN_FILE SEARCH_CONSOLE_TOKEN_FILE)
  BIN_NAMES=(SEO_AGENTS_EXE HERMES_CLI)
  for name in "${DIR_NAMES[@]}"; do
    in_missing "$name" && continue
    [ -d "${VALS[$name]}" ] || problems+=("$name does not point at an existing directory")
  done
  for name in "${FILE_NAMES[@]}"; do
    in_missing "$name" && continue
    [ -f "${VALS[$name]}" ] || problems+=("$name does not point at an existing file")
  done
  for name in "${BIN_NAMES[@]}"; do
    in_missing "$name" && continue
    v="${VALS[$name]}"
    case "$v" in
      */*) [ -x "$v" ] || problems+=("$name does not point at an executable file") ;;
      *) command -v "$v" >/dev/null 2>&1 || problems+=("$name is not on PATH") ;;
    esac
  done
fi

if [ "$PERM_CHECK" -eq 1 ]; then
  mode="$(stat -c '%a' "$ENV_FILE" 2>/dev/null || echo unknown)"
  owner="$(stat -c '%U' "$ENV_FILE" 2>/dev/null || echo unknown)"
  [ "$mode" = "600" ] || problems+=("file mode must be 600 (found $mode)")
  [ "$owner" = "seo" ] || problems+=("file owner must be seo (found $owner)")
else
  echo "warning: --no-perm-check: file mode and owner were NOT checked" >&2
fi

if [ "${#problems[@]}" -gt 0 ]; then
  for p in "${problems[@]}"; do echo "FAIL $p"; done
  echo "render-env: ${#problems[@]} problem(s); $(( ${#REQUIRED[@]} - ${#missing[@]} ))/${#REQUIRED[@]} required names present"
  exit 1
fi

echo "render-env: OK ${#REQUIRED[@]} required names present; TZ, GBP_POSTER, SEO_PIPELINE, MAV_BRIDGE_GBP, SEO_AUTO_APPROVE, FB_BOOST_API valid; paths $([ "$PATH_CHECK" -eq 1 ] && echo checked || echo not checked); perms $([ "$PERM_CHECK" -eq 1 ] && echo checked || echo skipped)"
exit 0
