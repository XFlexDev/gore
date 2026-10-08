const $ = s => document.querySelector(s);
const app = $('#app');
let state = { sort: 'new', tag: '', q: '', page: 1 };
let feedTags = [];

const esc = s => String(s ?? '').replace(/[&<>"']/g,
  c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtDur = s => s > 0 ? `${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,'0')}` : '';
const fmtTime = t => { const d = (Date.now()/1000 - t); if (d<60) return 'just now'; if (d<3600) return `${d/60|0}m ago`; if (d<86400) return `${d/3600|0}h ago`; return `${d/86400|0}d ago`; };
const fmtN = n => n >= 1e6 ? (n/1e6).toFixed(1)+'M' : n >= 1e3 ? (n/1e3).toFixed(1)+'k' : String(n);

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
  const [route, arg] = h.split('/');
  return { route: route || 'feed', arg: arg || '' };
}
window.addEventListener('hashchange', render);
$('#search').addEventListener('keydown', e => {
  if (e.key === 'Enter') { state.q = e.target.value.trim(); state.page = 1; location.hash = '#/'; render(); }
});
document.querySelectorAll('.sortbtn').forEach(b => b.onclick = e => {
  e.preventDefault(); state.sort = b.dataset.sort; state.page = 1;
  document.querySelectorAll('.sortbtn').forEach(x => x.classList.toggle('on', x === b));
  if (location.hash !== '#/' ) location.hash = '#/';
  render();
});

async function render() {
  const { route, arg } = parseHash();
  if (route === 'p') return renderPost(arg);
  if (route === 'tag') { state.tag = arg; state.page = 1; return renderFeed(); }
  if (route === 'about') return renderAbout();
  if (route === 'feed' || route === '') {
    if (parseHash().route !== 'tag') state.tag = '';
    return renderFeed();
  }
  renderFeed();
}

/* ---------- feed ---------- */
async function renderFeed() {
  app.innerHTML = '<div class="empty">loading…</div>';
  const p = new URLSearchParams({ sort: state.sort, tag: state.tag, q: state.q, page: state.page });
  const data = await api('/api/feed?' + p);
  feedTags = data.tags;
  $('#tagbar').innerHTML = feedTags.map(t =>
    `<span class="tag ${t===state.tag?'on':''}" data-t="${esc(t)}">#${esc(t)}</span>`).join('');
  document.querySelectorAll('#tagbar .tag').forEach(el => el.onclick = () => {
    state.tag = el.dataset.t === state.tag ? '' : el.dataset.t; state.page = 1; renderFeed();
  });
  if (!data.posts.length) { app.innerHTML = '<div class="empty">nothing here yet. upload something.</div>'; return; }
  const pages = Math.ceil(data.total / data.per);
  app.innerHTML = `<div class="grid">` + data.posts.map(p => `
    <a class="card" href="#/p/${p.slug}">
      <div class="thumb ${p.tags.includes('nsfl') ? 'blurred' : ''}">
        ${p.thumb_url ? `<img loading="lazy" src="${p.thumb_url}" alt="">` : ''}
        ${p.duration ? `<span class="dur">${fmtDur(p.duration)}</span>` : ''}
      </div>
      <div class="c-body">
        <div class="c-title">${esc(p.title)}</div>
        <div class="c-meta">
          <span class="${p.score < 0 ? 'neg' : 'score'}">${p.score > 0 ? '+' : ''}${p.score}</span>
          <span>${fmtN(p.views)} views</span><span>${fmtTime(p.created_at)}</span>
          <span>${esc(p.nick)}</span>
        </div>
      </div>
    </a>`).join('') + `</div>` +
    (pages > 1 ? `<div class="pager">
      ${state.page > 1 ? '<button class="btn sm" id="prev">← prev</button>' : ''}
      <span class="dim" style="align-self:center">${state.page} / ${pages}</span>
      ${state.page < pages ? '<button class="btn sm" id="next">next →</button>' : ''}
    </div>` : '');
  const nx = $('#next'), pv = $('#prev');
  if (nx) nx.onclick = () => { state.page++; renderFeed(); scrollTo(0,0); };
  if (pv) pv.onclick = () => { state.page--; renderFeed(); scrollTo(0,0); };
}

/* ---------- post ---------- */
let reportTarget = null;
async function renderPost(s) {
  app.innerHTML = '<div class="empty">loading…</div>';
  let data;
  try { data = await api('/api/post/' + s); }
  catch { app.innerHTML = '<div class="empty">post not found (removed?).</div>'; return; }
  const p = data.post;
  const mediaHtml = p.media_kind === 'video'
    ? `<video controls preload="metadata" src="${p.media_url}" poster="${p.thumb_url}"></video>`
    : `<img src="${p.media_url}" alt="">`;
  app.innerHTML = `<div class="post">
    <div class="player">${mediaHtml}</div>
    <div class="p-head">
      <div class="p-title">${esc(p.title)}</div>
      <div class="p-meta">
        <span class="votes">
          <button id="vup">▲</button>
          <span class="vscore" id="vscore">${p.score}</span>
          <button id="vdown">▼</button>
        </span>
        <span>${fmtN(p.views)} views</span>
        <span>${new Date(p.created_at*1000).toLocaleString()}</span>
        <span>by ${esc(p.nick)}</span>
        <span class="reportlink" id="reportbtn">⚑ report</span>
      </div>
    </div>
    ${p.tags.length ? `<div class="p-tags" style="padding-top:14px">${p.tags.map(t => `<a class="tag" href="#/tag/${esc(t)}">#${esc(t)}</a>`).join('')}</div>` : ''}
    ${p.description ? `<div class="p-desc">${esc(p.description)}</div>` : ''}
    <div class="comments">
      <h3>COMMENTS (${data.comments.length})</h3>
      <div class="cmtform">
        <input id="cnick" placeholder="nickname (optional)" maxlength="40">
        <textarea id="cbody" placeholder="say something…" rows="3"></textarea>
        <button class="btn sm" id="csend" style="width:120px">COMMENT</button>
      </div>
      <div id="cmts">${data.comments.map(c => `
        <div class="cmt"><span class="who">${esc(c.nick)}</span><span class="when">${fmtTime(c.created_at)}</span>
        <div class="txt">${esc(c.body)}</div></div>`).join('') || '<div class="empty" style="padding:24px">no comments yet</div>'}
      </div>
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
  toast('report sent. thanks.');
};

/* ---------- about ---------- */
function renderAbout() {
  app.innerHTML = `<div class="post"><div class="p-desc">
<h2 style="margin-bottom:14px">GORE</h2>
<p>Uncensored, user-uploaded media. The raw feed.</p>
<br>
<p><b>Rules</b></p>
<p>• You must be 18+ to view or upload.<br>
• No CSAM — zero tolerance, reports go straight to moderation and authorities.<br>
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
      const blob = uFile.slice(off, end);
      const r = await fetch(`/api/uploads/${upload_id}/chunk?offset=${off}`,
        { method: 'PUT', body: blob });
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
    toast('posted.');
    location.hash = '#' + post.url;
    $('#umodal').classList.remove('open');
    uFile = null; utitle.value = udesc.value = utags.value = unick.value = '';
    $('#unsfl').checked = false; $('#ubarfill').style.width = '0';
    drop.hidden = false; $('#uform').hidden = true; $('#uprev').innerHTML = '';
  } catch (e) { toast('upload failed: ' + e.message); }
  btn.disabled = false;
};
const utitle = $('#utitle'), udesc = $('#udesc'), utags = $('#utags'), unick = $('#unick');

render();
