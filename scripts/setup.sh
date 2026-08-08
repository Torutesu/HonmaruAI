#!/usr/bin/env bash
#
# Interactive first-time setup. Asks a few questions and writes .asc.env,
# so nobody has to know which file a Team ID belongs in.
#
#   scripts/setup.sh
#
# Safe to re-run: existing answers are offered as defaults, and you are asked
# before anything is overwritten.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO_ROOT/.asc.env"

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
dim()   { printf '\033[2m%s\033[0m\n' "$*"; }
ok()    { printf '\033[32m✓  %s\033[0m\n' "$*"; }
warn()  { printf '\033[33m!  %s\033[0m\n' "$*"; }
die()   { printf '\033[31mx  %s\033[0m\n' "$*" >&2; exit 1; }

# ask VAR "Label" "where to find it" [default] [optional]
# Keeps asking until the answer is non-empty, unless the field is marked
# optional — an empty required field only surfaces as a failure much later.
ask() {
  local var="$1" label="$2" hint="$3" default="${4:-}" optional="${5:-}"
  local current="${!var:-}" reply
  [ -n "$current" ] && default="$current"

  printf '\n'
  bold "$label"
  dim  "   $hint"
  while :; do
    if [ -n "$default" ]; then
      printf '   [%s]: ' "$default"
    else
      printf '   > '
    fi
    read -r reply
    # Pasted values routinely arrive with stray spaces or a leading newline.
    reply="${reply#"${reply%%[![:space:]]*}"}"
    reply="${reply%"${reply##*[![:space:]]}"}"
    reply="${reply:-$default}"
    [ -n "$reply" ] && break
    [ -n "$optional" ] && break
    warn "  this one is required — paste the value, then press Enter"
  done
  printf -v "$var" '%s' "$reply"
}

bold "Honmaru AI — App Store Connect setup"
dim  "Answer each question, or press Enter to keep the value in brackets."

if [ -f "$ENV_FILE" ]; then
  warn "$ENV_FILE already exists — your current values are shown as defaults."
  # shellcheck disable=SC1090
  set -a; . "$ENV_FILE"; set +a
fi

ask DEVELOPMENT_TEAM \
  "Apple Developer Team ID" \
  "10 characters, e.g. A1B2C3D4E5. Find it at developer.apple.com/account -> Membership details."

ask ASC_KEY_ID \
  "App Store Connect API — Key ID" \
  "About 10 characters. App Store Connect -> Users and Access -> Integrations -> App Store Connect API."

ask ASC_ISSUER_ID \
  "App Store Connect API — Issuer ID" \
  "Long code with dashes, shown at the top of that same Integrations page."

ask ASC_PRIVATE_KEY \
  "Path to your .p8 key file" \
  "The file you downloaded from that page. Tip: drag the file into this window to paste its path." \
  "$HOME/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID:-XXXXXXXXXX}.p8"

# Drag-and-drop in Terminal wraps paths in quotes and escapes spaces.
ASC_PRIVATE_KEY="${ASC_PRIVATE_KEY%\'}"; ASC_PRIVATE_KEY="${ASC_PRIVATE_KEY#\'}"
ASC_PRIVATE_KEY="${ASC_PRIVATE_KEY%\"}"; ASC_PRIVATE_KEY="${ASC_PRIVATE_KEY#\"}"
ASC_PRIVATE_KEY="${ASC_PRIVATE_KEY//\\ / }"
ASC_PRIVATE_KEY="${ASC_PRIVATE_KEY/#\~/$HOME}"

ask ASC_APP_ID \
  "App Store Connect app ID (optional for now)" \
  "Numeric, e.g. 6478123456. Leave blank until you have created the app record; 'scripts/release.sh doctor' will remind you." \
  "" optional

printf '\n'
if [ -f "$ENV_FILE" ]; then
  printf '\033[1m?  Overwrite %s with these answers? [y/N] \033[0m' ".asc.env"
  read -r reply
  case "$reply" in y|Y|yes|YES) ;; *) die "nothing was changed" ;; esac
fi

umask 077   # the file names a private key path — keep it owner-readable only
cat > "$ENV_FILE" <<EOF
# Written by scripts/setup.sh. Gitignored — never commit this file.

ASC_KEY_ID=$ASC_KEY_ID
ASC_ISSUER_ID=$ASC_ISSUER_ID
ASC_PRIVATE_KEY=$ASC_PRIVATE_KEY
ASC_PROFILE=${ASC_PROFILE:-HonmaruAI}

ASC_APP_ID=$ASC_APP_ID
ASC_BUNDLE_ID=${ASC_BUNDLE_ID:-com.honmaru.ai}

DEVELOPMENT_TEAM=$DEVELOPMENT_TEAM

ASC_LOCALE=${ASC_LOCALE:-en-US}
ASC_SCHEME=${ASC_SCHEME:-HonmaruAI}
EOF

printf '\n'
ok "Saved to .asc.env"

# --- sanity checks, each one a thing that would otherwise fail much later ---

printf '\n'
bold "Checking your answers"

if [ "$DEVELOPMENT_TEAM" = "$ASC_KEY_ID" ]; then
  # Both are ~10 alphanumeric characters, so they get pasted into each other's slot.
  warn "Team ID and Key ID are the same value — they are two different things."
  dim  "   Team ID: developer.apple.com/account -> Membership details"
  dim  "   Key ID:  App Store Connect -> Users and Access -> Integrations"
elif [ ${#DEVELOPMENT_TEAM} -eq 10 ]; then
  ok "Team ID looks right (10 characters)"
else
  warn "Team ID is ${#DEVELOPMENT_TEAM} characters — Apple's are normally 10. Double-check it."
fi

if [ -n "$ASC_ISSUER_ID" ] && [ "${ASC_ISSUER_ID//-/}" = "$ASC_ISSUER_ID" ]; then
  warn "Issuer ID has no dashes — Apple's look like 1234abcd-56ef-78ab-90cd-1234567890ab"
fi

if [ -f "$ASC_PRIVATE_KEY" ]; then
  ok "Found your key file"
else
  warn "No file at: $ASC_PRIVATE_KEY"
  # The .p8 is almost always still sitting wherever the browser dropped it.
  found="$(find "$HOME/Downloads" "$HOME/Desktop" "$HOME/.appstoreconnect" \
             -maxdepth 2 -name 'AuthKey_*.p8' 2>/dev/null | head -n 3)"
  if [ -n "$found" ]; then
    dim "   But there is a key file here:"
    printf '%s\n' "$found" | while read -r f; do dim "     $f"; done
    dim "   Move it into place with:"
    dim "   mkdir -p ~/.appstoreconnect/private_keys && mv ~/Downloads/AuthKey_*.p8 ~/.appstoreconnect/private_keys/"
    dim "   then re-run this script and accept the default path."
  else
    dim "   No AuthKey_*.p8 found in Downloads or Desktop either."
    dim "   Download it from App Store Connect -> Users and Access -> Integrations."
    dim "   Apple only lets you download it once; if it is lost, create a new key."
  fi
fi

for tool in asc xcodegen xcodebuild; do
  if command -v "$tool" >/dev/null 2>&1; then
    ok "$tool is installed"
  else
    case "$tool" in
      asc|xcodegen) warn "$tool is missing — install it with: brew install $tool" ;;
      xcodebuild)   warn "Xcode is missing — install it from the Mac App Store" ;;
    esac
  fi
done

printf '\n'
bold "Next step"
dim  "   scripts/release.sh login     # hand your key to the asc tool"
dim  "   scripts/release.sh doctor    # check everything is ready"
