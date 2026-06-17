#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════════════
# scripts/gen-certs.sh
#
# Generates self-signed HTTPS certificates trusted by all browsers on this
# machine using mkcert (https://github.com/FiloSottile/mkcert).
#
# Run ONCE per machine. The generated certs are trusted by:
#   - Chrome, Firefox, Safari on the same machine
#   - Android Chrome IF you install the root CA manually (see below)
#
# USAGE:
#   chmod +x scripts/gen-certs.sh
#   ./scripts/gen-certs.sh
#
# ANDROID HTTPS SETUP (optional — needed for camera permission on mobile):
#   1. After running this script, the root CA is at:
#        $(mkcert -CAROOT)/rootCA.pem
#   2. Email it to yourself or airdrop it to your phone.
#   3. On Android: Settings → Security → Install certificate → CA certificate
#   4. Trust it, then open https://192.168.1.x:3000 on your phone.
# ══════════════════════════════════════════════════════════════════════════════

set -euo pipefail

# ── 1. Check mkcert is installed ──────────────────────────────────────────────
if ! command -v mkcert &>/dev/null; then
  echo "❌ mkcert is not installed."
  echo ""
  echo "Install it:"
  echo "  macOS:   brew install mkcert"
  echo "  Linux:   sudo apt install mkcert   (Ubuntu 22.04+)"
  echo "           OR: https://github.com/FiloSottile/mkcert/releases"
  echo "  Windows: choco install mkcert   OR   winget install mkcert"
  echo ""
  exit 1
fi

# ── 2. Detect LAN IP ──────────────────────────────────────────────────────────
detect_lan_ip() {
  # Linux
  ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if ($i=="src") print $(i+1)}' | head -1
}

LAN_IP=$(detect_lan_ip)
if [ -z "$LAN_IP" ]; then
  # macOS fallback
  LAN_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "")
fi
if [ -z "$LAN_IP" ]; then
  echo "⚠️  Could not detect LAN IP automatically."
  echo "   Enter your LAN IP (from ipconfig/ip a):"
  read -r LAN_IP
fi

echo "🌐 LAN IP: $LAN_IP"

# ── 3. Create certs/ directories ──────────────────────────────────────────────
mkdir -p erp-enterprise-full/certs
mkdir -p erp-unified-backend/certs

# ── 4. Install local CA (run once — adds to system/browser trust store) ───────
echo "🔐 Installing mkcert root CA into system trust store..."
mkcert -install

# ── 5. Generate certificates covering localhost + LAN IP ──────────────────────
echo "📜 Generating certificates for: localhost, 127.0.0.1, $LAN_IP"

# Frontend certs (used by Vite when VITE_HTTPS=true)
mkcert \
  -key-file  "erp-enterprise-full/certs/localhost-key.pem" \
  -cert-file "erp-enterprise-full/certs/localhost.pem" \
  localhost 127.0.0.1 "$LAN_IP"

# Backend certs (used by Express when HTTPS=true in backend .env)
cp erp-enterprise-full/certs/localhost-key.pem erp-unified-backend/certs/
cp erp-enterprise-full/certs/localhost.pem     erp-unified-backend/certs/

echo ""
echo "✅ Certificates generated:"
echo "   erp-enterprise-full/certs/localhost.pem"
echo "   erp-enterprise-full/certs/localhost-key.pem"
echo "   erp-unified-backend/certs/localhost.pem"
echo "   erp-unified-backend/certs/localhost-key.pem"
echo ""
echo "📱 To enable HTTPS:"
echo "   Frontend: add VITE_HTTPS=true to erp-enterprise-full/.env.local"
echo "   Backend:  add HTTPS=true       to erp-unified-backend/.env.local"
echo "             (or use Nginx instead — see nginx/nginx.development.conf)"
echo ""
echo "📱 To trust on Android (for camera over HTTPS on mobile):"
CAROOT=$(mkcert -CAROOT)
echo "   CA root: $CAROOT/rootCA.pem"
echo "   1. Copy rootCA.pem to your phone (email / USB / ADB)"
echo "   2. Settings → Security → Install certificate → CA certificate"
echo ""
