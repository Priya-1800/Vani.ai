import asyncio
import os
from typing import Dict, Optional, Set

from fastapi import WebSocket

try:
    import redis.asyncio as aioredis
except ImportError:  # redis is only needed when REDIS_URL is set
    aioredis = None

CHANNEL_PREFIX = "vani:room:"


def _redis_url() -> Optional[str]:
    # Vercel Marketplace Redis integrations expose REDIS_URL (some older KV/Upstash
    # setups expose KV_URL). Read lazily so load_dotenv() in main.py has already run.
    return os.getenv("REDIS_URL") or os.getenv("KV_URL")


class ConnectionManager:
    """Audience sockets grouped by room.

    On Vercel the presenter and each viewer can land on different function
    instances, so an in-memory list only reaches viewers on the presenter's
    instance. When REDIS_URL is set, broadcast() publishes to a Redis channel per
    room and every instance that holds viewers of that room forwards the message
    to them. Without REDIS_URL (local dev, single uvicorn process) messages are
    delivered in memory.
    """

    def __init__(self):
        self.rooms: Dict[str, Set[WebSocket]] = {}
        self._listeners: Dict[str, asyncio.Task] = {}
        self._redis = None
        self._redis_checked = False

    def _client(self):
        if not self._redis_checked:
            self._redis_checked = True
            url = _redis_url()
            if url:
                if aioredis is None:
                    print("⚠️ REDIS_URL is set but the redis package is not installed; rooms stay in memory.")
                else:
                    self._redis = aioredis.from_url(url, decode_responses=True, health_check_interval=30)
                    print("🧩 Rooms are shared through Redis pub/sub.")
        return self._redis

    async def connect(self, room: str, websocket: WebSocket):
        await websocket.accept()
        self.rooms.setdefault(room, set()).add(websocket)
        print(f"📺 Audience joined room '{room}'. Viewers on this instance: {len(self.rooms[room])}")

        if self._client() and room not in self._listeners:
            self._listeners[room] = asyncio.create_task(self._listen(room))

    def disconnect(self, room: str, websocket: WebSocket):
        viewers = self.rooms.get(room)
        if viewers is None:
            return
        viewers.discard(websocket)
        print(f"📺 Audience left room '{room}'. Viewers on this instance: {len(viewers)}")
        if not viewers:
            del self.rooms[room]
            listener = self._listeners.pop(room, None)
            if listener:
                listener.cancel()

    async def broadcast(self, room: str, message: str):
        """Send a message to every viewer of the room, on any instance."""
        client = self._client()
        if client:
            try:
                await client.publish(CHANNEL_PREFIX + room, message)
                return
            except Exception as e:
                # Don't drop captions for local viewers just because Redis hiccupped.
                print(f"⚠️ Redis publish failed, delivering locally only: {e}")
        await self._send_local(room, message)

    async def _send_local(self, room: str, message: str):
        for connection in list(self.rooms.get(room, ())):
            try:
                await connection.send_text(message)
            except Exception as e:
                print(f"⚠️ Dropping dead viewer socket: {e}")
                self.disconnect(room, connection)

    async def _listen(self, room: str):
        """Forward this room's Redis messages to the viewers held by this instance."""
        delay = 1
        while room in self.rooms:
            pubsub = self._redis.pubsub()
            try:
                await pubsub.subscribe(CHANNEL_PREFIX + room)
                delay = 1
                async for item in pubsub.listen():
                    if item.get("type") == "message":
                        await self._send_local(room, item["data"])
                await asyncio.sleep(delay)  # listen() ended without an error; don't spin
            except asyncio.CancelledError:
                raise
            except Exception as e:
                print(f"⚠️ Redis subscription for room '{room}' dropped, retrying in {delay}s: {e}")
                await asyncio.sleep(delay)
                delay = min(delay * 2, 30)
            finally:
                try:
                    await pubsub.aclose()
                except Exception:
                    pass


manager = ConnectionManager()
