/* Steal a Papu - servidor de cuentas y progreso (Vercel Function, sin dependencias) */
const crypto = require('crypto');

const DB_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const DB_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const SECRET = process.env.SECRET || '';
const ADMIN_USER = process.env.ADMIN_USER || '';
const ADMIN_PASS = process.env.ADMIN_PASS || '';

/* mismos valores que el juego: nivel -> ingreso por segundo y precio */
const INC = [.25, 1.25, 3, 6, 12.5, 2.5, 10, 1375, 5500, 10000, 40000, 175, 700, 19, 75, 150000, 625000];
const PRICE = [0, 0, 0, 0, 0, 50, 200, 60000, 240000, 600000, 2400000, 6000, 24000, 500, 2000, 15000000, 100000000];
/* evento en vivo: Papu Golden Time (el admin lo inicia; los jugadores lo reciben al sincronizar) */
const EV_MS = 120000;
/* estado de eventos para los jugadores: Golden Time, Papus invocados por el admin y la hora del servidor */
async function evInfo() {
  const [gt, sm, cl, rm, am0] = (await db('MGET', 'ev:gt', 'ev:sm', 'srv:closed', 'rm', 'ev:msg')) || [];
  const now = Date.now(), left = gt ? +gt - now : 0;
  let list = []; try { list = sm ? JSON.parse(sm) : []; } catch (e) { list = []; }
  return { ev: left > 0 ? left : 0, sm: list.filter(m => now - m.ts < 30000).map(m => ({ id: m.id, lvl: m.lvl, age: now - m.ts })), now, closed: !!cl, rc: rm || null, am: amView(am0, now) };   /* rc = código de la sala activa (lo decide el servidor) */
}
/* mensaje del admin en pantalla: vive solo mientras dura (+4 s de margen); viaja en la misma consulta de siempre, sin comandos extra */
function amView(v, now) { if (!v) return null; try { const m = JSON.parse(v), age = now - m.ts; return age < m.secs * 1000 + 4000 ? { id: m.id, text: m.text, secs: m.secs, age } : null; } catch (e) { return null; } }
async function evLeft() { const v = await db('GET', 'ev:gt'); const left = v ? +v - Date.now() : 0; return left > 0 ? left : 0; }
/* decoracion de bases: 1-10 colores de estructura (de barato a caro), 11 = efecto Papu Fuego */
const DPRICE = [0, 2500000, 56000000, 1600000000, 3200000000, 5900000000, 12000000000, 320000000000, 28000000000, 47000000000, 90000000000, 2200000000000];
/* pisos de la base: se empieza con 1 (10 espacios) y se pueden comprar hasta 5; precio del piso numero n */
/* BASE 001 (guardada): Papus nuevos 17..51, mismos valores que el cliente. Solo el admin puede invocarlos en la cinta. */
[[5, 10], [5, 25], [7, 10], [7, 25], [9, 10], [9, 25], [11, 10], [11, 25], [13, 10], [13, 25]].forEach(([b, m]) => { INC.push(INC[b] * m); PRICE.push(PRICE[b] * m); });
INC.push(INC[16] * 10); PRICE.push(PRICE[16] * 10);
[[18, 1000], [26, 1700], [35, 2500], [600, 650000], [2100, 3600000], [4000, 7200000]].forEach(([i, p]) => [1, 4, 10, 25].forEach(m => { INC.push(i * m); PRICE.push(p * m); }));
const MAXLVL = INC.length - 1;
/* BASE 001 ACTIVA: ingresos y precios finales de los Papus 5..51 (mismos valores que el cliente) */
const B1_INC = [2500, 10000, 250000, 1000000, 1500000, 6000000, 80000, 320000, 12000, 48000, 120000000, 500000000, 25000, 62500, 2500000, 6250000, 15000000, 37500000, 800000, 2000000, 120000, 300000, 5000000000, 18000, 72000, 180000, 450000, 26000, 104000, 260000, 650000, 35000, 140000, 350000, 875000, 600000, 2400000, 6000000, 15000000, 2100000, 8400000, 21000000, 52500000, 4000000, 16000000, 40000000, 100000000], B1_PR = [50000, 200000, 180000000, 720000000, 2400000000, 9600000000, 9000000, 36000000, 500000, 2000000, 120000000000, 500000000000, 500000, 1250000, 1800000000, 4500000000, 24000000000, 60000000000, 90000000, 225000000, 5000000, 12500000, 2000000000000, 1000000, 4000000, 10000000, 25000000, 1700000, 6800000, 17000000, 42500000, 2500000, 10000000, 25000000, 62500000, 650000000, 2600000000, 6500000000, 16250000000, 3600000000, 14400000000, 36000000000, 90000000000, 7200000000, 28800000000, 72000000000, 180000000000];
B1_INC.forEach((v, i) => { INC[5 + i] = v; PRICE[5 + i] = B1_PR[i]; });
/* Rebirth: dinero, multiplicador y Papus (nivel del Papu, cantidad) que debes tener en tu base. Reiniciar todo menos lo exclusivo */
const REB = [{"n": 1, "money": 5000000000, "mult": 1.5, "papus": [[29, 1]]}, {"n": 2, "money": 30000000000, "mult": 2, "papus": [[37, 1], [12, 1]]}, {"n": 3, "money": 600000000000, "mult": 2.5, "papus": [[41, 1], [8, 1]]}, {"n": 4, "money": 10000000000000, "mult": 3, "papus": [[19, 1], [34, 1]]}, {"n": 5, "money": 50000000000000, "mult": 3.5, "papus": [[21, 1], [42, 1], [31, 1]]}, {"n": 6, "money": 150000000000000, "mult": 4, "papus": [[46, 2], [35, 1]]}, {"n": 7, "money": 450000000000000, "mult": 4.5, "papus": [[50, 1], [22, 1], [43, 1], [46, 1]]}, {"n": 8, "money": 1200000000000000, "mult": 5, "papus": [[47, 2], [16, 1]]}, {"n": 9, "money": 3000000000000000, "mult": 5.5, "papus": [[51, 1], [22, 1], [47, 1], [16, 2]]}, {"n": 10, "money": 8000000000000000, "mult": 6, "papus": [[51, 2], [16, 2], [27, 1], [47, 1]]}];
const REBM = [1].concat(REB.map(x => x.mult));
/* SALA ACTIVA: el servidor guarda el código de la sala (clave 'rm', caduca en 35 s si el anfitrión no la renueva). Así nunca hay dos salas ni una sala fantasma. */
/* la sala está 'viva' si su anfitrión la renovó hace menos de ~25 s; el admin solo puede reemplazar una sala MUERTA, nunca una sala con gente jugando */
const RM_TTL = 50, RM_STALE = 25000;
/* ---- Servidor de relevo (TURN) de Cloudflare: lo usan los jugadores que NO pueden conectarse directo (distinto WiFi/operador). Las claves van SOLO en variables de entorno de Vercel (CF_TURN_ID y CF_TURN_TOKEN); sin ellas el juego usa los relevos públicos de siempre ---- */
let _ice = null, _iceT = 0;
async function turnIce() {
  const id = process.env.CF_TURN_ID, tk = process.env.CF_TURN_TOKEN;
  if (!id || !tk) return null;
  if (_ice && Date.now() - _iceT < 3 * 3600 * 1000) return _ice;   /* se reutiliza 3 h: casi nunca llama a Cloudflare */
  try {
    const ac = new AbortController(), to = setTimeout(() => ac.abort(), 2500);
    const r = await fetch('https://rtc.live.cloudflare.com/v1/turn/keys/' + encodeURIComponent(id) + '/credentials/generate', { method: 'POST', headers: { Authorization: 'Bearer ' + tk, 'Content-Type': 'application/json' }, body: JSON.stringify({ ttl: 86400 }), signal: ac.signal });
    clearTimeout(to);
    const j = await r.json(), ic = j && j.iceServers;
    if (ic) { _ice = Array.isArray(ic) ? ic : [ic]; _iceT = Date.now(); return _ice; }
  } catch (e) {}
  return _ice;
}
async function rmDead() { const t = await db('PTTL', 'rm'); return !(t > RM_STALE); }
const okCode = c => typeof c === 'string' && /^[A-Za-z0-9]{3,16}$/.test(c);
/* versión del cliente: si una pestaña vieja (otra versión) sigue abierta, se le pide recargar para que nunca haya dos versiones jugando en salas distintas */
const CV = 5;
const FPRICE = [0, 0, 9600000000, 46000000000, 220000000000, 1420000000000], MAXF = 5, SLOTF = 10;
const OPRICE = { bat: 870000000, push: 1740000000, dance: 2999999967000, freddy: 5999999934000 }, MAXM = 1e27, START = 50000, NSLOT = 50, NSKIN = 12, TOKEN_DAYS = 30, MAX_DT = 25000;

async function db(...cmd) {
  const r = await fetch(DB_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + DB_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}
const ukey = u => 'u:' + u.toLowerCase();
const emptySlots = () => Array(NSLOT).fill(-1);
/* EXCLUSIVO: objetos que NUNCA se pierden al reiniciar progreso ni al hacer Rebirth (misma lista que el cliente) */
const EXCLUSIVO = ['dance', 'freddy'];
/* reinicio de progreso a cero (reiniciar cuenta o Rebirth): conserva siempre los objetos exclusivos */
function resetProgress(r) {
  const keep = (Array.isArray(r.inv) ? r.inv : []).filter(i => EXCLUSIVO.includes(i));
  r.slots = emptySlots(); r.fl = 1; r.dco = { o: [], c: 0, f: 0 }; r.inv = keep; r.held = -1; r.hpaid = 0; r.money = START; r.t = Date.now();
}
/* mult de Rebirth: nivel r.rb (0..10) */
const rbMult = r => REBM[Math.max(0, Math.min(10, r.rb | 0))] || 1;

/* ---- cifrado reversible de la contraseña (el admin puede verla; la base de datos sola no la revela) ---- */
const aesKey = () => crypto.createHash('sha256').update('pw:' + SECRET).digest();
function encPass(p) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', aesKey(), iv);
  const ct = Buffer.concat([c.update(p, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), ct].map(b => b.toString('base64')).join('.');
}
function decPass(s) {
  try {
    const [iv, tag, ct] = s.split('.').map(x => Buffer.from(x, 'base64'));
    const d = crypto.createDecipheriv('aes-256-gcm', aesKey(), iv); d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  } catch (e) { return '(no se pudo leer)'; }
}
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

/* ---- sesiones firmadas ---- */
const b64u = b => Buffer.from(b).toString('base64url');
function signTok(o) {
  const body = b64u(JSON.stringify(o));
  return body + '.' + crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
}
function readTok(t) {
  try {
    const [body, sig] = String(t).split('.');
    const ok = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
    if (!safeEq(sig, ok)) return null;
    const o = JSON.parse(Buffer.from(body, 'base64url').toString());
    return o.exp > Date.now() ? o : null;
  } catch (e) { return null; }
}

class Err extends Error { constructor(msg, code) { super(msg); this.code = code || 'err'; } }

/* ---- ingresos: el servidor calcula el dinero, el cliente no puede inventarlo ---- */
function accrue(r, now) {
  const dms = Math.min(Math.max(now - (r.t || now), 0), MAX_DT), dt = dms / 1000;
  r.pt = (r.pt || 0) + dms;   /* tiempo jugado (ms), para la tabla de clasificación */
  let inc = 0; r.slots.forEach(l => { if (l >= 0) inc += INC[l] || 0; });
  r.money = Math.min(MAXM, r.money + inc * rbMult(r) * dt); r.t = now; r.seen = now; r.off = 0;
}
const view = r => ({ rb: r.rb | 0, nick: r.nick, skin: r.skin, money: Math.round(r.money * 100) / 100, slots: r.slots, aid: r.aid, held: r.held == null ? -1 : r.held, cat: r.cat || {}, deco: decoView(r), inv: Array.isArray(r.inv) ? r.inv : [], vol: r.vol || null, cmd: (r.cmd && Date.now() - r.cmd.ts < 90000) ? { id: r.cmd.id, on: r.cmd.on, age: Date.now() - r.cmd.ts } : null });
function decoView(r) { const d = r.dco || {}; return { o: Array.isArray(d.o) ? d.o : [], c: d.c | 0, f: d.f ? 1 : 0, n: r.fl || 1 }; }
/* catálogo (bitácora): primera vez que colocaste cada Papu en tu base. Los Papus que ya tenías puestos antes del catálogo se anotan una sola vez */
function touchCat(r) {
  if (!r.cat) r.cat = {};
  if (!r.catv) { r.catv = 1; const n = Date.now(); r.slots.forEach(l => { if (l >= 5 && !r.cat[l]) r.cat[l] = n; }); }
}
/* id público de cuenta (para robar): no revela el usuario ni la contraseña */
async function ensureAid(r) {
  if (!r.aid) { r.aid = crypto.randomBytes(6).toString('base64url'); }
  await db('SET', 'a:' + r.aid, r.user);
}
/* si te sales con un Papu en la mano no se guarda: se te devuelve lo que pagaste */
function settleHeld(r) {
  if (r.held != null && r.held >= 0) { r.money += r.hpaid || 0; }
  r.held = -1; r.hpaid = 0;
}
const isAdminUser = u => !!ADMIN_USER && String(u).toLowerCase() === ADMIN_USER.toLowerCase();
/* el admin tambien juega: tiene su propio registro de jugador (la contraseña real nunca se guarda ahi) */
async function adminRec() {
  let r = await loadRec(ADMIN_USER);
  if (r) return r;
  const now = Date.now();
  r = { user: ADMIN_USER, pass: encPass(crypto.randomBytes(12).toString('base64url')), nick: cleanNick('Admin'), skin: 0, money: START, slots: emptySlots(), held: -1, hpaid: 0, t: now, seen: now, created: now, sid: crypto.randomBytes(9).toString('base64url') };
  r.aid = crypto.randomBytes(6).toString('base64url');
  await db('SET', ukey(ADMIN_USER), JSON.stringify(r), 'NX');
  await db('SADD', 'users', ADMIN_USER.toLowerCase());
  return (await loadRec(ADMIN_USER)) || r;
}
async function loadRec(user) {
  const s = await db('GET', ukey(user));
  if (!s) return null;
  const r = JSON.parse(s);
  while (r.slots.length < NSLOT) r.slots.push(-1);   /* cuentas viejas tenian 10 espacios */
  return r;
}
const saveRec = r => db('SET', ukey(r.user), JSON.stringify(r));

async function userFromTok(tok) {
  const t = readTok(tok);
  if (!t || t.u === '*admin') throw new Err('Sesión no válida. Inicia sesión de nuevo.', 'auth');
  const r = await loadRec(t.u);
  if (!r) throw new Err('Esta cuenta ya no existe.', 'auth');
  if (r.sid !== t.sid) throw new Err('Tu cuenta se abrió en otro lugar.', 'auth');
  if (r.kk) { r.kk = 0; r.sid = crypto.randomBytes(9).toString('base64url'); r.kk = 0; await saveRec(r); throw new Err('Un administrador te expulsó de la partida.', 'auth'); }
  return r;
}
function adminFromTok(tok) {
  const t = readTok(tok);
  if (!t || !t.adm) throw new Err('No autorizado.', 'auth');
}

/* ---- freno contra adivinar contraseñas ---- */
async function guard(user) {
  const k = 'f:' + user.toLowerCase();
  const n = +(await db('GET', k)) || 0;
  if (n >= 8) throw new Err('Demasiados intentos. Espera unos minutos.', 'locked');
}
async function fail(user) {
  const k = 'f:' + user.toLowerCase();
  await db('INCR', k); await db('EXPIRE', k, 600);
}

const CLOSED_MSG = 'El servidor está cerrado por el administrador. Intenta más tarde.';
const isClosed = async () => !!(await db('GET', 'srv:closed'));
const checkUser = u => /^[A-Za-z0-9_]{3,16}$/.test(u);
const cleanNick = n => String(n || '').trim().replace(/\s+/g, ' ').slice(0, 14);

/* ---- TABLA DE CLASIFICACIÓN: un solo registro 'lb' con el top 5 de cada categoría (m dinero, p tiempo jugado en s, s robos).
   Se actualiza dentro del sync que ya existe (sin peticiones nuevas) y se lee una sola vez al abrir la tabla ---- */
const LBN = 5;
function lbApply(lb, r) {
  if (!r.aid) return false;   /* el admin también aparece en la tabla */
  const vals = { m: Math.floor(r.money), p: Math.floor((r.pt || 0) / 1000), s: r.sc | 0, r: r.rb | 0 };
  let structural = false, changed = false;
  for (const k of ['m', 'p', 's', 'r']) {
    const a = lb[k] || (lb[k] = []), v = vals[k], before = a.map(e => e[0]).join();
    const i = a.findIndex(e => e[0] === r.aid);
    /* el admin solo aparece en dinero; la cuenta de pruebas (usuario 1234) no aparece en ninguna tabla */
    if (String(r.user) === '1234' || (k !== 'm' && isAdminUser(r.user))) { if (i >= 0) { a.splice(i, 1); changed = true; } if (a.map(e => e[0]).join() !== before) structural = true; continue; }
    if (i >= 0) { if (v <= 0) { a.splice(i, 1); changed = true; } else if (a[i][2] !== v || a[i][1] !== r.nick) { a[i][2] = v; a[i][1] = r.nick; changed = true; } }
    else if (v > 0 && (a.length < LBN || v > a[a.length - 1][2])) { a.push([r.aid, r.nick, v]); changed = true; }
    a.sort((x, y) => y[2] - x[2]); if (a.length > LBN) a.length = LBN;
    if (a.map(e => e[0]).join() !== before) structural = true;
  }
  return changed ? (structural ? 2 : 1) : 0;   /* 2 = cambió el puesto de alguien, 1 = solo cambiaron números */
}
const lbParse = s => { try { const o = s ? JSON.parse(s) : {}; return { m: o.m || [], p: o.p || [], s: o.s || [], r: o.r || [], t: o.t || 0 }; } catch (e) { return { m: [], p: [], s: [], r: [], t: 0 }; } };

const actions = {
  async register(b) {
    if (await isClosed()) throw new Err(CLOSED_MSG, 'closed');
    const user = String(b.user || '').trim(), pass = String(b.pass || ''), nick = cleanNick(b.nick);
    if (!checkUser(user)) throw new Err('Usuario: de 3 a 16 letras, números o _ (sin espacios).');
    if (pass.length < 4 || pass.length > 32) throw new Err('La contraseña debe tener de 4 a 32 caracteres.');
    if (!nick) throw new Err('Escribe un nickname.');
    if (ADMIN_USER && user.toLowerCase() === ADMIN_USER.toLowerCase()) throw new Err('Ese usuario ya existe.');
    const sid = crypto.randomBytes(9).toString('base64url'), now = Date.now();
    const r = { user, pass: encPass(pass), nick, skin: 0, money: START, slots: emptySlots(), held: -1, hpaid: 0, t: now, seen: now, created: now, lin: now, sid };
    r.aid = crypto.randomBytes(6).toString('base64url');
    const ok = await db('SET', ukey(user), JSON.stringify(r), 'NX');
    if (!ok) throw new Err('Ese usuario ya existe.');
    await ensureAid(r);
    await db('SADD', 'users', user.toLowerCase());
    return { tok: signTok({ u: user, sid, exp: Date.now() + TOKEN_DAYS * 864e5 }), st: view(r) };
  },
  async login(b) {
    const user = String(b.user || '').trim(), pass = String(b.pass || '');
    if (!user || !pass) throw new Err('Escribe tu usuario y contraseña.');
    await guard(user);
    if (ADMIN_USER && ADMIN_PASS && safeEq(user.toLowerCase(), ADMIN_USER.toLowerCase())) {
      if (!safeEq(pass, ADMIN_PASS)) { await fail(user); throw new Err('Usuario o contraseña incorrectos.'); }
      const r = await adminRec();
      r.sid = crypto.randomBytes(9).toString('base64url'); r.kk = 0; r.t = Date.now(); r.seen = r.t; r.off = 0; r.lin = r.t;
      settleHeld(r); touchCat(r); await ensureAid(r);
      await db('SADD', 'users', ADMIN_USER.toLowerCase());
      await saveRec(r);
      return { admin: true, tok: signTok({ u: r.user, sid: r.sid, adm: 1, exp: Date.now() + 7 * 864e5 }), st: view(r), ...(await evInfo()) };
    }
    const r = await loadRec(user);
    if (!r || !safeEq(decPass(r.pass), pass)) { await fail(user); throw new Err('Usuario o contraseña incorrectos.'); }
    if (await isClosed()) throw new Err(CLOSED_MSG, 'closed');
    r.sid = crypto.randomBytes(9).toString('base64url'); r.kk = 0; r.t = Date.now(); r.seen = r.t; r.off = 0; r.lin = r.t; /* sin ingresos mientras estuviste fuera */
    settleHeld(r); touchCat(r); await ensureAid(r);
    await saveRec(r);
    return { tok: signTok({ u: r.user, sid: r.sid, exp: Date.now() + TOKEN_DAYS * 864e5 }), st: view(r), ...(await evInfo()) };
  },
  async resume(b) {
    const t = readTok(b.tok);
    if (t && t.adm && t.u === '*admin') throw new Err('Inicia sesión de nuevo.', 'auth');
    if (!(t && t.adm) && await isClosed()) throw new Err(CLOSED_MSG, 'closed');
    const r = await userFromTok(b.tok);
    r.t = Date.now(); r.seen = r.t; r.off = 0; settleHeld(r); touchCat(r); await ensureAid(r); await saveRec(r);
    return { tok: b.tok, st: view(r), ...(t && t.adm ? { admin: true } : {}), ...(await evInfo()) };
  },
  /* la pestaña se cerro o el navegador paso al fondo: se guarda el progreso y se marca fuera de linea al instante (una sola peticion, solo al salir) */
  async away(b) {
    if (okCode(b.hc) && readTok(b.tok) && (await db('GET', 'rm')) === b.hc) await db('DEL', 'rm');   /* el anfitrión se fue solo: la sala queda libre al instante */
    const r = await userFromTok(b.tok); accrue(r, Date.now()); r.off = 1; r.mob = b.mob ? 1 : 0; await saveRec(r); return { ok: true };
  },
  async sync(b) {
    if (b.cv !== CV && !process.env.NO_CV_CHECK) throw new Err('Hay una versión nueva del juego. Recargando…', 'auth');
    const skipLb = !!b.nl;   /* el cliente pide el ranking solo 1 de cada 3 veces: menos comandos */
    const [r, info, lbs] = await Promise.all([userFromTok(b.tok), evInfo(), skipLb ? null : db('GET', 'lb')]);   /* en paralelo: menos tiempo de funcion */
    accrue(r, Date.now());
    const lb = skipLb ? null : lbParse(lbs), ch = skipLb ? 0 : lbApply(lb, r), nowT = Date.now();
    const tk = readTok(b.tok), hc = okCode(b.hc) ? b.hc : null;
    if (hc && (!info.rc || info.rc === hc || (tk && tk.adm && await rmDead()))) { info.rc = hc; await db('SET', 'rm', hc, 'EX', RM_TTL); }   /* el admin siempre manda: su sala reemplaza a cualquier otra */
    const jobs = [saveRec(r)];   /* el progreso se guarda siempre, incluso si el servidor esta cerrado */
    if (!skipLb && (ch === 2 || (ch === 1 && nowT - lb.t > 25000))) { lb.t = nowT; jobs.push(db('SET', 'lb', JSON.stringify(lb))); }
    await Promise.all(jobs);
    const t = readTok(b.tok);
    if (info.closed && !(t && t.adm)) throw new Err('El servidor se cerró. Tu progreso se guardó.', 'closed');
    return { st: view(r), ...info };
  },
  /* comprar un Papu de la cinta: se cobra al agarrarlo (si lo pierdes, lo pierdes) */
  async buy(b) {
    const r = await userFromTok(b.tok); accrue(r, Date.now());
    const lvl = b.lvl;
    if (!Number.isInteger(lvl) || lvl < 5 || lvl > MAXLVL) throw new Err('Jugada no válida.', 'bad');
    if (r.held >= 0) { await saveRec(r); throw Object.assign(new Err('Ya llevas un Papu.', 'bad'), { st: view(r) }); }
    if (r.money < PRICE[lvl]) { await saveRec(r); throw Object.assign(new Err('No te alcanza el dinero.', 'bad'), { st: view(r) }); }
    r.money -= PRICE[lvl]; r.held = lvl; r.hpaid = PRICE[lvl];
    await saveRec(r); return { st: view(r) };
  },
  /* colocar en tu base el Papu que llevas (comprado, recogido del suelo o robado) */
  async place(b) {
    const r = await userFromTok(b.tok); accrue(r, Date.now());
    const slot = b.slot, lvl = r.held;
    if (!Number.isInteger(slot) || slot < 0 || slot >= NSLOT || slot >= SLOTF * (r.fl || 1)) throw new Err('Jugada no válida.', 'bad');
    if (lvl == null || lvl < 0) { await saveRec(r); throw Object.assign(new Err('No llevas ningún Papu.', 'bad'), { st: view(r) }); }
    const cur = r.slots[slot];
    if (cur >= 0 && INC[lvl] <= INC[cur]) { await saveRec(r); throw Object.assign(new Err('Ese lugar ya tiene uno igual o mejor.', 'bad'), { st: view(r) }); }
    r.slots[slot] = lvl; r.held = -1; r.hpaid = 0;
    touchCat(r); if (!r.cat[lvl]) r.cat[lvl] = Date.now();
    await saveRec(r); return { st: view(r) };
  },
  /* el Papu cae al suelo (aturdido): se puede recoger durante unos segundos */
  async drop(b) {
    const r = await userFromTok(b.tok); accrue(r, Date.now());
    const gid = String(b.gid || '');
    if (!/^[a-z0-9]{4,12}$/.test(gid)) throw new Err('Jugada no válida.', 'bad');
    if (r.held >= 0) { await db('SET', 'g:' + gid, String(r.held), 'EX', b.p ? 86400 : b.q ? 4 : 14);   /* b.p: Papu sacado de una base y soltado por un ladrón: se queda en el suelo hasta que alguien lo agarre */ r.held = -1; r.hpaid = 0; }
    await saveRec(r); return { st: view(r) };
  },
  async pick(b) {
    const r = await userFromTok(b.tok); accrue(r, Date.now());
    const gid = String(b.gid || '');
    if (!/^[a-z0-9]{4,12}$/.test(gid) || r.held >= 0) { await saveRec(r); return { ok: false, st: view(r) }; }
    const v = await db('GETDEL', 'g:' + gid);
    if (v == null) { await saveRec(r); return { ok: false, st: view(r) }; }
    r.held = +v; r.hpaid = 0; await saveRec(r);
    return { ok: true, lvl: r.held, st: view(r) };
  },
  /* robar de la base de otro jugador (el cliente exige mantener E 7 s) */
  async steal(b) {
    const r = await userFromTok(b.tok); accrue(r, Date.now());
    const aid = String(b.aid || ''), slot = b.slot;
    if (!/^[A-Za-z0-9_-]{4,16}$/.test(aid) || !Number.isInteger(slot) || slot < 0 || slot >= NSLOT) throw new Err('Jugada no válida.', 'bad');
    if (r.held >= 0) { await saveRec(r); throw Object.assign(new Err('Ya llevas un Papu.', 'bad'), { st: view(r) }); }
    const vu = await db('GET', 'a:' + aid);
    const v = vu ? await loadRec(vu) : null;
    if (!v || v.user === r.user) { await saveRec(r); return { ok: false, st: view(r) }; }
    /* celular con la pantalla apagada: su base ya no esta en la partida, no se le puede robar */
    if (v.off && v.mob) { await saveRec(r); throw Object.assign(new Err('Ese jugador no está disponible.', 'bad'), { st: view(r) }); }
    accrue(v, Date.now());
    const lvl = v.slots[slot];
    if (lvl == null || lvl < 0) { await saveRec(v); await saveRec(r); return { ok: false, st: view(r) }; }
    v.slots[slot] = -1; await saveRec(v);
    r.held = lvl; r.hpaid = 0; r.sc = (r.sc || 0) + 1; await saveRec(r);   /* un robo más para la tabla de clasificación */
    return { ok: true, lvl, st: view(r) };
  },
  /* traspaso de anfitrion: el admin pide una prueba corta y el anfitrion actual la verifica (la prueba no sirve para nada mas) */
  /* reclamar la sala: el primero en llegar la crea; los demás reciben el código ganador. El admin puede reemplazar una sala caída. */
  async claim(b) {
    const t = readTok(b.tok); if (!t) throw new Err('Sesión no válida. Inicia sesión de nuevo.', 'auth');
    if (!okCode(b.code)) throw new Err('Jugada no válida.', 'bad');
    if (t.adm && b.force && await rmDead()) { await db('SET', 'rm', b.code, 'EX', RM_TTL); return { rc: b.code, won: true }; }   /* sala muerta: el admin la reemplaza; si hay gente jugando, el admin se une a ella */
    if ((await db('SET', 'rm', b.code, 'NX', 'EX', RM_TTL)) === 'OK') return { rc: b.code, won: true };
    const cur = await db('GET', 'rm'); return { rc: cur || b.code, won: !cur, w: cur ? Math.max(0, +(await db('PTTL', 'rm')) || 0) : 0 };   /* w = cuánto le queda a la sala registrada (ms): el cliente sabe si el anfitrión está vivo o la sala es fantasma */
  },
  /* latido del anfitrión cuando su pestaña está oculta (el sync normal no corre oculto) */
  async hb(b) {
    const t = readTok(b.tok); if (!t) throw new Err('Sesión no válida. Inicia sesión de nuevo.', 'auth');
    if (!okCode(b.hc)) throw new Err('Jugada no válida.', 'bad');
    const cur = await db('GET', 'rm');
    if (!cur || cur === b.hc || (t.adm && await rmDead())) { await db('SET', 'rm', b.hc, 'EX', RM_TTL); return { rc: b.hc }; }
    return { rc: cur };
  },
  /* tabla de clasificación: una sola lectura, sin recorrer cuentas */
  async top(b) {
    if (!readTok(b.tok)) throw new Err('Sesión no válida. Inicia sesión de nuevo.', 'auth');
    const lb = lbParse(await db('GET', 'lb'));
    return { lb: { m: lb.m, p: lb.p, s: lb.s, r: lb.r } };
  },
  async hproof(b) { adminFromTok(b.tok); return { pr: signTok({ h: 1, exp: Date.now() + 60000 }) }; },
  async hchk(b) { const t = readTok(b.pr); return { ok: !!(t && t.h === 1) }; },
  /* mover un Papu de tu base: lo levanta a la mano (se coloca con place) */
  async lift(b) {
    const r = await userFromTok(b.tok); accrue(r, Date.now());
    const slot = b.slot;
    if (!Number.isInteger(slot) || slot < 0 || slot >= NSLOT) throw new Err('Jugada no válida.', 'bad');
    if (r.held >= 0) { await saveRec(r); throw Object.assign(new Err('Ya llevas un Papu.', 'bad'), { st: view(r) }); }
    const lvl = r.slots[slot];
    if (lvl == null || lvl < 0) { await saveRec(r); return { ok: false, st: view(r) }; }
    r.slots[slot] = -1; r.held = lvl; r.hpaid = 0; await saveRec(r);
    return { ok: true, lvl, st: view(r) };
  },
  /* eliminar un Papu de tu base (sin reembolso) */
  async delslot(b) {
    const r = await userFromTok(b.tok); accrue(r, Date.now());
    const slot = b.slot;
    if (!Number.isInteger(slot) || slot < 0 || slot >= NSLOT) throw new Err('Jugada no válida.', 'bad');
    r.slots[slot] = -1; await saveRec(r);
    return { ok: true, st: view(r) };
  },
  /* decoracion: comprar un color o el Papu Fuego (se paga una sola vez) */
  async dbuy(b) {
    const r = await userFromTok(b.tok); accrue(r, Date.now());
    const id = b.id;
    if (!Number.isInteger(id) || id < 1 || id > 11) throw new Err('Jugada no válida.', 'bad');
    const d = r.dco || (r.dco = { o: [], c: 0, f: 0 });
    if (d.o.includes(id)) { await saveRec(r); throw Object.assign(new Err('Ya lo compraste.', 'bad'), { st: view(r) }); }
    if (r.money < DPRICE[id]) { await saveRec(r); throw Object.assign(new Err('No te alcanza el dinero.', 'bad'), { st: view(r) }); }
    r.money -= DPRICE[id]; d.o.push(id);
    await saveRec(r); return { st: view(r) };
  },
  /* objetos (inventario): se compran una sola vez */
  async obuy(b) {
    const r = await userFromTok(b.tok); accrue(r, Date.now());
    const id = String(b.id || '');
    if (!OPRICE[id]) throw new Err('Jugada no válida.', 'bad');
    const inv = Array.isArray(r.inv) ? r.inv : (r.inv = []);
    if (inv.includes(id)) { await saveRec(r); throw Object.assign(new Err('Ya lo compraste.', 'bad'), { st: view(r) }); }
    if (r.money < OPRICE[id]) { await saveRec(r); throw Object.assign(new Err('No te alcanza el dinero.', 'bad'), { st: view(r) }); }
    r.money -= OPRICE[id]; inv.push(id);
    await saveRec(r); return { st: view(r) };
  },
  /* ajustes de sonido por cuenta */
  async vol(b) {
    const r = await userFromTok(b.tok);
    const m = Number(b.m), f = Number(b.f);
    if (!(m >= 0 && m <= 1 && f >= 0 && f <= 1)) throw new Err('Valor no válido.', 'bad');
    r.vol = { m: Math.round(m * 100) / 100, f: Math.round(f * 100) / 100 };
    await saveRec(r); return { ok: true };
  },
  /* equipar / quitar: un solo color a la vez; el Papu Fuego se activa aparte */
  async dequip(b) {
    const r = await userFromTok(b.tok); accrue(r, Date.now());
    const id = b.id;
    if (!Number.isInteger(id) || id < 1 || id > 11) throw new Err('Jugada no válida.', 'bad');
    const d = r.dco || (r.dco = { o: [], c: 0, f: 0 });
    if (!d.o.includes(id)) { await saveRec(r); throw Object.assign(new Err('Primero cómpralo.', 'bad'), { st: view(r) }); }
    if (id === 11) d.f = d.f ? 0 : 1; else d.c = d.c === id ? 0 : id;
    await saveRec(r); return { st: view(r) };
  },
  /* comprar el siguiente piso de la base (permanente, hasta 5 pisos) */
  async fbuy(b) {
    const r = await userFromTok(b.tok); accrue(r, Date.now());
    const n = r.fl || 1;
    if (n >= MAXF) { await saveRec(r); throw Object.assign(new Err('Tu base ya tiene todos los pisos.', 'bad'), { st: view(r) }); }
    if (Number.isInteger(b.n) && b.n !== n + 1) { await saveRec(r); throw Object.assign(new Err('Compra los pisos en orden.', 'bad'), { st: view(r) }); }
    if (r.money < FPRICE[n + 1]) { await saveRec(r); throw Object.assign(new Err('No te alcanza el dinero.', 'bad'), { st: view(r) }); }
    r.money -= FPRICE[n + 1]; r.fl = n + 1;
    await saveRec(r); return { st: view(r) };
  },
  /* REBIRTH: necesitas el dinero y los Papus del siguiente nivel en tu base; se reinicia todo menos lo exclusivo y subes el multiplicador */
  async rebirth(b) {
    const r = await userFromTok(b.tok); accrue(r, Date.now());
    const n = (r.rb | 0) + 1;
    if (n > REB.length) { await saveRec(r); throw Object.assign(new Err('Ya completaste todos los Rebirth.', 'bad'), { st: view(r) }); }
    if (Number.isInteger(b.n) && b.n !== n) { await saveRec(r); throw Object.assign(new Err('Haz los Rebirth en orden.', 'bad'), { st: view(r) }); }
    const L = REB[n - 1];
    if (r.money < L.money) { await saveRec(r); throw Object.assign(new Err('No te alcanza el dinero para el Rebirth.', 'bad'), { st: view(r) }); }
    const cnt = {}; r.slots.forEach(l => { if (l >= 0) cnt[l] = (cnt[l] || 0) + 1; });
    if (!L.papus.every(([l, q]) => (cnt[l] || 0) >= q)) { await saveRec(r); throw Object.assign(new Err('Te faltan Papus en tu base para este Rebirth.', 'bad'), { st: view(r) }); }
    settleHeld(r); resetProgress(r); r.rb = n; r.rbt = Date.now();
    await saveRec(r); return { st: view(r) };
  },
  async clear(b) { const r = await userFromTok(b.tok); accrue(r, Date.now()); r.slots = emptySlots(); await saveRec(r); return { st: view(r) }; },
  /* "Reiniciar todo" ya no existe para los jugadores: solo el admin reinicia cuentas (aclear) */
  async reset(b) { await userFromTok(b.tok); throw new Err('Solo el administrador puede reiniciar cuentas.', 'bad'); },
  async nick(b) {
    const r = await userFromTok(b.tok), n = cleanNick(b.nick);
    if (!n) throw new Err('Escribe un nickname.');
    r.nick = n; await saveRec(r); return { st: view(r) };
  },
  async skin(b) {
    const r = await userFromTok(b.tok), k = b.k;
    if (!Number.isInteger(k) || k < 0 || k >= NSKIN) throw new Err('Skin no válida.');
    if (k === 11 && !isAdminUser(r.user) && !(Array.isArray(r.inv) && r.inv.includes('freddy'))) throw new Err('Primero compra la skin Freddy Papu en la tienda.', 'bad');   /* Freddy Papu: exclusiva de tienda (o admin) */
    r.skin = k; await saveRec(r); return { st: view(r) };
  },

  /* ---------- panel admin ---------- */
  async alist(b) {
    adminFromTok(b.tok);
    const names = (await db('SMEMBERS', 'users')) || [], out = [];
    for (const n of names) {
      const r = await loadRec(n);
      if (!r) { await db('SREM', 'users', n); continue; }
      out.push({ lin: r.lin || r.created || 0, aid: r.aid || null, user: r.user, pass: isAdminUser(r.user) ? '(cuenta admin)' : decPass(r.pass), admin: isAdminUser(r.user), nick: r.nick, money: Math.floor(r.money), papus: r.slots.filter(l => l >= 0).length, fl: r.fl || 1, slots: r.slots, cat: r.cat || {}, created: r.created, seen: r.seen, online: !r.off && Date.now() - r.seen < 25000 });
    }
    /* en línea arriba por orden de entrada (el que entró primero, primero); fuera de línea abajo: el que entró más recientemente arriba y el que lleva más tiempo sin entrar hasta abajo */
    out.sort((a, b) => (b.online - a.online) || (a.online ? (a.lin - b.lin) : (b.seen - a.seen)));
    return { users: out, now: Date.now(), ev: await evLeft(), closed: await isClosed() };
  },
  async aset(b) {
    adminFromTok(b.tok);
    const r = await loadRec(String(b.user || '')); if (!r) throw new Err('Ese usuario no existe.');
    const m = Number(b.money); if (!isFinite(m) || m < 0 || m > MAXM) throw new Err('Cantidad no válida.');
    r.money = Math.floor(m); r.t = Date.now(); await saveRec(r); return { ok: true };
  },
  /* el admin activa o desactiva la barrera de un jugador en línea (sin enfriamiento para el admin) */
  async abar(b) {
    adminFromTok(b.tok);
    const r = await loadRec(String(b.user || '')); if (!r) throw new Err('Ese usuario no existe.');
    r.cmd = { id: crypto.randomBytes(5).toString('base64url'), on: !!b.on, ts: Date.now() }; await saveRec(r); return { ok: true };
  },
  /* expulsar: se guarda su progreso, se marca fuera de linea y en su siguiente peticion (<=10 s) se le cierra la sesion */
  async akick(b) {
    adminFromTok(b.tok);
    const r = await loadRec(String(b.user || '')); if (!r) throw new Err('Ese usuario no existe.');
    if (isAdminUser(r.user)) throw new Err('No puedes expulsar al administrador.');
    accrue(r, Date.now()); r.off = 1; r.kk = 1; await saveRec(r); return { ok: true };
  },
  async aclear(b) {
    adminFromTok(b.tok);
    const r = await loadRec(String(b.user || '')); if (!r) throw new Err('Ese usuario no existe.');
    resetProgress(r); r.rb = 0; await saveRec(r); return { ok: true };
  },
  /* eventos: iniciar o detener el Papu Golden Time */
  async amsg(b) {
    adminFromTok(b.tok);
    const text = String(b.text || '').replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e]/g, ' ').trim().slice(0, 140), secs = [1, 2, 3, 5, 10].includes(b.secs) ? b.secs : 5;
    if (!text) throw new Err('Escribe un mensaje.', 'bad');
    const m = { id: crypto.randomBytes(5).toString('hex'), text, secs, ts: Date.now() };
    await db('SET', 'ev:msg', JSON.stringify(m), 'EX', 30);
    return { ok: true, am: { id: m.id, text, secs, age: 0 } };
  },
  async aev(b) {
    adminFromTok(b.tok);
    if (b.on) await db('SET', 'ev:gt', String(Date.now() + EV_MS), 'EX', 180); else await db('DEL', 'ev:gt');
    return { ev: await evLeft() };
  },
  /* cerrar / abrir el servidor: cerrado, solo entra el admin (para pruebas); los jugadores en linea son sacados al sincronizar */
  async aclose(b) {
    adminFromTok(b.tok);
    if (b.on) await db('SET', 'srv:closed', '1'); else await db('DEL', 'srv:closed');
    return { closed: await isClosed() };
  },
  /* invocar un Papu: aparece asegurado en la cinta para todos */
  async asummon(b) {
    adminFromTok(b.tok);
    const lvl = b.lvl; if (!Number.isInteger(lvl) || lvl < 5 || lvl > MAXLVL) throw new Err('Papu no válido.');
    const now = Date.now(); let list = [];
    try { const v = await db('GET', 'ev:sm'); list = v ? JSON.parse(v) : []; } catch (e) { list = []; }
    list = list.filter(m => now - m.ts < 30000).slice(-9);
    const m = { id: crypto.randomBytes(5).toString('hex'), lvl, ts: now }; list.push(m);
    await db('SET', 'ev:sm', JSON.stringify(list), 'EX', 60);
    return { ok: true, id: m.id };
  },
  /* restablecer el catálogo de una cuenta (solo admin) */
  async acat(b) {
    adminFromTok(b.tok);
    const r = await loadRec(String(b.user || '')); if (!r) throw new Err('Ese usuario no existe.');
    r.cat = {}; r.catv = 1; await saveRec(r); return { ok: true };
  },
  async adel(b) {
    adminFromTok(b.tok);
    const u = String(b.user || ''); if (isAdminUser(u)) throw new Err('La cuenta de administrador no se puede borrar.');
    { const d = await loadRec(u); if (d && d.aid) { const lb = lbParse(await db('GET', 'lb')); let c = false; for (const k of ['m', 'p', 's', 'r']) { const n = lb[k].filter(e => e[0] !== d.aid); if (n.length !== lb[k].length) { lb[k] = n; c = true; } } if (c) await db('SET', 'lb', JSON.stringify(lb)); } }
    await db('DEL', ukey(u)); await db('SREM', 'users', u.toLowerCase()); return { ok: true };
  }
};

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ err: 'Método no permitido' });
  if (!DB_URL || !DB_TOKEN || !SECRET) return res.status(500).json({ err: 'El servidor aún no está configurado (falta la base de datos o SECRET).', code: 'cfg' });
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  b = b || {};
  const fn = actions[b.a];
  if (!fn) return res.status(400).json({ err: 'Acción desconocida' });
  try {
    const out = await fn(b);
    if (out && (b.a === 'login' || b.a === 'register' || b.a === 'resume')) { const ic = await turnIce(); if (ic) out.ice = ic; }
    res.status(200).json(out);
  } catch (e) {
    if (e instanceof Err) return res.status(e.code === 'auth' ? 401 : 200).json({ err: e.message, code: e.code, st: e.st });
    console.error(e);
    res.status(500).json({ err: 'Error del servidor. Intenta de nuevo.', code: 'srv' });
  }
};
module.exports._actions = actions;
