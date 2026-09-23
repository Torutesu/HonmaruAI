#!/usr/bin/env bash
#
# Everything the TestFlight workflow needs, from one App Store Connect API key.
#
#     scripts/testflight-secrets.sh            # do it
#     scripts/testflight-secrets.sh --run 1.0.1  # and start the TestFlight workflow
#
# The workflow (.github/workflows/testflight.yml) wants seven repository
# secrets. Six of them can be made from the seventh: with an API key, `asc`
# can issue the distribution certificate and the App Store profile, and `gh`
# can store all of it. So the one thing left for a browser is creating the
# key (docs/handoff-computer-use.md walks a person, or an agent, through it).
#
# Needs a Mac (`security`, `openssl`), `asc`, `gh` logged in, and `.asc.env`
# from scripts/setup.sh. Idempotent: an existing IOS_DISTRIBUTION certificate
# is reused when its private key is here; an existing "HonmaruAI AppStore"
# profile is reused; secrets are overwritten.
#
# Backs the private key up under ~/.honmaru-signing — without it the
# certificate is dead weight, and an account may hold only three.

set -euo pipefail

cd "$(dirname "$0")/.."

REPO="${GH_REPO:-Torutesu/HonmaruAI}"
PROFILE_NAME="${PROFILE_NAME:-HonmaruAI AppStore}"
SIGNING_DIR="${SIGNING_DIR:-$HOME/.honmaru-signing}"
BOLD=$(tput bold 2>/dev/null || true); DIM=$(tput dim 2>/dev/null || true); OFF=$(tput sgr0 2>/dev/null || true)
say() { printf '\n%s%s%s\n' "$BOLD" "$1" "$OFF"; }
note() { printf '%s  %s%s\n' "$DIM" "$1" "$OFF"; }
die() { echo "error: $1" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$2"; }

RUN_VERSION=""
while [ $# -gt 0 ]; do
  case "$1" in
    --run) RUN_VERSION="${2:-}"; [ -n "$RUN_VERSION" ] || die "--run needs a version, e.g. --run 1.0.1"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

say "0. Tools and the key"
[ "$(uname -s)" = "Darwin" ] || die "this needs a Mac: the keychain and codesign live there"
need asc "brew install asc"
need gh "brew install gh, then: gh auth login"
need openssl "openssl is part of macOS"
need python3 "python3 is part of macOS"
gh auth status >/dev/null 2>&1 || die "gh is not logged in: gh auth login"
[ -f .asc.env ] || die ".asc.env is missing: run scripts/setup.sh first (it asks for the key id, issuer id and .p8 path)"
# shellcheck disable=SC1091
set -a; . ./.asc.env; set +a
: "${ASC_KEY_ID:?ASC_KEY_ID is not set in .asc.env}"
: "${ASC_ISSUER_ID:?ASC_ISSUER_ID is not set in .asc.env}"
: "${ASC_PRIVATE_KEY:?ASC_PRIVATE_KEY is not set in .asc.env}"
: "${DEVELOPMENT_TEAM:?DEVELOPMENT_TEAM is not set in .asc.env}"
ASC_PRIVATE_KEY="${ASC_PRIVATE_KEY/#\~/$HOME}"
[ -f "$ASC_PRIVATE_KEY" ] || die "the .p8 is not at $ASC_PRIVATE_KEY"
BUNDLE="${ASC_BUNDLE_ID:-com.honmaru.ai}"
export ASC_KEY_ID ASC_ISSUER_ID ASC_PRIVATE_KEY
asc auth status --validate >/dev/null 2>&1 || asc auth login --key-id "$ASC_KEY_ID" --issuer-id "$ASC_ISSUER_ID" --private-key "$ASC_PRIVATE_KEY" >/dev/null
note "key $ASC_KEY_ID, team $DEVELOPMENT_TEAM, bundle $BUNDLE, repo $REPO"

json() { python3 -c "$1"; }

say "1. Distribution certificate"
mkdir -p "$SIGNING_DIR"; chmod 700 "$SIGNING_DIR"; cd "$SIGNING_DIR"; umask 077
CERT_ID=""
if [ -f dist.key ] && [ -f cert.id ]; then
  CERT_ID="$(cat cert.id)"
  if asc certificates view --id "$CERT_ID" --output json >/dev/null 2>&1; then
    note "reusing certificate $CERT_ID (its key is here)"
  else
    CERT_ID=""
  fi
fi
if [ -z "$CERT_ID" ]; then
  [ -f dist.key ] || openssl genrsa -out dist.key 2048 2>/dev/null
  openssl req -new -key dist.key -out dist.csr -subj "/CN=Honmaru AI/C=US"
  CERT_ID="$(asc certificates create --certificate-type IOS_DISTRIBUTION --csr dist.csr --output json \
    | json 'import sys,json; print(json.load(sys.stdin)["data"]["id"])')"
  printf '%s' "$CERT_ID" > cert.id
  note "issued certificate $CERT_ID"
fi
asc certificates view --id "$CERT_ID" --output json \
  | json 'import sys,json,base64; sys.stdout.buffer.write(base64.b64decode(json.load(sys.stdin)["data"]["attributes"]["certificateContent"]))' > dist.cer
openssl x509 -inform DER -in dist.cer -out dist.pem
# The team id is the certificate's OU. A mismatch here is the classic
# "no signing certificate found" an hour later in CI.
OU="$(openssl x509 -in dist.pem -noout -subject -nameopt RFC2253 | sed -n 's/.*OU=\([^,]*\).*/\1/p')"
[ "$OU" = "$DEVELOPMENT_TEAM" ] || die "the certificate belongs to team $OU, but .asc.env says DEVELOPMENT_TEAM=$DEVELOPMENT_TEAM"
P12_PASSWORD="$(uuidgen)"
# macOS cannot read a PKCS#12 written with OpenSSL 3 defaults.
openssl pkcs12 -export -inkey dist.key -in dist.pem -out dist.p12 \
  -passout "pass:$P12_PASSWORD" -macalg sha1 -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES
note "dist.p12 written under $SIGNING_DIR (back up dist.key)"

say "2. App Store profile"
BUNDLE_ID="$(asc bundle-ids list --output json \
  | json "import sys,json; rows=json.load(sys.stdin)['data']; m=[r['id'] for r in rows if r['attributes'].get('identifier')=='$BUNDLE']; print(m[0] if m else '')")"
[ -n "$BUNDLE_ID" ] || die "no bundle id $BUNDLE in this team — register it once at developer.apple.com → Identifiers"
PROFILE_ID="$(asc profiles list --output json \
  | json "import sys,json; rows=json.load(sys.stdin)['data']; m=[r['id'] for r in rows if r['attributes'].get('name')=='$PROFILE_NAME' and r['attributes'].get('profileState')=='ACTIVE']; print(m[0] if m else '')")"
if [ -n "$PROFILE_ID" ]; then
  # A profile only knows the certificates it was made with. One made before
  # this certificate signs nothing built with it.
  if asc profiles view --id "$PROFILE_ID" --output json --include certificates 2>/dev/null | grep -q "\"$CERT_ID\""; then
    note "reusing profile $PROFILE_ID"
  else
    note "profile $PROFILE_ID predates this certificate; replacing it"
    asc profiles delete --id "$PROFILE_ID" --confirm >/dev/null 2>&1 || true
    PROFILE_ID=""
  fi
fi
if [ -z "$PROFILE_ID" ]; then
  PROFILE_ID="$(asc profiles create --name "$PROFILE_NAME" --profile-type IOS_APP_STORE \
    --bundle "$BUNDLE_ID" --certificate "$CERT_ID" --output json \
    | json 'import sys,json; print(json.load(sys.stdin)["data"]["id"])')"
  note "created profile $PROFILE_ID"
fi
asc profiles download --id "$PROFILE_ID" --output profile.mobileprovision >/dev/null
[ -s profile.mobileprovision ] || die "the profile did not download"

say "3. Repository secrets"
set_secret() { printf '%s' "$2" | gh secret set "$1" --repo "$REPO" >/dev/null && note "$1"; }
set_secret ASC_KEY_ID "$ASC_KEY_ID"
set_secret ASC_ISSUER_ID "$ASC_ISSUER_ID"
set_secret ASC_KEY_P8 "$(cat "$ASC_PRIVATE_KEY")"
set_secret DEVELOPMENT_TEAM "$DEVELOPMENT_TEAM"
set_secret DIST_CERT_P12 "$(base64 -i dist.p12)"
set_secret DIST_CERT_PASSWORD "$P12_PASSWORD"
set_secret PROVISIONING_PROFILE "$(base64 -i profile.mobileprovision)"
rm -f dist.csr dist.cer dist.pem
note "seven secrets set on $REPO"

if [ -n "$RUN_VERSION" ]; then
  say "4. TestFlight"
  gh workflow run testflight.yml --repo "$REPO" -f "version=$RUN_VERSION" -f "group=Internal Testers"
  note "started; watch it with: gh run watch --repo $REPO"
else
  say "Done."
  note "Start a build with: scripts/testflight-secrets.sh --run 1.0.1"
  note "or Actions → TestFlight → Run workflow."
fi
