import * as THREE from 'three';
import { initScene } from './scene.js';

const $ = (id) => document.getElementById(id);
const canvas = $('scene'), panel = $('panel'), panelBody = $('panel-body');
const tip = $('tip'), help = $('help'), loader = $('loader');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------------------------------------------------------------- sound (synthesised, no audio files; off until asked for)
const sound = (() => {
  let ctx = null, master = null, on = false;
  function ambience(c, out) { // the looping bed: low room hum plus PC fan air
    [[55, 0.05], [82.5, 0.03], [110.4, 0.015]].forEach(([f, v]) => {
      const o = c.createOscillator(), g = c.createGain();
      o.frequency.value = f; g.gain.value = v; o.connect(g).connect(out); o.start();
    });
    const buf = c.createBuffer(1, c.sampleRate * 2, c.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const n = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
    n.buffer = buf; n.loop = true; f.type = 'lowpass'; f.frequency.value = 480; g.gain.value = 0.03;
    n.connect(f).connect(g).connect(out); n.start();
  }
  function chirp(c, out, at, f0, f1, dur, vol = 0.1, type = 'triangle') {
    const o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.setValueAtTime(f0, at); o.frequency.exponentialRampToValueAtTime(f1, at + dur);
    g.gain.setValueAtTime(vol, at); g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g).connect(out); o.start(at); o.stop(at + dur + 0.02);
  }
  function start() {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain(); master.gain.value = 0; master.connect(ctx.destination);
    ambience(ctx, master);
  }
  // Renders the same sound graph silently (nothing reaches the speakers) and reports its loudness,
  // so the audio can be checked without anyone having to listen.
  async function selfTest() {
    const sr = 44100, off = new OfflineAudioContext(1, sr * 2, sr), out = off.createGain();
    out.gain.value = 0.7; out.connect(off.destination);
    ambience(off, out);
    chirp(off, out, 1.0, 520, 880, 0.14);            // panel open
    chirp(off, out, 1.3, 900, 90, 0.6, 0.07, 'sawtooth'); // hologram crumble
    const d = (await off.startRendering()).getChannelData(0);
    const stat = (a, b) => { let s = 0, p = 0; for (let i = a; i < b; i++) { s += d[i] * d[i]; p = Math.max(p, Math.abs(d[i])); } return { rms: +Math.sqrt(s / (b - a)).toFixed(4), peak: +p.toFixed(4) }; };
    const bed = stat(0, sr), fx = stat(sr, sr * 2);
    return { ambienceOnly: bed, withEffects: fx, audible: bed.rms > 0.005, effectsAddSound: fx.peak > bed.peak * 1.2, clipping: fx.peak >= 1 };
  }
  function tone(f0, f1, dur, vol = 0.1, type = 'triangle') {
    if (on) chirp(ctx, master, ctx.currentTime, f0, f1, dur, vol, type);
  }
  return {
    selfTest,
    coin: () => { tone(988, 988, 0.08, 0.08, 'square'); setTimeout(() => tone(1319, 1319, 0.3, 0.08, 'square'), 80); },
    bounce: () => tone(440, 520, 0.03, 0.03, 'square'),
    meow: () => { tone(620, 980, 0.16, 0.06, 'triangle'); setTimeout(() => tone(980, 560, 0.3, 0.05, 'triangle'), 150); },
    woof: () => { tone(240, 130, 0.11, 0.1, 'sawtooth'); setTimeout(() => tone(230, 120, 0.13, 0.09, 'sawtooth'), 190); },
    beep: () => { tone(880, 880, 0.07, 0.05, 'sine'); setTimeout(() => tone(1320, 1320, 0.1, 0.05, 'sine'), 90); },
    rev: () => { tone(80, 240, 0.45, 0.06, 'sawtooth'); setTimeout(() => tone(140, 320, 0.5, 0.05, 'sawtooth'), 380); },
    honk: () => { tone(415, 415, 0.11, 0.05, 'square'); setTimeout(() => tone(415, 415, 0.16, 0.05, 'square'), 160); },
    pin: () => { tone(1500, 700, 0.06, 0.07, 'triangle'); setTimeout(() => tone(180, 120, 0.08, 0.07, 'sine'), 50); },
    plop: () => tone(320, 900, 0.09, 0.05, 'sine'),
    toggle() { if (!ctx) start(); on = !on; ctx.resume(); master.gain.linearRampToValueAtTime(on ? 0.7 : 0, ctx.currentTime + 0.4); return on; },
    open: () => tone(520, 880, 0.14),
    close: () => tone(700, 380, 0.14),
    hover: () => tone(1300, 1500, 0.04, 0.035, 'sine'),
    crumble: () => tone(900, 90, 1.1, 0.07, 'sawtooth'),
    rise: () => tone(120, 1000, 1.8, 0.05, 'sine'),
  };
})();
$('sound').addEventListener('click', (e) => {
  const on = sound.toggle();
  e.currentTarget.textContent = on ? '♪ on' : '♪ off';
  e.currentTarget.setAttribute('aria-pressed', String(on));
});

let content = null;
let three = null; // set once the 3D scene is up; the panels work without it

// ---------------------------------------------------------------- guest notes on the contact board
// Visitors pin short notes, and everyone sees them. They are kept by a small notes service: its address is "notesUrl"
// in content.json (the Google Sheet service in notes-service/Code.gs), or, when that is blank, the site's own server
// (server.js). If neither answers, a note is kept in this browser and shown only here.
const NOTE_COLORS = ['#fff3a8', '#ffc4d6', '#bdefff', '#d5c7ff', '#c9f2c2'];
const NOTE_MAX = 80, NAME_MAX = 18, BOARD_NOTES = 7;
const guest = { notes: [], shared: true, fresh: null, color: 0 };
const localNotes = () => { try { return JSON.parse(localStorage.getItem('swr-notes') || '[]'); } catch { return []; } };
const notesUrl = () => (content && content.notesUrl) || 'api/notes';
const visitorId = (() => { // a random tag kept in this browser, so the service can slow down one visitor posting over and over
  try {
    let v = localStorage.getItem('swr-visitor');
    if (!v) { v = Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem('swr-visitor', v); }
    return v;
  } catch { return ''; }
})();
async function loadNotes() {
  try {
    const r = await fetch(notesUrl(), { cache: 'no-store' });
    if (!r.ok) throw new Error('no notes service');
    guest.notes = (await r.json()).notes || [];
    guest.shared = true;
  } catch {
    guest.shared = false;
    guest.notes = localNotes();
  }
}
async function postNote(text, name, color) {
  text = text.replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX); name = name.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
  if (text.length < 2) return { error: 'Write a few words first.' };
  if (guest.shared) {
    try {
      // sent as plain text on purpose: that keeps it a "simple" request, which a notes service on another address accepts without a pre-check
      const r = await fetch(notesUrl(), { method: 'POST', body: JSON.stringify({ text, name, color, visitor: visitorId }) });
      const j = await r.json();
      if (!r.ok || !j.note) return { error: j.error || 'That did not go through. Try again.' };
      guest.notes.unshift(j.note);
      return { note: j.note };
    } catch { return { error: 'Could not reach the board. Try again in a moment.' }; }
  }
  const note = { id: Date.now().toString(36), text, name, color, at: Date.now() };
  guest.notes.unshift(note);
  try { localStorage.setItem('swr-notes', JSON.stringify(guest.notes.slice(0, 30))); } catch { /* private window: the note lasts until the page closes */ }
  return { note };
}
const ago = (at) => { const m = Math.round((Date.now() - at) / 60000); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' d ago'; };
const noteListHTML = () => (guest.notes.length
  ? guest.notes.slice(0, 30).map((n) => `<li style="--c:${NOTE_COLORS[n.color] || NOTE_COLORS[0]}"><p>${esc(n.text)}</p><span>${esc(n.name || 'Anonymous')} · ${ago(n.at)}</span></li>`).join('')
  : '<li class="empty">No notes yet. Yours can be the first.</li>');
function wireNotes() { // the form lives inside the Contact panel, which is rebuilt every time it opens
  const form = $('note-form'), msg = $('note-msg'), text = $('note-text'), count = $('note-count');
  if (!form) return;
  const swatches = [...form.querySelectorAll('.swatches button')];
  const pick = (i) => { guest.color = i; swatches.forEach((b, k) => b.setAttribute('aria-checked', String(k === i))); };
  swatches.forEach((b, i) => b.addEventListener('click', () => pick(i)));
  pick(guest.color);
  text.addEventListener('input', () => { count.textContent = `${text.value.length} / ${NOTE_MAX}`; });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('.pin');
    btn.disabled = true; msg.textContent = 'Pinning…'; msg.className = '';
    const res = await postNote(text.value, $('note-name').value, guest.color);
    btn.disabled = false;
    if (res.error) { msg.textContent = res.error; msg.className = 'bad'; return; }
    text.value = ''; count.textContent = `0 / ${NOTE_MAX}`;
    msg.textContent = guest.shared ? 'Pinned. Thanks for stopping by!' : 'Pinned on this device.';
    msg.className = 'good';
    $('note-list').innerHTML = noteListHTML();
    sound.pin();
    guest.fresh = res.note.id; // the new note drops onto the board
    const t0 = performance.now();
    const step = () => { const k = Math.min(1, (performance.now() - t0) / 520); three?.redrawContact(k); if (k < 1) requestAnimationFrame(step); else guest.fresh = null; };
    step();
  });
}

// ---------------------------------------------------------------- panels
function panelHTML(key) {
  const c = content[key];
  if (key === 'about') {
    return `<p class="kicker">${esc(content.name)}</p><h1>${esc(c.title)}</h1>
      <p><strong>${esc(content.tagline)}</strong></p>
      ${c.paragraphs.map((p) => `<p>${esc(p)}</p>`).join('')}
      <ul class="facts">${c.facts.map(([k, v]) => `<li><span>${esc(k)}</span><span>${esc(v)}</span></li>`).join('')}</ul>`;
  }
  if (key === 'projects') {
    return `<p class="kicker">${esc(content.name)}</p><h1>${esc(c.title)}</h1>
      <div class="cards">${c.items.map((it) => {
        const tag = it.link ? 'a' : 'div';
        const href = it.link ? ` href="${esc(it.link)}" target="_blank" rel="noopener"` : '';
        return `<${tag} class="card"${href}><h2>${esc(it.title)}</h2><p>${esc(it.blurb)}</p>
          <div class="tags">${(it.tags || []).map((t) => `<span>${esc(t)}</span>`).join('')}</div></${tag}>`;
      }).join('')}</div>`;
  }
  return `<p class="kicker">${esc(content.name)}</p><h1>${esc(c.title)}</h1><p>${esc(c.intro)}</p>
    <ul class="links">${c.links.map((l) => {
      const inner = `<b>${esc(l.label)}</b><span>${esc(l.value)}</span>`;
      return `<li>${l.href ? `<a href="${esc(l.href)}" target="_blank" rel="noopener">${inner}</a>` : `<div>${inner}</div>`}</li>`;
    }).join('')}</ul>
    <section class="guest">
      <h2>Guest notes</h2>
      <p>Pin a note to the board. Short and friendly, ${NOTE_MAX} characters at most.${guest.shared ? '' : ' Here, notes are kept on this device only.'}</p>
      <form id="note-form" autocomplete="off">
        <label class="sr" for="note-text">Your note</label>
        <textarea id="note-text" maxlength="${NOTE_MAX}" rows="2" placeholder="Say hi, leave a tip, sign the wall…" required></textarea>
        <div class="row">
          <label class="sr" for="note-name">Your name</label>
          <input id="note-name" maxlength="${NAME_MAX}" placeholder="Name (optional)">
          <div class="swatches" role="radiogroup" aria-label="Note colour">${NOTE_COLORS.map((c, i) => `<button type="button" role="radio" aria-checked="false" aria-label="Colour ${i + 1}" style="--c:${c}"></button>`).join('')}</div>
        </div>
        <div class="row"><button type="submit" class="pin">Pin it</button><span id="note-count">0 / ${NOTE_MAX}</span><span id="note-msg" role="status"></span></div>
      </form>
      <ul class="notes" id="note-list">${noteListHTML()}</ul>
    </section>`;
}

let openKey = null;
function openPanel(key) {
  if (!content || !content[key]) return;
  openKey = key;
  sound.open();
  panelBody.innerHTML = panelHTML(key);
  panel.hidden = false;
  requestAnimationFrame(() => panel.classList.add('open'));
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('on', b.dataset.open === key));
  help.classList.add('hide');
  three?.focus(key);
  $('close').focus({ preventScroll: true });
  if (key === 'contact') wireNotes();
}
function closePanel() {
  if (!openKey) return;
  openKey = null;
  sound.close();
  panel.classList.remove('open');
  setTimeout(() => { if (!openKey) panel.hidden = true; }, 460);
  document.querySelectorAll('nav button').forEach((b) => b.classList.remove('on'));
  three?.overview();
}
document.querySelectorAll('nav button[data-open]').forEach((b) => b.addEventListener('click', () => openPanel(b.dataset.open)));
$('close').addEventListener('click', closePanel);
$('brand').addEventListener('click', (e) => { e.preventDefault(); closePanel(); });
addEventListener('keydown', (e) => { if (e.key === 'Escape') closePanel(); });

// ---------------------------------------------------------------- screen art (drawn live from content.json)
function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return [c, c.getContext('2d')];
}
function wrap(ctx, text, x, y, maxW, lh, maxLines = 3) {
  const words = String(text).split(/\s+/);
  let line = '', n = 0;
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (ctx.measureText(test).width > maxW && line) {
      n++;
      if (n === maxLines) { ctx.fillText(line.replace(/.{0,3}$/, '…'), x, y); return y + lh; }
      ctx.fillText(line, x, y); y += lh; line = w;
    } else line = test;
  }
  ctx.fillText(line, x, y);
  return y + lh;
}
const MONO = '"Cascadia Code", Consolas, ui-monospace, monospace';
const SANS = '"Segoe UI", system-ui, sans-serif';

// Canvas sizes match the screens' shapes: About is the vertical monitor, Projects the left landscape one,
// Contact the big wall board. (scene.js creates the canvases; keep the two in step.)
function drawAbout(c, x, typed = 1e9, cursor = false) { // 580 x 1024, portrait
  const W = 580, H = 1024, P = 38;
  x.textAlign = 'left';
  const g = x.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#0d1433'); g.addColorStop(1, '#1b0f3a');
  x.fillStyle = g; x.fillRect(0, 0, W, H);
  x.fillStyle = 'rgba(255,255,255,0.06)'; x.fillRect(0, 0, W, 46);
  ['#ff5f57', '#febc2e', '#28c840'].forEach((col, i) => { x.fillStyle = col; x.beginPath(); x.arc(28 + i * 26, 23, 8, 0, 7); x.fill(); });
  x.fillStyle = '#8f8bb5'; x.font = `18px ${MONO}`; x.fillText('~/about', 120, 29);
  x.fillStyle = '#27e0ff'; x.font = `24px ${MONO}`; x.fillText('> whoami', P, 128);
  x.fillStyle = '#ffffff'; x.font = `700 78px ${SANS}`; x.fillText(content.name, P - 4, 226, W - 2 * P);
  x.fillStyle = '#d6d3e8'; x.font = `30px ${SANS}`;
  const done = typed >= content.tagline.length;
  let y = wrap(x, content.tagline.slice(0, typed) + (cursor ? ' ▌' : ''), P, 292, W - 2 * P, 42, 5);
  if (done) {
    y += 18;
    x.fillStyle = 'rgba(255,255,255,0.16)'; x.fillRect(P, y, W - 2 * P, 2);
    y += 52;
    content.about.facts.slice(0, 4).forEach(([k, v]) => {
      x.fillStyle = '#ff3d81'; x.font = `600 19px ${MONO}`; x.fillText(String(k).toUpperCase(), P, y);
      x.fillStyle = '#ffffff'; x.font = `28px ${SANS}`; x.fillText(v, P, y + 38, W - 2 * P);
      y += 98;
    });
  }
  x.fillStyle = '#27e0ff'; x.font = `600 22px ${MONO}`; x.textAlign = 'right'; x.fillText('click to read more ▸', W - P, H - 40);
}
function drawProjects(c, x, active = -1) { // 1024 x 580
  x.textAlign = 'left';
  x.fillStyle = '#140d2b'; x.fillRect(0, 0, 1024, 580);
  x.fillStyle = '#ff3d81'; x.font = `600 26px ${MONO}`; x.fillText('PROJECTS', 44, 56);
  const items = content.projects.items.slice(0, 4);
  items.forEach((it, i) => {
    const cx = 44 + (i % 2) * 474, cy = 82 + Math.floor(i / 2) * 226;
    const on = i === active;
    x.fillStyle = on ? 'rgba(255,61,129,0.28)' : 'rgba(255,255,255,0.06)';
    x.strokeStyle = on ? '#ff3d81' : i % 2 ? '#27e0ff' : '#8b5cff'; x.lineWidth = on ? 6 : 3;
    x.beginPath(); x.roundRect(cx, cy, 462, 206, 18); x.fill(); x.stroke();
    x.fillStyle = '#fff'; x.font = `700 38px ${SANS}`; wrap(x, it.title, cx + 26, cy + 64, 410, 44, 2);
    x.fillStyle = '#b9b5d6'; x.font = `22px ${MONO}`; x.fillText((it.tags || []).join(' · '), cx + 26, cy + 174, 410);
  });
  x.fillStyle = '#27e0ff'; x.font = `600 22px ${MONO}`; x.textAlign = 'right'; x.fillText('click to open ▸', 980, 560);
}
function drawFeature(c, x, it, i, n) { // 1024 x 580
  x.textAlign = 'left';
  const g = x.createLinearGradient(0, 0, 1024, 580);
  g.addColorStop(0, i % 2 ? '#0d1b3a' : '#24104a'); g.addColorStop(1, '#140d2b');
  x.fillStyle = g; x.fillRect(0, 0, 1024, 580);
  x.fillStyle = '#ff3d81'; x.font = `600 26px ${MONO}`; x.fillText(`PROJECT 0${i + 1} / 0${n}`, 52, 70);
  x.fillStyle = '#fff'; x.font = `800 84px ${SANS}`; const y = wrap(x, it.title, 48, 184, 928, 88, 2);
  x.fillStyle = '#cfcbe6'; x.font = `32px ${SANS}`; wrap(x, it.blurb, 52, y + 6, 900, 44, 3);
  x.fillStyle = '#27e0ff'; x.font = `26px ${MONO}`; x.fillText((it.tags || []).join(' · '), 52, 506, 900);
  x.font = `600 22px ${MONO}`; x.textAlign = 'right'; x.fillText('click to open ▸', 980, 560);
}
let corkCache = null;
const HAND = '"Segoe Print", "Bradley Hand", "Comic Sans MS", cursive';
function drawContact(c, x, pop = 1) { // 1400 x 810: a cork board headed "CONTACT ME", with the visitors' notes pinned along the bottom
  const W = 1400, H = 810;
  if (!corkCache) { // the cork itself never changes: drawn once
    const [cc, cx] = makeCanvas(W, H);
    cx.fillStyle = '#c9a26b'; cx.fillRect(0, 0, W, H);
    for (let i = 0; i < 5200; i++) { // cork speckle, deterministic
      cx.fillStyle = i % 3 ? 'rgba(120,80,40,0.18)' : 'rgba(255,235,200,0.14)';
      cx.fillRect((i * 7919) % W, (i * 104729) % H, 3, 3);
    }
    corkCache = cc;
  }
  x.setTransform(1, 0, 0, 1, 0, 0); x.globalAlpha = 1; x.shadowColor = 'transparent';
  x.drawImage(corkCache, 0, 0);
  const paper = (X, Y, w, h, col) => { x.save(); x.shadowColor = 'rgba(0,0,0,0.35)'; x.shadowBlur = 16; x.shadowOffsetY = 7; x.fillStyle = col; x.fillRect(X, Y, w, h); x.restore(); };
  const pin = (X, Y, r = 12, col = '#ff3d81') => {
    x.fillStyle = 'rgba(0,0,0,0.25)'; x.beginPath(); x.arc(X + 2, Y + 4, r, 0, 7); x.fill();
    x.fillStyle = col; x.beginPath(); x.arc(X, Y, r, 0, 7); x.fill();
    x.fillStyle = 'rgba(255,255,255,0.55)'; x.beginPath(); x.arc(X - r * 0.3, Y - r * 0.3, r * 0.32, 0, 7); x.fill();
  };
  // header strip pinned across the top
  paper(360, 20, 680, 104, '#fdfbf4');
  pin(388, 42); pin(1012, 42);
  x.fillStyle = '#1d1a2e'; x.textAlign = 'center'; x.font = `900 78px ${SANS}`; x.fillText('CONTACT ME', W / 2, 100, 600);
  // four notes in a row, each one a way to reach you
  const fit = (text, maxW, px, weight) => { let s = px; do { x.font = `${weight} ${s}px ${SANS}`; } while (x.measureText(text).width > maxW && (s -= 2) > 18); };
  const notes = [{ t: 'Say hi', sub: content.contact.intro, col: '#fff3a8' },
    ...content.contact.links.slice(0, 3).map((l, i) => ({ t: l.label, sub: l.value, col: ['#ffc4d6', '#bdefff', '#d5c7ff'][i] }))];
  notes.forEach((n, i) => {
    const w = 308, h = 348, cx = 52 + i * 331 + w / 2, cy = 150 + h / 2 + (i % 2 ? 10 : 0);
    x.save(); x.translate(cx, cy); x.rotate([-0.02, 0.016, -0.012, 0.022][i]);
    paper(-w / 2, -h / 2, w, h, n.col);
    pin(0, -h / 2 + 24);
    x.fillStyle = '#1d1a2e'; x.textAlign = 'left';
    fit(n.t, w - 52, 56, 800); x.fillText(n.t, -w / 2 + 26, -h / 2 + 108);
    x.fillStyle = 'rgba(29,26,46,0.25)'; x.fillRect(-w / 2 + 26, -h / 2 + 128, w - 52, 3);
    x.fillStyle = '#1d1a2e';
    if (/\s/.test(n.sub)) { x.font = `30px ${SANS}`; wrap(x, n.sub, -w / 2 + 26, -h / 2 + 184, w - 52, 40, 4); }
    else { fit(n.sub, w - 52, 38, 600); x.fillText(n.sub, -w / 2 + 26, -h / 2 + 190); }
    x.restore();
  });
  // the visitors' row: a tag, then the newest notes
  x.save(); x.translate(104, 664); x.rotate(-0.05);
  paper(-84, -76, 168, 152, '#fdfbf4'); pin(0, -56, 10, '#27b8d8');
  x.fillStyle = '#1d1a2e'; x.textAlign = 'center'; x.font = `900 34px ${SANS}`; x.fillText('GUEST', 0, -4); x.fillText('NOTES', 0, 32);
  x.font = `600 17px ${SANS}`; x.fillStyle = '#ff3d81'; x.fillText('pin yours ▸', 0, 60);
  x.restore();
  const shown = guest.notes.slice(0, BOARD_NOTES);
  const list = shown.length ? shown : [{ id: 'none', text: 'Be the first to leave a note here.', name: '', color: 0, ghost: true }];
  list.forEach((n, i) => {
    const w = 156, h = 204, cx = 300 + i * 167, seed = [...String(n.id)].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 997, 7);
    const cy = 662 + ((seed % 5) - 2) * 5, rot = (((seed * 7) % 11) - 5) * 0.012;
    const fresh = n.id === guest.fresh && pop < 1, e = fresh ? 1 - Math.pow(1 - pop, 3) : 1; // a new note swoops in and settles
    x.save(); x.translate(cx, cy - (1 - e) * 120); x.rotate(rot + (1 - e) * 0.5); x.scale(1 + (1 - e) * 0.7, 1 + (1 - e) * 0.7);
    x.globalAlpha = (n.ghost ? 0.55 : 1) * (fresh ? Math.min(1, pop * 3) : 1);
    paper(-w / 2, -h / 2, w, h, NOTE_COLORS[n.color] || NOTE_COLORS[0]);
    pin(0, -h / 2 + 16, 9, ['#ff3d81', '#27b8d8', '#8b5cff', '#ff9a3d'][seed % 4]);
    x.fillStyle = '#1d1a2e'; x.textAlign = 'left'; x.font = `600 21px ${HAND}`;
    const body = String(n.text).replace(/(\S{11})(?=\S)/g, '$1 '); // a long unbroken word is split so it stays on the note
    wrap(x, body, -w / 2 + 13, -h / 2 + 58, w - 24, 27, n.name ? 5 : 6);
    if (n.name) { x.font = `600 17px ${HAND}`; x.fillStyle = 'rgba(29,26,46,0.7)'; x.textAlign = 'right'; x.fillText('— ' + n.name, w / 2 - 12, h / 2 - 14, w - 24); }
    x.restore();
  });
  x.globalAlpha = 1; x.textAlign = 'left';
}

// One shader for both mirrors: a soft (5-tap) planar reflection that is stronger at glancing angles.
const MIRROR_SHADER = {
  name: 'GlossMirror',
  uniforms: {
    color: { value: null }, tDiffuse: { value: null }, textureMatrix: { value: null },
    uBase: { value: new THREE.Color(0x000000) }, uStrength: { value: 0.5 }, uBlur: { value: 0.004 },
    uCenter: { value: new THREE.Vector2() }, uFade: { value: 1000 }, uGlow: { value: 0 },
  },
  vertexShader: /* glsl */`
    uniform mat4 textureMatrix; varying vec4 vUv; varying vec3 vWorld;
    void main() {
      vUv = textureMatrix * vec4(position, 1.0);
      vec4 w = modelMatrix * vec4(position, 1.0);
      vWorld = w.xyz;
      gl_Position = projectionMatrix * viewMatrix * w;
    }`,
  fragmentShader: /* glsl */`
    uniform vec3 color; uniform sampler2D tDiffuse; uniform vec3 uBase;
    uniform float uStrength; uniform float uBlur; uniform vec2 uCenter; uniform float uFade; uniform float uGlow;
    varying vec4 vUv; varying vec3 vWorld;
    void main() {
      vec2 uv = vUv.xy / vUv.w;
      vec3 r = texture2D(tDiffuse, uv).rgb * 0.36;
      r += texture2D(tDiffuse, uv + vec2(uBlur, 0.0)).rgb * 0.16;
      r += texture2D(tDiffuse, uv - vec2(uBlur, 0.0)).rgb * 0.16;
      r += texture2D(tDiffuse, uv + vec2(0.0, uBlur * 1.6)).rgb * 0.16;
      r += texture2D(tDiffuse, uv - vec2(0.0, uBlur * 1.6)).rgb * 0.16;
      vec3 v = normalize(cameraPosition - vWorld);
      float fres = pow(1.0 - clamp(v.y, 0.0, 1.0), 2.0);
      float fade = 1.0 - smoothstep(uFade * 0.25, uFade, distance(vWorld.xz, uCenter));
      // soft pool of coloured light spilling from the room onto the ground
      vec2 d = vWorld.xz - uCenter;
      vec3 pool = mix(vec3(1.0, 0.24, 0.5), vec3(0.15, 0.88, 1.0), smoothstep(-5.0, 5.0, d.x + d.y)) * exp(-dot(d, d) / 55.0) * uGlow;
      gl_FragColor = vec4(uBase + pool + min(r, vec3(4.0)) * color * uStrength * mix(0.45, 1.0, fres) * fade, 1.0);
    }`,
};


// everything the 3D scene (scene.js) needs from this file
const api = {
  canvas, panel, tip, help, reduceMotion, sound, makeCanvas, MIRROR_SHADER,
  art: { drawAbout, drawProjects, drawFeature, drawContact },
  openPanel, closePanel,
  get content() { return content; },
  get openKey() { return openKey; },
  progress: (f) => { $('bar').style.width = Math.round(f * 100) + '%'; },
  // the scene calls this whenever the room switches between night and day (bed click or header button)
  onDay: (isDay) => {
    const b = $('daynight');
    b.textContent = isDay ? '☀ day' : '☾ night';
    b.setAttribute('aria-pressed', String(isDay));
    document.documentElement.dataset.time = isDay ? 'day' : 'night';
  },
};
$('daynight').addEventListener('click', () => { if (three) three.toggleDay(); });

// ---------------------------------------------------------------- boot
(async () => {
  try {
    content = await (await fetch('content.json')).json();
    $('brand').textContent = content.name;
    document.title = content.name;
  } catch (err) {
    $('loader-msg').textContent = 'Could not load content.json. Open the site through the local server, not as a file.';
    console.error(err);
    return;
  }
  const notesReady = loadNotes(); // fetched alongside the room, so a slow notes service never holds up the first view
  try {
    three = await initScene(api);
  } catch (err) {
    console.error(err);
    window.__roomError = String(err && err.stack ? err.stack : err); // readable from the console when the 3D view fails
    help.textContent = '3D view unavailable here. Use the buttons above.';
  }
  notesReady.then(() => { three?.redrawContact(); if (openKey === 'contact' && $('note-list')) $('note-list').innerHTML = noteListHTML(); });
  loader.classList.add('done');
  setTimeout(() => help.classList.add('hide'), 9000);
})();
