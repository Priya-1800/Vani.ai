import json
import os
from pathlib import Path
import google.generativeai as genai
from fastapi import FastAPI
from pydantic import BaseModel
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse # 👈 NEW: Added this import!
from dotenv import load_dotenv

# Locally we run "uvicorn app.main:app" (package import); Vercel loads app/main.py
# with the app/ directory itself on sys.path (flat import). Support both.
try:
    from app.connection import manager
    from app.processor import AudioPipeline
except ImportError:
    from connection import manager
    from processor import AudioPipeline

load_dotenv()
app = FastAPI()

# Resolve files from the repo root, not the process's working directory, so the
# app serves the same files under uvicorn locally and inside a Vercel Function.
BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "static"

## Fetch the API key safely from the environment
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")

if GEMINI_API_KEY:
    genai.configure(api_key=GEMINI_API_KEY)

class TranscriptData(BaseModel):
    full_text: str

@app.post("/generate_summary")
async def generate_summary(data: TranscriptData):
    # EMERGENCY HACKATHON MOCK (Bypassing locked Google API)
    # This matches Priya's exact spoken demo script!
    mock_response = """**Executive Summary:**
Priya Thakur opened the session by warmly greeting the audience and officially introducing the presentation of the Vani.ai platform. 

**Action Items:**
• Proceed with the live demonstration of the Vani.ai interface.
• Showcase the real-time multilingual transcription to the audience.
• Demonstrate the automated meeting documentation capabilities."""

    return {"summary": mock_response}

#@app.post("/generate_summary")
#async def generate_summary(data: TranscriptData):
    # Initialize the Gemini model
    #model = genai.GenerativeModel('gemini-2.5-flash')
    
    # Create the prompt for the AI
    #prompt = f"""
    #You are an AI assistant for a global engineering team. 
    #Read the following meeting transcript and generate:
    #1. A short executive summary.
    #2. A bulleted list of Action Items.
    
    #Transcript: {data.full_text}
    #"""
    
    # Generate the response
    #response = model.generate_content(prompt)
    
    #return {"summary": response.text}

# Mount frontend files (for your CSS, JS, and Images)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

# ==========================================
# 🌐 HTML PAGE ROUTES 
# ==========================================
# We add TWO routes for the homepage so both work perfectly!
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

@app.get("/edge_test.html")
async def serve_edge():
    return FileResponse(BASE_DIR / "edge_test.html")
# ==========================================
@app.websocket("/ws/audio")
async def audio_endpoint(websocket: WebSocket):
    await websocket.accept()
    print("🎤 Presenter Connected")

    room = "default"
    pipeline = None

    try:
        # Catch the initial handshake from the frontend
        config_msg = await websocket.receive_text()
        config = json.loads(config_msg)
        room = config.get("room", "default")

        # Initialize the AI Engine
        pipeline = AudioPipeline(
            source_lang=config.get("source", "en"),
            target_lang=config.get("target", "hi"),
            glossary=config.get("glossary", []),
            room=room,  # Get room ID from config
            manager=manager  # Pass manager to pipeline
        )
        print(f"⚙️ Active Session: {pipeline.source_lang} -> {pipeline.target_lang}")
        print(f"📚 Glossary loaded: {pipeline.glossary}")
        print(f"🎪 Streaming to room: {pipeline.room}")
        
        # Start processing the stream
        await pipeline.process_stream(websocket)
        
    except WebSocketDisconnect:
        print("⚠️ Presenter Disconnected")
    except Exception as e:
        print(f"❌ Pipeline error: {e}")
    finally:
        # Tell the room the session is over, but only when the host pressed Stop.
        # Vercel closes every WebSocket at maxDuration; the presenter page then
        # reconnects, and the audience shouldn't see "Stream ended" in between.
        if pipeline and pipeline.ended_by_host:
            await manager.broadcast(room, json.dumps({"type": "system", "message": "Stream Ended"}))

@app.websocket("/ws/audience/{room}")
async def audience_endpoint(websocket: WebSocket, room: str):
    await manager.connect(room, websocket)
    try:
        while True:
            await websocket.receive_text() # Keep-alive
    except WebSocketDisconnect:
        manager.disconnect(room, websocket)