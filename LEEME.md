# Taxímetro – puesta en marcha con cobro

Archivos: `index.html` (la app), `server.js` (ingreso con Google, cuenta los viajes y cobra con Mercado Pago), `package.json` y `.gitignore`. Van juntos en la raíz del repositorio.

## 1. Ingreso con Google (nuevo)
La prueba de 50 viajes y la suscripción quedan atadas a la cuenta de Google, no al teléfono. Reinstalar la app o borrar datos no reinicia la prueba.

1. Entrá a console.cloud.google.com e iniciá sesión con tu cuenta de Google.
2. Creá un proyecto (por ejemplo "Taximetro").
3. Menú "APIs y servicios", luego **Pantalla de consentimiento de OAuth**. Tipo de usuario **Externo**. Completá el nombre de la app y tu email de contacto.
4. En esa misma sección, tocá **Publicar la app** para pasarla a "En producción". Si queda en "Prueba", solo pueden ingresar los emails que cargues a mano.
5. Menú **Credenciales**, **Crear credenciales**, **ID de cliente de OAuth**. Tipo **Aplicación web**.
6. En **Orígenes autorizados de JavaScript** agregá la dirección de tu app, por ejemplo `https://taximetroarg-production.up.railway.app` (sin barra al final). No hace falta cargar URI de redireccionamiento.
7. Copiá el **ID de cliente** (termina en `.apps.googleusercontent.com`). No es secreto. Cargalo en Railway como variable `GOOGLE_CLIENT_ID`.

## 2. Mercado Pago
1. Entrá a mercadopago.com.ar/developers, "Tus integraciones", y creá una aplicación (Suscripciones).
2. Copiá el **Access Token** (de prueba mientras probás, de producción para lanzar). Es secreto: no lo pongas en `index.html` ni en GitHub.
3. En la aplicación, sección **Webhooks**, cargá la URL `https://TU-DOMINIO/api/webhook` y marcá el evento **Planes y suscripciones**.

## 3. Servidor
Necesitás un hosting con Node 18+, HTTPS y disco persistente (Railway, Render, un VPS).

Variables de entorno:
```
GOOGLE_CLIENT_ID=xxxxxxxx.apps.googleusercontent.com
MP_ACCESS_TOKEN=APP_USR-xxxxxxxx
BASE_URL=https://TU-DOMINIO
DATA_FILE=/data/data.json
PRICE=5000
```
Arranque: `node server.js`

- `DATA_FILE` tiene que estar dentro del volumen montado (por ejemplo `/data`); si el disco se borra, se pierden los contadores y las suscripciones.
- Si cambiás el precio, cambialo en `PRICE` de `index.html` (solo es el texto que se muestra) y en la variable `PRICE` del servidor (es el que se cobra).

## 4. Cómo funciona
- El usuario ingresa con Google. El servidor verifica el token de Google y le entrega una sesión que dura 6 meses.
- El servidor cuenta sus viajes. Al llegar a 50, la app pide la suscripción.
- El usuario escribe su email de Mercado Pago y paga. Cuando Mercado Pago avisa al webhook, el servidor activa 30 días (más 2 de gracia) y se renueva solo con cada cobro.
- Sin internet la app sigue funcionando; los viajes se envían al servidor cuando vuelve la conexión.

## 5. Probalo antes de lanzar
1. Abrí la app, ingresá con Google y hacé un viaje en modo simulación: el cartel tiene que pasar a 49.
2. Hacé un Redeploy en Railway: tiene que seguir en 49 (el disco funciona).
3. Desinstalá o borrá los datos del navegador, volvé a ingresar con la misma cuenta: tiene que seguir en 49.
4. Con credenciales de prueba de Mercado Pago, hacé una suscripción de punta a punta con la cuenta de comprador de prueba y mirá que la app pase a "Suscripción hasta …".

## Límites a tener en cuenta
- Una persona puede crear otra cuenta de Google gratis y obtener otros 50 viajes. Atar la prueba a la cuenta sube la barrera, pero no la elimina. Si más adelante hace falta algo más estricto, se puede pedir verificación por teléfono o limitar la prueba a un solo dispositivo.
- Google no deja ingresar desde navegadores internos de otras apps (por ejemplo, abrir el link dentro de WhatsApp). La pantalla de ingreso avisa que hay que abrirlo en Chrome o Safari.
- Los datos de los usuarios (email y nombre de su cuenta de Google) quedan guardados en `data.json`. Si lanzás al público, conviene tener una política de privacidad.
