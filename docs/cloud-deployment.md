# MayaCardio — Free Cloud Deployment Guide (§1, §5 #1)

This guide documents deploying the MayaCardio Cloud Backend (`@mayacardio/cloud-api`) to real free-tier cloud providers without incurring any cost, compliant with the assessment rules.

## Recommended Free-Tier Cloud Providers

| Provider | Service | Free Tier Limits | Suitability for MayaCardio |
|---|---|---|---|
| **Render** | Fastify Web Service + PostgreSQL | 750 free instance hours/month, 1GB PostgreSQL | Excellent for single-board evaluation |
| **Fly.io** | Container App + PostgreSQL Lite | Free allowance (shared CPU, 256MB RAM) | Minimal latency, globally distributed |
| **Supabase** | Managed PostgreSQL Database | 500 MB storage, free pooled connections | High-performance managed Postgres backend |

---

## Deployment Option A: Self-Contained Local / Test Server

For local verification, CI/CD, or automated judging runs without internet:
```bash
# Terminal 1: Launch cloud API with embedded storage
npm run cloud
```
The server binds to `0.0.0.0:8080` with zero configuration.

---

## Deployment Option B: Render (Fastify + Managed PostgreSQL)

### 1. Provision Free PostgreSQL
1. Create a free account at [render.com](https://render.com).
2. Click **New +** -> **PostgreSQL**.
3. Name: `mayacardio-db`.
4. Plan: **Free**.
5. Copy the **Internal Database URL** (or External URL).

### 2. Deploy Web Service
1. Connect this GitHub repository.
2. Select **Web Service**.
3. Environment: `Node`.
4. Build Command: `npm install && npm run build`
5. Start Command: `npm run cloud`
6. Add Environment Variables:
   - `DATABASE_URL`: `<YOUR_RENDER_POSTGRES_URL>`
   - `CLOUD_API_KEY`: `mayacardio-edge-secret-token-2026`
   - `LOG_LEVEL`: `info`
7. Click **Create Web Service**.

Once deployed, copy the service URL (e.g. `https://mayacardio-cloud.onrender.com`).

---

## Configuring the Bedside Raspberry Pi Board

On the Raspberry Pi bedside device, set `.env`:
```env
CLOUD_API_URL=https://mayacardio-cloud.onrender.com
CLOUD_API_KEY=mayacardio-edge-secret-token-2026
```
Test connectivity from device:
```bash
curl -i https://mayacardio-cloud.onrender.com/health
```
Output:
`{"status":"ok","uptime":...,"timestamp":"..."}`
