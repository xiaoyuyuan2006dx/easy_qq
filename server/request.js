const { sseClients } = require('./state');

function readBody(req) {
  return new Promise((resolve, reject) => {
    let destroyed = false;
    const chunks = [];
    let size = 0;
    const LIMIT = 2 * 1024 * 1024; // 2MB
    req.on('data', (chunk) => {
      if (destroyed) return;
      size += chunk.length;
      if (size > LIMIT) {
        destroyed = true;
        req.destroy();
        reject(new Error('Payload too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (destroyed) return;
      if (!chunks.length) return resolve({});
      const raw = Buffer.concat(chunks).toString('utf8');
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', (err) => {
      if (!destroyed) reject(err);
    });
  });
}

function broadcast(payload) {
  const line = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) client.write(line);
}

module.exports = { readBody, broadcast };
