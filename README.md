# ilist

ilist is a lightweight file sharing site for Cloudflare Workers. It uses a native Worker entrypoint, Workers Assets for the React UI, R2 for files, and D1 for the file index and admin sessions.

## Stack

- Cloudflare native Worker, no Hono
- Workers Assets
- R2 bucket binding: `R2_BUCKET`
- D1 database binding: `DB`
- React + Vite frontend

## Local Setup

Install dependencies:

```bash
npm install
```

Generate a password hash:

```bash
npm run hash-password -- "your-admin-password"
```

Create `.dev.vars` from the example and paste the generated hash:

```bash
cp .dev.vars.example .dev.vars
```

Example:

```env
ADMIN_PASSWORD_HASH=pbkdf2:210000:...
SESSION_SECRET=replace-with-at-least-32-random-characters
```

Create Cloudflare resources and update `wrangler.jsonc` with the real D1 `database_id`:

```bash
wrangler r2 bucket create ilist-files
wrangler d1 create ilist-db
```

Apply migrations:

```bash
wrangler d1 migrations apply ilist-db --local
```

Start local development:

```bash
npm run build
npm run dev
```

Open `/` for the public browser and `/admin` for the admin UI.

## Production Setup

Set production secrets:

```bash
wrangler secret put ADMIN_PASSWORD_HASH
wrangler secret put SESSION_SECRET
```

Apply D1 migrations remotely:

```bash
wrangler d1 migrations apply ilist-db --remote
```

Deploy:

```bash
npm run deploy
```

## API

Public:

- `GET /api/public/tree?prefix=`
- `GET /api/public/object?key=`
- `GET /file/*key`

Admin:

- `POST /api/admin/login`
- `POST /api/admin/logout`
- `GET /api/admin/me`
- `GET /api/admin/objects?prefix=`
- `PUT /api/admin/objects/*key`
- `DELETE /api/admin/objects/*key`
- `PATCH /api/admin/objects/*key`
