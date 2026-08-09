import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(currentDir, '..');
const cssPath = path.join(currentDir, 'index.css');
const htmlPath = path.join(webRoot, 'index.html');

describe('local bundled fonts', () => {
  it('does not reference Google Fonts in CSS or HTML', () => {
    const css = readFileSync(cssPath, 'utf8');
    const html = readFileSync(htmlPath, 'utf8');

    expect(css).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/);
    expect(html).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/);
  });

  it('loads Inter and JetBrains Mono from local public fonts', () => {
    const css = readFileSync(cssPath, 'utf8');

    expect(css).toContain("url('/fonts/inter/Inter-Regular.woff2')");
    expect(css).toContain("url('/fonts/inter/Inter-Medium.woff2')");
    expect(css).toContain("url('/fonts/inter/Inter-SemiBold.woff2')");
    expect(css).toContain("url('/fonts/jetbrains-mono/JetBrainsMono-Regular.woff2')");
    expect(css).toContain("url('/fonts/jetbrains-mono/JetBrainsMono-Bold.woff2')");
  });

  it('ships font license files in the repo', () => {
    expect(existsSync(path.join(webRoot, 'public/fonts/licenses/Inter-LICENSE.txt'))).toBe(true);
    expect(existsSync(path.join(webRoot, 'public/fonts/licenses/JetBrainsMono-LICENSE.txt'))).toBe(true);
  });
});
