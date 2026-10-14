import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');

function listHtmlFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listHtmlFiles(full);
    return entry.name.endsWith('.html') ? [full] : [];
  });
}

describe('system version', () => {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string };
  const versionJs = readFileSync(path.join(root, 'public', 'js', 'version.js'), 'utf8');

  it('version.js version matches package.json (Ver x.y.z format)', () => {
    const match = versionJs.match(/NDRF_APP_VERSION = '(\d+\.\d+\.\d+)'/);
    expect(match).not.toBeNull();
    expect(match![1]).toBe(pkg.version);
  });

  it('every page with a footer shows the version and loads version.js', () => {
    const pages = listHtmlFiles(publicDir).filter((file) =>
      readFileSync(file, 'utf8').includes('Developed by RP Team')
    );
    expect(pages.length).toBeGreaterThan(0);
    for (const file of pages) {
      const html = readFileSync(file, 'utf8');
      expect(html, `${file} footer should have a version placeholder`).toContain('data-app-version');
      expect(html, `${file} should load /js/version.js`).toContain('/js/version.js');
    }
  });
});
