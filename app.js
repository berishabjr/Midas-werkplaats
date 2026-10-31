'use strict';
/* =====================================================================
   Midas Werkplaats — personeel (tablet/prikstation) + beheer
   Alle gegevens staan in Supabase. Deze pagina bevat geen geheimen.
   ===================================================================== */
const CFG = window.MW_CONFIG;
const sb = window.supabase.createClient(CFG.url, CFG.key);

/* ---------- Hulpfuncties ---------- */
const TZ = 'Europe/Brussels';
const $ = (s, r) => (r || document).querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => (n < 10 ? '0' + n : '' + n);
const dayKey = ts => new Date(ts).toLocaleDateString('sv-SE', { timeZone: TZ });
const today = () => dayKey(Date.now());
const hm = ts => new Date(ts).toLocaleTimeString('nl-BE', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
const dur = ms => { const m = Math.floor(Math.max(0, ms) / 60000); return Math.floor(m / 60) + 'u' + pad(m % 60); };
const DAGEN = ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'];
const nlDate = s => { const d = new Date(s + 'T12:00:00'); return DAGEN[d.getDay()] + ' ' + pad(d.getDate()) + '/' + pad(d.getMonth() + 1); };
const ini = n => String(n || '?').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
const DAG_LIMIET = 8 * 3600000, WEEK_LIMIET = 38 * 3600000;

function addDays(key, n) { const d = new Date(key + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toLocaleDateString('sv-SE'); }
function weekMonday(key) { const d = new Date(key + 'T12:00:00'); return addDays(key, -((d.getDay() + 6) % 7)); }
function weekLabel(mon) { const a = new Date(mon + 'T12:00:00'), b = new Date(addDays(mon, 6) + 'T12:00:00');
  return pad(a.getDate()) + '/' + pad(a.getMonth() + 1) + ' – ' + pad(b.getDate()) + '/' + pad(b.getMonth() + 1); }

/* Een prik zonder uitklok op een vroegere dag = anomalie: telt niet mee tot een beheerder ze valideert */
function sessMs(p) {
  if (p.uit_ts) return new Date(p.uit_ts) - new Date(p.in_ts);
  return dayKey(p.in_ts) === today() ? Date.now() - new Date(p.in_ts) : 0;
}
const isAnom = p => !p.uit_ts && dayKey(p.in_ts) < today();
const tagc = s => (s === 'Goedgekeurd' ? 'ok' : s === 'Geweigerd' ? 'no' : 'w');

let toastT;
function toast(t, bad) {
  const e = $('#toast');
  e.innerHTML = '<div class="toast' + (bad ? ' bad' : '') + '">' + esc(t) + '</div>';
  clearTimeout(toastT); toastT = setTimeout(() => { e.innerHTML = ''; }, 3200);
}
function openSheet(html) {
  $('#modal').innerHTML = '<div class="overlay" onclick="if(event.target===this)closeSheet()"><div class="sheet">' + html + '</div></div>';
}
function closeSheet() { $('#modal').innerHTML = ''; }
window.closeSheet = closeSheet;
async function rpc(name, args) { const r = await sb.rpc(name, args); if (r.error) throw r.error; return r.data; }
const errTxt = e => String((e && (e.message || e.error_description)) || e || 'Onbekende fout');
const logoImg = () => '<img src="assets/logo.png" alt="Midas">';

/* =====================================================================
   PERSONEEL (prikstation of eigen toestel)
   ===================================================================== */
const DEVICE_KEY = 'mw_toestel';
const getDevice = () => { try { return localStorage.getItem(DEVICE_KEY) || ''; } catch (e) { return ''; } };
const setDevice = t => { try { if (t) localStorage.setItem(DEVICE_KEY, t); else localStorage.removeItem(DEVICE_KEY); } catch (e) {} };

const K = { sessie: null, id: null, naam: null, pick: null, pin: '', idle: null, clock: null, pts: [], aanv: null, tiles: null };
const P = { cb: null };           // pincode-invoer
const A = { user: null };         // beheerder (voor routing)

function kStop() { clearTimeout(K.idle); clearInterval(K.clock); K.idle = null; K.clock = null; }
function kIdleReset() {
  clearTimeout(K.idle);
  if (!K.sessie) return;
  const ms = getDevice() ? 25000 : 10 * 60000;   // tablet: snel afmelden voor de volgende
  K.idle = setTimeout(kLogout, ms);
}
['pointerdown', 'keydown'].forEach(ev => document.addEventListener(ev, () => { if (K.sessie) kIdleReset(); aIdleReset(); }, true));

async function kLogout() {
  const s = K.sessie;
  kStop(); closeSheet();
  Object.assign(K, { sessie: null, id: null, naam: null, pick: null, pin: '', pts: [], aanv: null });
  if (s) { try { await rpc('uitloggen', { p_sessie: s }); } catch (e) {} }
  if (!location.hash.startsWith('#/beheer')) kLogin();
}
window.kLogout = kLogout;

/* ----- Aanmelden ----- */
async function kLogin() {
  kStop();
  const app = $('#app');
  const dev = getDevice();
  if (dev) {
    app.innerHTML = '<div class="center">' +
      '<div class="brand">' + logoImg() + '<div class="t">Wie ben jij?</div></div>' +
      '<div class="tiles" id="tiles"><div class="empty">Laden…</div></div>' +
      '<a class="footlink" href="#/beheer">Beheer</a></div>';
    try {
      const rows = await rpc('kiosk_personeel', { p_toestel: dev });
      K.tiles = rows || [];
      if (!K.tiles.length) {
        $('#tiles').innerHTML = '<div class="card" style="grid-column:1/-1;text-align:center">' +
          '<div style="font-weight:800;margin-bottom:6px">Dit toestel is niet (meer) geregistreerd</div>' +
          '<div class="muted" style="margin-bottom:14px">Vraag de beheerder om dit toestel opnieuw te registreren.</div>' +
          '<button class="btn" onclick="setDevice(\'\');kLogin()">Toestel loskoppelen</button></div>';
        return;
      }
      $('#tiles').innerHTML = K.tiles.map(t =>
        '<button class="ntile" data-id="' + esc(t.o_id) + '"><span class="av">' + esc(ini(t.o_naam)) +
        '</span><span class="n">' + esc(t.o_naam) + '</span></button>').join('');
      document.querySelectorAll('.ntile').forEach(b => b.onclick = () => kPickTile(b.dataset.id));
    } catch (e) { $('#tiles').innerHTML = '<div class="empty">Geen verbinding. Probeer opnieuw.</div>'; }
  } else {
    app.innerHTML = '<div class="center"><div class="brand">' + logoImg() + '<div class="t">Personeelsportaal</div></div>' +
      '<div class="card" style="width:100%;max-width:400px" id="lcard">' +
      '<div class="field"><label>Stamnummer</label><input id="stam" inputmode="numeric" autocomplete="off" placeholder="bv. 001"></div>' +
      '<div class="lbl muted" style="font-size:12px;letter-spacing:.1em;text-transform:uppercase">Pincode</div>' +
      pinPadHtml() + '<div class="err" id="perr"></div></div>' +
      '<div class="note" style="max-width:400px">Inklokken en uitklokken kan enkel op de tablet in de garage.</div>' +
      '<a class="footlink" href="#/beheer">Beheer</a></div>';
    pinInit(async pin => {
      const stam = $('#stam').value.trim();
      if (!stam) { $('#perr').textContent = 'Vul je stamnummer in'; pinReset(); return; }
      try {
        const r = (await rpc('inloggen_stamnummer', { p_centrum: CFG.centrum, p_stamnummer: stam, p_pin: pin }))[0];
        kLoginResult(r);
      } catch (e) { $('#perr').textContent = 'Geen verbinding'; pinReset(); }
    });
  }
}
window.setDevice = setDevice; window.kLogin = kLogin;

function kPickTile(id) {
  const t = (K.tiles || []).find(x => x.o_id === id); if (!t) return;
  K.pick = t;
  $('#app').innerHTML = '<div class="center"><div class="brand"><span class="av" style="width:72px;height:72px;font-size:28px;margin:0 auto">' +
    esc(ini(t.o_naam)) + '</span><div style="font-size:22px;font-weight:800;margin-top:10px">' + esc(t.o_naam) + '</div></div>' +
    '<div class="card" style="width:100%;max-width:400px" id="lcard">' +
    '<div class="muted" style="font-size:12px;letter-spacing:.1em;text-transform:uppercase;text-align:center">Pincode</div>' +
    pinPadHtml() + '<div class="err" id="perr"></div>' +
    '<button class="btn block" style="margin-top:8px" onclick="kLogin()">← Terug</button></div></div>';
  pinInit(async pin => {
    try {
      const r = (await rpc('inloggen_kiosk', { p_toestel: getDevice(), p_medewerker: t.o_id, p_pin: pin }))[0];
      kLoginResult(r);
    } catch (e) { $('#perr').textContent = 'Geen verbinding'; pinReset(); }
  });
}

function kLoginResult(r) {
  if (r && r.o_status === 'ok') {
    K.sessie = r.o_sessie; K.id = r.o_id; K.naam = r.o_naam; K.pin = '';
    kMenu(); return;
  }
  const s = r ? r.o_status : 'fout';
  const msg = s === 'geblokkeerd' ? 'Geblokkeerd na 3 foute pogingen. Vraag de beheerder om je te deblokkeren.'
    : s === 'toestel_ongeldig' ? 'Dit toestel is niet geregistreerd.'
    : 'Verkeerde pincode' + (r && r.o_over != null ? ' (' + r.o_over + ' poging(en) over)' : '');
  $('#perr').textContent = msg;
  const c = $('#lcard'); if (c) { c.classList.add('shake'); setTimeout(() => c.classList.remove('shake'), 400); }
  pinReset();
}

/* ----- Pincode-invoer ----- */
function pinPadHtml() {
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '←'];
  return '<div class="dots" id="dots"><div class="dot"></div><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>' +
    '<div class="pad">' + keys.map(k => '<button class="key' + (k === 'C' || k === '←' ? ' fn' : '') + '" data-k="' + k + '">' + k + '</button>').join('') + '</div>';
}
function pinInit(cb) {
  P.cb = cb; P.pin = '';
  document.querySelectorAll('.key').forEach(b => b.onclick = () => pinKey(b.dataset.k));
}
function pinDraw() { const d = document.querySelectorAll('#dots .dot'); d.forEach((x, i) => x.classList.toggle('on', i < P.pin.length)); }
function pinReset() { P.pin = ''; pinDraw(); }
function pinKey(k) {
  if (!P.cb) return;
  if (k === 'C') P.pin = '';
  else if (k === '←') P.pin = P.pin.slice(0, -1);
  else if (P.pin.length < 4) P.pin += k;
  pinDraw();
  if (P.pin.length === 4) { const pin = P.pin, cb = P.cb; setTimeout(() => cb(pin), 120); }
}
document.addEventListener('keydown', e => {
  if (!P.cb || !$('#dots') || e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (/^[0-9]$/.test(e.key)) pinKey(e.key);
  else if (e.key === 'Backspace') pinKey('←');
  else if (e.key === 'Escape' || e.key === 'Delete') pinKey('C');
});

/* ----- Hoofdscherm medewerker ----- */
async function kLoad() {
  const mon = weekMonday(today());
  const [pts, aanv] = await Promise.all([
    rpc('mijn_pointages', { p_sessie: K.sessie, p_van: mon, p_tot: addDays(mon, 6) }),
    rpc('mijn_aanvragen', { p_sessie: K.sessie })
  ]);
  K.pts = pts || []; K.aanv = aanv || { verlof: [], materiaal: [] };
}
function kHandleErr(e) {
  const m = errTxt(e);
  if (m.indexOf('sessie_ongeldig') >= 0) { toast('Sessie verlopen, meld je opnieuw aan', true); kLogout(); return; }
  if (m.indexOf('toestel_niet_geregistreerd') >= 0) { toast('Dit toestel is geen geregistreerd prikstation', true); return; }
  toast('Er ging iets mis: ' + m, true);
}

async function kMenu() {
  kIdleReset();
  $('#app').innerHTML = '<div class="topbar"><span class="av">' + esc(ini(K.naam)) + '</span><div><div class="who">' + esc(K.naam) +
    '</div><div class="sub">' + esc(CFG.naam) + '</div></div><span class="grow"></span>' +
    '<button class="btn small" onclick="kLogout()">Afmelden</button></div>' +
    '<div id="notif"></div><div class="page wide"><div class="empty">Laden…</div></div>';
  try { await kLoad(); } catch (e) { kHandleErr(e); return; }
  kRenderMenu();
  clearInterval(K.clock); K.clock = setInterval(kTick, 1000);
}
function kOpenPunch() { return K.pts.filter(p => !p.o_uit && dayKey(p.o_in) === today())[0]; }
function kTick() {
  const c = $('#clk'); if (!c) return;
  const n = new Date();
  c.textContent = n.toLocaleTimeString('nl-BE', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: TZ });
  const d = $('#dur'); if (d) d.textContent = dur(kTodayMs());
}
function kTodayMs() {
  let ms = 0;
  K.pts.forEach(p => { if (dayKey(p.o_in) === today()) ms += p.o_uit ? new Date(p.o_uit) - new Date(p.o_in) : Date.now() - new Date(p.o_in); });
  return ms;
}
function kRenderMenu() {
  const dev = !!getDevice(), open = kOpenPunch();
  const todayPts = K.pts.filter(p => dayKey(p.o_in) === today());
  const mon = weekMonday(today());
  let weekMs = 0;
  K.pts.forEach(p => { weekMs += p.o_uit ? new Date(p.o_uit) - new Date(p.o_in) : (dayKey(p.o_in) === today() ? Date.now() - new Date(p.o_in) : 0); });
  const weekOT = Math.max(0, weekMs - WEEK_LIMIET);

  /* meldingen over beslissingen */
  const items = [];
  (K.aanv.verlof || []).forEach(x => { if (x.gezien === false && x.status !== 'In behandeling') items.push(['verlof', x]); });
  (K.aanv.materiaal || []).forEach(x => { if (x.gezien === false && x.status !== 'In behandeling') items.push(['materiaal', x]); });
  $('#notif').innerHTML = items.map(([soort, x]) => {
    const ok = x.status === 'Goedgekeurd';
    const wat = soort === 'verlof' ? esc(x.type) + ' · ' + nlDate(x.van) + ' → ' + nlDate(x.tot) :
      esc(x.omschrijving) + (x.maat ? ' · maat ' + esc(x.maat) : '') + ' (' + esc(x.aantal) + 'x)';
    return '<div class="banner ' + (ok ? 'ok' : 'no') + '"><span class="bi">' + (ok ? '✅' : '⛔') + '</span><span class="bt">Je ' +
      (soort === 'verlof' ? 'verlofaanvraag' : 'materiaalaanvraag') + ' is ' + (ok ? 'goedgekeurd' : 'geweigerd') +
      '<small>' + wat + (!ok && x.weiger_reden ? '<br>Reden: ' + esc(x.weiger_reden) : '') + '</small></span>' +
      '<button class="bx" onclick="kGelezen(\'' + soort + '\',\'' + esc(x.id) + '\')">✕</button></div>';
  }).join('');

  const punchHtml = dev
    ? '<button class="punch ' + (open ? 'out' : 'in') + '" onclick="kPunch()">' + (open ? 'Uitklokken' : 'Inklokken') + '</button>'
    : '<div class="note">Inklokken en uitklokken kan enkel op de tablet aan het vestiaire of de pc in de garage.</div>';
  const dagen = [];
  for (let i = 0; i < 7; i++) { const k = addDays(today(), -i); const l = K.pts.filter(p => dayKey(p.o_in) === k); if (l.length) dagen.push([k, l]); }
  const weekRows = dagen.map(([k, l]) => {
    const tot = l.reduce((s, p) => s + sessMs({ in_ts: p.o_in, uit_ts: p.o_uit }), 0), ot = Math.max(0, tot - DAG_LIMIET);
    const anom = l.some(p => isAnom({ in_ts: p.o_in, uit_ts: p.o_uit }));
    return '<div class="row' + (anom ? ' warn' : '') + '"><div><div class="l">' + nlDate(k) + (anom ? ' <span class="tag a">Niet uitgeklokt</span>' : '') +
      '</div><div class="s">' + l.map(p => hm(p.o_in) + '–' + (p.o_uit ? hm(p.o_uit) + (p.o_gecorrigeerd ? ' 🛠️' : '') : (dayKey(p.o_in) === today() ? '…' : '⚠️'))).join(' · ') +
      (ot > 0 ? ' · <span style="color:#ff7b7b">+' + dur(ot) + ' overuren</span>' : '') + '</div></div><div class="r">' + dur(tot) + '</div></div>';
  }).join('');

  $('#app').lastElementChild.outerHTML = '<div class="page wide"><div class="dash"><div>' +
    '<div class="clock"><div class="t" id="clk">--:--:--</div><div class="d">' +
    new Date().toLocaleDateString('nl-BE', { weekday: 'long', day: 'numeric', month: 'long', timeZone: TZ }) + '</div></div>' +
    '<div class="card status"><span class="pill' + (open ? ' in' : '') + '"></span><div><div class="s1">' + (open ? 'Ingeklokt' : 'Uitgeklokt') +
    '</div><div class="s2">' + (todayPts.length ? 'Eerste inklok om ' + hm(todayPts[0].o_in) : 'Nog niet ingeklokt vandaag') +
    '</div></div><div class="dur" id="dur">' + (todayPts.length ? dur(kTodayMs()) : '') + '</div></div>' + punchHtml + '</div><div>' +
    '<div class="grid2">' +
    '<button class="tile" onclick="kForm(\'verlof\')"><span class="ic">🌴</span><span class="tt">Verlofaanvraag</span><span class="ts">Vakantie, recup of ziekte</span></button>' +
    '<button class="tile" onclick="kForm(\'mat\')"><span class="ic">🔧</span><span class="tt">Materiaalaanvraag</span><span class="ts">Gereedschap of kledij</span></button>' +
    '<button class="tile" onclick="kUren()"><span class="ic">⏱️</span><span class="tt">Mijn uren</span><span class="ts">Overzicht gewerkte uren</span></button>' +
    '<button class="tile" onclick="kAanvragen()"><span class="ic">📋</span><span class="tt">Mijn aanvragen</span><span class="ts">Status van je aanvragen</span></button></div>' +
    '<h2 class="sec">Deze week</h2><div class="row hl"><div><div class="l">Week ' + weekLabel(mon) + '</div><div class="s">Contract 38u/week' +
    (weekOT > 0 ? ' · <span style="color:#ff7b7b">+' + dur(weekOT) + ' overuren</span>' : '') + '</div></div><div class="r" style="color:var(--yellow)">' + dur(weekMs) + '</div></div>' +
    (weekRows || '<div class="empty">Nog geen geregistreerde uren</div>') + '</div></div></div>';
  kTick();
}

async function kGelezen(soort, id) {
  try { await rpc('aanvraag_gelezen', { p_sessie: K.sessie, p_soort: soort, p_id: id }); await kLoad(); kRenderMenu(); } catch (e) { kHandleErr(e); }
}
window.kGelezen = kGelezen;

async function kPunch() {
  const b = document.querySelector('.punch'); if (b) b.disabled = true;
  try {
    const r = (await rpc('pointeer', { p_sessie: K.sessie, p_toestel: getDevice() }))[0];
    const inn = r.o_actie === 'in', voor = String(r.o_naam || '').split(' ')[0];
    clearInterval(K.clock); clearTimeout(K.idle);
    $('#app').insertAdjacentHTML('beforeend', '<div class="confirm ' + (inn ? 'in' : 'out') + '"><div class="big">' +
      (inn ? 'Welkom ' : 'Tot ziens ') + esc(voor) + '</div><div class="time">' + hm(r.o_tijd) + '</div><div style="margin-top:10px;font-size:20px">' +
      (inn ? 'Ingeklokt' : 'Uitgeklokt') + '</div></div>');
    setTimeout(kLogout, 3200);
  } catch (e) { if (b) b.disabled = false; kHandleErr(e); }
}
window.kPunch = kPunch;

/* ----- Formulieren ----- */
const CATALOOG = {
  'Kledij': [{ n: 'Werkbroek', m: 'kleding' }, { n: 'Pullover', m: 'kleding' }, { n: 'T-shirt', m: 'kleding' }, { n: 'Andere', m: null }],
  'Persoonlijke veiligheidsmateriaal': [{ n: 'Werkschoenen', m: 'schoen' }, { n: 'Handschoenen', m: 'kleding' },
    { n: 'Veiligheidsbril', m: null }, { n: 'Helm', m: null }, { n: 'Andere', m: null }],
  'Gereedschap': ['Ratelsleutel', 'Dopsleutel', 'Steeksleutel', 'Momentsleutel', 'Slagmoersleutel', 'Boormachine', 'Hamer',
    'Schroevendraaierset', 'Bandenlichters', 'Diagnosetool (OBD)'].map(n => ({ n, m: null })).concat([{ n: 'Andere', m: null }])
};
function kForm(t) {
  if (t === 'verlof') {
    openSheet('<h3>Verlofaanvraag</h3><div class="field"><label>Type</label><select id="vT"><option>Vakantie</option><option>Recuperatie</option>' +
      '<option>Ziekte</option><option>Familiaal verlof</option><option>Onbetaald verlof</option></select></div>' +
      '<div class="field"><label>Van</label><input type="date" id="vV" value="' + today() + '"></div>' +
      '<div class="field"><label>Tot en met</label><input type="date" id="vE" value="' + today() + '"></div>' +
      '<div class="field"><label>Opmerking</label><textarea id="vR" placeholder="Optioneel"></textarea></div><div class="err" id="ferr"></div>' +
      '<div class="btns"><button class="btn" onclick="closeSheet()">Annuleren</button><button class="btn primary" onclick="kSendVerlof()">Indienen</button></div>');
  } else {
    openSheet('<h3>Materiaalaanvraag</h3><div class="field"><label>Categorie</label><select id="mC" onchange="kCat()">' +
      Object.keys(CATALOOG).map(c => '<option>' + esc(c) + '</option>').join('') + '</select></div>' +
      '<div class="field"><label>Artikel</label><select id="mI" onchange="kItem()"></select></div>' +
      '<div class="field hidden" id="mSW"><label>Maat</label><select id="mM"></select></div>' +
      '<div class="field hidden" id="mOW"><label>Omschrijving</label><input id="mO" placeholder="Omschrijf het artikel"></div>' +
      '<div class="field"><label>Aantal</label><input type="number" id="mA" value="1" min="1"></div>' +
      '<div class="field"><label>Urgentie</label><select id="mU"><option>Normaal</option><option>Dringend</option><option>Zeer dringend</option></select></div>' +
      '<div class="field"><label>Motivatie</label><textarea id="mR" placeholder="Waarvoor is dit nodig?"></textarea></div><div class="err" id="ferr"></div>' +
      '<div class="btns"><button class="btn" onclick="closeSheet()">Annuleren</button><button class="btn primary" onclick="kSendMat()">Indienen</button></div>');
    kCat();
  }
}
function kCat() { const c = $('#mC').value; $('#mI').innerHTML = (CATALOOG[c] || []).map(i => '<option>' + esc(i.n) + '</option>').join(''); kItem(); }
function kItem() {
  const c = $('#mC').value, v = $('#mI').value, it = (CATALOOG[c] || []).filter(i => i.n === v)[0], other = v === 'Andere';
  $('#mOW').classList.toggle('hidden', !other);
  const sw = $('#mSW');
  if (it && it.m && !other) {
    sw.classList.remove('hidden');
    const opts = it.m === 'schoen' ? Array.from({ length: 10 }, (_, i) => 38 + i) : ['S', 'M', 'L', 'XL'];
    $('#mM').innerHTML = opts.map(o => '<option>' + o + '</option>').join('');
  } else sw.classList.add('hidden');
}
async function kSendVerlof() {
  const v = $('#vV').value, e = $('#vE').value;
  if (!v || !e) { $('#ferr').textContent = 'Vul de datums in'; return; }
  if (e < v) { $('#ferr').textContent = '"Tot en met" mag niet voor "Van" liggen'; return; }
  try {
    await rpc('verlof_indienen', { p_sessie: K.sessie, p_type: $('#vT').value, p_van: v, p_tot: e, p_opmerking: $('#vR').value });
    closeSheet(); toast('Verlofaanvraag ingediend'); await kLoad(); kRenderMenu();
  } catch (er) { kHandleErr(er); }
}
async function kSendMat() {
  const item = $('#mI').value, o = ($('#mO').value || '').trim(), sw = $('#mSW');
  if (item === 'Andere' && !o) { $('#ferr').textContent = 'Omschrijf het artikel'; return; }
  const aantal = parseInt($('#mA').value, 10);
  if (!(aantal >= 1)) { $('#ferr').textContent = 'Geef een aantal op'; return; }
  try {
    await rpc('materiaal_indienen', { p_sessie: K.sessie, p_categorie: $('#mC').value, p_omschrijving: item === 'Andere' ? o : item,
      p_maat: sw.classList.contains('hidden') ? '' : $('#mM').value, p_aantal: aantal, p_urgentie: $('#mU').value, p_motivatie: $('#mR').value });
    closeSheet(); toast('Materiaalaanvraag ingediend'); await kLoad(); kRenderMenu();
  } catch (er) { kHandleErr(er); }
}
Object.assign(window, { kForm, kCat, kItem, kSendVerlof, kSendMat });

async function kUren() {
  try {
    const rows = await rpc('mijn_pointages', { p_sessie: K.sessie, p_van: addDays(today(), -60), p_tot: today() }) || [];
    const per = {};
    rows.forEach(p => { (per[dayKey(p.o_in)] = per[dayKey(p.o_in)] || []).push(p); });
    const keys = Object.keys(per).sort().reverse();
    let tot = 0;
    const h = keys.map(k => {
      const l = per[k], t = l.reduce((s, p) => s + sessMs({ in_ts: p.o_in, uit_ts: p.o_uit }), 0); tot += t;
      const anom = l.some(p => isAnom({ in_ts: p.o_in, uit_ts: p.o_uit })), ot = Math.max(0, t - DAG_LIMIET);
      return '<div class="row' + (anom ? ' warn' : '') + '"><div><div class="l">' + nlDate(k) + (anom ? ' <span class="tag a">Niet uitgeklokt</span>' : '') +
        '</div><div class="s">' + l.map(p => hm(p.o_in) + '–' + (p.o_uit ? hm(p.o_uit) + (p.o_gecorrigeerd ? ' 🛠️' : '') : (dayKey(p.o_in) === today() ? '…' : '⚠️'))).join(' · ') +
        (ot > 0 ? ' · <span style="color:#ff7b7b">+' + dur(ot) + ' overuren</span>' : '') + '</div></div><div class="r">' + dur(t) + '</div></div>';
    }).join('');
    openSheet('<h3>Mijn uren (laatste 60 dagen)</h3>' + (h ? '<div class="row hl"><div class="l">Totaal</div><div class="r" style="color:var(--yellow)">' + dur(tot) + '</div></div>' + h
      : '<div class="empty">Nog geen uren geregistreerd</div>') + '<div class="btns"><button class="btn" onclick="closeSheet()">Sluiten</button></div>');
  } catch (e) { kHandleErr(e); }
}
function kAanvragen() {
  const v = K.aanv.verlof || [], m = K.aanv.materiaal || [];
  const reden = x => (x.status === 'Geweigerd' && x.weiger_reden) ? '<div class="s" style="color:#ff7b7b">Reden: ' + esc(x.weiger_reden) + '</div>' : '';
  openSheet('<h3>Mijn aanvragen</h3><h2 class="sec" style="margin-top:4px">Verlof</h2>' +
    (v.length ? v.map(x => '<div class="row"><div><div class="l">' + esc(x.type) + '</div><div class="s">' + nlDate(x.van) + ' → ' + nlDate(x.tot) + '</div>' + reden(x) +
      '</div><span class="tag ' + tagc(x.status) + '" style="margin-left:auto">' + esc(x.status) + '</span></div>').join('') : '<div class="empty">Geen verlofaanvragen</div>') +
    '<h2 class="sec">Materiaal</h2>' +
    (m.length ? m.map(x => '<div class="row"><div><div class="l">' + esc(x.omschrijving) + (x.maat ? ' · maat ' + esc(x.maat) : '') + '</div><div class="s">' +
      esc(x.categorie) + ' · ' + esc(x.aantal) + ' st · ' + esc(x.urgentie) + '</div>' + reden(x) + '</div><span class="tag ' + tagc(x.status) +
      '" style="margin-left:auto">' + esc(x.status) + '</span></div>').join('') : '<div class="empty">Geen materiaalaanvragen</div>') +
    '<div class="btns"><button class="btn" onclick="closeSheet()">Sluiten</button></div>');
}
Object.assign(window, { kUren, kAanvragen });

/* =====================================================================
   BEHEER (e-mail + wachtwoord)
   ===================================================================== */
const MED_COLS = 'id,centre_id,stamnummer,naam,functie,type,geboortedatum,adres,telefoon,email,contracttype,uren_per_week,mislukte_pogingen,geblokkeerd,actief,created_at';
const B = { info: null, tab: 'overzicht', med: [], pt: [], vl: [], mat: [], dev: [], beh: [], aud: [], emp: null, empDate: today(), empSub: 'pointages',
  chan: null, poll: null, idle: null, rt: null };
const TABS = [['overzicht', 'Overzicht'], ['personeel', 'Personeel'], ['verlof', 'Verlof'], ['materiaal', 'Materiaal'],
  ['valideren', 'Te valideren'], ['export', 'Export'], ['toestel', 'Toestel'], ['journaal', 'Journaal']];

function aIdleReset() {
  clearTimeout(B.idle);
  if (!B.info) return;
  B.idle = setTimeout(async () => { await aLogout(true); }, 30 * 60000);
}
async function aStop() {
  clearTimeout(B.idle); clearInterval(B.poll); clearTimeout(B.rt);
  if (B.chan) { try { await sb.removeChannel(B.chan); } catch (e) {} B.chan = null; }
}
async function aStart() {
  kStop();
  const r = await sb.auth.getSession();
  if (!r.data.session) return aLoginView();
  return aEnter(r.data.session.user);
}
function aLoginView(msg) {
  $('#app').innerHTML = '<div class="center"><div class="brand">' + logoImg() + '<div class="t">Beheer</div></div>' +
    '<form class="card" style="width:100%;max-width:400px" id="lf">' +
    '<div class="field"><label>E-mail</label><input id="em" type="email" autocomplete="username" required></div>' +
    '<div class="field"><label>Wachtwoord</label><input id="pw" type="password" autocomplete="current-password" required></div>' +
    '<div class="err" id="lerr">' + esc(msg || '') + '</div><button class="btn primary block" type="submit">Aanmelden</button></form>' +
    '<a class="footlink" href="#/">← Terug naar personeel</a></div>';
  $('#lf').onsubmit = async ev => {
    ev.preventDefault();
    const r = await sb.auth.signInWithPassword({ email: $('#em').value.trim(), password: $('#pw').value });
    if (r.error) { $('#lerr').textContent = 'Aanmelden mislukt: controleer e-mail en wachtwoord'; return; }
    aEnter(r.data.user);
  };
}
async function aEnter(user) {
  const r = await sb.from('beheerders').select('*').eq('user_id', user.id).eq('actief', true).maybeSingle();
  if (r.error || !r.data) {
    $('#app').innerHTML = '<div class="center"><div class="card" style="max-width:420px;text-align:center"><div style="font-weight:800;margin-bottom:8px">Geen toegang</div>' +
      '<div class="muted" style="margin-bottom:16px">Dit account is niet gekoppeld aan een centrum.</div><button class="btn block" onclick="aLogout()">Afmelden</button></div></div>';
    return;
  }
  B.info = r.data; B.tab = 'overzicht'; B.emp = null;
  $('#app').innerHTML = '<div class="empty" style="padding:80px 0">Laden…</div>';
  await aLoad();
  aShell(); aIdleReset();
  B.chan = sb.channel('beheer-live');
  ['verlof', 'materiaal', 'pointages'].forEach(t => B.chan.on('postgres_changes', { event: '*', schema: 'public', table: t }, pl => aLive(t, pl)));
  B.chan.subscribe();
  clearInterval(B.poll); B.poll = setInterval(() => aRefresh(), 30000);
}
async function aLogout(auto) {
  await aStop(); B.info = null;
  await sb.auth.signOut();
  if (auto) toast('Automatisch afgemeld na 30 minuten inactiviteit');
  if (location.hash.startsWith('#/beheer')) aLoginView();
}
window.aLogout = aLogout;

async function aLoad() {
  const since = new Date(Date.now() - 62 * 864e5).toISOString();
  const [m, p, v, x, d, b, au] = await Promise.all([
    sb.from('medewerkers').select(MED_COLS).order('naam'),
    sb.from('pointages').select('*').gte('in_ts', since).order('in_ts', { ascending: false }).limit(5000),
    sb.from('verlof').select('*').order('created_at', { ascending: false }),
    sb.from('materiaal').select('*').order('created_at', { ascending: false }),
    sb.from('toestellen').select('*').order('created_at'),
    sb.from('beheerders').select('user_id,naam,rol'),
    sb.from('auditlog').select('*').order('ts', { ascending: false }).limit(200)
  ]);
  B.med = m.data || []; B.pt = p.data || []; B.vl = v.data || []; B.mat = x.data || [];
  B.dev = d.data || []; B.beh = b.data || []; B.aud = au.data || [];
}
async function aRefresh() { if (!B.info) return; try { await aLoad(); aRender(); } catch (e) {} }
function aLive(tabel, pl) {
  clearTimeout(B.rt);
  B.rt = setTimeout(aRefresh, 300);
  if (pl.eventType === 'INSERT' && tabel !== 'pointages') toast('🔔 Nieuwe ' + (tabel === 'verlof' ? 'verlofaanvraag' : 'materiaalaanvraag'));
}
const medNaam = id => (B.med.filter(m => m.id === id)[0] || {}).naam || '—';
const pending = l => l.filter(x => x.status === 'In behandeling').length;
function anomalies() {
  const out = [];
  B.pt.forEach(p => { if (isAnom(p)) out.push(p); });
  return out.sort((a, b) => (a.in_ts < b.in_ts ? 1 : -1));
}

function aShell() {
  $('#app').innerHTML = '<div class="topbar"><span class="av">' + esc(ini(B.info.naam)) + '</span><div><div class="who">' + esc(B.info.naam) +
    '</div><div class="sub">' + esc(B.info.rol === 'eigenaar' ? 'Eigenaar' : 'Assistent') + ' · ' + esc(CFG.naam) + '</div></div><span class="grow"></span>' +
    '<a class="btn small" href="#/" style="text-decoration:none">Personeel</a><button class="btn small" onclick="aLogout()">Afmelden</button></div>' +
    '<div class="admin"><div class="tabs" id="tabs"></div><div id="anotif"></div><div id="acontent"></div></div>';
  aRender();
}
function aRender() {
  if (!$('#tabs')) return;
  const nAnom = anomalies().length, nv = pending(B.vl), nm = pending(B.mat);
  $('#tabs').innerHTML = TABS.map(([k, l]) => {
    const n = k === 'verlof' ? nv : k === 'materiaal' ? nm : k === 'valideren' ? nAnom : 0;
    return '<button class="tab' + (B.tab === k && !B.emp ? ' on' : '') + '" onclick="aTab(\'' + k + '\')">' + l + (n ? '<span class="n">' + n + '</span>' : '') + '</button>';
  }).join('');
  /* nieuwe aanvragen = opvallende melding */
  const nw = [];
  B.vl.forEach(x => { if (!x.gezien_door_beheer && x.status === 'In behandeling') nw.push(['verlof', x]); });
  B.mat.forEach(x => { if (!x.gezien_door_beheer && x.status === 'In behandeling') nw.push(['materiaal', x]); });
  nw.sort((a, b) => (a[1].created_at < b[1].created_at ? 1 : -1));
  $('#anotif').innerHTML = nw.map(([soort, x]) => {
    const wat = soort === 'verlof' ? 'Verlof · ' + esc(x.type) + ' · ' + nlDate(x.van) + ' → ' + nlDate(x.tot)
      : 'Materiaal · ' + esc(x.omschrijving) + (x.maat ? ' · maat ' + esc(x.maat) : '') + ' (' + esc(x.aantal) + 'x)';
    return '<div class="banner new" style="border-radius:12px;margin-top:10px" onclick="aTab(\'' + soort + '\')"><span class="bi">🔔</span><span class="bt">Nieuwe aanvraag van ' +
      esc(medNaam(x.medewerker_id)) + '<small>' + wat + '</small></span><button class="bx" onclick="event.stopPropagation();aGezien(\'' + soort + '\',\'' + esc(x.id) + '\')">✕</button></div>';
  }).join('');
  const c = $('#acontent');
  if (B.emp) c.innerHTML = aEmpView();
  else c.innerHTML = ({ overzicht: aOverzicht, personeel: aPersoneel, verlof: () => aReqList('verlof'), materiaal: () => aReqList('materiaal'),
    valideren: aValideren, export: aExport, toestel: aToestel, journaal: aJournaal }[B.tab] || aOverzicht)();
}
function aTab(t) { B.tab = t; B.emp = null; aRender(); }
async function aGezien(soort, id) {
  const tbl = soort === 'verlof' ? 'verlof' : 'materiaal';
  const r = await sb.from(tbl).update({ gezien_door_beheer: true }).eq('id', id);
  if (r.error) return toast(errTxt(r.error), true);
  const it = (soort === 'verlof' ? B.vl : B.mat).filter(x => x.id === id)[0]; if (it) it.gezien_door_beheer = true; aRender();
}
Object.assign(window, { aTab, aGezien });

function aOverzicht() {
  const inNu = B.med.filter(m => B.pt.some(p => p.medewerker_id === m.id && !p.uit_ts && dayKey(p.in_ts) === today())).length;
  const na = anomalies().length;
  return '<div class="kpis"><div class="kpi"><div class="n">' + inNu + '</div><div class="l">Nu ingeklokt</div></div>' +
    '<div class="kpi"><div class="n">' + pending(B.vl) + '</div><div class="l">Verlof in behandeling</div></div>' +
    '<div class="kpi"><div class="n">' + pending(B.mat) + '</div><div class="l">Materiaal in behandeling</div></div>' +
    '<button class="kpi" onclick="aTab(\'valideren\')"><div class="n" style="' + (na ? 'color:#ff9900' : '') + '">' + na + '</div><div class="l">Niet uitgeklokt</div></button></div>' +
    '<button class="btn primary block" onclick="aNieuwMed()">+ Werknemer toevoegen</button><h2 class="sec">Status vandaag</h2>' +
    (B.med.filter(m => m.actief).map(m => {
      const p = B.pt.filter(x => x.medewerker_id === m.id && dayKey(x.in_ts) === today()).sort((a, b) => (a.in_ts > b.in_ts ? 1 : -1));
      const on = p.some(x => !x.uit_ts);
      return '<button class="row" style="width:100%;text-align:left" onclick="aEmp(\'' + esc(m.id) + '\')"><span class="av">' + esc(ini(m.naam)) + '</span><div><div class="l">' +
        esc(m.naam) + (m.geblokkeerd ? ' <span class="tag no">Geblokkeerd</span>' : '') + '</div><div class="s">' + (on ? '🟢 ingeklokt · ' : '⚪ ') +
        (p.length ? 'sinds ' + hm(p[0].in_ts) : 'niet ingeklokt') + '</div></div><span class="r muted">›</span></button>';
    }).join('') || '<div class="empty">Nog geen personeel. Voeg je eerste werknemer toe.</div>');
}
function aPersoneel() {
  return '<button class="btn primary block" style="margin-bottom:14px" onclick="aNieuwMed()">+ Werknemer toevoegen</button>' +
    (B.med.map(m => '<button class="row" style="width:100%;text-align:left" onclick="aEmp(\'' + esc(m.id) + '\')"><span class="av">' + esc(ini(m.naam)) + '</span><div><div class="l">' +
      esc(m.naam) + (m.geblokkeerd ? ' <span class="tag no">Geblokkeerd</span>' : '') + (!m.actief ? ' <span class="tag w">Inactief</span>' : '') + '</div><div class="s">' +
      esc(m.functie || m.type || '') + ' · nr ' + esc(m.stamnummer) + '</div></div><span class="r muted">›</span></button>').join('') ||
      '<div class="empty">Nog geen personeel</div>');
}

/* ----- Aanvragen ----- */
function aReqRow(x, soort) {
  const titel = soort === 'verlof' ? esc(x.type) + ' · ' + nlDate(x.van) + ' → ' + nlDate(x.tot)
    : esc(x.omschrijving) + (x.maat ? ' · maat ' + esc(x.maat) : '') + ' (' + esc(x.aantal) + 'x) · ' + esc(x.categorie);
  const meta = soort === 'verlof' ? esc(x.opmerking || '—') : esc(x.urgentie) + (x.motivatie ? ' · ' + esc(x.motivatie) : '');
  let h = '<div class="req"><div class="top"><span class="who">' + esc(medNaam(x.medewerker_id)) + '</span><span class="tag ' + tagc(x.status) + '">' + esc(x.status) + '</span></div>' +
    '<div>' + titel + '</div><div class="meta">' + meta + '</div>';
  if (x.status === 'Geweigerd' && x.weiger_reden) h += '<div class="meta" style="color:#ff7b7b;margin-top:4px">Reden: ' + esc(x.weiger_reden) + '</div>';
  if (x.status === 'In behandeling') {
    h += '<div class="acts"><button class="btn ok" onclick="aBeslis(\'' + soort + '\',\'' + esc(x.id) + '\',\'Goedgekeurd\')">Goedkeuren</button>' +
      '<button class="btn no" onclick="' + (soort === 'verlof' ? 'aReden(\'' + soort + '\',\'' + esc(x.id) + '\')' : 'aBeslis(\'' + soort + '\',\'' + esc(x.id) + '\',\'Geweigerd\')') + '">Weigeren</button></div>';
  }
  return h + '</div>';
}
function aReqList(soort) {
  const l = (soort === 'verlof' ? B.vl : B.mat).slice().sort((a, b) => {
    const pa = a.status === 'In behandeling' ? 0 : 1, pb = b.status === 'In behandeling' ? 0 : 1;
    return pa !== pb ? pa - pb : (a.created_at < b.created_at ? 1 : -1);
  });
  return l.length ? l.map(x => aReqRow(x, soort)).join('') : '<div class="empty">Geen aanvragen</div>';
}
async function aBeslis(soort, id, status, reden) {
  const tbl = soort === 'verlof' ? 'verlof' : 'materiaal';
  const upd = { status, beslist_door: B.info.user_id, beslist_op: new Date().toISOString(), gezien_door_beheer: true, gezien_door_werknemer: false };
  if (status === 'Geweigerd' && reden) upd.weiger_reden = reden;
  const r = await sb.from(tbl).update(upd).eq('id', id);
  if (r.error) return toast(errTxt(r.error), true);
  toast('Aanvraag ' + status.toLowerCase()); await aRefresh();
}
function aReden(soort, id) {
  openSheet('<h3>Reden van weigering</h3><div class="field"><label>Reden</label><textarea id="rdn" placeholder="Leg uit waarom dit verlof geweigerd wordt"></textarea></div>' +
    '<div class="err" id="rerr"></div><div class="btns"><button class="btn" onclick="closeSheet()">Annuleren</button>' +
    '<button class="btn no" onclick="aRedenOk(\'' + soort + '\',\'' + id + '\')">Weigeren</button></div>');
}
async function aRedenOk(soort, id) {
  const v = $('#rdn').value.trim();
  if (!v) { $('#rerr').textContent = 'Een reden is verplicht'; return; }
  closeSheet(); await aBeslis(soort, id, 'Geweigerd', v);
}
Object.assign(window, { aBeslis, aReden, aRedenOk });

/* ----- Werknemerdetail ----- */
function aEmp(id) { B.emp = id; B.empDate = today(); B.empSub = 'pointages'; aRender(); }
function aEmpView() {
  const m = B.med.filter(x => x.id === B.emp)[0]; if (!m) return '<div class="empty">Niet gevonden</div>';
  let h = '<button class="back" onclick="B.emp=null;aRender()">← Terug</button><h2 style="margin-bottom:10px">' + esc(m.naam) + '</h2>';
  if (m.geblokkeerd) h += '<div class="card" style="border-color:#ff7b7b;margin-bottom:12px"><div style="font-weight:800;color:#ff7b7b">Account geblokkeerd</div>' +
    '<div class="muted" style="margin:4px 0 12px">Na 3 verkeerde pincodes.</div><button class="btn primary block" onclick="aDeblok(\'' + esc(m.id) + '\')">Deblokkeren</button></div>';
  const info = [['Functie', m.functie], ['Type', m.type], ['Contract', m.contracttype ? m.contracttype + ' · ' + m.uren_per_week + ' u/week' : ''],
    ['Geboortedatum', m.geboortedatum], ['Telefoon', m.telefoon], ['E-mail', m.email], ['Adres', m.adres]].filter(r => r[1]);
  if (info.length) h += '<div class="card" style="margin-bottom:12px">' + info.map(r => '<div style="display:flex;justify-content:space-between;gap:10px;font-size:14px;padding:3px 0"><span class="muted">' +
    r[0] + '</span><span style="text-align:right">' + esc(r[1]) + '</span></div>').join('') + '</div>';
  h += '<div class="btns" style="margin-bottom:6px"><button class="btn small" onclick="aPinWijzig(\'' + esc(m.id) + '\')">Pincode wijzigen</button>' +
    '<button class="btn small" onclick="aNieuwePrik(\'' + esc(m.id) + '\')">+ Vergeten prik toevoegen</button></div>';
  let strip = '', d = addDays(today(), -5);
  for (let i = 0; i < 11; i++) {
    const dd = new Date(d + 'T12:00:00');
    strip += '<button class="daybtn' + (d === B.empDate ? ' on' : '') + '" onclick="B.empDate=\'' + d + '\';aRender()"><div class="w">' + DAGEN[dd.getDay()] + '</div><div class="d">' + dd.getDate() + '</div></button>';
    d = addDays(d, 1);
  }
  h += '<div class="daystrip">' + strip + '</div><div class="seg">' + ['pointages', 'verlof', 'materiaal'].map(s =>
    '<button class="' + (B.empSub === s ? 'on' : '') + '" onclick="B.empSub=\'' + s + '\';aRender()">' + s[0].toUpperCase() + s.slice(1) + '</button>').join('') + '</div>';
  if (B.empSub === 'pointages') {
    const p = B.pt.filter(x => x.medewerker_id === m.id && dayKey(x.in_ts) === B.empDate).sort((a, b) => (a.in_ts > b.in_ts ? 1 : -1));
    const tot = p.reduce((s, x) => s + sessMs(x), 0), ot = Math.max(0, tot - DAG_LIMIET), an = p.some(isAnom);
    h += p.length ? '<div class="row' + (an ? ' warn' : ' hl') + '"><div><div class="l">Totaal ' + nlDate(B.empDate) + '</div>' + (ot ? '<div class="s" style="color:#ff7b7b">+ ' + dur(ot) + ' overuren (> 8u/dag)</div>' : '') +
      (an ? '<div class="s" style="color:#ff9900">Telt niet mee tot gevalideerd</div>' : '') + '</div><div class="r">' + dur(tot) + '</div></div>' +
      p.map(x => '<div class="row"><div><div class="l">' + hm(x.in_ts) + ' → ' + (x.uit_ts ? hm(x.uit_ts) : (isAnom(x) ? '⚠️ niet uitgeklokt' : 'nog bezig')) + '</div><div class="s">' +
        (x.gecorrigeerd ? 'gecorrigeerd' + (x.correctie_notitie ? ': ' + esc(x.correctie_notitie) : '') : 'sessie') + '</div></div><div class="r">' + (isAnom(x) ? 'Te valideren' : dur(sessMs(x))) +
        '</div><button class="btn small" onclick="aCorrectie(\'' + esc(x.id) + '\')">Corrigeren</button></div>').join('')
      : '<div class="empty">Geen pointages op ' + nlDate(B.empDate) + '</div>';
    const mon = weekMonday(B.empDate); let wk = 0;
    for (let i = 0; i < 7; i++) B.pt.filter(x => x.medewerker_id === m.id && dayKey(x.in_ts) === addDays(mon, i)).forEach(x => { wk += sessMs(x); });
    const wot = Math.max(0, wk - WEEK_LIMIET);
    h += '<h2 class="sec">Weektotaal</h2><div class="row' + (wot ? ' warn' : '') + '"><div><div class="l">Week van ' + weekLabel(mon) + '</div><div class="s">Contract 38u/week' +
      (wot ? ' · <span style="color:#ff7b7b">+ ' + dur(wot) + ' overuren</span>' : '') + '</div></div><div class="r">' + dur(wk) + '</div></div>';
  } else {
    const l = (B.empSub === 'verlof' ? B.vl : B.mat).filter(x => x.medewerker_id === m.id);
    h += l.length ? l.map(x => aReqRow(x, B.empSub)).join('') : '<div class="empty">Geen aanvragen</div>';
  }
  return h;
}
window.B = B; window.aRender = aRender; window.aEmp = aEmp;

async function aDeblok(id) {
  try { await rpc('beheer_deblokkeren', { p_medewerker: id }); toast('Gedeblokkeerd'); await aRefresh(); } catch (e) { toast(errTxt(e), true); }
}
function aPinWijzig(id) {
  openSheet('<h3>Pincode wijzigen</h3><div class="field"><label>Nieuwe pincode (4 cijfers)</label><input id="np" type="tel" inputmode="numeric" maxlength="4"></div>' +
    '<div class="err" id="perr2"></div><div class="btns"><button class="btn" onclick="closeSheet()">Annuleren</button><button class="btn primary" onclick="aPinOk(\'' + id + '\')">Opslaan</button></div>');
}
async function aPinOk(id) {
  const p = $('#np').value.trim();
  if (!/^\d{4}$/.test(p)) { $('#perr2').textContent = 'Pincode moet uit 4 cijfers bestaan'; return; }
  try { await rpc('beheer_pin_wijzigen', { p_medewerker: id, p_pin: p }); closeSheet(); toast('Pincode gewijzigd'); await aRefresh(); } catch (e) { $('#perr2').textContent = errTxt(e); }
}
function tijdOpDag(dag, tijd) { return new Date(dag + 'T' + tijd + ':00').toISOString(); }
function aCorrectie(id) {
  const p = B.pt.filter(x => x.id === id)[0]; if (!p) return;
  openSheet('<h3>Pointage corrigeren</h3><div class="muted" style="margin-bottom:12px">' + esc(medNaam(p.medewerker_id)) + ' · ' + nlDate(dayKey(p.in_ts)) + '</div>' +
    '<div class="field"><label>Ingeklokt</label><input type="time" id="ci" value="' + hm(p.in_ts) + '"></div>' +
    '<div class="field"><label>Uitgeklokt</label><input type="time" id="cu" value="' + (p.uit_ts ? hm(p.uit_ts) : '') + '"></div>' +
    '<div class="field"><label>Reden van de correctie (verplicht)</label><textarea id="cn" placeholder="bv. vergat uit te klokken"></textarea></div>' +
    '<div class="err" id="cerr"></div><div class="btns"><button class="btn" onclick="closeSheet()">Annuleren</button><button class="btn primary" onclick="aCorrOk(\'' + id + '\')">Opslaan</button></div>');
}
async function aCorrOk(id) {
  const p = B.pt.filter(x => x.id === id)[0], ti = $('#ci').value, tu = $('#cu').value, n = $('#cn').value.trim(), dag = dayKey(p.in_ts);
  if (!ti) { $('#cerr').textContent = 'Vul de inkloktijd in'; return; }
  if (!n) { $('#cerr').textContent = 'Een reden is verplicht'; return; }
  const upd = { in_ts: tijdOpDag(dag, ti), uit_ts: tu ? tijdOpDag(dag, tu) : null, gecorrigeerd: true, gecorrigeerd_door: B.info.user_id, correctie_notitie: n };
  if (upd.uit_ts && upd.uit_ts <= upd.in_ts) { $('#cerr').textContent = 'Uitkloktijd moet na de inkloktijd liggen'; return; }
  const r = await sb.from('pointages').update(upd).eq('id', id);
  if (r.error) { $('#cerr').textContent = errTxt(r.error); return; }
  closeSheet(); toast('Pointage gecorrigeerd'); await aRefresh();
}
function aNieuwePrik(medId) {
  openSheet('<h3>Vergeten prik toevoegen</h3><div class="muted" style="margin-bottom:12px">' + esc(medNaam(medId)) + '</div>' +
    '<div class="field"><label>Datum</label><input type="date" id="nd" value="' + B.empDate + '" max="' + today() + '"></div>' +
    '<div class="field"><label>Ingeklokt</label><input type="time" id="ni"></div><div class="field"><label>Uitgeklokt</label><input type="time" id="nu"></div>' +
    '<div class="field"><label>Reden (verplicht)</label><textarea id="nn"></textarea></div><div class="err" id="nerr"></div>' +
    '<div class="btns"><button class="btn" onclick="closeSheet()">Annuleren</button><button class="btn primary" onclick="aPrikOk(\'' + medId + '\')">Toevoegen</button></div>');
}
async function aPrikOk(medId) {
  const d = $('#nd').value, ti = $('#ni').value, tu = $('#nu').value, n = $('#nn').value.trim();
  if (!d || !ti || !tu) { $('#nerr').textContent = 'Vul datum, in- en uitkloktijd in'; return; }
  if (!n) { $('#nerr').textContent = 'Een reden is verplicht'; return; }
  const a = tijdOpDag(d, ti), b = tijdOpDag(d, tu);
  if (b <= a) { $('#nerr').textContent = 'Uitkloktijd moet na de inkloktijd liggen'; return; }
  const r = await sb.from('pointages').insert({ centre_id: B.info.centre_id, medewerker_id: medId, in_ts: a, uit_ts: b, gecorrigeerd: true,
    gecorrigeerd_door: B.info.user_id, correctie_notitie: n });
  if (r.error) { $('#nerr').textContent = errTxt(r.error); return; }
  closeSheet(); toast('Pointage toegevoegd'); await aRefresh();
}
Object.assign(window, { aDeblok, aPinWijzig, aPinOk, aCorrectie, aCorrOk, aNieuwePrik, aPrikOk });

/* ----- Nieuwe werknemer ----- */
function aNieuwMed() {
  const nxt = String(B.med.reduce((mx, m) => Math.max(mx, parseInt(m.stamnummer, 10) || 0), 0) + 1).padStart(3, '0');
  openSheet('<h3>Werknemer toevoegen</h3>' +
    '<div class="field"><label>Type</label><select id="nT"><option>Arbeider</option><option>Bediende</option></select></div>' +
    '<div class="field"><label>Functie</label><input id="nF" placeholder="bv. Mecanicien, Onthaal"></div>' +
    '<div class="field"><label>Naam</label><input id="nN" placeholder="Voor- en achternaam"></div>' +
    '<div class="field"><label>Stamnummer</label><input id="nS" value="' + nxt + '"></div>' +
    '<div class="field"><label>Geboortedatum</label><input type="date" id="nG"></div>' +
    '<div class="field"><label>Adres</label><input id="nA"></div><div class="field"><label>Telefoon</label><input id="nP" type="tel"></div>' +
    '<div class="field"><label>E-mail</label><input id="nE" type="email"></div>' +
    '<div class="field"><label>Contract</label><select id="nC" onchange="document.getElementById(\'nUW\').classList.toggle(\'hidden\',this.value!==\'Andere\')">' +
    '<option>Voltijds</option><option>Halftijds</option><option>Andere</option></select></div>' +
    '<div class="field hidden" id="nUW"><label>Uren / week</label><input id="nU" type="number" min="1" max="60"></div>' +
    '<div class="field"><label>Pincode (4 cijfers)</label><input id="nPin" type="tel" inputmode="numeric" maxlength="4"></div><div class="err" id="nerr2"></div>' +
    '<div class="btns"><button class="btn" onclick="closeSheet()">Annuleren</button><button class="btn primary" onclick="aMedOk()">Toevoegen</button></div>');
}
async function aMedOk() {
  const naam = $('#nN').value.trim(), stam = $('#nS').value.trim(), pin = $('#nPin').value.trim(), c = $('#nC').value;
  if (!naam || !stam || !pin) { $('#nerr2').textContent = 'Naam, stamnummer en pincode zijn verplicht'; return; }
  if (!/^\d{4}$/.test(pin)) { $('#nerr2').textContent = 'Pincode moet uit 4 cijfers bestaan'; return; }
  const uren = c === 'Voltijds' ? 38 : c === 'Halftijds' ? 19 : parseFloat($('#nU').value) || 38;
  try {
    await rpc('beheer_medewerker_toevoegen', { p_stamnummer: stam, p_naam: naam, p_pin: pin, p_functie: $('#nF').value.trim() || null, p_type: $('#nT').value,
      p_geboortedatum: $('#nG').value || null, p_adres: $('#nA').value.trim() || null, p_telefoon: $('#nP').value.trim() || null,
      p_email: $('#nE').value.trim() || null, p_contracttype: c, p_uren: uren });
    closeSheet(); toast('Werknemer toegevoegd'); await aRefresh();
  } catch (e) { $('#nerr2').textContent = errTxt(e).indexOf('duplicate') >= 0 ? 'Dit stamnummer bestaat al' : errTxt(e); }
}
Object.assign(window, { aNieuwMed, aMedOk });

/* ----- Te valideren (vergeten uit te klokken) ----- */
function aValideren() {
  const l = anomalies();
  if (!l.length) return '<div class="empty">Geen anomalieën — alle pointages zijn in orde</div>';
  return '<p class="muted" style="font-size:13px;margin:6px 0 14px">Deze dagen tellen niet mee in uren of overuren tot ze hier gevalideerd zijn.</p>' +
    l.map(p => '<div class="req"><div class="top"><span class="who">' + esc(medNaam(p.medewerker_id)) + '</span><span class="tag a">Niet uitgeklokt</span></div>' +
      '<div>' + nlDate(dayKey(p.in_ts)) + ' · ingeklokt om ' + hm(p.in_ts) + '</div><div class="field" style="margin:10px 0 0"><label>Echte uitkloktijd</label><input type="time" id="an-' + esc(p.id) + '"></div>' +
      '<div class="acts"><button class="btn ok" onclick="aValOk(\'' + esc(p.id) + '\',false)">Bevestigen</button>' +
      '<button class="btn no" onclick="aValOk(\'' + esc(p.id) + '\',true)">Onbekend · sluit af 23:59</button></div></div>').join('');
}
async function aValOk(id, onbekend) {
  const p = B.pt.filter(x => x.id === id)[0]; if (!p) return;
  const dag = dayKey(p.in_ts), t = onbekend ? '23:59' : ($('#an-' + id).value || '');
  if (!t) return toast('Vul een uitkloktijd in', true);
  const uit = tijdOpDag(dag, t);
  if (uit <= p.in_ts) return toast('Uitkloktijd moet na de inkloktijd liggen', true);
  const r = await sb.from('pointages').update({ uit_ts: uit, gecorrigeerd: true, gecorrigeerd_door: B.info.user_id,
    correctie_notitie: onbekend ? 'onbekend eindtijdstip, afgesloten om 23:59' : 'uitkloktijd bevestigd door beheerder' }).eq('id', id);
  if (r.error) return toast(errTxt(r.error), true);
  toast(onbekend ? 'Dag afgesloten om 23:59' : 'Pointage gevalideerd'); await aRefresh();
}
window.aValOk = aValOk;

/* ----- Export (xlsx) ----- */
function lastMonths(n) {
  const out = []; const d = new Date();
  for (let i = 0; i < n; i++) { out.push({ v: d.getFullYear() + '-' + pad(d.getMonth() + 1), l: d.toLocaleDateString('nl-BE', { month: 'long', year: 'numeric' }) }); d.setMonth(d.getMonth() - 1, 1); }
  return out;
}
function aExport() {
  return '<div class="card"><div class="field"><label>Maand</label><select id="xm">' + lastMonths(6).map(m => '<option value="' + m.v + '">' + esc(m.l) + '</option>').join('') + '</select></div>' +
    '<div class="field"><label>Werknemer</label><select id="xe"><option value="all">Alle personeel</option>' + B.med.map(m => '<option value="' + esc(m.id) + '">' + esc(m.naam) + '</option>').join('') + '</select></div>' +
    '<button class="btn primary block" onclick="aXlsx()">Exporteer .xlsx</button></div>';
}
function loadXlsx() {
  return new Promise((res, rej) => {
    if (window.XLSX) return res();
    const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    s.onload = res; s.onerror = rej; document.head.appendChild(s);
  });
}
async function aXlsx() {
  const m = $('#xm').value, e = $('#xe').value, rows = [];
  (e === 'all' ? B.med : B.med.filter(x => x.id === e)).forEach(w => {
    B.pt.filter(p => p.medewerker_id === w.id && dayKey(p.in_ts).indexOf(m) === 0).sort((a, b) => (a.in_ts > b.in_ts ? 1 : -1)).forEach(p => {
      rows.push({ Stamnummer: w.stamnummer, Naam: w.naam, Datum: dayKey(p.in_ts), In: hm(p.in_ts), Uit: p.uit_ts ? hm(p.uit_ts) : '',
        Uren: Math.round(sessMs(p) / 36000) / 100, Status: isAnom(p) ? 'Niet gevalideerd' : (p.gecorrigeerd ? 'Gecorrigeerd' : 'OK'), Opmerking: p.correctie_notitie || '' });
    });
  });
  if (!rows.length) return toast('Geen pointages voor deze selectie', true);
  try { await loadXlsx(); } catch (er) { return toast('Exportmodule niet geladen, probeer opnieuw', true); }
  const ws = XLSX.utils.json_to_sheet(rows), wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Pointages'); XLSX.writeFile(wb, 'Pointages_' + m + (e === 'all' ? '' : '_' + e) + '.xlsx'); toast('Export gestart');
}
window.aXlsx = aXlsx;

/* ----- Toestel (prikstation) ----- */
function aToestel() {
  const mine = !!getDevice();
  return '<div class="card"><div class="row' + (mine ? ' hl' : '') + '"><div><div class="l">' + (mine ? '🟢 Dit toestel is een prikstation' : '⚪ Dit toestel is geen prikstation') + '</div><div class="s">' +
    (mine ? 'Werknemers kunnen hier in- en uitklokken.' : 'Hier kan niet in- of uitgeklokt worden.') + '</div></div></div>' +
    '<p class="muted" style="font-size:13px;line-height:1.55;margin:12px 0">Activeer dit enkel op de tablet aan het vestiaire of de vaste pc in de garage — nooit op een toestel dat thuis of onderweg gebruikt wordt. ' +
    'Zo kan het prikken niet op afstand vervalst worden. Verlof- en materiaalaanvragen blijven overal beschikbaar.</p>' +
    (mine ? '<button class="btn block" onclick="aToestelLos()">Prikstation uitschakelen op dit toestel</button>'
      : '<button class="btn primary block" onclick="aToestelNieuw()">Dit toestel registreren als prikstation</button>') + '</div>' +
    '<h2 class="sec">Geregistreerde prikstations</h2>' +
    (B.dev.length ? B.dev.map(d => '<div class="row"><div><div class="l">' + esc(d.naam) + '</div><div class="s">sinds ' + nlDate(dayKey(d.created_at)) + '</div></div><span class="r">' +
      (d.actief ? '<button class="btn small no" onclick="aToestelIntrek(\'' + esc(d.id) + '\')">Intrekken</button>' : '<span class="tag no">Ingetrokken</span>') + '</span></div>').join('')
      : '<div class="empty">Nog geen prikstation geregistreerd</div>');
}
function aToestelNieuw() {
  openSheet('<h3>Prikstation registreren</h3><div class="field"><label>Naam van dit toestel</label><input id="tn" value="Tablet vestiaire"></div>' +
    '<div class="err" id="terr"></div><div class="btns"><button class="btn" onclick="closeSheet()">Annuleren</button><button class="btn primary" onclick="aToestelOk()">Registreren</button></div>');
}
async function aToestelOk() {
  const n = $('#tn').value.trim(); if (!n) { $('#terr').textContent = 'Geef het toestel een naam'; return; }
  try { const t = await rpc('beheer_toestel_registreren', { p_naam: n }); setDevice(t); closeSheet(); toast('Prikstation geregistreerd'); await aRefresh(); }
  catch (e) { $('#terr').textContent = errTxt(e); }
}
function aToestelLos() { setDevice(''); toast('Prikstation uitgeschakeld op dit toestel. Trek het ook in de lijst in.'); aRender(); }
async function aToestelIntrek(id) {
  try { await rpc('beheer_toestel_intrekken', { p_toestel: id }); toast('Toestel ingetrokken'); await aRefresh(); } catch (e) { toast(errTxt(e), true); }
}
Object.assign(window, { aToestelNieuw, aToestelOk, aToestelLos, aToestelIntrek });

/* ----- Journaal ----- */
function aJournaal() {
  const wie = id => id ? ((B.beh.filter(b => b.user_id === id)[0] || {}).naam || 'beheerder') : 'systeem / medewerker';
  const acties = { INSERT: 'aangemaakt', UPDATE: 'gewijzigd', DELETE: 'verwijderd' };
  return '<p class="muted" style="font-size:13px;margin:6px 0 12px">Laatste 200 wijzigingen. Niemand kan deze lijst aanpassen.</p><div class="card" style="padding:6px 12px;overflow-x:auto">' +
    '<table class="log"><tr><th>Wanneer</th><th>Wie</th><th>Wat</th></tr>' + B.aud.map(a => '<tr><td>' + nlDate(dayKey(a.ts)) + ' ' + hm(a.ts) + '</td><td>' + esc(wie(a.door)) +
      '</td><td>' + esc(a.tabel) + ' ' + esc(acties[a.actie] || a.actie) + '</td></tr>').join('') + '</table></div>';
}

/* =====================================================================
   ROUTER
   ===================================================================== */
function route() {
  closeSheet();
  P.cb = null;
  if (location.hash.startsWith('#/beheer')) { kStop(); aStart(); }
  else { aStop(); if (K.sessie) kMenu(); else kLogin(); }
}
window.addEventListener('hashchange', route);
route();
