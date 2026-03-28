// Pino v7+ worker transport: default export = async function -> returns a Writable
import { Writable } from 'node:stream';
import http from 'node:http';
import https from 'node:https';

interface TransportOptions {
  url?: string;
  batch?: number;
  interval?: number;
  headers?: Record<string, string>;
}

export default async function transport(opts: TransportOptions = {}): Promise<Writable> {
  const { getConfig } = await import('../config/app-config.js');
  const config = getConfig();
  const url = opts.url || config.telemetry.endpoint;
  if (!url) {
    // No endpoint configured → return a no-op writable (as per docs pattern)
    return new Writable({ 
      write(_chunk: any, _enc: BufferEncoding, cb: (error?: Error | null) => void) { 
        cb(); 
      } 
    });
  }

  const batchSize = Number(opts.batch ?? 20);     // how many lines per POST
  const flushMs   = Number(opts.interval ?? 2000); // flush interval
  const headers   = { 'content-type': 'application/x-ndjson', ...(opts.headers || {}) };

  // Use keep-alive for efficiency (optional but recommended)
  const agent = url.startsWith('https:')
    ? new https.Agent({ keepAlive: true })
    : new http.Agent({ keepAlive: true });

  let buffer: string[] = [];

  async function flush(): Promise<void> {
    if (buffer.length === 0) return;
    const lines = buffer.splice(0, batchSize);
    const body = lines.join('') + '\n';

    await new Promise<void>((resolve) => {
      const req = (url.startsWith('https:') ? https : http).request(
        url,
        { 
          method: 'POST', 
          headers: { ...headers, 'content-length': Buffer.byteLength(body) }, 
          agent 
        },
        (res) => { 
          res.resume(); 
          resolve(); 
        } // consume & resolve regardless (non-blocking)
      );
      req.on('error', () => resolve());       // drop on network error (non-blocking)
      req.write(body);
      req.end();
    });
  }

  const timer = setInterval(flush, flushMs);

  return new Writable({
    write(chunk: any, _enc: BufferEncoding, cb: (error?: Error | null) => void) {
      // Pino sends NDJSON lines already; keep as lines and batch
      buffer.push(chunk.toString().trimEnd() + '\n');
      if (buffer.length >= batchSize) {
        flush().finally(() => cb());
      } else {
        cb();
      }
    },
    final(cb: (error?: Error | null) => void) {
      clearInterval(timer);
      flush().finally(() => cb());
    },
    destroy(err: Error | null, cb?: (error?: Error | null) => void) {
      clearInterval(timer);
      buffer = [];
      cb?.(err);
    }
  });
}
