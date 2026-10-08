const $ = s => document.querySelector(s);
const app = $('#app');
let mode = 'reports';
const esc = s => String(s ?? '').replace(/[&<>"']/g,
  c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtDur = s => s > 0 ? `${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,'0')}` : '';
const tok = () => localStorage.gore_admin || $('#tok').value;
async function api(path, opts={}) {
  opts.headers = Object.assign({'x-admin-token': tok()}, opts.headers || {});
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error((await r.json().catch(()=>({}))).detail || r.statusText);
  return r.json();
}
document.querySelectorAll('#tagbar .tag').forEach(t => t.onclick = () => {
  document.querySelectorAll('#tagbar .tag').forEach(x => x.classList.toggle('on', x === t));
  mode = t.dataset.v; load();
});
$('#load').onclick = () => { localStorage.gore_admin = $('#tok').value; load(); };
$('#tok').value = localStorage.gore_admin || '';

function row(p, extra) {
  const img = p.thumb ? `/media/thumbs/${p.thumb}`
    : (p.media_kind === 'image' ? p.media_url : '');
  return `<div class="row">
    ${img ? `<img src="${img}">` : '<div style="width:110px"></div>'}
    <div class="t"><a href="/#/p/${p.slug}" target="_blank">${esc(p.title)}</a>
      <div class="dim">${esc(p.nick)} · ${fmtN(p.views||0)} views · ${fmtDur(p.duration)} · ${esc((p.tags||[]).join(' '))}</div>
      ${extra || ''}</div>
    <span class="dim">${p.status}</span>
    ${p.status === 'active'
      ? `<button class="btn sm" data-act="remove" data-s="${p.slug}">REMOVE</button>`
      : `<button class="btn sm" data-act="restore" data-s="${p.slug}">RESTORE</button>`}
  </div>`;
}
const fmtN = n => n >= 1e3 ? (n/1e3).toFixed(1)+'k' : String(n||0);

async function load() {
  app.innerHTML = '<div class="empty">loading…</div>';
  try {
    if (mode === 'reports') {
      const d = await api('/api/admin/reports');
      app.innerHTML = d.reports.length
        ? d.reports.map(r => row(r,
            `<div style="color:#e88">report: ${esc(r.reason)||'—'}</div>`)).join('')
        : '<div class="empty">no reports</div>';
    } else {
      const d = await api('/api/admin/posts?status=' + mode);
      app.innerHTML = d.posts.length ? d.posts.map(p => row(p)).join('')
        : '<div class="empty">none</div>';
    }
  } catch (e) { app.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  document.querySelectorAll('[data-act]').forEach(b => b.onclick = async () => {
    await api(`/api/admin/post/${b.dataset.s}/status`, { method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ status: b.dataset.act === 'remove' ? 'removed' : 'active' }) });
    load();
  });
}
if (tok()) load();
