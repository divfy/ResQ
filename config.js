/**
 * RESQ Client Deployment Configuration
 * 
 * When deploying on Vercel:
 * 1. Deploy your backend on Render first to get your Render URL (e.g. https://resq-backend.onrender.com).
 * 2. Set RESQ_BACKEND_URL below to your Render URL.
 * 3. Commit and push to GitHub. Vercel will automatically redeploy!
 */
(function () {
    // Production Render backend service URL:
    const RESQ_BACKEND_URL = "https://resq-backend-dpxs.onrender.com";

    if (RESQ_BACKEND_URL) {
        const cleanUrl = RESQ_BACKEND_URL.replace(/\/+$/, "");
        window.RESQ_API_URL = ${cleanUrl}/api/v1;
        window.RESQ_WS_URL = cleanUrl.replace(/^http/, "ws");
    }
})();
