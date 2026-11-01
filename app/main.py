import asyncio
import json
import time
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

# Load .env before importing modules that read environment variables at import time.
load_dotenv()

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

# Locally we run "uvicorn app.main:app" (package import); Vercel loads app/main.py
# with the app/ directory itself on sys.path (flat import). Support both.
try:
    from app import ai
    from app.connection import manager
    from app.processor import AudioPipeline
except ImportError:
    import ai
    from connection import manager
    from processor import AudioPipeline

app = FastAPI(title="Vani.ai API")

# Resolve files from the repo root, not the process's working directory, so the
# app serves the same files under uvicorn locally and inside a Vercel Function.
BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "static"

ALLOWED_REACTIONS = {"❤️", "👏", "🤔", "🚀"}
REACTION_MIN_INTERVAL_S = 0.25  # per viewer, so one person can't flood the host


# ==========================================
# 🧠 AI: summary and audience Q&A
# ==========================================
class TranscriptData(BaseModel):
    # Limits protect the Gemini quota from empty or huge requests.
    full_text: str = Field(min_length=1, max_length=60_000)


class QuestionData(BaseModel):
    question: str = Field(min_length=1, max_length=500)
    transcript: str = Field(default="", max_length=60_000)


@app.post("/generate_summary")
async def generate_summary(data: TranscriptData):
    summary, source = await ai.summarize(data.full_text)
    return {"summary": summary, "source": source}


@app.post("/ask")
async def ask(data: QuestionData):
    if not data.transcript.strip():
        return {"answer": "The talk hasn't produced any captions yet. Ask again once the speaker has started.", "source": "none"}
    answer, source = await ai.answer(data.transcript, data.question)
    return {"answer": answer, "source": source}


# ==========================================
# ✉️ Contact form (landing page)
# ==========================================
class ContactData(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    email: str = Field(min_length=3, max_length=200, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
    message: str = Field(min_length=1, max_length=4000)


@app.post("/contact")
async def contact(data: ContactData):
    entry = json.dumps({**data.model_dump(), "received_at": datetime.now(timezone.utc).isoformat()})
    print(f"✉️ Contact message from {data.name} <{data.email}>")
    try:
        stored = await manager.save_contact_message(entry)
    except Exception as e:
        print(f"❌ Could not store contact message: {e}")
        raise HTTPException(status_code=503, detail="Message could not be sent right now. Please try again later.")
    if not stored:
        # No Redis configured (local development): the log line above is the only record.
        print(f"✉️ (not stored, no REDIS_URL) {entry}")
    return {"ok": True}


# Mount frontend files (for your CSS, JS, and Images)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

# ==========================================
# 🌐 HTML PAGE ROUTES
# ==========================================
@app.get("/")
@app.get("/index.html")
async def serve_index():
    return FileResponse(STATIC_DIR / "index.html")

@app.get("/presenter.html")
async def serve_presenter():
    return FileResponse(STATIC_DIR / "presenter.html")

@app.get("/audience.html")
async def serve_audience():
    return FileResponse(STATIC_DIR / "audience.html")

@app.get("/legal.html")
async def serve_legal():
    return FileResponse(STATIC_DIR / "legal.html")

@app.get("/edge_test.html")
async def serve_edge():
    return FileResponse(BASE_DIR / "edge_test.html")


def _clean_glossary(raw):
    """Speechmatics additional_vocab: short strings only, capped in size."""
    if not isinstance(raw, list):
        return []
    words = [str(w).strip()[:60] for w in raw if str(w).strip()]
    return list(dict.fromkeys(words))[:100]


# ==========================================
# 🎤 WEBSOCKETS
# ==========================================
@app.websocket("/ws/audio")
async def audio_endpoint(websocket: WebSocket):
    await websocket.accept()
    print("🎤 Presenter Connected")

    room = "default"
    pipeline = None
    host_task = None

    try:
        # Catch the initial handshake from the frontend
        config_msg = await websocket.receive_text()
        config = json.loads(config_msg)
        room = str(config.get("room") or "default")[:40]

        # Initialize the AI Engine
        pipeline = AudioPipeline(
            source_lang=config.get("source", "en"),
            target_lang=config.get("target", "hi"),
            glossary=_clean_glossary(config.get("glossary", [])),
            room=room,  # Get room ID from config
            manager=manager  # Pass manager to pipeline
        )
        print(f"⚙️ Active Session: {pipeline.source_lang} -> {pipeline.target_lang}")
        print(f"📚 Glossary loaded: {pipeline.glossary}")
        print(f"🎪 Streaming to room: {pipeline.room}")

        # Audience reactions travel back to this presenter while the session runs.
        host_task = asyncio.create_task(manager.host_feed(room, websocket))

        # Start processing the stream
        await pipeline.process_stream(websocket)

    except WebSocketDisconnect:
        print("⚠️ Presenter Disconnected")
    except Exception as e:
        print(f"❌ Pipeline error: {e}")
    finally:
        if host_task:
            host_task.cancel()
        # Tell the room the session is over, but only when the host pressed Stop.
        # Vercel closes every WebSocket at maxDuration; the presenter page then
        # reconnects, and the audience shouldn't see "Stream ended" in between.
        if pipeline and pipeline.ended_by_host:
            await manager.broadcast(room, json.dumps({"type": "system", "message": "Stream Ended"}))


@app.websocket("/ws/audience/{room}")
async def audience_endpoint(websocket: WebSocket, room: str):
    await manager.connect(room, websocket)
    last_reaction = 0.0
    try:
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except ValueError:
                continue  # plain keep-alive text
            if not isinstance(msg, dict) or msg.get("type") != "reaction":
                continue
            emoji = msg.get("emoji")
            now = time.monotonic()
            if emoji in ALLOWED_REACTIONS and now - last_reaction >= REACTION_MIN_INTERVAL_S:
                last_reaction = now
                delivered = await manager.publish_to_host(room, json.dumps({"type": "reaction", "emoji": emoji}))
                if not delivered:
                    # Let the viewer know instead of silently dropping it.
                    await websocket.send_text(json.dumps({"type": "reaction_status", "delivered": False}))
    except WebSocketDisconnect:
        pass
    except Exception as e:
        print(f"⚠️ Audience socket error: {e}")
    finally:
        manager.disconnect(room, websocket)
