#!/usr/bin/env bash
# render-env.sh [--no-perm-check] [ENV_FILE]
#
# Validates a PC-built .env for the AIWA SEO host (decision D2). Nothing here fetches or
# writes secrets: the file is built on the PC and shipped through the Orca release path.
# Prints NAMES only, never values.
#
# Checks:
#   1. every name listed in deploy/aiwa/env.required is present and non-empty
#   2. TZ=America/Chicago
#   3. GBP_POSTER and SEO_PIPELINE explicitly set to allowed values
#   4. mode 600 and owner seo (skip with --no-perm-check for Windows or dev dry runs only)
#
# Exit: 0 valid, 1 validation failed (problems listed), 2 usage or read error.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REQUIRED_FILE="$SCRIPT_DIR/env.required"
ENV_FILE="/opt/seo/.env"
PERM_CHECK=1

for arg in "$@"; do
  case "$arg" in
    --no-perm-check) PERM_CHECK=0 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
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

if [ "${VALS[TZ]:-}" != "America/Chicago" ]; then
  problems+=("TZ must be exactly America/Chicago")
fi

if ! in_missing GBP_POSTER; then
  case "${VALS[GBP_POSTER]:-}" in
    api|playwright) ;;
    *) problems+=("GBP_POSTER must be set to api or playwright") ;;
  esac
fi

if ! in_missing SEO_PIPELINE; then
  case "${VALS[SEO_PIPELINE]:-}" in
    legacy|shadow|new) ;;
    *) problems+=("SEO_PIPELINE must be set to legacy, shadow or new") ;;
  esac
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

echo "render-env: OK ${#REQUIRED[@]} required names present; TZ, GBP_POSTER, SEO_PIPELINE valid; perms $([ "$PERM_CHECK" -eq 1 ] && echo checked || echo skipped)"
exit 0
