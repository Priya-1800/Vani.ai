"""Gemini helpers for the meeting summary and the audience Q&A bot.

Both features fall back to a simple text-only answer when Gemini is not
configured or the call fails, so the buttons always return something useful
and say which path produced it.
"""
import asyncio
import os
import re

from google import genai
from google.genai import errors as genai_errors

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
# Optional pin. Google retires model names regularly (gemini-2.5-flash started
# returning 404 in late 2026), so by default the newest stable "gemini-X.Y-flash"
# model that this API key can use is picked automatically.
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "").strip()
GEMINI_TIMEOUT_S = 25

_client = genai.Client(api_key=GEMINI_API_KEY) if GEMINI_API_KEY else None
_model_name = None  # cached choice for this function instance
_STABLE_FLASH = re.compile(r"^gemini-(\d+(?:\.\d+)*)-flash$")

SUMMARY_PROMPT = """You are an AI assistant for a global engineering team.
Read the following meeting transcript and generate:
1. A short executive summary.
2. A bulleted list of Action Items.

Use plain text with "Executive Summary:" and "Action Items:" headings.

Transcript:
{transcript}
"""

ASK_PROMPT = """You answer questions from people watching a live talk.
Answer ONLY from the transcript below. If the answer is not in the transcript,
say that the speaker has not covered it yet. Keep the answer under 80 words.

Transcript:
{transcript}

Question: {question}
"""

ACTION_HINTS = re.compile(
    r"\b(will|need to|needs to|should|must|have to|has to|let's|lets|todo|to-do|action|follow up|deadline|by (monday|tuesday|wednesday|thursday|friday|tomorrow|next week))\b",
    re.IGNORECASE,
)
STOPWORDS = set(
    "a an the and or but if of to in on at for with by from is are was were be been it this that "
    "these those i you he she we they what who whom which when where why how do does did can could "
    "would should will shall may might about as into than then there here so not no yes your my our".split()
)


def choose_model(available, pinned=""):
    """Pick a model from the names this key can use for generateContent.

    The pinned GEMINI_MODEL wins if it's available; otherwise the highest-versioned
    stable flash model (no -lite/-preview/-image suffix); otherwise any flash model.
    """
    if pinned and pinned in available:
        return pinned
    stable = []
    for name in available:
        match = _STABLE_FLASH.match(name)
        if match:
            stable.append((tuple(int(x) for x in match.group(1).split(".")), name))
    if stable:
        return max(stable)[1]
    flash = sorted(n for n in available if n.startswith("gemini-") and "flash" in n)
    if flash:
        return flash[-1]
    raise RuntimeError("No Gemini text model is available for this API key")


async def _resolve_model():
    global _model_name
    if _model_name is None:
        available = []
        async for model in await _client.aio.models.list():
            if "generateContent" in (model.supported_actions or []):
                available.append(model.name.removeprefix("models/"))
        _model_name = choose_model(available, GEMINI_MODEL)
        if GEMINI_MODEL and _model_name != GEMINI_MODEL:
            print(f"⚠️ GEMINI_MODEL={GEMINI_MODEL} is not available; using {_model_name}")
        print(f"🧠 Using Gemini model {_model_name}")
    return _model_name


async def _generate(prompt: str) -> str:
    model = await _resolve_model()
    response = await _client.aio.models.generate_content(model=model, contents=prompt)
    text = (response.text or "").strip()
    if not text:
        raise RuntimeError("Gemini returned an empty response")
    return text


async def _gemini(prompt: str) -> str:
    global _model_name
    if not _client:
        raise RuntimeError("GEMINI_API_KEY is not set")
    try:
        return await asyncio.wait_for(_generate(prompt), GEMINI_TIMEOUT_S)
    except genai_errors.ClientError as e:
        if getattr(e, "code", None) != 404:
            raise
        # The cached model was retired while this instance was running: pick again once.
        _model_name = None
        return await asyncio.wait_for(_generate(prompt), GEMINI_TIMEOUT_S)


def _sentences(text: str):
    parts = re.split(r"(?<=[.!?])\s+", text.strip())
    return [p.strip() for p in parts if len(p.strip().split()) >= 3]


def fallback_summary(transcript: str) -> str:
    sentences = _sentences(transcript) or [transcript.strip()]
    overview = " ".join(sentences[:3])
    actions = [s for s in sentences if ACTION_HINTS.search(s)][:6]
    lines = ["Executive Summary:", overview, "", "Action Items:"]
    lines += [f"• {a}" for a in actions] if actions else ["• No explicit action items were mentioned."]
    return "\n".join(lines)


def fallback_answer(transcript: str, question: str) -> str:
    words = {w for w in re.findall(r"[a-zA-Z0-9']+", question.lower()) if w not in STOPWORDS and len(w) > 2}
    if not words:
        return "Please ask a more specific question about the talk."
    scored = []
    for sentence in _sentences(transcript):
        overlap = len(words & set(re.findall(r"[a-zA-Z0-9']+", sentence.lower())))
        if overlap:
            scored.append((overlap, sentence))
    if not scored:
        return "The speaker hasn't covered that yet, as far as the transcript shows."
    scored.sort(key=lambda x: -x[0])
    return "From the transcript: " + " ".join(s for _, s in scored[:2])


async def summarize(transcript: str):
    """Returns (summary_text, source) where source is 'gemini' or 'fallback'."""
    try:
        return await _gemini(SUMMARY_PROMPT.format(transcript=transcript)), "gemini"
    except Exception as e:
        print(f"⚠️ Gemini summary failed, using fallback: {type(e).__name__}: {e}")
        return fallback_summary(transcript), "fallback"


async def answer(transcript: str, question: str):
    """Returns (answer_text, source) where source is 'gemini' or 'fallback'."""
    try:
        return await _gemini(ASK_PROMPT.format(transcript=transcript, question=question)), "gemini"
    except Exception as e:
        print(f"⚠️ Gemini answer failed, using fallback: {type(e).__name__}: {e}")
        return fallback_answer(transcript, question), "fallback"
