from app.main import app

if __name__ == "__main__":
    import os

    import uvicorn

    host = os.environ.get("TEACHQRS_HOST", "0.0.0.0")
    port = int(os.environ.get("TEACHQRS_PORT", "8765"))
    uvicorn.run(app, host=host, port=port)
