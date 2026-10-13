#!/usr/bin/env bash
# verify-units.sh: checks deploy/aiwa before it reaches the host.
#   - bash -n on every .sh in deploy/aiwa (always)
#   - shellcheck on every .sh when installed (otherwise reports SKIPPED)
#   - units: systemd-analyze verify when installed; otherwise a grep lint that also runs on Windows
#   - ecosystem.linux.config.cjs loads under node
# Exit 0 = all checks passed, 1 = a check failed.
set -u

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNITS="$DIR/systemd"
fail=0
ok()  { printf 'ok    %s\n' "$*"; }
bad() { printf 'FAIL  %s\n' "$*"; fail=1; }
skip(){ printf 'SKIP  %s\n' "$*"; }

# 1. shell syntax
for f in "$DIR"/*.sh; do
  if bash -n "$f"; then ok "bash -n $(basename "$f")"; else bad "bash -n $(basename "$f")"; fi
done

# 2. shellcheck
if command -v shellcheck >/dev/null 2>&1; then
  for f in "$DIR"/*.sh; do
    if shellcheck "$f"; then ok "shellcheck $(basename "$f")"; else bad "shellcheck $(basename "$f")"; fi
  done
else
  skip "shellcheck not installed (install with apt-get install shellcheck on the LXC)"
fi

# 3. units
shopt -s nullglob
services=("$UNITS"/*.service)
timers=("$UNITS"/*.timer)
if [ "${#services[@]}" -eq 0 ] || [ "${#timers[@]}" -eq 0 ]; then
  bad "no units found under $UNITS"
fi

if command -v systemd-analyze >/dev/null 2>&1; then
  echo "mode: systemd-analyze verify"
  if systemd-analyze verify "${services[@]}" "${timers[@]}"; then ok "systemd-analyze verify (${#services[@]} services, ${#timers[@]} timers)"; else bad "systemd-analyze verify"; fi
else
  echo "mode: grep lint (systemd-analyze not installed on this host)"
  need() { # file pattern label
    if grep -qE "$2" "$1"; then return 0; fi
    bad "$(basename "$1"): missing $3"; return 1
  }
  for s in "${services[@]}"; do
    n="$(basename "$s")"
    need "$s" '^User=seo$' 'User=seo'
    need "$s" '^WorkingDirectory=/opt/seo$' 'WorkingDirectory=/opt/seo'
    need "$s" '^EnvironmentFile=/opt/seo/\.env$' 'EnvironmentFile=/opt/seo/.env'
    need "$s" '^Environment=TZ=America/Chicago$' 'Environment=TZ=America/Chicago'
    need "$s" '^Type=oneshot$' 'Type=oneshot'
    need "$s" '^ExecStart=/' 'ExecStart with absolute path'
    if grep -qE '^ExecStart=' "$s" && ! grep -qE '^ExecStart=/' "$s"; then bad "$n: ExecStart is not an absolute path"; fi
    if grep -E '^ExecStart' "$s" | grep -qE 'C:\\|/home/|Desktop'; then bad "$n: ExecStart contains a Windows or personal path"; fi
    if [ "$(grep -cE '^ExecStart=' "$s")" -ne 1 ]; then bad "$n: expected exactly one ExecStart= line"; fi
  done
  for t in "${timers[@]}"; do
    n="$(basename "$t")"
    need "$t" '^OnCalendar=' 'OnCalendar'
    # F10: every timer names its zone explicitly (systemd >= 247; Debian 12 has 252), so a
    # host timezone reset cannot move the Friday timers to 08:30 UTC.
    need "$t" '^OnCalendar=.* America/Chicago$' 'OnCalendar ... America/Chicago suffix'
    need "$t" '^Persistent=(true|false)$' 'Persistent=true|false'
    need "$t" '^Unit=seo-[a-z-]+\.service$' 'Unit=<service>'
    unit="$(sed -n 's/^Unit=//p' "$t")"
    [ -f "$UNITS/$unit" ] || bad "$n: Unit=$unit has no matching file in systemd/"
    # A Friday timer must not catch up on a later day; a daily timer should.
    if grep -qE '^OnCalendar=Fri' "$t" && ! grep -qE '^Persistent=false$' "$t"; then
      bad "$n: Friday timer must set Persistent=false"
    fi
    if grep -qE '^OnCalendar=\*-\*-\*' "$t" && ! grep -qE '^Persistent=true$' "$t"; then
      bad "$n: daily timer should set Persistent=true"
    fi
  done
  if [ "$fail" -eq 0 ]; then ok "grep lint: ${#services[@]} services, ${#timers[@]} timers (OnCalendar + America/Chicago, EnvironmentFile, TZ, Persistent, Unit)"; fi
fi

# 4. ecosystem loads
if command -v node >/dev/null 2>&1; then
  if node -e "const c=require(process.argv[1]); if(!Array.isArray(c.apps)||!c.apps.length) process.exit(1); console.log('apps: '+c.apps.map(a=>a.name).join(', '))" "$DIR/ecosystem.linux.config.cjs"; then
    ok "ecosystem.linux.config.cjs loads"
  else
    bad "ecosystem.linux.config.cjs did not load"
  fi
else
  skip "node not on PATH; ecosystem not loaded"
fi

if [ "$fail" -eq 0 ]; then echo "verify-units: PASS"; else echo "verify-units: FAIL"; fi
exit "$fail"
