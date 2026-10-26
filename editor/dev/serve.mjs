// Serves the editor for trying the UI in a browser: node dev/serve.mjs [port]
// /__arena/AdvancedOutput.xml is Arena's real file, read-only.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.argv[2] ?? 5178);
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.xml': 'application/xml' };

createServer(async (req, res) => {
  const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  // Optional: with SNAPSHOT_DIR set, POST /__snapshot/<name>.png saves a PNG there (for checking renders).
  if (req.method === 'POST' && url.startsWith('/__snapshot/') && process.env.SNAPSHOT_DIR) {
    const name = url.slice('/__snapshot/'.length).replace(/[^\w.-]/g, '_');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(process.env.SNAPSHOT_DIR, name), Buffer.from(Buffer.concat(chunks).toString(), 'base64'));
    res.writeHead(204).end();
    return;
  }
  const file =
    url === '/__arena/AdvancedOutput.xml'
      ? join(homedir(), 'Documents', 'Resolume Arena', 'Preferences', 'AdvancedOutput.xml')
      : join(root, normalize(url === '/' ? '/index.html' : url));
  if (!file.startsWith(root) && !url.startsWith('/__arena/')) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' }).end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(port, '127.0.0.1', () => console.log(`Editor UI on http://127.0.0.1:${port}`));
