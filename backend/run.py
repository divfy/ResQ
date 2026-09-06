"""
Backend-scoped Entrypoint for RESQ Backend.
"""
import os
import uvicorn

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    host = os.environ.get("HOST", "0.0.0.0")
    print(f"[RESQ] Starting backend on {host}:{port}...")
    try:
        from app.main import app
        uvicorn.run("app.main:app", host=host, port=port)
    except ImportError:
        from backend.app.main import app
        uvicorn.run("backend.app.main:app", host=host, port=port)
