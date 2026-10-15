# lume

Command center over the vertis-sync outbound pipelines. A second, independent
Next.js app inside this repo; see `docs/lume/2026-10-14-lume-design.md`.

## Deploy

In the Vercel project settings, set **Root Directory** to `lume`. `vercel.json`
here declares the framework; crons are added by later tasks.

Environment variable names are listed in `.env.example`. Supabase Auth → URL
Configuration must allowlist `<origin>/auth/callback` for `http://localhost:3000`
and the Vercel URL before the magic link can land.

## Develop

```sh
npm install
npm run dev        # http://localhost:3000
npm run lint
npm test           # vitest
npm run build
```

Full README lands in Task 15.
