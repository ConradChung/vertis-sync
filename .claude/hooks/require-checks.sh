#!/usr/bin/env bash
# Stop hook: Claude may not say "done" until the repo's own checks pass and the
# verify-app reviewer has written PASS to review/verdict.txt for this exact change.
#
#   .claude/hooks/require-checks.sh               as the Stop hook (reads hook JSON on stdin)
#   .claude/hooks/require-checks.sh --checks-only run the checks and print the report
#                                                 (what the verify-app subagent calls; it
#                                                 also records which change was reviewed)
#
# Exit codes as a Stop hook: 0 = let Claude stop, 2 = block the stop and hand
# stderr back to Claude as the reason. After MAX_ATTEMPTS blocked rounds on the
# same change it gives up (exit 0 + a message to the user) so it can't loop forever.
#
# Scope: only what changed since the merge base with main (committed + working
# tree + untracked). A session that changed nothing stops freely, and a change
# that already passed isn't re-checked.
#
# Verdict first lines the hook understands:
#   PASS  the change is verified; stop.
#   FAIL  the rest of the file is the builder's next instructions; block.
#   ASK   the reviewer found a decision only Conrad can make; let the builder
#         stop and ask (the question is shown to the user).
set -uo pipefail

ROOT="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$ROOT" || exit 0
REVIEW="$ROOT/review"
VERDICT="$REVIEW/verdict.txt"
REVIEWED_FP_FILE="$REVIEW/.reviewed-fp"
ATTEMPTS_FILE="$REVIEW/.stop-attempts"
PASSED_FILE="$REVIEW/.last-pass"
GAVE_UP_FILE="$REVIEW/.gave-up"
LOG="$REVIEW/checks.log"
MAX_ATTEMPTS="${VERIFY_MAX_ATTEMPTS:-3}"
MODE="hook"
[ "${1:-}" = "--checks-only" ] && MODE="checks"

mkdir -p "$REVIEW"
if [ "$MODE" = "hook" ] && [ ! -t 0 ]; then
  # Keep the builder's last message so the next verify-app round can read what it claimed.
  INPUT="$(cat 2>/dev/null)"
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$INPUT" | jq -r '.last_assistant_message // empty' 2>/dev/null >"$REVIEW/builder-last-message.md" || true
  fi
fi

json_message() { # json_message <text>: a message shown to the user when the hook lets go
  if command -v jq >/dev/null 2>&1; then jq -cn --arg m "$1" '{systemMessage: $m}'
  else printf '{"systemMessage": "%s"}\n' "$(printf '%s' "$1" | tr -d '"\\\n')"; fi
}

FAILURES=()
NOTES=()

# Plain, unprefixed, uncoloured diffs whatever the user's git config says.
gdiff() { git -c diff.noprefix=false -c diff.mnemonicPrefix=false -c core.quotePath=false \
  diff --no-ext-diff --no-textconv --no-color "$@"; }

# ---------------------------------------------------------------- what changed
BASE="$(git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD main 2>/dev/null || true)"
if [ -z "$BASE" ]; then
  BASE="$(git rev-parse HEAD 2>/dev/null)"
  NOTES+=("Skipped: no origin/main or main to compare with; only uncommitted changes were checked.")
fi
CHANGED="$( { gdiff --name-only "$BASE" 2>/dev/null; git -c core.quotePath=false ls-files --others --exclude-standard 2>/dev/null; } | sort -u)"

if [ -z "$CHANGED" ]; then
  [ "$MODE" = "checks" ] && { echo "Nothing changed since $BASE; no checks to run."; printf '%s\n' "${NOTES[@]+"${NOTES[@]}"}"; }
  rm -f "$ATTEMPTS_FILE"
  exit 0
fi

hash_stdin() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 | cut -d' ' -f1
  else git hash-object --stdin; fi
}
fingerprint() {
  {
    gdiff --binary "$BASE" 2>/dev/null
    git ls-files --others --exclude-standard -z 2>/dev/null | while IFS= read -r -d '' f; do
      printf '%s\n' "$f"; cat -- "$f" 2>/dev/null
    done
  } | hash_stdin
}
FP="$(fingerprint)"
[ -z "$FP" ] && FAILURES+=("Can't fingerprint the change (no sha256sum, shasum or git hash-object), so a verdict can't be tied to it.")

matches_fp() { [ -n "$FP" ] && [ -s "$1" ] && [ "$(cat "$1")" = "$FP" ]; }

if [ "$MODE" = "hook" ]; then
  # Already verified this exact change: stop freely.
  matches_fp "$PASSED_FILE" && { rm -f "$ATTEMPTS_FILE"; exit 0; }
  # The reviewer says only Conrad can unblock this change (verdict ASK): let the
  # builder stop and ask, without re-running the suites.
  if [ -f "$VERDICT" ] && head -n1 "$VERDICT" | grep -q '^ASK' \
     && matches_fp "$REVIEWED_FP_FILE" && [ ! "$VERDICT" -ot "$REVIEWED_FP_FILE" ]; then
    rm -f "$ATTEMPTS_FILE"
    json_message "Not verified yet: the reviewer needs Conrad's decision. $(sed -n '2,8p' "$VERDICT" | tr '\n' ' ')"
    exit 0
  fi
  # Already gave up on this exact change: stop, but never silently.
  if matches_fp "$GAVE_UP_FILE"; then
    json_message "This change is still not verified (the reviewer loop gave up after $MAX_ATTEMPTS rounds). See review/verdict.txt and review/checks.log."
    exit 0
  fi
fi

changed_under() { printf '%s\n' "$CHANGED" | grep -E "$1" ; }
as_list() { printf '%s\n' "$1" | sed '/^$/d; s/^/  /'; }

: >"$LOG"

run() { # run <label> <dir> <cmd...>
  local label="$1" dir="$2"; shift 2
  echo "== $label ($dir: $*)" >>"$LOG"
  if (cd "$ROOT/$dir" && "$@") >>"$LOG" 2>&1; then
    echo "   PASS" >>"$LOG"
  else
    echo "   FAIL" >>"$LOG"
    FAILURES+=("$label failed. Run \`cd $dir && $*\` to see why (output also in review/checks.log).")
  fi
}
skip() { NOTES+=("Skipped: $1"); echo "== SKIPPED: $1" >>"$LOG"; }

# ---------------------------------------------------------------- hard checks
# Rules Conrad has had to say more than once live here, so they're enforced
# instead of remembered. Add a new block for each one; keep the message plain.

# 1. Never edit an applied migration; add a *_fixes one instead (CLAUDE.md).
EDITED_MIGRATIONS="$(gdiff --name-only --no-renames --diff-filter=MD "$BASE" -- supabase/migrations 2>/dev/null)"
if [ -n "$EDITED_MIGRATIONS" ]; then
  FAILURES+=("Hard check: an existing migration was edited, renamed or deleted:
$(as_list "$EDITED_MIGRATIONS")
Applied migrations are never edited; restore it and add a new *_fixes migration.")
fi

# 2. Secrets never in code, logs or docs (CLAUDE.md). Looks only at added lines.
#    A deliberate fake in a test can carry an `allow-secret` comment on the same
#    line; the verify-app reviewer checks every such line.
SECRET_RE='sk-ant-[A-Za-z0-9_-]{20,}|sbp_[a-f0-9]{40}|eyJhbGciOi[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.|xox[abpr]-[A-Za-z0-9-]{10,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|\b[0-9]{8,10}:AA[A-Za-z0-9_-]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----'
SECRET_FILES="$( { gdiff -U0 "$BASE" 2>/dev/null \
    | awk '/^\+\+\+ / {f=$0; sub(/^\+\+\+ (b\/)?/, "", f); next} /^\+/ {print f "\t" $0}' \
    | grep -E -- "$SECRET_RE" | grep -v 'allow-secret' | cut -f1 ; \
  git ls-files --others --exclude-standard -z 2>/dev/null \
    | xargs -0 -r grep -IHE -- "$SECRET_RE" 2>/dev/null | grep -v 'allow-secret' | cut -d: -f1 ; } \
  | sort -u)"
if [ -n "$SECRET_FILES" ]; then
  FAILURES+=("Hard check: added lines look like a secret (API key, service-role JWT, bot token or private key) in:
$(as_list "$SECRET_FILES")
Secrets go in env, \`supabase secrets set\` or the vault, never in the repo; use a placeholder.")
fi

# 3. .env files with values never get committed (only .env.example).
ENV_FILES="$(changed_under '(^|/)\.env' | grep -vE '\.env\.example$')"
[ -n "$ENV_FILES" ] && FAILURES+=("Hard check: env file(s) in the change:
$(as_list "$ENV_FILES")
Only .env.example (names, no values) belongs in the repo.")

# ---------------------------------------------------------------- automated checks
need_node_modules() { # need_node_modules <dir> <label>
  if [ ! -d "$ROOT/$1/node_modules" ]; then
    FAILURES+=("$2 checks can't run: $1/node_modules is missing. Run \`cd $1 && npm ci\`, then stop again.")
    return 1
  fi
}

# Root app: NorthStar CRM (Next.js). Typecheck the project, lint only the files
# that changed (main carries ~50 older lint errors in files nobody touched).
ROOT_SRC="$(changed_under '^(app|components|lib|contexts|hooks)/.*\.(ts|tsx|js|jsx|mjs)$|^middleware\.ts$|^next\.config\.ts$')"
ROOT_CFG="$(changed_under '^(package\.json|package-lock\.json|tsconfig\.json|eslint\.config\.mjs)$')"
if [ -n "$ROOT_SRC$ROOT_CFG" ] && need_node_modules . "Root app"; then
  run "Root typecheck" . npx tsc --noEmit
  LINT_FILES=()
  while IFS= read -r f; do [ -n "$f" ] && [ -f "$f" ] && LINT_FILES+=("$f"); done <<<"$ROOT_SRC"
  if [ ${#LINT_FILES[@]} -gt 0 ]; then
    run "Root lint (changed files)" . npx eslint --max-warnings=-1 "${LINT_FILES[@]}"
  fi
fi

# Lume (its own Next.js app). The four checks lume/README.md lists.
LUME_ANY="$(changed_under '^lume/')"
LUME_SRC="$(changed_under '^lume/(app|components|hooks|lib|public|middleware\.ts|next\.config\.ts|package\.json|package-lock\.json|tsconfig\.json|postcss\.config\.mjs)')"
if [ -n "$LUME_ANY" ] && need_node_modules lume "Lume"; then
  run "Lume lint" lume npm run lint --silent
  run "Lume typecheck" lume npx tsc --noEmit
  # vitest: one retry, so a flaky test doesn't cost the builder a round; the flake is reported.
  echo "== Lume tests (vitest) (lume: npx vitest run)" >>"$LOG"
  if (cd lume && npx vitest run) >"$REVIEW/vitest-1.log" 2>&1; then
    echo "   PASS" >>"$LOG"
  else
    FLAKY="$(grep -E '^ *(FAIL|×) ' "$REVIEW/vitest-1.log" | sed 's/^ *//' | sort -u | head -5)"
    if (cd lume && npx vitest run) >>"$LOG" 2>&1; then
      echo "   PASS on retry" >>"$LOG"
      NOTES+=("Flaky: Lume vitest failed once and passed on retry. First-run failures (review/vitest-1.log):
$(as_list "$FLAKY")")
    else
      echo "   FAIL" >>"$LOG"
      FAILURES+=("Lume tests (vitest) failed twice. Run \`cd lume && npx vitest run\` to see why (output also in review/checks.log).")
    fi
  fi
  if [ -n "$LUME_SRC" ]; then
    run "Lume build" lume npm run build --silent
  fi
fi

# Edge functions (Deno). The whole suite takes ~10 s. A failure that also fails
# on main (the merge base) is reported, not counted against this change.
deno_failures() { # deno_failures <functions dir>: the names of failing tests, one per line
  (cd "$1" && NO_COLOR=1 deno test --allow-env --allow-read 2>&1) \
    | awk '/^ *FAILURES *$/ {on=1; next} on && / => / {sub(/ => .*/, ""); print}' | sort -u
}
EDGE="$(changed_under '^supabase/functions/')"
if [ -n "$EDGE" ]; then
  if command -v deno >/dev/null 2>&1; then
    echo "== Edge function tests (supabase/functions: deno test --allow-env --allow-read)" >>"$LOG"
    if (cd supabase/functions && NO_COLOR=1 deno test --allow-env --allow-read) >>"$LOG" 2>&1; then
      echo "   PASS" >>"$LOG"
    else
      NOW_FAILING="$(deno_failures "$ROOT/supabase/functions")"
      BASE_TREE="$(mktemp -d)"
      BASE_FAILING=""
      if git worktree add --detach -q "$BASE_TREE/wt" "$BASE" >/dev/null 2>&1; then
        BASE_FAILING="$(deno_failures "$BASE_TREE/wt/supabase/functions")"
        git worktree remove --force "$BASE_TREE/wt" >/dev/null 2>&1
      fi
      rm -rf "$BASE_TREE"
      NEW_FAILING="$(comm -23 <(printf '%s\n' "$NOW_FAILING") <(printf '%s\n' "$BASE_FAILING") | sed '/^$/d')"
      if [ -z "$NOW_FAILING" ] || [ -n "$NEW_FAILING" ]; then
        echo "   FAIL" >>"$LOG"
        FAILURES+=("Edge function tests (deno) failed. New failures (not failing on main):
$(as_list "${NEW_FAILING:-(could not read test names; see review/checks.log)}")
Run \`cd supabase/functions && deno test --allow-env --allow-read\`.")
      else
        echo "   PASS (only failures that main has too)" >>"$LOG"
        NOTES+=("Edge tests that already fail on main (not caused by this change):
$(as_list "$NOW_FAILING")")
      fi
    fi
    for fn in $(printf '%s\n' "$EDGE" | awk -F/ '$3 !~ /^_/ && NF>=4 {print $3}' | sort -u); do
      [ -f "supabase/functions/$fn/index.ts" ] && run "deno check $fn" supabase/functions deno check "$fn/index.ts"
    done
  else
    skip "edge function tests: deno isn't installed here, so supabase/functions changes are unchecked. The verify-app reviewer must say so in its verdict."
  fi
fi

# Database (pgTAP). Needs the Supabase CLI and a running local stack (Docker).
if [ -n "$(changed_under '^supabase/(migrations|tests)/')" ]; then
  if command -v supabase >/dev/null 2>&1 && supabase status >/dev/null 2>&1; then
    run "Database tests (pgTAP)" . supabase test db
  else
    skip "pgTAP tests: no local Supabase stack here, so migration/test changes are unchecked."
  fi
fi

# Crawl worker (Python). Unit tests only; the live test skips itself without RUN_LIVE=1.
if [ -n "$(changed_under '^workers/crawl/')" ]; then
  PY=""
  for cand in "$ROOT/.venv/bin/python" python3; do
    if command -v "$cand" >/dev/null 2>&1 && "$cand" -c 'import fastapi, crawl4ai, pytest' >/dev/null 2>&1; then PY="$cand"; break; fi
  done
  if [ -n "$PY" ]; then
    run "Crawl worker tests (pytest)" workers/crawl "$PY" -m pytest tests -q
  else
    skip "crawl worker tests: its Python deps (fastapi, crawl4ai) aren't installed; see workers/crawl/README.md."
  fi
fi

# ---------------------------------------------------------------- report (checks-only mode)
if [ "$MODE" = "checks" ]; then
  # Record which change the reviewer is looking at; a verdict counts only for this one.
  [ -n "$FP" ] && printf '%s\n' "$FP" >"$REVIEWED_FP_FILE"
  echo "Changed since $BASE:"; as_list "$CHANGED"
  if [ ${#NOTES[@]} -gt 0 ]; then printf '%s\n' "${NOTES[@]}"; fi
  if [ ${#FAILURES[@]} -gt 0 ]; then printf 'FAIL: %s\n' "${FAILURES[@]}"; exit 1; fi
  echo "All automated checks passed. Full output: review/checks.log"
  exit 0
fi

# ---------------------------------------------------------------- the reviewer's verdict
VERDICT_HEAD="$(head -n1 "$VERDICT" 2>/dev/null)"
if [ ! -f "$VERDICT" ]; then
  FAILURES+=("No review/verdict.txt. Run the verify-app subagent on this change before saying you're done.")
elif ! matches_fp "$REVIEWED_FP_FILE" || [ "$VERDICT" -ot "$REVIEWED_FP_FILE" ]; then
  FAILURES+=("review/verdict.txt doesn't cover the current change (something was edited, added or deleted after the review). Delete it and run verify-app again.")
elif ! printf '%s' "$VERDICT_HEAD" | grep -q '^PASS'; then
  # The reviewer's FAIL verdict carries its instructions for the builder; pass them back whole.
  FAILURES+=("The verify-app reviewer said FAIL. Its instructions for you:
$(head -c 6000 "$VERDICT")")
fi

# ---------------------------------------------------------------- decide
if [ ${#FAILURES[@]} -eq 0 ]; then
  printf '%s\n' "$FP" >"$PASSED_FILE"
  rm -f "$ATTEMPTS_FILE" "$GAVE_UP_FILE"
  exit 0
fi

# Rounds are counted per change: a different change starts again at round 1.
LAST_FP=""; LAST_N=0
[ -f "$ATTEMPTS_FILE" ] && read -r LAST_FP LAST_N <"$ATTEMPTS_FILE"
if [ "${LAST_FP:-}" = "$FP" ]; then ATTEMPTS=$(( ${LAST_N:-0} + 1 )); else ATTEMPTS=1; fi
if [ "$ATTEMPTS" -gt "$MAX_ATTEMPTS" ]; then
  rm -f "$ATTEMPTS_FILE"
  [ -n "$FP" ] && printf '%s\n' "$FP" >"$GAVE_UP_FILE"
  json_message "Verification still failing after $MAX_ATTEMPTS rounds; letting Claude stop. Not verified: see review/checks.log and review/verdict.txt."
  exit 0
fi
printf '%s %s\n' "$FP" "$ATTEMPTS" >"$ATTEMPTS_FILE"

{
  echo "Not done yet: verification failed (round $ATTEMPTS of $MAX_ATTEMPTS). Fix these, delete review/verdict.txt, run the verify-app subagent again, then stop."
  printf -- '- %s\n' "${FAILURES[@]}"
  if [ ${#NOTES[@]} -gt 0 ]; then printf -- '- %s\n' "${NOTES[@]}"; fi
  [ "$ATTEMPTS" -eq "$MAX_ATTEMPTS" ] && echo "This is the last round: if it still fails, you'll be let go and must tell Conrad plainly what isn't verified."
} >&2
exit 2
