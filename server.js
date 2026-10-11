// Servidor del Taxímetro: ingreso con Google, cuenta los viajes de prueba por cuenta
// y cobra la suscripción con Mercado Pago.
// Requiere Node 18 o superior. No usa librerías externas.
//
// Variables de entorno:
//   GOOGLE_CLIENT_ID  ID de cliente OAuth de Google (tipo "Aplicación web") (obligatorio)
//   MP_ACCESS_TOKEN   Access Token de tu aplicación de Mercado Pago (obligatorio)
//   BASE_URL          Dirección pública de la app, con https (ej: https://taximetro.tudominio.com)
//   PRICE             Precio mensual en pesos (por defecto 5000; debe coincidir con PRICE de index.html)
//   GRACE_DAYS        Días de gracia después del vencimiento (por defecto 2)
//   DATA_FILE         Archivo donde se guardan los datos (por defecto ./data.json)
//   PORT              Puerto (por defecto 3000)

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DAY = 86400000;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const TOKEN = process.env.MP_ACCESS_TOKEN || '';
const BASE_URL = (process.env.BASE_URL || '').replace(/\/$/, '');
const PRICE = Number(process.env.PRICE || 5000);
const GRACE_MS = Number(process.env.GRACE_DAYS || 2) * DAY;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const PORT = Number(process.env.PORT || 3000);
const SESSION_MS = 180 * DAY;   // la sesión dura 6 meses sin volver a ingresar
const MAX_SESSIONS = 10;        // sesiones simultáneas por cuenta

if (!GOOGLE_CLIENT_ID) console.warn('ATENCIÓN: falta GOOGLE_CLIENT_ID. Nadie va a poder ingresar.');
if (!TOKEN || !BASE_URL) console.warn('ATENCIÓN: faltan MP_ACCESS_TOKEN o BASE_URL. El cobro no va a funcionar.');

// ---------- Datos ----------
let db = { accounts: {}, sessions: {}, byPreapproval: {} };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))); } catch (e) {}
let saving = false, dirty = false;
function save() {
  dirty = true;
  if (saving) return;
  saving = true; dirty = false;
  const tmp = DATA_FILE + '.tmp';
  fs.writeFile(tmp, JSON.stringify(db), err => {
    if (!err) fs.rename(tmp, DATA_FILE, () => { saving = false; if (dirty) save(); });
    else { saving = false; console.error('No se pudo guardar:', err.message); }
  });
}

// ---------- Ingreso con Google ----------
// Se valida el token que entrega Google: firma, emisor, destinatario (nuestro ID de cliente),
// vencimiento y email verificado. No hace falta ninguna librería.
const b64u = s => Buffer.from(s, 'base64url');
let jwks = { keys: [], at: 0 };
async function googleKeys(force) {
  const age = Date.now() - jwks.at;
  if (jwks.keys.length && (force ? age < 60000 : age < 3600000)) return jwks.keys;
  const r = await fetch('https://www.googleapis.com/oauth2/v3/certs');
  if (!r.ok) throw new Error('no se pudieron leer las claves de Google');
  const j = await r.json();
  jwks = { keys: j.keys || [], at: Date.now() };
  return jwks.keys;
}
async function verifyGoogle(idToken, clientId, keysFn) {
  const p = String(idToken || '').split('.');
  if (p.length !== 3 || p.some(x => !x)) throw new Error('token mal formado');
  let header, payload;
  try {
    header = JSON.parse(b64u(p[0]).toString('utf8'));
    payload = JSON.parse(b64u(p[1]).toString('utf8'));
  } catch (e) { throw new Error('token ilegible'); }
  if (header.alg !== 'RS256') throw new Error('algoritmo no permitido');
  const getKeys = keysFn || googleKeys;
  let jwk = (await getKeys(false)).find(k => k.kid === header.kid);
  if (!jwk) jwk = (await getKeys(true)).find(k => k.kid === header.kid);
  if (!jwk) throw new Error('clave desconocida');
  const ok = crypto.verify('RSA-SHA256', Buffer.from(p[0] + '.' + p[1]),
    crypto.createPublicKey({ key: jwk, format: 'jwk' }), b64u(p[2]));
  if (!ok) throw new Error('firma inválida');
  if (payload.iss !== 'accounts.google.com' && payload.iss !== 'https://accounts.google.com') throw new Error('emisor inválido');
  if (!clientId || payload.aud !== clientId) throw new Error('destinatario inválido');
  if (!(payload.exp * 1000 > Date.now())) throw new Error('token vencido');
  if (typeof payload.sub !== 'string' || !payload.sub) throw new Error('sin identificador');
  if (payload.email_verified !== true && payload.email_verified !== 'true') throw new Error('email sin verificar');
  return payload;
}

function newSession(sub) {
  const mine = Object.keys(db.sessions).filter(t => db.sessions[t].sub === sub)
    .sort((a, b) => db.sessions[a].ts - db.sessions[b].ts);
  while (mine.length >= MAX_SESSIONS) delete db.sessions[mine.shift()];
  const t = crypto.randomBytes(32).toString('hex');
  db.sessions[t] = { sub, ts: Date.now() };
  return t;
}
// Devuelve el identificador de la cuenta si la sesión del pedido es válida.
function auth(req) {
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : '';
  const s = db.sessions[t];
  if (!s) return null;
  if (Date.now() - s.ts > SESSION_MS) { delete db.sessions[t]; save(); return null; }
  return db.accounts[s.sub] ? s.sub : null;
}

// ---------- Mercado Pago ----------
async function mp(method, endpoint, body) {
  const r = await fetch('https://api.mercadopago.com' + endpoint, {
    method,
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error('MP ' + r.status); e.detail = j; throw e; }
  return j;
}

// Consulta a Mercado Pago el estado real de una suscripción (nunca se confía en lo que llega en el aviso).
async function syncPreapproval(id) {
  const p = await mp('GET', '/preapproval/' + encodeURIComponent(id));
  const sub = p.external_reference;
  const a = typeof sub === 'string' ? db.accounts[sub] : null;
  if (!a) return;
  db.byPreapproval[id] = sub;
  if (p.status === 'authorized') {
    const next = p.next_payment_date ? Date.parse(p.next_payment_date) : 0;
    const until = (next > Date.now() ? next : Date.now() + 30 * DAY) + GRACE_MS;
    a.until = Math.max(a.until, until);
  }
  a.mpStatus = p.status;
  save();
  console.log('Suscripción', id, p.status, '→ cuenta', a.email);
}

// ---------- HTTP ----------
function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((ok, no) => {
    let s = '';
    req.on('data', c => { s += c; if (s.length > 20000) { req.destroy(); no(new Error('grande')); } });
    req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { ok({}); } });
    req.on('error', no);
  });
}
const hits = new Map(); // límite simple de pedidos por IP
function limited(ip) {
  const now = Date.now(), h = (hits.get(ip) || []).filter(t => now - t < 60000);
  h.push(now); hits.set(ip, h);
  return h.length > 60;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some(t => now - t < 60000)) hits.delete(k); }, 300000).unref();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
    }
    if (url.pathname.startsWith('/api/') && url.pathname !== '/api/webhook' && limited(ip)) return send(res, 429, { error: 'demasiados pedidos' });

    if (req.method === 'GET' && url.pathname === '/api/config') {
      return send(res, 200, { googleClientId: GOOGLE_CLIENT_ID });
    }

    if (req.method === 'POST' && url.pathname === '/api/login') {
      if (!GOOGLE_CLIENT_ID) return send(res, 500, { error: 'ingreso sin configurar' });
      const b = await readBody(req);
      let g;
      try { g = await verifyGoogle(b.credential, GOOGLE_CLIENT_ID); }
      catch (e) { console.warn('Ingreso rechazado:', e.message); return send(res, 401, { error: 'no se pudo verificar la cuenta de Google' }); }
      const a = db.accounts[g.sub] || (db.accounts[g.sub] = { trips: 0, until: 0, created: Date.now() });
      a.email = g.email; a.name = g.name || '';
      const token = newSession(g.sub);
      save();
      return send(res, 200, { token, email: a.email, name: a.name, trips: a.trips, until: a.until });
    }

    if (req.method === 'GET' && url.pathname === '/api/status') {
      const sub = auth(req);
      if (!sub) return send(res, 401, { error: 'sesión inválida' });
      const a = db.accounts[sub];
      return send(res, 200, { trips: a.trips, until: a.until, email: a.email });
    }

    if (req.method === 'POST' && url.pathname === '/api/trip') {
      const sub = auth(req);
      if (!sub) return send(res, 401, { error: 'sesión inválida' });
      const b = await readBody(req);
      const a = db.accounts[sub];
      a.trips += Math.min(Math.max(parseInt(b.n, 10) || 1, 1), 10);
      save();
      return send(res, 200, { trips: a.trips, until: a.until });
    }

    if (req.method === 'POST' && url.pathname === '/api/subscribe') {
      const sub = auth(req);
      if (!sub) return send(res, 401, { error: 'sesión inválida' });
      const b = await readBody(req);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email || '')) return send(res, 400, { error: 'email inválido' });
      if (!TOKEN || !BASE_URL) return send(res, 500, { error: 'servidor sin configurar' });
      const p = await mp('POST', '/preapproval', {
        reason: 'Taxímetro - suscripción mensual',
        external_reference: sub,
        payer_email: b.email,
        auto_recurring: { frequency: 1, frequency_type: 'months', transaction_amount: PRICE, currency_id: 'ARS' },
        back_url: BASE_URL + '/?pago=ok',
        status: 'pending'
      });
      db.byPreapproval[p.id] = sub; save();
      return send(res, 200, { url: p.init_point });
    }

    // Aviso de Mercado Pago (configurar en el panel de la aplicación: Webhooks → suscripciones y pagos)
    if (url.pathname === '/api/webhook') {
      const b = req.method === 'POST' ? await readBody(req) : {};
      const type = b.type || b.topic || url.searchParams.get('type') || url.searchParams.get('topic') || '';
      const id = (b.data && b.data.id) || url.searchParams.get('data.id') || url.searchParams.get('id') || '';
      res.writeHead(200); res.end('ok');            // responder rápido
      try {
        if (!id) return;
        if (type === 'subscription_preapproval' || type === 'preapproval') await syncPreapproval(id);
        else if (type === 'subscription_authorized_payment' || type === 'authorized_payment') {
          const ap = await mp('GET', '/authorized_payments/' + encodeURIComponent(id));
          if (ap.preapproval_id) await syncPreapproval(ap.preapproval_id);
        }
      } catch (e) { console.error('Webhook:', e.message, JSON.stringify(e.detail || {})); }
      return;
    }

    send(res, 404, { error: 'no encontrado' });
  } catch (e) {
    console.error(e.message, JSON.stringify(e.detail || {}));
    send(res, 500, { error: 'error del servidor' });
  }
});

if (require.main === module) server.listen(PORT, () => console.log('Taxímetro en el puerto ' + PORT));
module.exports = { verifyGoogle };
