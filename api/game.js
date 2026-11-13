/* Steal a Papu - servidor de cuentas y progreso (Vercel Function, sin dependencias) */
const crypto = require('crypto');

const DB_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const DB_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const SECRET = process.env.SECRET || '';
const ADMIN_USER = process.env.ADMIN_USER || '';
const ADMIN_PASS = process.env.ADMIN_PASS || '';

/* mismos valores que el juego: nivel -> ingreso por segundo y precio */
const INC = [1, 5, 12, 25, 50, 10, 40, 25, 100, 60, 240, 150, 600];
const PRICE = [0, 0, 0, 0, 0, 50, 200, 150, 600, 400, 1600, 1000, 4000];
const START = 50, NSLOT = 10, NSKIN = 4, TOKEN_DAYS = 30, MAX_DT = 12000;

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
const view = r => ({ nick: r.nick, skin: r.skin, money: Math.round(r.money * 100) / 100, slots: r.slots });
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
    const r = { user, pass: encPass(pass), nick, skin: 0, money: START, slots: emptySlots(), t: now, seen: now, created: now, sid };
    const ok = await db('SET', ukey(user), JSON.stringify(r), 'NX');
    if (!ok) throw new Err('Ese usuario ya existe.');
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
    await saveRec(r);
    return { tok: signTok({ u: r.user, sid: r.sid, exp: Date.now() + TOKEN_DAYS * 864e5 }), st: view(r) };
  },
  async resume(b) {
    const t = readTok(b.tok);
    if (t && t.adm) return { admin: true, tok: b.tok };
    const r = await userFromTok(b.tok);
    r.t = Date.now(); r.seen = r.t; await saveRec(r);
    return { tok: b.tok, st: view(r) };
  },
  async sync(b) {
    const r = await userFromTok(b.tok); accrue(r, Date.now()); await saveRec(r); return { st: view(r) };
  },
  async place(b) {
    const r = await userFromTok(b.tok); accrue(r, Date.now());
    const slot = b.slot, lvl = b.lvl;
    if (!Number.isInteger(slot) || slot < 0 || slot >= NSLOT || !Number.isInteger(lvl) || lvl < 5 || lvl > 12) throw new Err('Jugada no válida.', 'bad');
    const cur = r.slots[slot];
    if (cur >= 0 && INC[lvl] <= INC[cur]) { await saveRec(r); throw Object.assign(new Err('Ese lugar ya tiene uno igual o mejor.', 'bad'), { st: view(r) }); }
    if (r.money < PRICE[lvl]) { await saveRec(r); throw Object.assign(new Err('No te alcanza el dinero.', 'bad'), { st: view(r) }); }
    r.money -= PRICE[lvl]; r.slots[slot] = lvl;
    await saveRec(r); return { st: view(r) };
  },
  async clear(b) { const r = await userFromTok(b.tok); accrue(r, Date.now()); r.slots = emptySlots(); await saveRec(r); return { st: view(r) }; },
  async reset(b) { const r = await userFromTok(b.tok); r.slots = emptySlots(); r.money = START; r.t = Date.now(); await saveRec(r); return { st: view(r) }; },
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
      out.push({ user: r.user, pass: decPass(r.pass), nick: r.nick, money: Math.floor(r.money), papus: r.slots.filter(l => l >= 0).length, slots: r.slots, created: r.created, seen: r.seen, online: Date.now() - r.seen < 20000 });
    }
    out.sort((a, b) => b.seen - a.seen);
    return { users: out, now: Date.now() };
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
