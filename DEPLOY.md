# Deploy EagleEye so the live site actually works

Your backend (`server.js`) **also serves the dashboard**, so the simplest setup is to
deploy the backend once — that one URL runs the website *and* the API together, with
no CORS and no Backend-URL field to set.

---

## Option A (recommended): one deploy on Render — website + API together

You need a free GitHub account and a free Render account.

### 1. Put the code on GitHub
From this project folder:
```bash
git init
git add server.js package.json public .nvmrc Dockerfile Procfile render.yaml .gitignore
git commit -m "EagleEye backend"
```
Create an empty repo on github.com, then:
```bash
git remote add origin https://github.com/<you>/eagleeye.git
git branch -M main
git push -u origin main
```

### 2. Deploy on Render
1. Go to https://dashboard.render.com → **New** → **Web Service**.
2. Connect the GitHub repo you just pushed.
3. Render reads `render.yaml` automatically. If it asks, set:
   - **Runtime:** Node
   - **Build command:** `npm install`
   - **Start command:** `node server.js`
   - **Health check path:** `/healthz`
4. Click **Create Web Service**. After ~1 minute you get a URL like
   `https://eagleeye-backend.onrender.com`.

### 3. Done
Open that Render URL — the **dashboard loads and sign-in works**, because the API is
on the same URL. Create your parent account there.

The device agents (`eagleeye_config.json`) should point `serverUrl` at this Render URL
instead of `http://localhost:4000`.

> Free-tier note: Render's free disk is **ephemeral** — if the service restarts, the
> database resets (accounts gone). For permanent data, add a paid **Disk** mounted at
> `/data` and set the env var `DB_PATH=/data/eagleeye.db` (see `render.yaml`).

---

## Option B: keep the Netlify site, backend separate

1. Deploy the backend as in Option A (you get the Render URL).
2. Set the backend's CORS to your Netlify origin: on Render add env var
   `CORS_ORIGIN = https://eagleeye2026.netlify.app`.
3. Open your Netlify site, and on the sign-in screen put the Render URL in the
   **Backend URL** field. It's saved in your browser.

---

## Railway instead of Render

1. Install the CLI: `npm i -g @railway/cli`, then `railway login`.
2. From this folder: `railway init` then `railway up`.
3. In the Railway dashboard, open the service → **Settings → Networking → Generate
   Domain**. That URL serves the dashboard + API. Add a **Volume** for persistent data
   and set `DB_PATH=/data/eagleeye.db`.

---

## Docker (any host: Fly.io, a VPS, etc.)

```bash
docker build -t eagleeye .
docker run -p 4000:4000 -v eagleeye-data:/data -e DB_PATH=/data/eagleeye.db eagleeye
```

---

## After deploying — security checklist
- Set `CORS_ORIGIN` to your exact site URL (not `*`).
- The host already gives you HTTPS — keep it.
- Point every device agent's `serverUrl` at the deployed URL.
