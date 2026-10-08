const $ = s => document.querySelector(s);
const app = $('#app');
let state = { sort: 'new', tag: '', q: '', page: 1 };

const esc = s => String(s ?? '').replace(/[&<>"']/g,
  c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtDur = s => s > 0 ? `${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,'0')}` : '';
const fmtTime = t => { const d = (Date.now()/1000 - t); if (d<60) return 'just now'; if (d<3600) return `${d/60|0} minutes ago`; if (d<86400) return `${d/3600|0} hours ago`; return `${d/86400|0} days ago`; };
const fmtN = n => n >= 1e6 ? (n/1e6).toFixed(1)+'M' : n >= 1e3 ? (n/1e3).toFixed(1)+'K' : String(n||0);

const AVCOLORS = ['#5cb85c','#7b6fd0','#c94f6d','#b8860b','#4582b4','#777','#a0522d','#2e8b57'];
const avColor = n => AVCOLORS[[...String(n||'a')].reduce((a,c)=>a+c.charCodeAt(0),0) % AVCOLORS.length];
const avatar = (nick, cls='lav') =>
  `<span class="${cls}" style="background:${avColor(nick)}">${esc((nick||'a')[0].toUpperCase())}</span>`;

async function api(path, opts={}) {
  const r = await fetch(path, opts);
  if (!r.ok) { let e; try { e = (await r.json()).detail } catch { e = r.statusText } throw new Error(e || 'error'); }
  return r.json();
}
function toast(msg) {
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t); setTimeout(() => t.remove(), 2600);
}

/* ---------- age gate ---------- */
if (localStorage.gore_age === '1') $('#agegate').classList.add('gone');
$('#ag-enter').onclick = () => { localStorage.gore_age = '1'; $('#agegate').classList.add('gone'); };

/* ---------- routing ---------- */
function parseHash() {
  const h = location.hash.slice(2) || '';
  const [route, ...rest] = h.split('/');
  return { route: route || 'feed', arg: rest.join('/') || '' };
}
window.addEventListener('hashchange', render);
$('#search').addEventListener('keydown', e => {
  if (e.key === 'Enter') { state.q = e.target.value.trim(); state.page = 1; location.hash = '#/'; render(); }
});
document.querySelectorAll('.sortbtn').forEach(b => b.onclick = e => {
  e.preventDefault(); state.sort = b.dataset.sort; state.page = 1;
  document.querySelectorAll('.sortbtn').forEach(x => x.classList.toggle('on', x === b));
  if (location.hash !== '#/') location.hash = '#/';
  render();
});

async function render() {
  const { route, arg } = parseHash();
  if (route === 'p') return renderPost(arg);
  if (route === 'tag') { state.tag = arg; state.page = 1; return renderFeed(); }
  if (route === 'about') return renderAbout();
  state.tag = '';
  return renderFeed();
}

/* ---------- sidebar ---------- */
async function renderSidebar(data) {
  $('#tagw').innerHTML = data.tags.map(t =>
    `<a class="tag ${t===state.tag?'on':''}" href="#/tag/${esc(t)}">#${esc(t)}</a>`).join('')
    || '<span class="dim">none yet</span>';
  const latest = data.posts.filter(p => p.latest_body).slice(0, 6);
  $('#latest').innerHTML = latest.map(p => `
    <div class="witem">${avatar(p.latest_nick)}
      <div class="wtxt">
        <a class="wt" href="#/p/${p.slug}">${esc(p.latest_body.slice(0, 60))}</a>
        <span class="wm">${fmtTime(p.latest_at)} · ${esc(p.latest_nick)} · in
        <a href="#/p/${p.slug}">${esc(p.title.slice(0, 28))}</a></span>
      </div>
    </div>`).join('') || '<span class="dim">no comments yet</span>';
  const s = await api('/api/stats');
  $('#sitestats').innerHTML = `
    <div><span class="k">Posts:</span><b>${fmtN(s.posts)}</b></div>
    <div><span class="k">Views:</span><b>${fmtN(s.views)}</b></div>
    <div><span class="k">Comments:</span><b>${fmtN(s.comments)}</b></div>`;
}

/* ---------- feed ---------- */
function nodeHtml(p) {
  const isNew = Date.now()/1000 - p.created_at < 86400;
  const nsfl = p.tags.includes('nsfl');
  const latest = p.latest_body
    ? `${avatar(p.latest_nick)}<span class="lt">${esc(p.latest_body.slice(0, 80))}</span>
       <span class="lm">${fmtTime(p.latest_at)} · ${esc(p.latest_nick)}</span>`
    : `${avatar(p.nick)}<span class="lt" style="font-weight:400">No comments yet</span>
       <span class="lm">${fmtTime(p.created_at)} · ${esc(p.nick)}</span>`;
  return `<a class="node" href="#/p/${p.slug}">
    <span class="av">${p.thumb_url ? `<img loading="lazy" src="${p.thumb_url}" alt="">` : (p.nick||'a')[0].toUpperCase()}</span>
    <span class="ni">
      <span class="n-title">${esc(p.title)}</span>${isNew ? '<span class="badge-new">New</span>' : ''}${nsfl ? '<span class="badge-new badge-nsfl">NSFL</span>' : ''}
      <div class="n-stats">👁 ${fmtN(p.views)}&ensp;·&ensp;💬 ${fmtN(p.comments_count)}&ensp;·&ensp;▲ ${p.score}${p.duration ? '&ensp;·&ensp;'+fmtDur(p.duration) : ''}</div>
      <div class="n-latest">${latest}</div>
    </span>
  </a>`;
}

async function renderFeed() {
  $('#ptitle').textContent = 'Media list';
  $('#crumb').textContent = 'New Posts' + (state.tag ? ` — #${state.tag}` : '') + (state.q ? ` — "${state.q}"` : '');
  app.innerHTML = '<div class="cathead">MAIN <span class="chev">▲</span></div><div class="empty">loading…</div>';
  const p = new URLSearchParams({ sort: state.sort, tag: state.tag, q: state.q, page: state.page });
  const data = await api('/api/feed?' + p);
  renderSidebar(data);
  const pages = Math.ceil(data.total / data.per);
  const body = data.posts.length
    ? `<div class="nodes">${data.posts.map(nodeHtml).join('')}</div>`
    : '<div class="empty">nothing here yet. upload something.</div>';
  app.innerHTML = '<div class="cathead">MAIN <span class="chev">▲</span></div>' + body +
    (pages > 1 ? `<div class="pager">
      ${state.page > 1 ? '<button class="btn-ghost sm" id="prev">← prev</button>' : ''}
      <span class="dim">${state.page} / ${pages}</span>
      ${state.page < pages ? '<button class="btn-ghost sm" id="next">next →</button>' : ''}
    </div>` : '');
  const nx = $('#next'), pv = $('#prev');
  if (nx) nx.onclick = () => { state.page++; renderFeed(); scrollTo(0,0); };
  if (pv) pv.onclick = () => { state.page--; renderFeed(); scrollTo(0,0); };
}

/* ---------- post (thread) page ---------- */
let reportTarget = null;
async function renderPost(s) {
  $('#ptitle').textContent = '';
  $('#crumb').innerHTML = '<a href="#/">Media list</a>';
  app.innerHTML = '<div class="empty">loading…</div>';
  let data;
  try { data = await api('/api/post/' + s); }
  catch { app.innerHTML = '<div class="empty">post not found (removed?).</div>'; return; }
  const p = data.post;
  $('#ptitle').textContent = p.title;
  const mediaHtml = p.media_kind === 'video'
    ? `<video controls preload="metadata" src="${p.media_url}" poster="${p.thumb_url}"></video>`
    : `<img src="${p.media_url}" alt="">`;
  app.innerHTML = `<div class="panel">
    <div class="player">${mediaHtml}</div>
    <div class="p-title">${esc(p.title)}</div>
    <div class="p-meta">
      <span class="votes"><button id="vup">▲</button><span class="vscore" id="vscore">${p.score}</span><button id="vdown">▼</button></span>
      <span>👁 ${fmtN(p.views)} views</span>
      <span>${new Date(p.created_at*1000).toLocaleString()}</span>
      <span>by <b>${esc(p.nick)}</b></span>
      <span class="reportlink" id="reportbtn">⚑ report</span>
    </div>
    ${p.tags.length ? `<div class="p-tags">${p.tags.map(t => `<a class="tag" href="#/tag/${esc(t)}">#${esc(t)}</a>`).join('')}</div>` : ''}
    ${p.description ? `<div class="p-desc">${esc(p.description)}</div>` : ''}
    <div class="msg" style="background:#f7f7f7;font-weight:700;font-size:12px;color:#666">COMMENTS (${data.comments.length})</div>
    <div id="cmts">${data.comments.map(c => `
      <div class="msg">${avatar(c.nick, 'mav')}
        <div class="mbody">
          <div class="mhead"><span class="who">${esc(c.nick)}</span><span class="when">${fmtTime(c.created_at)}</span></div>
          <div class="txt">${esc(c.body)}</div>
        </div>
      </div>`).join('') || '<div class="msg dim">no comments yet</div>'}
    </div>
    <div class="cmtform">
      <input id="cnick" placeholder="Nickname (optional)" maxlength="40">
      <textarea id="cbody" placeholder="Write a reply…" rows="3"></textarea>
      <div><button class="btn-blue sm" id="csend">Post reply</button></div>
    </div>
  </div>`;
  api(`/api/post/${s}/view`, { method: 'POST' });
  const vote = async dir => {
    const r = await api(`/api/post/${s}/vote`, { method: 'POST',
      headers: {'Content-Type':'application/json'}, body: JSON.stringify({dir}) });
    $('#vscore').textContent = r.score;
  };
  $('#vup').onclick = () => vote(1).catch(e => toast(e.message));
  $('#vdown').onclick = () => vote(-1).catch(e => toast(e.message));
  $('#csend').onclick = async () => {
    const body = $('#cbody').value.trim();
    if (!body) return;
    await api(`/api/post/${s}/comment`, { method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ body, nick: $('#cnick').value }) });
    renderPost(s);
  };
  $('#reportbtn').onclick = () => { reportTarget = s; $('#reportmodal').classList.add('open'); };
}
$('#rclose').onclick = () => $('#reportmodal').classList.remove('open');
$('#rsubmit').onclick = async () => {
  await api(`/api/post/${reportTarget}/report`, { method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ reason: $('#rreason').value }) });
  $('#reportmodal').classList.remove('open'); $('#rreason').value = '';
  toast('Report sent.');
};

/* ---------- about / rules ---------- */
function renderAbout() {
  $('#ptitle').textContent = 'Rules';
  $('#crumb').textContent = 'Rules';
  app.innerHTML = `<div class="panel"><div class="p-desc" style="padding:16px">
<p><b>GORE</b> — uncensored, user-uploaded media. The raw feed.</p>
<br>
<p><b>Rules</b></p>
<p>• You must be 18+ to view or upload.<br>
• No CSAM — zero tolerance, reported to authorities.<br>
• No doxxing of private individuals. No spam.<br>
• Mark extreme content with the <b>nsfl</b> tag.<br>
• Uploads are anonymous unless you set a nickname.</p>
<br>
<p><b>Moderation</b></p>
<p>Use ⚑ report on any post. Admins review reports and can remove posts or comments.</p>
<br>
<p class="dim">All content is user-submitted. Viewer discretion advised.</p>
</div></div>`;
}

/* ---------- upload ---------- */
const CHUNK = 32 * 1024 * 1024;
let uFile = null;
const utitle = $('#utitle'), udesc = $('#udesc'), utags = $('#utags'), unick = $('#unick');
$('#uploadbtn').onclick = () => { $('#umodal').classList.add('open'); };
$('#uclose').onclick = () => $('#umodal').classList.remove('open');
const drop = $('#udrop'), fileIn = $('#ufile');
drop.onclick = () => fileIn.click();
drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over');
  if (e.dataTransfer.files[0]) pickFile(e.dataTransfer.files[0]); };
fileIn.onchange = () => fileIn.files[0] && pickFile(fileIn.files[0]);

function pickFile(f) {
  if (!/^(video|image)\//.test(f.type)) { toast('videos and images only'); return; }
  uFile = f;
  drop.hidden = true; $('#uform').hidden = false;
  if (!utitle.value) utitle.value = f.name.replace(/\.[^.]+$/, '').slice(0, 140);
  const url = URL.createObjectURL(f);
  $('#uprev').innerHTML = f.type.startsWith('video')
    ? `<video src="${url}" muted playsinline></video>` : `<img src="${url}">`;
}

$('#usubmit').onclick = async () => {
  if (!uFile) return;
  const title = utitle.value.trim();
  if (!title) { toast('title required'); return; }
  const btn = $('#usubmit'); btn.disabled = true;
  try {
    const { upload_id } = await api('/api/uploads', { method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ filename: uFile.name, size: uFile.size }) });
    let off = 0;
    while (off < uFile.size) {
      const end = Math.min(off + CHUNK, uFile.size);
      const r = await fetch(`/api/uploads/${upload_id}/chunk?offset=${off}`,
        { method: 'PUT', body: uFile.slice(off, end) });
      if (!r.ok) throw new Error('chunk failed');
      const j = await r.json(); off = j.received;
      const pct = Math.round(off / uFile.size * 100);
      $('#ubarfill').style.width = pct + '%'; $('#upct').textContent = pct + '%';
    }
    const fin = await api(`/api/uploads/${upload_id}/complete`, { method: 'POST' });
    let tags = utags.value;
    if ($('#unsfl').checked && !/\bnsfl\b/i.test(tags)) tags = (tags + ' nsfl').trim();
    const post = await api('/api/posts', { method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ file: fin.file, title,
        description: udesc.value, tags, nick: unick.value }) });
    toast('Posted.');
    location.hash = '#' + post.url;
    $('#umodal').classList.remove('open');
    uFile = null; utitle.value = udesc.value = utags.value = unick.value = '';
    $('#unsfl').checked = false; $('#ubarfill').style.width = '0';
    drop.hidden = false; $('#uform').hidden = true; $('#uprev').innerHTML = '';
  } catch (e) { toast('upload failed: ' + e.message); }
  btn.disabled = false;
};

render();
