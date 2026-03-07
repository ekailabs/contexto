import http from 'node:http';
import https from 'node:https';

let cachedIp: string | undefined;
let inFlight: Promise<string | undefined> | null = null;

function request(url: string, timeoutMs = 2000): Promise<string> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve(data.trim()));
    });
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', reject);
  });
}

export async function getPublicIp(): Promise<string | undefined> {
  if (cachedIp) return cachedIp;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const endpoints = [
      'https://api.ipify.org',
      'https://ifconfig.me/ip',
      'http://checkip.amazonaws.com/',
    ];
    for (const url of endpoints) {
      try {
        const ip = await request(url);
        if (ip && /^(?:\d{1,3}\.){3}\d{1,3}$|^[a-fA-F0-9:]+$/.test(ip)) {
          cachedIp = ip;
          inFlight = null;
          return cachedIp;
        }
      } catch {
        // try next
      }
    }
    inFlight = null;
    return undefined;
  })();
  return inFlight;
}

export function isLocalAddress(ip?: string | null): boolean {
  if (!ip) return true;
  const v = ip.toLowerCase();
  return v === '::1' || v.startsWith('127.') || v.startsWith('::ffff:127.');
}

