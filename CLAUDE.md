# Kaleide-enrollment — Claude Context

## Project
Public-facing enrollment wizard (admissions.kaleide.org). Families submit applications anonymously; data lands in the AppSheet tables shared with the KMS.

## Stack
- **Google Apps Script** backend (`backend/Code.js`) — manifest `executeAs: USER_DEPLOYING`, `access: ANYONE_ANONYMOUS`. This is the inverse of the KMS (USER_ACCESSING + DOMAIN) and the two cannot share a single GAS project — see DL-E23.
- **Static frontend** (`frontend/`) served from the wizard's deployment URL.

## Deployment

The wizard is served from a **fixed deployment URL**. `clasp push` only updates Head — users hit the deployment URL, which is frozen until redeployed.

```bash
# From backend/
clasp push --force
clasp deploy \
  --deploymentId AKfycbyzyAR6J3_2UAiE6tCyNHVawoGfMNNbZEaurp99cRI76IYbiqGVEeQQcTxsgAqUFnGk0w \
  -d "<short description of the change>"
```

**Never create a new deployment** — always update the existing one above. A new deployment yields a new URL and breaks `admissions.kaleide.org`.

### Auto-deploy via GitHub Actions (CI backend-deploy job)

`.github/workflows/deploy.yml` includes a `backend-deploy` job that runs `clasp push --force` + `clasp deploy --deploymentId` on every push to `main`. It requires a GitHub secret:

- **`CLASP_TOKEN`**: JSON content of `~/.clasprc.json` from Diego's local machine (contains OAuth refresh token). Add via: GitHub repo → Settings → Secrets → Actions → New secret → name `CLASP_TOKEN` → paste the full contents of `~/.clasprc.json`.

Without this secret the job fails silently — the frontend-deploy (Pages) is unaffected.

### Smoke test lección (2026-05-29)

Calling the GAS web app directly via `curl` from Cloud Shell consistently returns a Dutch "Kan het bestand momenteel niet openen" Google Drive error page even though `access: ANYONE_ANONYMOUS` is set. Root cause unclear (possible: deployment predates webapp manifest config, or CI/Cloud Shell IP blocked). **Smoke tests must be done from a browser** — Diego opens the `admissions.kaleide.org` URL and checks the network tab, or hits the deployment URL directly. The Cloud Shell curl path is unreliable for GAS web apps.

## Email sending

Transactional emails (application received, etc.) use `GmailApp.sendEmail` with `from: ADMISSIONS_EMAIL` so they appear from `admissions@kaleide.org` instead of the deploying account. This requires `admissions@kaleide.org` to be configured as a **"Send mail as" alias** in the deploying Gmail account (Settings → Accounts → Send mail as). Without the alias, Gmail silently falls back to the deploying account address.

## Autonomy — main branch

Diego has authorized Claude Code to proceed without prior confirmation for any git and clasp operation on `main`, mirroring the kis-app autonomy directive:

- `git add`, `git commit`, `git push` on `main`
- `clasp push --force` (from `backend/`)
- `clasp deploy --deploymentId AKfycbyzyAR6J3_2UAiE6tCyNHVawoGfMNNbZEaurp99cRI76IYbiqGVEeQQcTxsgAqUFnGk0w -d "..."`

Still requires confirmation:
- `clasp create` (new GAS project)
- Creating a new deployment (would change the URL)
