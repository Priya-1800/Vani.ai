from fastapi import WebSocket
from typing import List, Dict

class ConnectionManager:
    def __init__(self):
        # Store active audience connections per room
        # rooms[room_id] = [websocket1, websocket2, ...]
        self.rooms: Dict[str, List[WebSocket]] = {}

    async def connect(self, room: str, websocket: WebSocket):
        await websocket.accept()
        if room not in self.rooms:
            self.rooms[room] = []
        self.rooms[room].append(websocket)
        print(f"📺 Audience joined room '{room}'. Total viewers: {len(self.rooms[room])}")

    def disconnect(self, room: str, websocket: WebSocket):
        if room in self.rooms:
            self.rooms[room].remove(websocket)
            print(f"📺 Audience left room '{room}'. Remaining viewers: {len(self.rooms[room])}")
            if len(self.rooms[room]) == 0:
                del self.rooms[room]

    async def broadcast(self, room: str, message: str):
        """Send message only to viewers in the specified room"""
        if room not in self.rooms:
            return
        
        for connection in self.rooms[room]:
            try:
                await connection.send_text(message)
            except Exception as e:
                print(f"⚠️ Failed to send to viewer: {e}")
                # Connection likely dead, will be cleaned up on disconnect

manager = ConnectionManager()