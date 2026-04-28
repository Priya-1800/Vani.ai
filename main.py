import json
import google.generativeai as genai
from fastapi import FastAPI
from pydantic import BaseModel
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse # 👈 NEW: Added this import!
from dotenv import load_dotenv
from connection import manager
from processor import AudioPipeline

load_dotenv()
app = FastAPI()

# Fetch the API key safely from the environment
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")

if GEMINI_API_KEY:
    genai.configure(api_key=GEMINI_API_KEY)

class TranscriptData(BaseModel):
    full_text: str

@app.post("/generate_summary")
async def generate_summary(data: TranscriptData):
    # Initialize the Gemini model
    model = genai.GenerativeModel('gemini-1.5-flash')
    
    # Create the prompt for the AI
    prompt = f"""
    You are an AI assistant for a global engineering team. 
    Read the following meeting transcript and generate:
    1. A short executive summary.
    2. A bulleted list of Action Items.
    
    Transcript: {data.full_text}
    """
    
    # Generate the response
    response = model.generate_content(prompt)
    
    return {"summary": response.text}

# Mount frontend files (for your CSS, JS, and Images)
app.mount("/static", StaticFiles(directory="static"), name="static")

# ==========================================
# 🌐 HTML PAGE ROUTES 
# ==========================================
# We add TWO routes for the homepage so both work perfectly!
@app.get("/")
@app.get("/index.html")
async def serve_index():
    return FileResponse("index.html")

@app.get("/presenter.html")
async def serve_presenter():
    return FileResponse("presenter.html")

@app.get("/audience.html")
async def serve_audience():
    return FileResponse("audience.html")

@app.get("/edge_test.html")
async def serve_edge():
    return FileResponse("edge_test.html")
# ==========================================
@app.websocket("/ws/audio")
async def audio_endpoint(websocket: WebSocket):
    await websocket.accept()
    print("🎤 Presenter Connected")
    
    try:
        # Catch the initial handshake from the frontend
        config_msg = await websocket.receive_text()
        config = json.loads(config_msg)
        
        # Initialize the AI Engine
        pipeline = AudioPipeline(
            source_lang=config.get("source", "en"),
            target_lang=config.get("target", "hi"),
            glossary=config.get("glossary", []),
            room=config.get("room", "default"),  # Get room ID from config
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

@app.websocket("/ws/audience/{room}")
async def audience_endpoint(websocket: WebSocket, room: str):
    await manager.connect(room, websocket)
    try:
        while True:
            await websocket.receive_text() # Keep-alive
    except WebSocketDisconnect:
        manager.disconnect(room, websocket)
