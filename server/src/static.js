import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

const CONTENT_TYPES = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
});

export async function tryServeStatic(request, response, pathname, publicDir) {
  if (!publicDir || !['GET', 'HEAD'].includes(request.method)) return false;
  if (
    pathname === '/entry'
    || pathname.startsWith('/entry/')
    || pathname === '/health'
    || pathname.startsWith('/api/')
  ) return false;

  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return false; }
  const segments = decoded.split('/').filter(Boolean);
  if (segments.some((part) => part === '..' || part.startsWith('.') || part.includes('\\'))) return false;

  const root = resolve(publicDir);
  let candidate = resolve(root, segments.join('/'));
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) return false;
  let metadata = await fileMetadata(candidate);
  if (!metadata?.isFile()) {
    candidate = resolve(root, 'index.html');
    metadata = await fileMetadata(candidate);
  }
  if (!metadata?.isFile()) return false;

  const extension = extname(candidate).toLowerCase();
  response.statusCode = 200;
  response.setHeader('Content-Type', CONTENT_TYPES[extension] || 'application/octet-stream');
  response.setHeader('Content-Length', metadata.size);
  response.setHeader(
    'Cache-Control',
    candidate.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-store'
  );
  if (request.method === 'HEAD') {
    response.end();
    return true;
  }
  await new Promise((resolveStream, rejectStream) => {
    const stream = createReadStream(candidate);
    stream.once('error', rejectStream);
    stream.once('end', resolveStream);
    stream.pipe(response);
  });
  return true;
}

async function fileMetadata(path) {
  try { return await stat(path); } catch { return null; }
}
