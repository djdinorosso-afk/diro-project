# AGENTS.md

## Cursor Cloud specific instructions

### What this is
Single Node.js service: `diro-telegram-oracle` (`server.js`). It's an Express web server that also
runs a Telegram bot (Grammy, webhook-only) and talks to Polygon smart contracts via ethers v5. It
serves static pages from `public/` (`pricing.html`, `wallet.html`, `claim.html`) and a small REST API
(`/health`, `/rewards/:walletAddr`, `POST /mark-claimed`, `/webhook`). There is no database — state is
persisted to `wallets.json` and `rewards.json` on disk (both gitignored).

### Run / lint / test / build
- Run (dev): `npm start` (= `node server.js`), listens on `PORT` (default `3000`). Script is in `package.json`.
- Lint / test / build: none exist (no test runner, no linter, no build/bundler step, no TypeScript).

### Non-obvious setup/run caveats
- The server needs a `.env` (gitignored) or it will crash at startup. `server.js` constructs the ethers
  `Wallet` and `Contract`s and the Grammy `Bot` at module load, so `PRIVATE_KEY` must be a valid hex key
  and `REGISTRY_ADDRESS` / `SUBSCRIPTION_ADDRESS` / `MONITOR_ADDRESS` must be valid addresses, or it throws.
  `WEBHOOK_URL` must be set or the process calls `process.exit(1)` in `setupWebhook()`.
- For local dev without real Telegram/Polygon credentials, dummy-but-valid `.env` values are enough to bring
  up the HTTP server, static pages, and REST API. Required keys: `TELEGRAM_BOT_TOKEN`, `WEBHOOK_URL`,
  `RPC_URL`, `PRIVATE_KEY`, `REGISTRY_ADDRESS`, `SUBSCRIPTION_ADDRESS`, `MONITOR_ADDRESS` (plus optional `PORT`).
  With a dummy bot token, startup logs `Ошибка установки вебхука ... 401: Unauthorized` — this is expected
  and non-fatal (the error is caught and the server keeps serving).
- `wallets.json` and `rewards.json` are read into memory only at startup. Editing those files while the
  server is running has no effect until you restart the process. `POST /mark-claimed` mutates the in-memory
  store and rewrites `rewards.json`.
- Full end-to-end (real Telegram updates, on-chain metric submission, subscription checks, reward claims)
  requires external credentials that are not in the repo: a real `TELEGRAM_BOT_TOKEN`, a funded Polygon hot
  wallet `PRIVATE_KEY`, deployed contract addresses, a public HTTPS `WEBHOOK_URL` (e.g. a tunnel), and browser
  MetaMask on Polygon. The browser pages (`pricing.html`, `wallet.html`) auto-call `connect()` and only render
  plans / rewards after a MetaMask connection.
