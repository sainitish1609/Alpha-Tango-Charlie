#!/usr/bin/env bash
# Makes HTTPS certificates for playing VECTOR across the home network (the microphone needs HTTPS).
# A small private certificate authority (certs/ca.crt) signs the server's certificate. Install ca.crt on a
# device once (the game serves it at /ca.crt) and that device trusts the game with no warnings.
# Usage: tools/make-certs.sh [extra names or IPs...]
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p certs && cd certs
umask 077
if [ ! -f ca.key ]; then
  openssl req -x509 -new -newkey rsa:3072 -nodes -keyout ca.key -out ca.crt -days 3650 \
    -subj "/CN=VECTOR home network CA ($(hostname))" -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
fi
SAN="DNS:localhost,DNS:$(hostname),DNS:$(hostname).local,IP:127.0.0.1"
for ip in $(hostname -I); do case "$ip" in 192.168.*|10.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*) SAN="$SAN,IP:$ip";; esac; done
for extra in "$@"; do if [[ "$extra" =~ ^[0-9.]+$ ]]; then SAN="$SAN,IP:$extra"; else SAN="$SAN,DNS:$extra"; fi; done
openssl req -new -newkey rsa:2048 -nodes -keyout server.key -out server.csr -subj "/CN=$(hostname) VECTOR" 2>/dev/null
printf "subjectAltName=%s\nextendedKeyUsage=serverAuth\nkeyUsage=critical,digitalSignature,keyEncipherment\nbasicConstraints=CA:FALSE\n" "$SAN" > server.ext
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out server.crt -days 825 -sha256 -extfile server.ext 2>/dev/null
rm -f server.csr server.ext
chmod 644 ca.crt server.crt
echo "certificates for: $SAN"
