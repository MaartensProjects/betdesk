// Progressive enhancement only: every form also works without this file.
import { renderMarkdown } from '/md.mjs';

const main = document.querySelector('main.chat');

// A turn streams as lines of JSON: text deltas, tool notes, then done. The page reloads at the end, so what you
// see afterwards is exactly what was saved.
async function streamTurn(form, submitter) {
  const body = new URLSearchParams();
  for (const [k, v] of new FormData(form)) if (typeof v === 'string') body.append(k, v);
  if (submitter?.name) body.append(submitter.name, submitter.value);
  const live = document.getElementById('live') || main;
  const status = document.createElement('p');
  status.className = 'state-line';
  status.textContent = 'Sending…';
  const typed = (form.querySelector('textarea[name=text]')?.value || '').trim();
  if (typed) {
    const you = document.createElement('div');
    you.className = 'msg you';
    you.innerHTML = renderMarkdown(typed);
    live.append(you);
  }
  const bubble = document.createElement('div');
  bubble.className = 'msg claude live';
  const tools = document.createElement('ul');
  tools.className = 'tools';
  live.append(tools, bubble, status);
  form.closest('section.pending')?.remove();
  form.hidden = true;
  window.scrollTo(0, document.body.scrollHeight);

  let text = '';
  const follow = () => {
    if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 200) window.scrollTo(0, document.body.scrollHeight);
  };
  try {
    const res = await fetch(form.action, {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/x-ndjson' },
      credentials: 'same-origin',
    });
    if (!res.ok || !(res.headers.get('content-type') || '').includes('ndjson')) {
      let msg = `The app answered ${res.status}.`;
      try {
        msg = (await res.json()).error || msg;
      } catch {}
      status.textContent = msg;
      form.hidden = false;
      return;
    }
    status.textContent = 'Claude is thinking…';
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    const convId = form.action.match(/\/c\/([0-9a-f-]{36})/)?.[1];
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const ev = JSON.parse(line);
        if (ev.type === 'text') {
          text += ev.text;
          bubble.innerHTML = renderMarkdown(text);
          status.textContent = 'Claude is writing…';
        } else if (ev.type === 'message') {
          text += '\n\n';
        } else if (ev.type === 'thinking') {
          status.textContent = 'Claude is thinking…';
        } else if (ev.type === 'tool') {
          const li = document.createElement('li');
          li.textContent = ev.text;
          tools.append(li);
          status.textContent = ev.text;
        } else if (ev.type === 'card') {
          status.textContent = `Saved BD-${ev.number}`;
        } else if (ev.type === 'question') {
          status.textContent = 'Claude asks you something…';
        } else if (ev.type === 'paused' || ev.type === 'error' || ev.type === 'note') {
          status.textContent = ev.text;
        } else if (ev.type === 'done') {
          location.replace(`/c/${convId}`);
          return;
        }
        follow();
      }
    }
    location.replace(`/c/${convId}`);
  } catch {
    status.textContent = 'The connection dropped. Claude keeps working; this page reloads in a moment.';
    setTimeout(() => location.reload(), 4000);
  }
}

document.addEventListener('submit', (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  if (form.hasAttribute('data-stream')) {
    event.preventDefault();
    if (form.dataset.busy) return;
    form.dataset.busy = '1';
    streamTurn(form, event.submitter);
    return;
  }
  // Other forms submit normally, once.
  if (form.dataset.busy) {
    event.preventDefault();
    return;
  }
  form.dataset.busy = '1';
  setTimeout(() => delete form.dataset.busy, 8000);
});

// In the message box, Enter sends and Shift+Enter starts a new line.
document.addEventListener('keydown', (event) => {
  const box = event.target;
  if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.isComposing || event.keyCode === 229) return;
  if (!(box instanceof HTMLTextAreaElement) || !box.form?.classList.contains('composer')) return;
  event.preventDefault();
  if (box.value.trim()) box.form.requestSubmit();
});

if (main) {
  // A new conversation with a first message starts by itself, once.
  if (main.dataset.autostart) {
    const composer = main.querySelector('form.composer');
    if (composer) composer.requestSubmit();
  }
  // A turn still running elsewhere: check every few seconds and reload when it ends.
  if (main.dataset.running) {
    const id = main.dataset.conv;
    const tick = async () => {
      try {
        const r = await (await fetch(`/c/${id}/state`, { credentials: 'same-origin' })).json();
        if (r.status !== 'running') return location.reload();
      } catch {}
      setTimeout(tick, 3000);
    };
    setTimeout(tick, 3000);
  }
  // Land on the open question, or at the end of the conversation.
  const pending = document.querySelector('section.pending');
  if (pending) pending.scrollIntoView({ block: 'start' });
  else window.scrollTo(0, document.body.scrollHeight);
}
