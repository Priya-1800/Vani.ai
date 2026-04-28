import os
import json
import asyncio
import websockets
from .connection import manager
from fastapi import WebSocketDisconnect

class AudioPipeline:
    def __init__(self, source_lang, target_lang, glossary, room="default", manager=None):
        self.source_lang = source_lang
        self.target_lang = target_lang # (Kept for compatibility, but translation happens in browser now!)
        self.glossary = glossary
        self.room = room
        self.manager = manager
        self.current_speaker = "Unknown Speaker"
        
    async def process_stream(self, client_ws):
        SM_URL = os.getenv("SPEECHMATICS_URL")
        SM_TOKEN = os.getenv("SPEECHMATICS_API_KEY")
        
        print(f"🔗 Attempting to connect to Speechmatics...")
        
        try:
            async with websockets.connect(SM_URL, additional_headers={"Authorization": f"Bearer {SM_TOKEN}"}) as sm_ws:
                print("✅ Connected to Speechmatics Cloud!")
                
                # 1. INJECT CONFIG
                formatted_vocab = [{"content": word} for word in self.glossary]
                start_config = {
                    "message": "StartRecognition",
                    "audio_format": {"type": "raw", "encoding": "pcm_s16le", "sample_rate": 16000},
                    "transcription_config": {
                        "language": self.source_lang,
                        "diarization": "speaker",
                        "additional_vocab": formatted_vocab,
                        "enable_partials": True  # <--- CRITICAL FOR FAST TYPING
                    }
                }
                await sm_ws.send(json.dumps(start_config))
                print("✅ Configuration sent to AI!")

                # 2. TASK: Forward Audio (Silenced to stop terminal spam)
                async def forward_audio():
                    try:
                        while True:
                            data = await client_ws.receive_bytes()
                            await sm_ws.send(data)
                    except WebSocketDisconnect:
                        print("⚠️ Presenter disconnected (Browser tab closed).")
                    except Exception as e:
                        print(f"❌ Forward Audio Crashed: {e}")

                # 3. TASK: Receive Text
                async def process_text():
                    try:
                        while True:
                            res = await sm_ws.recv()
                            data = json.loads(res)
                            message_type = data.get("message")
                            
                            # SILENCE THE SPAM: Only print errors!
                            if message_type == "Error":
                                print(f"🚨 SPEECHMATICS ERROR: {data}")
                            
                            # Stream the fast, live typing words
                            if message_type == "AddPartialTranscript":
                                results = data.get("results", [])
                                if results:
                                    partial_text = " ".join([r["alternatives"][0]["content"] for r in results])
                                    payload = {"type": "partial", "original": partial_text}
                                    if self.manager:
                                        await self.manager.broadcast(self.room, json.dumps(payload))

                            # Lock in the final sentence when the speaker pauses
                            elif message_type == "AddTranscript":
                                results = data.get("results", [])
                                if results:
                                    final_text = " ".join([r["alternatives"][0]["content"] for r in results])
                                    speaker = results[0].get("speaker", "Unknown Speaker")
                                    
                                    # ONLY print the final spoken text to the terminal!
                                    print(f"🗣️ [{speaker}]: {final_text}")
                                    
                                    payload = {
                                        "type": "final",
                                        "speaker": speaker,
                                        "original": final_text
                                    }
                                    if self.manager:
                                        await self.manager.broadcast(self.room, json.dumps(payload))
                                        
                    except websockets.exceptions.ConnectionClosed as e:
                        print(f"⚠️ Speechmatics closed the connection: {e}")
                    except Exception as e:
                        print(f"❌ Process Text Crashed: {e}")

                # 4. RUN TASKS
                print("🚀 Engine is running! Waiting for audio...")
                await asyncio.gather(forward_audio(), process_text())
                
        except Exception as e:
            print(f"❌ Fatal Speechmatics Error: {e}")