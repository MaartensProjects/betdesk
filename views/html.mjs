// Page shell and small HTML helpers. Every piece of user or Claude text goes through escapeHtml or renderMarkdown.
export const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const e = escapeHtml;

export const csrfField = (token) => `<input type="hidden" name="csrf" value="${e(token)}">`;

const hidden = (fields) => Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${e(k)}" value="${e(v)}">`).join('');

export const postButton = (action, label, token, fields = {}, cls = 'btn') =>
  `<form method="post" action="${e(action)}" class="inline">${csrfField(token)}${hidden(fields)}<button class="${e(cls)}" type="submit">${e(label)}</button></form>`;

// Every warning carries a button that resolves it.
export const warn = (text, buttons = '') => `<div class="warn"><p>${text}</p>${buttons ? `<div class="actions">${buttons}</div>` : ''}</div>`;
export const flash = (msg) => (msg ? `<div class="flash">${e(msg)}</div>` : '');

function nav(user, active) {
  const items = [
    ['/', 'Board', 'board'],
    ['/c', 'My ideas', 'ideas'],
    ['/new', 'New', 'new'],
    ...(user?.role === 'admin' ? [['/settings', 'Settings', 'settings']] : []),
  ];
  return `<nav class="bottom">${items.map(([href, label, key]) => `<a href="${href}" class="${active === key ? 'on' : ''}">${label}</a>`).join('')}</nav>`;
}

// opts: { nav, user, token, refresh, appName }
export function page(title, body, opts = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#0f7a52">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="${e(opts.appName || 'Betdesk')}">
${opts.refresh ? `<meta http-equiv="refresh" content="${Number(opts.refresh)}">` : ''}
${opts.token ? `<meta name="csrf" content="${e(opts.token)}">` : ''}
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icon-180.png">
<link rel="apple-touch-icon" href="/icon-180.png">
<title>${e(title)}</title>
<link rel="stylesheet" href="/style.css">
<script type="module" src="/app.js"></script>
</head>
<body>
${body}
${opts.user ? nav(opts.user, opts.nav) : ''}
</body>
</html>`;
}

export const header = (title, meta = '', right = '') => `<header class="top"><div><h1 class="clip">${e(title)}</h1>${meta ? `<p class="meta">${meta}</p>` : ''}</div>${right}</header>`;
