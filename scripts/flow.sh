#!/usr/bin/env bash
# The whole trial, act by act, from the CLI. Mainnet: acts 2-5 move real USD₮.
# Usage: scripts/flow.sh [--swarm] [--fixture] [--trust N --distrust N]
#   --swarm      STORAGE=swarm for this run (memory, receipts, disputes on Swarm)
#   --fixture    replay recorded exhibits instead of live calls
#   --trust/--distrust  verdict tally; without them act 5 reads the courtroom vote
set -euo pipefail
cd "$(dirname "$0")/.."

FIXTURE=()
VERDICT=()
while [ $# -gt 0 ]; do
  case "$1" in
    --swarm) export STORAGE=swarm ;;
    --fixture) FIXTURE=(--fixture) ;;
    --trust|--distrust) VERDICT+=("$1" "$2"); shift ;;
    *) echo "unknown flag $1" >&2; exit 2 ;;
  esac
  shift
done

step() { printf '\n=== %s ===\n' "$1"; }
pause() { read -r -p "next: $1 — enter to go, ctrl-c to stop "; }

step "preflight"
pnpm preflight
[ "${STORAGE:-local}" = swarm ] && pnpm check:storage

if ! grep -q '^SHADY_AGENT_ID=.\+' .env; then
  step "register the shady provider (once)"
  pnpm shady:register
fi

pause "act 1 identity";  step "act 1 identity";  pnpm act:identity "${FIXTURE[@]}"
pause "act 2 earn";      step "act 2 earn";      pnpm act:earn     "${FIXTURE[@]}"
pause "act 3 spend";     step "act 3 spend";     pnpm act:spend    "${FIXTURE[@]}"
pause "act 4 dispute";   step "act 4 dispute";   pnpm act:dispute  "${FIXTURE[@]}"
pause "act 5 verdict";   step "act 5 verdict";   pnpm act:verdict  "${FIXTURE[@]}" "${VERDICT[@]}"

step "done"
echo "exhibits: evidence/  ·  verify each one on <courtroom>/exhibit/<id>"
