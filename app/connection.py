import asyncio
import os
from typing import Dict, Optional, Set

from fastapi import WebSocket

try:
    import redis.asyncio as aioredis
except ImportError:  # redis is only needed when REDIS_URL is set
    aioredis = None

CHANNEL_PREFIX = "vani:room:"   # presenter -> audience (captions)
HOST_PREFIX = "vani:host:"      # audience -> presenter (reactions)


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
        self.hosts: Dict[str, Set[WebSocket]] = {}  # presenter sockets on this instance
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
            self._listeners[room] = asyncio.create_task(
                self._subscribe(CHANNEL_PREFIX + room, lambda m: self._send_local(room, m), lambda: room in self.rooms)
            )

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

    async def publish_to_host(self, room: str, message: str) -> int:
        """Send an audience message (e.g. a reaction) to the room's presenter, on any instance.

        Returns how many presenter sessions received it (0 = host not live).
        """
        client = self._client()
        if client:
            try:
                # PUBLISH returns the number of subscribers, i.e. live host sessions.
                return int(await client.publish(HOST_PREFIX + room, message))
            except Exception as e:
                print(f"⚠️ Redis publish to host failed, delivering locally only: {e}")
        delivered = 0
        for host in list(self.hosts.get(room, ())):
            try:
                await host.send_text(message)
                delivered += 1
            except Exception:
                self.hosts.get(room, set()).discard(host)
        return delivered

    async def host_feed(self, room: str, websocket: WebSocket):
        """Run for the length of a presenter session: deliver audience messages to the host.

        Cancel the task to stop it.
        """
        self.hosts.setdefault(room, set()).add(websocket)
        try:
            if self._client():
                await self._subscribe(HOST_PREFIX + room, websocket.send_text, lambda: True)
            else:
                await asyncio.Event().wait()  # in-memory mode: publish_to_host sends directly
        finally:
            hosts = self.hosts.get(room)
            if hosts is not None:
                hosts.discard(websocket)
                if not hosts:
                    del self.hosts[room]

    async def _subscribe(self, channel: str, deliver, keep_going):
        """Forward messages from a Redis channel to deliver() until keep_going() is False or cancelled."""
        delay = 1
        while keep_going():
            pubsub = self._redis.pubsub()
            try:
                await pubsub.subscribe(channel)
                delay = 1
                async for item in pubsub.listen():
                    if item.get("type") == "message":
                        await deliver(item["data"])
                await asyncio.sleep(delay)  # listen() ended without an error; don't spin
            except asyncio.CancelledError:
                raise
            except Exception as e:
                print(f"⚠️ Redis subscription '{channel}' dropped, retrying in {delay}s: {e}")
                await asyncio.sleep(delay)
                delay = min(delay * 2, 30)
            finally:
                try:
                    await pubsub.aclose()
                except Exception:
                    pass

    async def save_contact_message(self, entry: str) -> bool:
        """Keep the latest contact-form messages in Redis (list vani:contact). False without Redis."""
        client = self._client()
        if not client:
            return False
        await client.lpush("vani:contact", entry)
        await client.ltrim("vani:contact", 0, 499)
        return True


manager = ConnectionManager()
