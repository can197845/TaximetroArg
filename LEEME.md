# Taxímetro – puesta en marcha con cobro

Archivos: `index.html` (la app) y `server.js` (cuenta los viajes y cobra con Mercado Pago). Van juntos en la misma carpeta.

## 1. Mercado Pago
1. Entrá a mercadopago.com.ar/developers → "Tus integraciones" → crear una aplicación (Suscripciones).
2. Copiá el **Access Token de producción** (empieza con `APP_USR-`). Es secreto: no lo pongas en `index.html`.
3. En la aplicación, sección **Webhooks**, cargá la URL `https://TU-DOMINIO/api/webhook` (modo producción) y marcá los eventos **Planes y suscripciones** (suscripción y pago recurrente).

## 2. Servidor
Necesitás un hosting con Node 18+ y HTTPS (Render, Railway, Fly.io, un VPS, etc.).

```
MP_ACCESS_TOKEN=APP_USR-xxxxxxxx
BASE_URL=https://TU-DOMINIO
PRICE=5000
node server.js
```

- Usá un disco/volumen persistente para `data.json` (o definí `DATA_FILE` apuntando a él); si se borra, se pierden los contadores y las suscripciones.
- Si cambiás el precio, cambialo igual en `PRICE` de `index.html` (solo es el texto que se muestra) y en la variable `PRICE` del servidor (es el que se cobra).

## 3. Cómo funciona
- Cada teléfono tiene un identificador; el servidor cuenta sus viajes. Al llegar a 50, la app pide la suscripción.
- El usuario escribe su email y paga en Mercado Pago. Cuando Mercado Pago avisa al webhook, el servidor activa 30 días (más 2 de gracia) y se renueva solo con cada cobro.
- Sin internet la app sigue funcionando hasta que venza lo último que el servidor confirmó.

## 4. Probalo antes de lanzar
Con credenciales de prueba de Mercado Pago, hacé una suscripción de punta a punta y mirá que la app pase a "Suscripción hasta …".

## Limitación a tener en cuenta
La prueba se asocia al teléfono. Quien borre los datos del navegador o reinstale la app obtiene otro identificador y otros 50 viajes. Para cerrarlo del todo hay que pedir una cuenta (email + clave) desde el primer uso; es un cambio más grande, decime si lo querés.
