const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { getLocalIpv4List } = require('./network');

const CERT_FILE = path.join(__dirname, '..', 'data', 'cert.pem');
const KEY_FILE = path.join(__dirname, '..', 'data', 'key.pem');
const HTTPS_PORT = process.env.HTTPS_PORT ? Number(process.env.HTTPS_PORT) : 18443;

function generateCert() {
  const ips = getLocalIpv4List();
  const subject = `/CN=${ips[0] || 'easy_qq'}`;
  // Build SAN extension: IP:127.0.0.1, DNS:localhost, IP:192.168.x.x, ...
  const sanParts = ['IP:127.0.0.1', 'DNS:localhost', ...ips.map((ip) => `IP:${ip}`)];
  const sanExt = `subjectAltName=${sanParts.join(',')}`;

  execSync(
    `openssl req -x509 -newkey rsa:2048 -keyout "${KEY_FILE}" -out "${CERT_FILE}" -days 3650 -nodes -subj "${subject}" -addext "${sanExt}"`,
    { stdio: 'pipe' },
  );

  const cert = fs.readFileSync(CERT_FILE, 'utf8');
  const key = fs.readFileSync(KEY_FILE, 'utf8');
  return { cert, key };
}

function loadOrGenerateCert() {
  if (fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE)) {
    try {
      const cert = fs.readFileSync(CERT_FILE, 'utf8');
      const x509 = new (require('crypto')).X509Certificate(cert);
      const expires = new Date(x509.validTo);
      if (Date.now() < expires.getTime()) {
        return { cert, key: fs.readFileSync(KEY_FILE, 'utf8') };
      }
      console.log('[https] Certificate expired, regenerating...');
    } catch { /* corrupt cert, regenerate */ }
  }

  try {
    console.log('[https] Generating self-signed certificate (valid 10 years)...');
    const result = generateCert();
    const ips = getLocalIpv4List();
    console.log(`[https] HTTPS will start on port ${HTTPS_PORT}`);
    console.log(`[https] Access: https://localhost:${HTTPS_PORT}`);
    ips.forEach((ip) => console.log(`         https://${ip}:${HTTPS_PORT}`));
    console.log('[https] Browser will warn "Not secure" — click Advanced → Proceed to continue');
    return result;
  } catch (e) {
    console.log(`[https] Failed to generate certificate: ${e.message}`);
    console.log('[https] Install openssl or set HTTPS_PORT=0 to disable');
    return null;
  }
}

module.exports = { loadOrGenerateCert, getLocalIpv4List, HTTPS_PORT };
