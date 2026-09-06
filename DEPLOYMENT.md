# 🚀 Deploying RESQ to Render (Backend) and Vercel (Frontend)

This guide provides step-by-step instructions to deploy the full **RESQ** disaster simulation platform:
- **Backend (FastAPI + WebSockets + Physics Engine)** &rarr; **[Render](https://render.com)**
- **Frontend (Vanilla HTML/CSS/JS + OpenFreeMap 3D)** &rarr; **[Vercel](https://vercel.com)**

---

## 🏗️ Architecture Summary

`
                      ┌────────────────────────────────────────┐
                      │             Vercel (Frontend)          │
                      │  https://your-resq.vercel.app          │
                      └───────┬────────────────────────┬───────┘
                              │                        │
               REST HTTP      │                        │  Persistent WSS
         (Requests & Data)    │                        │  (Tick Telemetry)
                              ▼                        ▼
                      ┌────────────────────────────────────────┐
                      │             Render (Backend)           │
                      │  https://resq-backend.onrender.com     │
                      │  wss://resq-backend.onrender.com       │
                      └────────────────────────────────────────┘
`

---

## Step 1: Deploy the Backend on Render

The backend requires a persistent Python environment with WebSocket support. Render provides this on its free tier.

### Option A: Using Render Blueprints (Recommended — 1 Click)
1. Log in to your **[Render Dashboard](https://dashboard.render.com/)**.
2. Click **New +** &rarr; **Blueprint**.
3. Connect your GitHub repository (https://github.com/divfy/ResQ).
4. Render will automatically detect 
ender.yaml and configure:
   - **Service Name**: 
esq-backend
   - **Environment**: Python 3.11
   - **Build Command**: `pip install -r backend/requirements.txt`
   - **Start Command**: `python run.py`
   - **Health Check**: `/healthz`
5. Click **Apply**. Render will build and deploy your service.

### Option B: Manual Web Service Setup
1. In the **[Render Dashboard](https://dashboard.render.com/)**, click **New +** &rarr; **Web Service**.
2. Select **Build and deploy from a Git repository** and pick `divfy/ResQ`.
3. Configure the fields:
   - **Name**: `resq-backend` (or any unique name)
   - **Region**: Choose the closest region (e.g. *Singapore* or *Oregon*)
   - **Branch**: `main`
   - **Root Directory**: *(Leave empty)*
   - **Runtime**: `Python 3`
   - **Build Command**: `pip install -r backend/requirements.txt`
   - **Start Command**: `python run.py`
   - **Instance Type**: `Free`
4. Expand **Advanced**:
   - **Health Check Path**: /healthz
   - **Auto-Deploy**: Yes
5. Click **Create Web Service**.

Once deployed, copy your Render URL from the top of the dashboard:  
👉 **https://resq-backend-xxxx.onrender.com**

---

## Step 2: Connect Frontend to Your Render Backend

Open config.js in your project repository and set your Render URL:

`javascript
// config.js
(function () {
    const RESQ_BACKEND_URL = "https://resq-backend-xxxx.onrender.com"; // <-- Paste your Render URL here

    if (RESQ_BACKEND_URL) {
        const cleanUrl = RESQ_BACKEND_URL.replace(/\/+$/, "");
        window.RESQ_API_URL = ${cleanUrl}/api/v1;
        window.RESQ_WS_URL = cleanUrl.replace(/^http/, "ws");
    }
})();
`

> **Note**: If RESQ_BACKEND_URL is empty, the client automatically defaults to http://localhost:8000 for local development.

Commit and push this change to GitHub:
`ash
git add config.js
git commit -m "chore: set production Render backend URL"
git push origin main
`

---

## Step 3: Deploy the Frontend on Vercel

1. Log in to **[Vercel](https://vercel.com)**.
2. Click **Add New...** &rarr; **Project**.
3. Import your GitHub repository (divfy/ResQ).
4. Configure Project Settings:
   - **Framework Preset**: Other
   - **Root Directory**: ./ (leave default)
   - **Build and Output Settings**:
     - *Build Command*: Leave empty / default
     - *Output Directory*: Leave empty / default
5. Click **Deploy**.

Within 30 seconds, Vercel will deploy your frontend and assign a live production URL:  
👉 **https://your-resq-project.vercel.app**

---

## 💡 Important Production Tips

### 1. Render Free Tier Spin-up (Cold Starts)
- Free instances on Render spin down after 15 minutes of inactivity.
- When you first load the app after an idle period, the backend may take **30–50 seconds** to spin up.
- **Tip**: You can use a free monitoring service like [UptimeRobot](https://uptimerobot.com) or [cron-job.org](https://cron-job.org) to ping your health check endpoint (https://resq-backend-xxxx.onrender.com/healthz) every 10 minutes to keep it permanently awake!

### 2. Zero-Token 3D Map (OpenFreeMap)
- The 3D map uses **OpenFreeMap** and requires **no API keys, tokens, or credit cards**. It works globally out-of-the-box on your Vercel deployment.

### 3. Testing Your Live Deployment
1. Visit your Vercel URL: https://your-resq-project.vercel.app.
2. Select **India** &rarr; **Chennai** &rarr; **Tsunami**.
3. Click **INITIALIZE SIMULATION →**.
4. On the Command Dashboard, click **▶ START SIMULATION**.
5. You should see real-time WebSocket telemetry updates, cascading failure alerts, and evacuation routes updating live!
