# Vani.ai

Real-time multilingual captioning for talks and meetings. A presenter speaks, the audience sees live text in their own room, and Gemini can turn the transcript into a summary with action items.

Built as a final-year capstone (team of four) and presented at ImCReTE 2026 in the paper *“Vani.ai Next Generation Multilingual Streaming Using Websockets and Edge Fallback”*. This repository is the software platform; it is under active development (see the roadmap).

## What it does today

- Streams the presenter’s microphone audio over a WebSocket to a FastAPI backend.
- Forwards the audio to the Speechmatics real-time API with speaker diarization, a custom glossary (`additional_vocab`) and partial results for fast on-screen text.
- Sends partial and final transcripts (with speaker labels) back to the presenter and broadcasts them to every audience page in the same room.
- Translation to the audience’s language happens in the browser.
- `POST /generate_summary` asks Gemini 2.5 Flash for an executive summary and action items.

## Architecture

```mermaid
flowchart LR
    P[Presenter browser<br/>presenter.html] -- "PCM 16 kHz over /ws/audio" --> A[FastAPI<br/>main.py]
    A --> R[AudioPipeline<br/>processor.py]
    R -- "WebSocket" --> S[(Speechmatics<br/>real-time API)]
    S -- "partial / final text + speaker" --> R
    R --> P
    R --> M[ConnectionManager<br/>connection.py]
    M -- "/ws/audience/{room}" --> U[Audience browsers<br/>audience.html]
    P -- "POST /generate_summary" --> A
    A --> G[(Gemini API)]
```

## Quick start

```bash
git clone https://github.com/Priya-1800/Vani.ai.git
cd Vani.ai
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env               # then fill in your keys
uvicorn main:app --reload
```

Open `http://localhost:8000/presenter.html` to present and `http://localhost:8000/audience.html` to watch.

## Configuration

| Variable | Purpose |
|---|---|
| `SPEECHMATICS_API_KEY` | Speechmatics real-time API token |
| `SPEECHMATICS_URL` | Speechmatics real-time WebSocket URL for your region |
| `GEMINI_API_KEY` | Gemini API key for summaries |
| `APP_API_KEY` | Optional. If set, `/generate_summary` requires an `X-API-Key` header |

## API

| Route | Type | Description |
|---|---|---|
| `/presenter.html`, `/audience.html`, `/edge_test.html` | GET | Frontend pages |
| `/ws/audio` | WebSocket | Presenter audio. First message is JSON: `{"source": "en", "target": "hi", "glossary": [], "room": "default"}`, then binary PCM |
| `/ws/audience/{room}` | WebSocket | Audience stream for a room |
| `/generate_summary` | POST | Body `{"full_text": "..."}` returns `{"summary": "..."}` |

## Roadmap

- [x] Real-time captions with speaker labels, glossary and audience rooms
- [x] Gemini summary and action items
- [ ] Phase 0: cleanup, README, pinned dependencies, secured summary endpoint
- [ ] Phase 1: SQLite persistence for meetings, utterances and summaries
- [ ] Phase 2: multi-agent analysis with LangGraph (cleaner, summarizer, action items, JA↔EN translator, critic)
- [ ] Phase 3: question answering over past meetings (FAISS)
- [ ] Phase 4: evaluation against the single-prompt baseline
- [ ] Phase 5: Docker, docker-compose and CI
- [ ] Phase 6: cloud deployment and demo

## Author

Priya Thakur · [GitHub](https://github.com/Priya-1800) · [LinkedIn](https://www.linkedin.com/in/priya-thakur-8701a1272)

Licensed under the MIT License.
