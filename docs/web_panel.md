# Panel web privado

Panel del team en tu propio dominio, con inicio de sesión de Discord: trackers con su horario, raids, upkeep de los TC con cuenta atrás, Deep Sea, mercado y eventos.

## Cómo protege el acceso

- Se entra con **"Entrar con Discord"**. La contraseña se escribe en Discord, nunca en el panel.
- El panel solo pide a Discord tu **identidad** (permiso `identify`): no puede leer tus mensajes, servidores ni nada más.
- Solo entran los **miembros de tu servidor de Discord**, y opcionalmente solo los que tengan un **rol**. Si alguien sale del servidor o pierde el rol, pierde el acceso en menos de un minuto.
- Las claves (`RPP_WEB_CLIENT_SECRET`) solo están en el `.env` de tu VPS. Nunca se envían al navegador ni se guardan en GitHub.
- Todo va por **HTTPS**, con un certificado gratuito que se renueva solo.

## Instalación (una sola vez)

### 1. Porkbun: apunta un subdominio a tu VPS

1. Averigua la IP del VPS: `curl -4 ifconfig.me`
2. En Porkbun: **Domain Management** → tu dominio → **DNS**.
3. Añade un registro:
   - **Type:** `A`
   - **Host:** `rust` (el panel quedará en `rust.tudominio.com`; puedes elegir otro nombre)
   - **Answer:** la IP del VPS
4. Guarda. Suele funcionar en unos minutos.

### 2. Abre los puertos 80 y 443 en el VPS

```bash
ufw status
```

Si sale `Status: active`:

```bash
ufw allow 80/tcp
ufw allow 443/tcp
```

Si tu proveedor tiene un firewall propio en su web (por ejemplo, el *Firewall* de Hetzner Cloud), abre también ahí los puertos TCP 80 y 443.

### 3. Discord Developer Portal

1. Entra en https://discord.com/developers/applications y abre la aplicación de **tu bot**.
2. Ve a **OAuth2**.
3. En **Client Secret** pulsa **Reset Secret** y copia la clave. No afecta al token del bot.
4. En **Redirects**, pulsa **Add Redirect** y pon: `https://rust.tudominio.com/callback` (con tu dominio).
5. Pulsa **Save Changes**.

### 4. `.env` del VPS

```bash
cd /opt/rustplusplus
nano .env
```

Añade al final:

```
RPP_WEB_DOMAIN=rust.tudominio.com
RPP_WEB_CLIENT_SECRET=la_clave_que_copiaste
```

Para que solo entren los que tengan un rol del Discord, añade también:

```
RPP_WEB_ROLE=Team
```

### 5. Arranca el bot con el panel

```bash
docker compose -f compose.prod.yml -f docker-compose.web.yml up -d --build
```

A partir de ahora, usa siempre los dos `-f` al actualizar.

Abre `https://rust.tudominio.com`. La primera vez puede tardar un minuto en salir el candado, mientras se crea el certificado.

## Si ya tienes nginx en el VPS

Si el paso 5 da `failed to bind host port 0.0.0.0:80/tcp: address already in use` y `sudo ss -tlnp | grep ':80 '` muestra `nginx`, usa tu nginx en lugar de Caddy. Así no tocas tus otras webs.

1. Quita el contenedor de Caddy y arranca el bot publicando el panel solo para el propio VPS:

   ```bash
   docker rm -f rpp-web
   cd /opt/rustplusplus
   docker compose -f compose.prod.yml -f docker-compose.nginx.yml up -d --build
   ```

   A partir de ahora, usa estos dos `-f` al actualizar.

2. Crea el sitio en nginx (cambia `rust.tudominio.com` por tu dominio):

   ```bash
   sed 's/rust.tudominio.com/TU_DOMINIO/' web/nginx-rustplusplus.conf > /etc/nginx/sites-available/rustplusplus
   ln -s /etc/nginx/sites-available/rustplusplus /etc/nginx/sites-enabled/
   nginx -t && systemctl reload nginx
   ```

   Si `nginx -t` da error, no recargues: borra el enlace con `rm /etc/nginx/sites-enabled/rustplusplus` y revisa el mensaje.

3. HTTPS con certbot:

   ```bash
   apt install -y certbot python3-certbot-nginx   # solo si no lo tienes
   certbot --nginx -d TU_DOMINIO
   ```

   Certbot añade el certificado al sitio y lo renueva solo.

## Si algo no funciona

- **No carga la web**: comprueba que el registro DNS apunta a la IP correcta (`ping rust.tudominio.com`) y que los puertos 80 y 443 están abiertos.
- **Error al iniciar sesión**: la dirección de *Redirects* en Discord debe ser exactamente `https://rust.tudominio.com/callback`.
- **"Sin acceso"**: esa cuenta de Discord no está en el servidor o no tiene el rol de `RPP_WEB_ROLE`.
- **Ver qué pasa**: `docker logs --tail 50 rpp` y `docker logs --tail 50 rpp-web`.

## Desactivarlo

Quita `RPP_WEB_DOMAIN` y `RPP_WEB_CLIENT_SECRET` del `.env` y arranca solo con `docker compose -f compose.prod.yml up -d --build`. Después, `docker rm -f rpp-web` para parar el contenedor del certificado.
