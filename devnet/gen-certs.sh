#!/usr/bin/env bash
# Generate the devnet node's self-signed p2p certificate and record its peer id in .env.
# The peer id chainweb expects in --known-peer-info is base64url(sha256(certificate DER)).
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p certs
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=devnet-bootstrap-node" \
  -keyout certs/devnet-bootstrap-node.key.pem -out certs/devnet-bootstrap-node.cert.pem >/dev/null 2>&1
PEER=$(openssl x509 -in certs/devnet-bootstrap-node.cert.pem -outform DER | openssl dgst -sha256 -binary | basenc --base64url | tr -d '=\n')
if grep -q '^BOOTSTRAP_PEER_ID=' .env 2>/dev/null; then sed -i "s|^BOOTSTRAP_PEER_ID=.*|BOOTSTRAP_PEER_ID=$PEER|" .env; else echo "BOOTSTRAP_PEER_ID=$PEER" >> .env; fi
echo "certificate written to certs/, peer id $PEER recorded in .env"
