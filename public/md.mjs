// A small, safe markdown renderer shared by the server and the browser. Input is escaped first;
// only a handful of constructs become HTML. Links are limited to http(s).
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function inline(s) {
  return esc(s)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\[\]\n]+)\]\((https?:\/\/[^()\s\[\]]+)\)/g, '<a href="$2" rel="noreferrer noopener" target="_blank">$1</a>');
}

export function renderMarkdown(src) {
  const out = [];
  const parts = String(src ?? '').split(/^```[^\n]*\n?/m);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      out.push(`<pre class="code"><code>${esc(part.replace(/\n$/, ''))}</code></pre>`);
      return;
    }
    let list = null;
    let table = [];
    let para = [];
    const flushPara = () => {
      if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
      para = [];
    };
    const flushList = () => {
      if (list) out.push(`<${list.tag}>${list.items.map((x) => `<li>${inline(x)}</li>`).join('')}</${list.tag}>`);
      list = null;
    };
    const flushTable = () => {
      if (table.length) out.push(`<pre class="table">${esc(table.join('\n'))}</pre>`);
      table = [];
    };
    for (const line of part.split('\n')) {
      const t = line.trim();
      if (t.startsWith('|')) {
        flushPara();
        flushList();
        table.push(t);
        continue;
      }
      flushTable();
      const h = t.match(/^#{1,6}\s+(.*)$/);
      const ul = t.match(/^[-*]\s+(.*)$/);
      const ol = t.match(/^\d+[.)]\s+(.*)$/);
      if (!t) {
        flushPara();
        flushList();
      } else if (h) {
        flushPara();
        flushList();
        out.push(`<p class="h">${inline(h[1])}</p>`);
      } else if (ul || ol) {
        flushPara();
        const tag = ul ? 'ul' : 'ol';
        if (list && list.tag !== tag) flushList();
        if (!list) list = { tag, items: [] };
        list.items.push((ul || ol)[1]);
      } else if (list && /^\s+\S/.test(line)) {
        list.items[list.items.length - 1] += ' ' + t;
      } else {
        flushList();
        para.push(t);
      }
    }
    flushPara();
    flushList();
    flushTable();
  });
  return out.join('\n');
}
