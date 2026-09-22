// Revisión de seguridad del 22/09/2026 — el HTML de los artículos SEO iba a
// WordPress sin limpiar. Ver src/lib/seo-article-html.ts.

import { describe, it, expect, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { sanitizeArticleHtml, toPlainText } from '@/lib/seo-article-html';

describe('sanitizeArticleHtml', () => {
  it('keeps the structure a blog article needs', () => {
    const html =
      '<h2>Precios</h2><p>Un <strong>fontanero</strong> en <em>Madrid</em>.</p>' +
      '<ul><li>Uno</li></ul><p><a href="https://example.com/contacto" title="Contacto">Llámanos</a></p>' +
      '<table><tr><th colspan="2">Tarifa</th></tr><tr><td>A</td><td>B</td></tr></table>';
    const out = sanitizeArticleHtml(html);
    expect(out).toContain('<h2>Precios</h2>');
    expect(out).toContain('<strong>fontanero</strong>');
    expect(out).toContain('<a href="https://example.com/contacto" title="Contacto">Llámanos</a>');
    expect(out).toContain('<th colspan="2">Tarifa</th>');
  });

  it.each([
    ['<p>ok</p><script>alert(1)</script>', 'script'],
    ['<p>ok</p><iframe src="https://evil.example"></iframe>', 'iframe'],
    ['<img src="x" onerror="alert(1)">', 'onerror'],
    ['<p onclick="alert(1)">ok</p>', 'onclick'],
    ['<a href="javascript:alert(1)">x</a>', 'javascript:'],
    ['<a href="data:text/html,<script>alert(1)</script>">x</a>', 'data:'],
    ['<a href="//evil.example">x</a>', 'evil.example'],
    ['<p style="position:fixed">x</p>', 'style'],
    ['<svg><script>alert(1)</script></svg>', 'svg'],
    ['<form action="https://evil.example"><input name="card"></form>', 'form'],
  ])('strips %j', (input, forbidden) => {
    expect(sanitizeArticleHtml(input).toLowerCase()).not.toContain(forbidden);
  });

  it('drops executable content entirely instead of leaving its text behind', () => {
    expect(sanitizeArticleHtml('<p>a</p><script>var stolen = document.cookie</script>')).toBe('<p>a</p>');
  });

  it('demotes <h1> to <h2> — the post title is already the page heading', () => {
    expect(sanitizeArticleHtml('<h1>Hola</h1>')).toBe('<h2>Hola</h2>');
  });
});

describe('toPlainText', () => {
  it('removes every tag from titles and excerpts', () => {
    expect(toPlainText('Precios <script>alert(1)</script>2026')).toBe('Precios 2026');
    expect(toPlainText('<b>Guía</b> de fontanería')).toBe('Guía de fontanería');
  });
});
