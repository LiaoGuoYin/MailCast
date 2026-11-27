import { readFileSync, readdirSync } from 'node:fs';
import { expect, it } from 'vitest';

// The view modules import './app.js'. A browser keys ES modules by full URL,
// so if index.html loads the entry as '/app.js?v=…' the views pull in a second
// copy of app.js, whose boot code runs before the views have initialised and
// the console renders a blank page. The entry URL must be the bare path.
it('loads the SPA entry under the same URL the view modules import it by', () => {
  const html = readFileSync('public/index.html', 'utf8');
  const entries = [...html.matchAll(/<script\b[^>]*type="module"[^>]*src="([^"]+)"/g)]
    .map((match) => match[1]);
  expect(entries).toEqual(['/app.js']);

  const importers = readdirSync('web')
    .filter((name) => name.endsWith('.ts') && name !== 'app.ts')
    .filter((name) => readFileSync(`web/${name}`, 'utf8').includes("from './app.js'"));
  expect(importers.length).toBeGreaterThan(0);
});
