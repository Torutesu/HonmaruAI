#!/usr/bin/env bash
# Attaches custom domains to a Cloudflare Pages project and, when the API
# token may edit the zone's DNS, points them at the project.
#
#   attach-pages-domain.sh <project> <zone> <host>...
#
# Idempotent. It never fails the job: a domain it cannot attach or a record
# it cannot add becomes a warning that names what to add by hand, and the
# site keeps its pages.dev address meanwhile.
set -u
project=$1 zone_name=$2; shift 2
api="https://api.cloudflare.com/client/v4"
auth=(-H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json")

have=$(curl -s "${auth[@]}" "$api/accounts/$CLOUDFLARE_ACCOUNT_ID/pages/projects/$project/domains" | jq -r '.result[]? | "\(.name) \(.status)"')
echo "attached to $project now:"; echo "${have:-  (none)}"
for host in "$@"; do
  grep -q "^$host " <<<"$have" && continue
  out=$(curl -s "${auth[@]}" -X POST "$api/accounts/$CLOUDFLARE_ACCOUNT_ID/pages/projects/$project/domains" --data "{\"name\":\"$host\"}")
  if jq -e .success <<<"$out" >/dev/null; then echo "attached $host"; else echo "::warning::Could not attach $host to $project: $(jq -c .errors <<<"$out")"; fi
done

# Where each domain stands with Pages, and why when it is not active yet.
curl -s "${auth[@]}" "$api/accounts/$CLOUDFLARE_ACCOUNT_ID/pages/projects/$project/domains" \
  | jq -r '.result[]? | "  \(.name): \(.status); certificate \(.validation_data.status // "-") \(.validation_data.error_message // ""); ownership \(.verification_data.status // "-") \(.verification_data.error_message // "")"'

zone=$(curl -s "${auth[@]}" "$api/zones?name=$zone_name" | jq -r '.result[0].id // empty')
for host in "$@"; do
  rec=""
  [ -n "$zone" ] && rec=$(curl -s "${auth[@]}" "$api/zones/$zone/dns_records?name=$host" | jq -r '.result[]? | "\(.type) \(.content)"')
  if [ -n "$rec" ]; then
    echo "$host already has: $rec"
    grep -q "CNAME $project.pages.dev" <<<"$rec" || echo "::warning::$host points elsewhere ($rec); left as it is."
    continue
  fi
  out='{"success":false,"errors":["the token cannot read the zone"]}'
  [ -n "$zone" ] && out=$(curl -s "${auth[@]}" -X POST "$api/zones/$zone/dns_records" --data "{\"type\":\"CNAME\",\"name\":\"$host\",\"content\":\"$project.pages.dev\",\"proxied\":true}")
  if jq -e .success <<<"$out" >/dev/null; then
    echo "added CNAME $host -> $project.pages.dev"
  else
    echo "::warning::Add this in Cloudflare DNS for $zone_name (the token cannot, $(jq -c .errors <<<"$out")): CNAME $host -> $project.pages.dev, proxied."
  fi
done
exit 0
