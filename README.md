---
title: Stylish Customer Care
emoji: 🧰
colorFrom: gray
colorTo: yellow
sdk: docker
app_port: 7860
pinned: false
---

# Stylish · Customer Care App

App de Customer Care con IA para **Stylish International** (marcas STYLISH y Sinks Direct).
Reemplaza el artefacto de Claude por una app real: el **servidor** habla directo con
Zoho Desk, Dropbox y la API de Gemini — sin diálogos de permiso, sin CORS y sin pasos
manuales en el chat.

## Qué hace

- **Dashboard** — métricas en vivo (tickets abiertos, artículos de KB, estado de conectores).
- **Inbox** — trae los tickets de Zoho Desk, **redacta la respuesta automáticamente** con la
  Knowledge Base aprobada, la podés editar y **"Approve & Send" la envía directo al cliente**
  (vía `sendReply`, no como borrador). Se **auto-actualiza cada 30 s**.
- **Knowledge Base** — 11 artículos de arranque con CRUD completo y **etiquetas de color por
  finish** (Stainless Steel, Graphite Black, Brushed Nickel, Polished Chrome, Gold, Gun Metal,
  Matte Black, Pearl White, Granite Composite).

## Arquitectura

```
stylish-care-app/
├── server/            ← Node + Express (Zoho, Dropbox, Gemini, KB)
│   ├── index.js       ← arranque, rutas, polling de tickets
│   ├── zoho.js        ← OAuth + listar/leer/responder tickets
│   ├── gemini.js      ← genera el borrador con la KB
│   ├── kb.js          ← almacén de la KB en archivo JSON
│   ├── dropbox.js     ← (opcional) manuales de instalación
│   └── routes/
├── client/            ← React + Vite (Dashboard, Inbox, KB)
└── .env.example       ← copiar a .env y completar
```

El frontend nunca toca Zoho ni Gemini directamente: todo pasa por el servidor.
Por eso desaparecen los problemas del artefacto (MCP colgado, CORS, refresco imposible).

---

## 1. Instalar

Necesitás **Node.js 18 o superior**.

```bash
cd stylish-care-app
npm run install:all        # instala servidor + cliente
cp .env.example .env        # luego edita .env con tus claves
```

## 2. Configurar `.env`

### Gemini
- `GEMINI_API_KEY` — tu clave de la API (aistudio.google.com/apikey).
- `GEMINI_MODEL` — opcional, por defecto `gemini-2.5-flash`.

### Zoho Desk
Necesitás un **refresh token** de OAuth. En **api-console.zoho.com** (o `.ca` si tu cuenta
está en el data center de Canadá):

1. Crea un cliente tipo **Self Client** → **Generate Code**.
2. Scope: `Desk.tickets.ALL,Desk.basic.READ,Desk.search.READ`
3. Copia el `code` y canjéalo por un refresh token (una sola vez):

```bash
curl -X POST "https://accounts.zoho.com/oauth/v2/token" \
  -d "grant_type=authorization_code" \
  -d "client_id=TU_CLIENT_ID" \
  -d "client_secret=TU_CLIENT_SECRET" \
  -d "code=EL_CODE_GENERADO"
```

La respuesta trae `refresh_token`. Pégalo en `.env` junto con el client id/secret.
Los demás valores (`ZOHO_ORG_ID`, `ZOHO_DEPARTMENT_ID`, `ZOHO_FROM_ADDRESS`) ya vienen
con los datos de Stylish.

> **Data center de Canadá:** si tu Zoho vive en `.ca`, cambia en `.env`:
> `ZOHO_API_BASE=https://desk.zohocloud.ca/api/v1` y
> `ZOHO_ACCOUNTS_BASE=https://accounts.zohocloud.ca/oauth/v2`

### Dropbox (opcional)
- `DROPBOX_ACCESS_TOKEN` — token de una app de Dropbox (dropbox.com/developers).
- `DROPBOX_MANUALS_PATH` — carpeta de los manuales, ej. `/Installation Manuals`.

## 3. Correr

```bash
npm run dev
```

- Frontend: http://localhost:5173
- API: http://localhost:8787

Ambos arrancan juntos. El servidor sincroniza tickets cada `POLL_INTERVAL_SECONDS`.

## 4. Producción / despliegue

```bash
npm run build     # compila el cliente
npm start         # sirve cliente + API desde el puerto 8787
```

Lo podés desplegar en cualquier servicio que corra Node (Render, Railway, Fly.io, un VPS).
Subí las variables de entorno en el panel del servicio. **No subas el archivo `.env` a git.**

---

## Notas

- El contenido de la KB en `server/kb-seed.json` es un punto de partida — reemplazalo con
  el **texto de política aprobado** de stylishkb.com y sinksdirect.ca. Los cambios que hagas
  desde la pestaña KB se guardan en `server/kb-data.json`.
- Si la IA no encuentra respuesta en la KB, marca el ticket como **"Needs human review"** y
  redacta solo un acuse, en vez de inventar políticas.
- El borrador respeta el idioma del cliente (inglés o español) automáticamente.
