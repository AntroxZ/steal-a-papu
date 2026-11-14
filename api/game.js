/* Steal a Papu - servidor de cuentas y progreso (Vercel Function, sin dependencias) */
const crypto = require('crypto');

const DB_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const DB_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const SECRET = process.env.SECRET || '';
const ADMIN_USER = process.env.ADMIN_USER || '';
const ADMIN_PASS = process.env.ADMIN_PASS || '';

/* mismos valores que el juego: nivel -> ingreso por segundo y precio */
const INC = [1, 5, 12, 25, 50, 10, 40, 5500, 22000, 40000, 160000, 700, 2800, 75, 300, 600000, 2500000];
const PRICE = [0, 0, 0, 0, 0, 50, 200, 60000, 240000, 600000, 2400000, 6000, 24000, 500, 2000, 15000000, 100000000];
/* evento en vivo: Papu Golden Time (el admin lo inicia; los jugadores lo reciben al sincronizar) */
const EV_MS = 120000;
async function evLeft() { const v = await db('GET', 'ev:gt'); const left = v ? +v - Date.now() : 0; return left > 0 ? left : 0; }
const START = 50, NSLOT = 10, NSKIN = 5, TOKEN_DAYS = 30, MAX_DT = 12000;

async function db(...cmd) {
  const r = await fetch(DB_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + DB_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}
const ukey = u => 'u:' + u.toLowerCase();
const emptySlots = () => Array(NSLOT).fill(-1);

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
  const dt = Math.min(Math.max(now - (r.t || now), 0), MAX_DT) / 1000;
  let inc = 0; r.slots.forEach(l => { if (l >= 0) inc += INC[l] || 0; });
  r.money += inc * dt; r.t = now; r.seen = now;
}
const view = r => ({ nick: r.nick, skin: r.skin, money: Math.round(r.money * 100) / 100, slots: r.slots, aid: r.aid, held: r.held == null ? -1 : r.held, cat: r.cat || {} });
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
async function loadRec(user) {
  const s = await db('GET', ukey(user));
  return s ? JSON.parse(s) : null;
}
const saveRec = r => db('SET', ukey(r.user), JSON.stringify(r));

async function userFromTok(tok) {
  const t = readTok(tok);
  if (!t || t.adm) throw new Err('Sesión no válida. Inicia sesión de nuevo.', 'auth');
  const r = await loadRec(t.u);
  if (!r) throw new Err('Esta cuenta ya no existe.', 'auth');
  if (r.sid !== t.sid) throw new Err('Tu cuenta se abrió en otro lugar.', 'auth');
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

const checkUser = u => /^[A-Za-z0-9_]{3,16}$/.test(u);
const cleanNick = n => String(n || '').trim().replace(/\s+/g, ' ').slice(0, 14);

const actions = {
  async register(b) {
    const user = String(b.user || '').trim(), pass = String(b.pass || ''), nick = cleanNick(b.nick);
    if (!checkUser(user)) throw new Err('Usuario: de 3 a 16 letras, números o _ (sin espacios).');
    if (pass.length < 4 || pass.length > 32) throw new Err('La contraseña debe tener de 4 a 32 caracteres.');
    if (!nick) throw new Err('Escribe un nickname.');
    if (ADMIN_USER && user.toLowerCase() === ADMIN_USER.toLowerCase()) throw new Err('Ese usuario ya existe.');
    const sid = crypto.randomBytes(9).toString('base64url'), now = Date.now();
    const r = { user, pass: encPass(pass), nick, skin: 0, money: START, slots: emptySlots(), held: -1, hpaid: 0, t: now, seen: now, created: now, sid };
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
      return { admin: true, tok: signTok({ u: '*admin', adm: 1, exp: Date.now() + 864e5 }) };
    }
    const r = await loadRec(user);
    if (!r || !safeEq(decPass(r.pass), pass)) { await fail(user); throw new Err('Usuario o contraseña incorrectos.'); }
    r.sid = crypto.randomBytes(9).toString('base64url'); r.t = Date.now(); r.seen = r.t; /* sin ingresos mientras estuviste fuera */
    settleHeld(r); touchCat(r); await ensureAid(r);
    await saveRec(r);
    return { tok: signTok({ u: r.user, sid: r.sid, exp: Date.now() + TOKEN_DAYS * 864e5 }), st: view(r), ev: await evLeft() };
  },
  async resume(b) {
    const t = readTok(b.tok);
    if (t && t.adm) return { admin: true, tok: b.tok };
    const r = await userFromTok(b.tok);
    r.t = Date.now(); r.seen = r.t; settleHeld(r); touchCat(r); await ensureAid(r); await saveRec(r);
    return { tok: b.tok, st: view(r), ev: await evLeft() };
  },
  async sync(b) {
    const r = await userFromTok(b.tok); accrue(r, Date.now()); await saveRec(r); return { st: view(r), ev: await evLeft() };
  },
  /* comprar un Papu de la cinta: se cobra al agarrarlo (si lo pierdes, lo pierdes) */
  async buy(b) {
    const r = await userFromTok(b.tok); accrue(r, Date.now());
    const lvl = b.lvl;
    if (!Number.isInteger(lvl) || lvl < 5 || lvl > 16) throw new Err('Jugada no válida.', 'bad');
    if (r.held >= 0) { await saveRec(r); throw Object.assign(new Err('Ya llevas un Papu.', 'bad'), { st: view(r) }); }
    if (r.money < PRICE[lvl]) { await saveRec(r); throw Object.assign(new Err('No te alcanza el dinero.', 'bad'), { st: view(r) }); }
    r.money -= PRICE[lvl]; r.held = lvl; r.hpaid = PRICE[lvl];
    await saveRec(r); return { st: view(r) };
  },
  /* colocar en tu base el Papu que llevas (comprado, recogido del suelo o robado) */
  async place(b) {
    const r = await userFromTok(b.tok); accrue(r, Date.now());
    const slot = b.slot, lvl = r.held;
    if (!Number.isInteger(slot) || slot < 0 || slot >= NSLOT) throw new Err('Jugada no válida.', 'bad');
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
    if (r.held >= 0) { await db('SET', 'g:' + gid, String(r.held), 'EX', 8); r.held = -1; r.hpaid = 0; }
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
    accrue(v, Date.now());
    const lvl = v.slots[slot];
    if (lvl == null || lvl < 0) { await saveRec(v); await saveRec(r); return { ok: false, st: view(r) }; }
    v.slots[slot] = -1; await saveRec(v);
    r.held = lvl; r.hpaid = 0; await saveRec(r);
    return { ok: true, lvl, st: view(r) };
  },
  async clear(b) { const r = await userFromTok(b.tok); accrue(r, Date.now()); r.slots = emptySlots(); await saveRec(r); return { st: view(r) }; },
  async reset(b) { const r = await userFromTok(b.tok); r.slots = emptySlots(); r.held = -1; r.hpaid = 0; r.money = START; r.t = Date.now(); await saveRec(r); return { st: view(r) }; },
  async nick(b) {
    const r = await userFromTok(b.tok), n = cleanNick(b.nick);
    if (!n) throw new Err('Escribe un nickname.');
    r.nick = n; await saveRec(r); return { st: view(r) };
  },
  async skin(b) {
    const r = await userFromTok(b.tok), k = b.k;
    if (!Number.isInteger(k) || k < 0 || k >= NSKIN) throw new Err('Skin no válida.');
    r.skin = k; await saveRec(r); return { st: view(r) };
  },

  /* ---------- panel admin ---------- */
  async alist(b) {
    adminFromTok(b.tok);
    const names = (await db('SMEMBERS', 'users')) || [], out = [];
    for (const n of names) {
      const r = await loadRec(n);
      if (!r) { await db('SREM', 'users', n); continue; }
      out.push({ user: r.user, pass: decPass(r.pass), nick: r.nick, money: Math.floor(r.money), papus: r.slots.filter(l => l >= 0).length, slots: r.slots, cat: r.cat || {}, created: r.created, seen: r.seen, online: Date.now() - r.seen < 20000 });
    }
    out.sort((a, b) => b.seen - a.seen);
    return { users: out, now: Date.now(), ev: await evLeft() };
  },
  async aset(b) {
    adminFromTok(b.tok);
    const r = await loadRec(String(b.user || '')); if (!r) throw new Err('Ese usuario no existe.');
    const m = Number(b.money); if (!isFinite(m) || m < 0 || m > 1e12) throw new Err('Cantidad no válida.');
    r.money = Math.floor(m); r.t = Date.now(); await saveRec(r); return { ok: true };
  },
  async aclear(b) {
    adminFromTok(b.tok);
    const r = await loadRec(String(b.user || '')); if (!r) throw new Err('Ese usuario no existe.');
    r.slots = emptySlots(); await saveRec(r); return { ok: true };
  },
  /* eventos: iniciar o detener el Papu Golden Time */
  async aev(b) {
    adminFromTok(b.tok);
    if (b.on) await db('SET', 'ev:gt', String(Date.now() + EV_MS), 'EX', 180); else await db('DEL', 'ev:gt');
    return { ev: await evLeft() };
  },
  /* restablecer el catálogo de una cuenta (solo admin) */
  async acat(b) {
    adminFromTok(b.tok);
    const r = await loadRec(String(b.user || '')); if (!r) throw new Err('Ese usuario no existe.');
    r.cat = {}; r.catv = 1; await saveRec(r); return { ok: true };
  },
  async adel(b) {
    adminFromTok(b.tok);
    const u = String(b.user || ''); await db('DEL', ukey(u)); await db('SREM', 'users', u.toLowerCase()); return { ok: true };
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
    res.status(200).json(await fn(b));
  } catch (e) {
    if (e instanceof Err) return res.status(e.code === 'auth' ? 401 : 200).json({ err: e.message, code: e.code, st: e.st });
    console.error(e);
    res.status(500).json({ err: 'Error del servidor. Intenta de nuevo.', code: 'srv' });
  }
};
module.exports._actions = actions;
