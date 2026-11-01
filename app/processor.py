import os
import json
import asyncio
import websockets
from fastapi import WebSocketDisconnect

try:
    from .connection import manager
except ImportError:
    from connection import manager

class AudioPipeline:
    def __init__(self, source_lang, target_lang, glossary, room="default", manager=None):
        self.source_lang = source_lang
        self.target_lang = target_lang # (Kept for compatibility, but translation happens in browser now!)
        self.glossary = glossary
        self.room = room
        self.manager = manager
        self.current_speaker = "Unknown Speaker"

    async def _notify(self, client_ws, stage, message):
        """Best-effort status frame for the host screen; never breaks the stream."""
        try:
            await client_ws.send_text(json.dumps({
                "type": "status",
                "stage": stage,
                "message": message,
            }))
        except Exception:
            pass

    
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

                # Let the host screen show real pipeline states instead of a static badge.
                await self._notify(client_ws, "connected", "Speechmatics session open")

                # 2. TASK: Forward Audio (Silenced to stop terminal spam)
                first_frame_logged = False
                frame_count = 0
                byte_count = 0

                async def forward_audio():
                    nonlocal first_frame_logged, frame_count, byte_count
                    try:
                        while True:
                            message = await client_ws.receive()
                            if message.get("type") == "websocket.disconnect":
                                break

                            # Control messages ("Stream Ended") arrive as text; only
                            # binary frames are audio for Speechmatics.
                            chunk = message.get("bytes")
                            if chunk:
                                await sm_ws.send(chunk)
                                frame_count += 1
                                byte_count += len(chunk)

                                if not first_frame_logged:
                                    first_frame_logged = True
                                    print(f"🎧 First audio frame from the browser: {len(chunk)} bytes")
                                    await self._notify(client_ws, "audio", "Audio flowing")

                                if frame_count == 200:
                                    print(f"🎧 10s of audio received ({byte_count / 32000:.1f}s)")
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
                                reason = data.get("type") or data.get("reason") or "unknown error"
                                await self._notify(client_ws, "error", f"Speechmatics: {reason}")
                            
                            # Stream the fast, live typing words
                            if message_type == "AddPartialTranscript":
                                results = data.get("results", [])
                                if results:
                                    partial_text = " ".join([r["alternatives"][0]["content"] for r in results])
                                    payload = {"type": "partial", "original": partial_text}
                                    
                                    # Send to Presenter Screen (NEW LINE)
                                    await client_ws.send_text(json.dumps(payload))
                                    
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
                                    
                                    # Send to Presenter Screen (NEW LINE)
                                    await client_ws.send_text(json.dumps(payload))
                                    
                                    if self.manager:
                                        await self.manager.broadcast(self.room, json.dumps(payload))
                                        
                    except websockets.exceptions.ConnectionClosed as e:
                        print(f"⚠️ Speechmatics closed the connection: {e}")
                    except Exception as e:
                        print(f"❌ Process Text Crashed: {e}")

                # 4. RUN TASKS
                print("🚀 Engine is running! Waiting for audio...")
                forward_task = asyncio.create_task(forward_audio())
                text_task = asyncio.create_task(process_text())

                # If either side stops, tear down the other instead of hanging on a
                # Speechmatics socket that is still open.
                _, pending = await asyncio.wait(
                    {forward_task, text_task}, return_when=asyncio.FIRST_COMPLETED
                )
                for task in pending:
                    task.cancel()
                
        except Exception as e:
            print(f"❌ Fatal Speechmatics Error: {e}")