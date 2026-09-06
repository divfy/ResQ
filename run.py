"""
Production Entrypoint for RESQ Backend (Render / Docker / Local).
Safely reads and binds to \ provided by hosting environments.
"""
import os
import uvicorn

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    host = os.environ.get("HOST", "0.0.0.0")
    print(f"[RESQ] Starting server on {host}:{port}...")
    uvicorn.run("backend.app.main:app", host=host, port=port)
