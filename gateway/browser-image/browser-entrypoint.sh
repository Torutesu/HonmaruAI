#!/bin/sh
set -eu

case "${BROWSER_UID:-}" in ''|*[!0-9]*) echo 'Invalid browser UID.' >&2; exit 64;; esac
case "${BROWSER_GID:-}" in ''|*[!0-9]*) echo 'Invalid browser GID.' >&2; exit 64;; esac
if [ "$BROWSER_UID" -lt 1 ] || [ "$BROWSER_GID" -lt 1 ]; then echo 'Invalid browser account.' >&2; exit 64; fi

# Each macOS user session gets a fresh lightweight VM. Only this VM can reach
# the network; inside it the untrusted browser user may reach loopback, while
# the separately-owned proxy UID may resolve DNS and open validated Web ports.
iptables -P INPUT DROP
iptables -P OUTPUT DROP
iptables -P FORWARD DROP
iptables -A INPUT -i lo -j ACCEPT
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
for server in $(awk '$1 == "nameserver" {print $2}' /etc/resolv.conf); do
  case "$server" in
    *:*) ip6tables -A OUTPUT -m owner --uid-owner 1001 -d "$server" -p udp --dport 53 -j ACCEPT
         ip6tables -A OUTPUT -m owner --uid-owner 1001 -d "$server" -p tcp --dport 53 -j ACCEPT;;
    *) iptables -A OUTPUT -m owner --uid-owner 1001 -d "$server" -p udp --dport 53 -j ACCEPT
       iptables -A OUTPUT -m owner --uid-owner 1001 -d "$server" -p tcp --dport 53 -j ACCEPT;;
  esac
done
for range in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 \
  192.0.0.0/24 192.0.2.0/24 192.88.99.0/24 192.168.0.0/16 198.18.0.0/15 \
  198.51.100.0/24 203.0.113.0/24 224.0.0.0/4 240.0.0.0/4; do
  iptables -A OUTPUT -m owner --uid-owner 1001 -p tcp -m multiport --dports 80,443 -d "$range" -j REJECT
done
for range in ::/128 ::1/128 64:ff9b::/96 64:ff9b:1::/48 100::/64 2001::/23 2001:10::/28 \
  2001:20::/28 2001:db8::/32 2002::/16 3fff::/20 5f00::/16 fc00::/7 fe80::/10 ff00::/8; do
  ip6tables -A OUTPUT -m owner --uid-owner 1001 -p tcp -m multiport --dports 80,443 -d "$range" -j REJECT
done
iptables -A OUTPUT -m owner --uid-owner 1001 -p tcp -m multiport --dports 80,443 -j ACCEPT
ip6tables -A OUTPUT -m owner --uid-owner 1001 -p tcp -m multiport --dports 80,443 -d 2000::/3 -j ACCEPT
ip6tables -P INPUT DROP
ip6tables -P OUTPUT DROP
ip6tables -P FORWARD DROP
ip6tables -A INPUT -i lo -j ACCEPT
ip6tables -A OUTPUT -o lo -j ACCEPT
ip6tables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
ip6tables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

mkdir -p /data /run/honmaru
# Apple Container named volumes include a root-owned lost+found directory that
# must remain inaccessible to the browser user. Give the profile root to the
# browser and transfer only actual profile entries.
chown "$BROWSER_UID:$BROWSER_GID" /data
find /data -mindepth 1 -maxdepth 1 ! -name lost+found -exec chown -R "$BROWSER_UID:$BROWSER_GID" {} +
umask 077
head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > /run/honmaru/control-token
# Restrict the token while root still owns it; the container drops FOWNER.
chmod 0400 /run/honmaru/control-token
chown "$BROWSER_UID:$BROWSER_GID" /run/honmaru/control-token

setpriv --reuid=1001 --regid=1001 --clear-groups --bounding-set=-all \
  node /opt/honmaru/browser-proxy-server.mjs &
proxy_pid=$!
trap 'kill "$proxy_pid" 2>/dev/null || true' EXIT INT TERM
ready=0
for attempt in $(seq 1 50); do
  if node -e "fetch('http://127.0.0.1:3128').then(()=>process.exit(0)).catch(()=>process.exit(1))" >/dev/null 2>&1; then ready=1; break; fi
  sleep 0.1
done
if [ "$ready" -ne 1 ]; then echo 'Browser proxy failed to start.' >&2; exit 70; fi

exec setpriv --reuid="$BROWSER_UID" --regid="$BROWSER_GID" --clear-groups --bounding-set=-all \
  node /opt/honmaru/browser-guest.mjs
