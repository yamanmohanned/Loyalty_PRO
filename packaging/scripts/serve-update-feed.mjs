#!/usr/bin/env node
/**
 * A logging static server for `packaging/dist/update`, for the end-to-end update test.
 *
 * The log is the point. "The updater works" is otherwise an assertion about something
 * that happens inside a Rust plugin with no visible output; a request log showing the
 * running app fetch `latest.json` and then pull 34 MB of installer is evidence.
 *
 *   node packaging/scripts/serve-update-feed.mjs [port]
 */

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../dist/update', import.meta.url)));
const port = Number(process.argv[2] ?? 8787);

createServer((req, res) => {
  const name = decodeURIComponent((req.url ?? '/').split('?')[0].replace(/^\//, ''));
  const path = join(ROOT, name);
  const stamp = new Date().toISOString().slice(11, 19);

  // Not a general-purpose file server: it serves two files to one localhost client for
  // the length of one test, and anything outside its root is a bug in the test.
  if (!name || !path.startsWith(ROOT) || !existsSync(path) || statSync(path).isDirectory()) {
    console.log(`  ${stamp}  404  ${name || '/'}`);
    res.writeHead(404).end('not found');
    return;
  }

  const size = statSync(path).size;
  console.log(`  ${stamp}  200  ${name}  (${(size / 1024 / 1024).toFixed(1)} MB)`);
  res.writeHead(200, {
    'content-type': name.endsWith('.json') ? 'application/json' : 'application/octet-stream',
    'content-length': String(size),
  });
  createReadStream(path).pipe(res);
}).listen(port, '127.0.0.1', () => {
  console.log(`  update feed on http://127.0.0.1:${port}  (serving ${ROOT})`);
});
