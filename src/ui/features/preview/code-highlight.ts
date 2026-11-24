import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import plaintext from 'highlight.js/lib/languages/plaintext';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import scss from 'highlight.js/lib/languages/scss';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

let registered = false;

function ensureLanguagesRegistered(): void {
  if (registered) return;
  registered = true;
  hljs.registerLanguage('bash', bash);
  hljs.registerLanguage('c', c);
  hljs.registerLanguage('cpp', cpp);
  hljs.registerLanguage('css', css);
  hljs.registerLanguage('diff', diff);
  hljs.registerLanguage('go', go);
  hljs.registerLanguage('ini', ini);
  hljs.registerLanguage('java', java);
  hljs.registerLanguage('javascript', javascript);
  hljs.registerLanguage('json', json);
  hljs.registerLanguage('markdown', markdown);
  hljs.registerLanguage('plaintext', plaintext);
  hljs.registerLanguage('python', python);
  hljs.registerLanguage('rust', rust);
  hljs.registerLanguage('scss', scss);
  hljs.registerLanguage('sql', sql);
  hljs.registerLanguage('typescript', typescript);
  hljs.registerLanguage('xml', xml);
  hljs.registerLanguage('yaml', yaml);

  hljs.registerAliases(['sh', 'zsh', 'shell'], { languageName: 'bash' });
  hljs.registerAliases(['js', 'mjs', 'cjs', 'jsx'], { languageName: 'javascript' });
  hljs.registerAliases(['ts', 'mts', 'cts', 'tsx'], { languageName: 'typescript' });
  hljs.registerAliases(['jsonc'], { languageName: 'json' });
  hljs.registerAliases(['yml'], { languageName: 'yaml' });
  hljs.registerAliases(['html', 'htm', 'svg'], { languageName: 'xml' });
  hljs.registerAliases(['less'], { languageName: 'css' });
  hljs.registerAliases(['py'], { languageName: 'python' });
  hljs.registerAliases(['rs'], { languageName: 'rust' });
  hljs.registerAliases(['h'], { languageName: 'c' });
  hljs.registerAliases(['hpp', 'cc', 'cxx'], { languageName: 'cpp' });
  hljs.registerAliases(['patch'], { languageName: 'diff' });
  hljs.registerAliases(['toml', 'conf', 'env'], { languageName: 'ini' });
  hljs.registerAliases(['md', 'mdx'], { languageName: 'markdown' });
  hljs.registerAliases(['txt', 'text', 'log'], { languageName: 'plaintext' });
}

export function escapeCodeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function detectCodeLanguage(filename: string, contentType?: string | null): string {
  ensureLanguagesRegistered();
  const dot = filename.lastIndexOf('.');
  if (dot > 0 && dot < filename.length - 1) {
    const ext = filename.slice(dot + 1).toLowerCase();
    if (hljs.getLanguage(ext)) return ext;
  }
  const normalized = contentType?.split(';', 1)[0]?.trim().toLowerCase();
  if (normalized === 'application/json') return 'json';
  if (normalized === 'application/xml' || normalized === 'text/xml') return 'xml';
  if (normalized === 'application/yaml' || normalized === 'text/yaml' || normalized === 'text/x-yaml') return 'yaml';
  if (normalized === 'text/css') return 'css';
  if (normalized === 'text/javascript' || normalized === 'application/javascript') return 'javascript';
  if (normalized === 'text/x-python') return 'python';
  if (normalized === 'application/x-sh') return 'bash';
  if (normalized === 'application/sql') return 'sql';
  return 'plaintext';
}

export function highlightCodeHtml(code: string, language?: string): { html: string; language: string } {
  ensureLanguagesRegistered();
  const requested = language?.trim().toLowerCase() ?? '';
  const target = requested && hljs.getLanguage(requested) ? requested : 'plaintext';
  try {
    const result = hljs.highlight(code, { language: target, ignoreIllegals: true });
    return { html: result.value, language: result.language ?? target };
  } catch {
    return { html: escapeCodeHtml(code), language: 'plaintext' };
  }
}
