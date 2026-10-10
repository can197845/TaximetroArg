// Servidor del Taxímetro: cuenta los viajes de prueba y cobra la suscripción con Mercado Pago.
// Requiere Node 18 o superior. No usa librerías externas.
//
// Variables de entorno:
//   MP_ACCESS_TOKEN  Access Token de PRODUCCIÓN de tu aplicación de Mercado Pago (obligatorio)
//   BASE_URL         Dirección pública de la app, con https (ej: https://taximetro.tudominio.com)
//   PRICE            Precio mensual en pesos (por defecto 5000; debe coincidir con PRICE de index.html)
//   GRACE_DAYS       Días de gracia después del vencimiento (por defecto 2)
//   DATA_FILE        Archivo donde se guardan los datos (por defecto ./data.json)
//   PORT             Puerto (por defecto 3000)

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.MP_ACCESS_TOKEN || '';
const BASE_URL = (process.env.BASE_URL || '').replace(/\/$/, '');
const PRICE = Number(process.env.PRICE || 5000);
const GRACE_MS = Number(process.env.GRACE_DAYS || 2) * 86400000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const PORT = Number(process.env.PORT || 3000);
const DAY = 86400000;

if (!TOKEN || !BASE_URL) console.warn('ATENCIÓN: faltan MP_ACCESS_TOKEN o BASE_URL. El cobro no va a funcionar.');

// ---------- Datos ----------
let db = { devices: {}, byPreapproval: {} };
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
const validId = s => typeof s === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(s);
const dev = id => db.devices[id] || (db.devices[id] = { trips: 0, until: 0, email: '', created: Date.now() });

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
  const device = p.external_reference;
  if (!validId(device) || !db.devices[device]) return;
  const d = dev(device);
  db.byPreapproval[id] = device;
  if (p.status === 'authorized') {
    const next = p.next_payment_date ? Date.parse(p.next_payment_date) : 0;
    const until = (next > Date.now() ? next : Date.now() + 30 * DAY) + GRACE_MS;
    d.until = Math.max(d.until, until);
  }
  d.mpStatus = p.status;
  save();
  console.log('Suscripción', id, p.status, '→ dispositivo', device.slice(0, 8));
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
    }
    if (url.pathname.startsWith('/api/') && url.pathname !== '/api/webhook' && limited(ip)) return send(res, 429, { error: 'demasiados pedidos' });

    if (req.method === 'GET' && url.pathname === '/api/status') {
      const id = url.searchParams.get('device');
      if (!validId(id)) return send(res, 400, { error: 'dispositivo inválido' });
      const first = !db.devices[id];
      const d = dev(id); if (first) save();
      return send(res, 200, { trips: d.trips, until: d.until });
    }

    if (req.method === 'POST' && url.pathname === '/api/trip') {
      const b = await readBody(req);
      if (!validId(b.device)) return send(res, 400, { error: 'dispositivo inválido' });
      const d = dev(b.device);
      d.trips += Math.min(Math.max(parseInt(b.n, 10) || 1, 1), 10);
      save();
      return send(res, 200, { trips: d.trips, until: d.until });
    }

    if (req.method === 'POST' && url.pathname === '/api/subscribe') {
      const b = await readBody(req);
      if (!validId(b.device)) return send(res, 400, { error: 'dispositivo inválido' });
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email || '')) return send(res, 400, { error: 'email inválido' });
      if (!TOKEN || !BASE_URL) return send(res, 500, { error: 'servidor sin configurar' });
      const d = dev(b.device); d.email = b.email; save();
      const p = await mp('POST', '/preapproval', {
        reason: 'Taxímetro - suscripción mensual',
        external_reference: b.device,
        payer_email: b.email,
        auto_recurring: { frequency: 1, frequency_type: 'months', transaction_amount: PRICE, currency_id: 'ARS' },
        back_url: BASE_URL + '/?pago=ok',
        status: 'pending'
      });
      db.byPreapproval[p.id] = b.device; save();
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

server.listen(PORT, () => console.log('Taxímetro en el puerto ' + PORT));
