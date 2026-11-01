# Replace the TranscriptData class and the /generate_summary route in main.py with this code.
# Type it in yourself and read every line: the comments explain what each change fixes.

# --- add to the imports at the top of main.py ---
import logging
from fastapi import Depends, Header, HTTPException
from pydantic import BaseModel, Field

logger = logging.getLogger("vani")

# Optional shared secret. Leave unset in local development, set it before you deploy.
APP_API_KEY = os.getenv("APP_API_KEY")


def require_api_key(x_api_key: str | None = Header(default=None)):
    """Reject the request unless X-API-Key matches APP_API_KEY (only enforced when it is set)."""
    if APP_API_KEY and x_api_key != APP_API_KEY:
        raise HTTPException(status_code=401, detail="Invalid or missing API key")


class TranscriptData(BaseModel):
    # Limits protect your Gemini quota from empty or huge requests.
    full_text: str = Field(min_length=1, max_length=50_000)


SUMMARY_PROMPT = """You are an AI assistant for a global engineering team.
Read the following meeting transcript and generate:
1. A short executive summary.
2. A bulleted list of Action Items.

Transcript:
{transcript}
"""


@app.post("/generate_summary", dependencies=[Depends(require_api_key)])
async def generate_summary(data: TranscriptData):
    if not GEMINI_API_KEY:
        raise HTTPException(status_code=503, detail="Summary service is not configured")

    model = genai.GenerativeModel("gemini-2.5-flash")
    try:
        # generate_content_async does not block the event loop (the old call did).
        response = await model.generate_content_async(
            SUMMARY_PROMPT.format(transcript=data.full_text)
        )
        return {"summary": response.text}
    except Exception:
        logger.exception("Gemini request failed")  # full details go to your logs only
        raise HTTPException(status_code=502, detail="The summary service is temporarily unavailable")
