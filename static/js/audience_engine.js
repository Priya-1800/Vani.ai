let ws;
let isPaused = false;
let intentionalClose = false; // set by "Leave" so onclose doesn't report a connection loss
let sentenceBuffer = ""; // Buffer to hold the current sentence being formed

// Vercel closes every WebSocket when the function reaches maxDuration (300 s in
// vercel.json), and networks drop, so viewers reconnect to the room on their own.
const MAX_RECONNECT_ATTEMPTS = 8;
let currentRoom = null;
let reconnectAttempts = 0;
let reconnectTimer = null;

// What this viewer has seen, for Export, History and the Vani Bot.
let audienceSession = null;   // { id, startedAt, room }
let spokenSentences = [];     // original sentences only (bot context)
let transcriptLines = [];     // sentence + translation, as exported
let lastReactionSent = 0;

function saveAudienceSession() {
    if (!audienceSession || !transcriptLines.length) return;
    VaniStore.saveSession({ ...audienceSession, role: 'client', text: transcriptLines.join('\n') });
}
window.addEventListener('beforeunload', saveAudienceSession);
const HEALTHY_MS = 10000; // a socket that stayed up this long resets the retry budget

// 🪄 THE HACKATHON CHEAT CODE: Free, instant browser-side translation (WITH TIMEOUT FAIL-SAFE)
async function fetchTranslation(text, targetLang) {
    if (!text || !targetLang) return text;
    
    try {
        // Create an AbortController to kill the request if it takes longer than 2 seconds
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2000);

        // sl=auto so the host can speak any language, not just English.
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${targetLang}&dt=t&q=${encodeURIComponent(text)}`;
        const response = await fetch(url, { signal: controller.signal });
        
        clearTimeout(timeoutId); // Clear the timeout if it succeeds
        
        if (!response.ok) throw new Error("Translation API rate limited.");
        
        const data = await response.json();
        return data[0][0][0]; 
    } catch (error) {
        console.warn("Translation skipped (timeout or rate limit):", error.message);
        return "⚠️ [Translation paused to prevent rate-limit]"; // Shows a graceful error instead of freezing
    }
}

function setPanelsJoined(joined) {
    const panel = document.getElementById('join-panel');
    const live = document.getElementById('live-area');

    if (panel) panel.classList.toggle('is-visible', !joined);
    if (live) live.classList.toggle('is-visible', joined);
}

function leaveSession() {
    saveAudienceSession();
    if (transcriptLines.length) Vani.toast('Session saved. Open it any time from the history icon.', 'success');
    audienceSession = null;
    spokenSentences = [];
    transcriptLines = [];
    intentionalClose = true;
    clearTimeout(reconnectTimer);
    currentRoom = null;
    if (ws) { try { ws.close(); } catch (e) { /* already closed */ } }
    ws = null;
    sentenceBuffer = '';

    const finalSpan = document.getElementById('final-span');
    const partialSpan = document.getElementById('partial-span');
    if (finalSpan) finalSpan.innerHTML = '';
    if (partialSpan) partialSpan.innerText = '';

    const joinBtn = document.getElementById('joinBtn');
    if (joinBtn) { joinBtn.disabled = false; joinBtn.innerText = 'Join'; }

    const badge = document.getElementById('status-badge');
    if (badge) { badge.innerText = 'Not connected'; badge.className = 'status-offline'; }

    const hint = document.getElementById('aud-hint');
    if (hint) { hint.style.display = ''; hint.innerText = 'Waiting for the host to start speaking...'; }

    setPanelsJoined(false);
}

function joinStream() {
    // 🛡️ EDGE FALLBACK INTERCEPTOR
    if (!navigator.onLine) {
        alert("No internet connection detected. Switching to local Edge processing...");
        window.location.href = "edge_test.html";
        return; // Stops the WebSocket from trying to connect
    }

    const codeInput = document.getElementById('join-code');
    const joinBtn = document.getElementById('joinBtn');
    const statusBadge = document.getElementById('status-badge');

    const room = (codeInput.value || '').trim().toUpperCase();
    if (!room) {
        codeInput.focus();
        return;
    }
    codeInput.value = room;

    joinBtn.disabled = true;
    joinBtn.innerText = "Connecting...";
    setPanelsJoined(true);

    clearTimeout(reconnectTimer);
    currentRoom = room;
    reconnectAttempts = 0;
    if (!audienceSession || audienceSession.room !== room) {
        saveAudienceSession();
        audienceSession = { id: VaniStore.newId(), startedAt: new Date().toISOString(), room: room };
        spokenSentences = [];
        transcriptLines = [];
    }
    openAudienceSocket(room);
}

function openAudienceSocket(room) {
    const joinBtn = document.getElementById('joinBtn');
    const statusBadge = document.getElementById('status-badge');

    // Same host the page was served from, so local dev and Vercel both work (wss on https).
    const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${wsProtocol}//${location.host}/ws/audience/${encodeURIComponent(room)}`);
    ws = socket;

    let openedAt = 0;

    socket.onopen = () => {
        openedAt = Date.now();
        statusBadge.innerText = `Live · ${room}`;
        statusBadge.className = "status-live";
        joinBtn.innerText = "Joined";
        joinBtn.disabled = false;

        const hint = document.getElementById('aud-hint');
        if (hint) hint.innerText = "Connected. Waiting for the host to start speaking...";
    };

    socket.onmessage = async (event) => {
        if (isPaused) return; 

        try {
            const data = JSON.parse(event.data);
            
            // 🛑 Catch the stream ended signal
            if (data.type === 'system' && data.message === 'Stream Ended') {
                const statusBadge = document.getElementById('status-badge');
                if (statusBadge) {
                    statusBadge.innerText = "Stream ended";
                    statusBadge.className = "status-offline";
                }
                saveAudienceSession();
                return;
            }

            // First real caption replaces the waiting hint.
            const hint = document.getElementById('aud-hint');
            if (hint) hint.style.display = 'none';

            const finalSpan = document.getElementById('final-span');
            const partialSpan = document.getElementById('partial-span');
            const display = document.getElementById('live-transcript');
            
            const langDropdown = document.getElementById('target-lang') || document.getElementById('language-select');
            const targetLang = langDropdown ? langDropdown.value : 'hi';
            
            const translateCheckbox = document.getElementById('aud-translate-toggle');
            const showTranslation = translateCheckbox && translateCheckbox.checked;

            const incomingText = data.original || data.text || "";
            const speakerName = data.speaker || "Speaker"; 
            const cleanText = incomingText.trim();

            if (!cleanText) return;

            // 1. Handle fast typing text (Grey)
            if (data.type === 'partial') {
                if (partialSpan) partialSpan.innerText = Vani.joinText(sentenceBuffer, cleanText);
                return;
            }

            // 2. Handle final locked-in chunks
            if (data.type === 'final' || (!data.type && cleanText !== "")) {
                
                // Add the new word/chunk to our buffer
                sentenceBuffer = Vani.joinText(sentenceBuffer, cleanText);

                // 🧠 Check if this chunk has a period, question mark, or exclamation mark
                const isEndOfSentence = /[.!?]/.test(cleanText);

                if (isEndOfSentence) {
                    // 🎉 WE HAVE A COMPLETE SENTENCE!
                    const completeSentence = sentenceBuffer;
                    sentenceBuffer = ""; // Reset the buffer for the next sentence
                    if (partialSpan) partialSpan.innerText = ''; // Clear the grey text

                    // Build the unified UI block
                    let blockHTML = `
                        <div style="margin-top: 10px; padding: 10px 14px; background: #ffffff; border-radius: 6px; border-left: 3px solid #cbd5e1; box-shadow: 0 1px 2px rgba(0,0,0,0.05); font-family: system-ui, -apple-system, sans-serif;">
                            <div style="color: #334155; font-size: 15px; line-height: 1.5; font-weight: 400; display: flex; align-items: flex-start; gap: 8px;">
                                <span style="flex-shrink: 0; font-size: 11px; font-weight: 600; color: #64748b; background: #f1f5f9; padding: 2px 6px; border-radius: 4px; letter-spacing: 0.5px;">
                                    <i class="fas fa-microphone-alt" style="margin-right: 3px;"></i>${Vani.escapeHtml(speakerName)}
                                </span>
                                <span style="color: #0f172a;">${Vani.escapeHtml(completeSentence)}</span>
                            </div>`;

                    spokenSentences.push(completeSentence);
                    let exportLine = `${speakerName}: ${completeSentence}`;

                    // Translate ONLY the complete sentence (saves API calls & improves accuracy!)
                    if (showTranslation) {
                        const translatedText = await fetchTranslation(completeSentence, targetLang);
                        const isSameLanguage = translatedText.trim().toLowerCase() === completeSentence.trim().toLowerCase();

                        // Skip the line when target == spoken language, so English rooms
                        // don't print every sentence twice.
                        if (!isSameLanguage) {
                            exportLine += `\n    → ${translatedText}`;
                            blockHTML += `
                                <div style="margin-top: 6px; color: #2563eb; font-size: 14px; line-height: 1.5; padding-left: 12px; border-left: 2px solid #bfdbfe; font-weight: 500; margin-left: 2px;">
                                    ${Vani.escapeHtml(translatedText)}
                                </div>`;
                        }
                    }

                    blockHTML += `</div>`;
                    transcriptLines.push(exportLine);

                    // Append the bundled block to the screen
                    if (finalSpan) {
                        finalSpan.innerHTML += blockHTML;
                        if (display) display.scrollTop = display.scrollHeight;
                    }

                } else {
                    // ⏳ It is a chunk, but NOT the end of the sentence.
                    // Show it in the grey span so the audience sees it instantly, but wait for the period!
                    if (partialSpan) {
                        partialSpan.innerText = sentenceBuffer + " ...";
                        if (display) display.scrollTop = display.scrollHeight;
                    }
                }
            }
        } catch (e) {
            console.error("Error parsing message:", e);
        }
    };

    socket.onclose = () => {
        if (intentionalClose) { intentionalClose = false; return; }
        // A newer socket (Rejoin, or a reconnect) already replaced this one.
        if (ws !== socket || currentRoom !== room) return;

        // Reset only after a healthy connection; resetting on open would loop
        // forever, with no delay, against a server that accepts and then closes.
        if (openedAt && Date.now() - openedAt > HEALTHY_MS) reconnectAttempts = 0;

        if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            const delay = reconnectAttempts === 0 ? 0 : Math.min(500 * 2 ** reconnectAttempts, 10000);
            reconnectAttempts += 1;
            statusBadge.innerText = "Reconnecting...";
            statusBadge.className = "status-offline";
            reconnectTimer = setTimeout(() => openAudienceSocket(room), delay);
            return;
        }

        statusBadge.innerText = "Connection lost";
        statusBadge.className = "status-offline";
        joinBtn.disabled = false;
        joinBtn.innerText = "Rejoin";
    };
}

// Pre-fill (and auto-join) when the host shares an ?code= link.
window.addEventListener('load', () => {
    const codeInput = document.getElementById('join-code');
    const shared = new URLSearchParams(location.search).get('code');

    if (shared) {
        codeInput.value = shared.trim().toUpperCase();
        joinStream();
    } else {
        codeInput.focus();
    }
});

function toggleFeed() {
    const pauseBtn = document.getElementById('pauseBtn');
    isPaused = !isPaused;
    
    if (isPaused) {
        pauseBtn.innerHTML = '<i class="fas fa-play"></i> Resume Feed';
        pauseBtn.style.background = "#3b82f6";
    } else {
        pauseBtn.innerHTML = '<i class="fas fa-pause"></i> Pause Feed';
        pauseBtn.style.background = "#000000"; 
    }
}

// 🤖 VANI BOT: ask questions about what the speaker has said so far
const botHistory = [];

function openAudienceBot() {
    const wrap = document.createElement('div');
    const log = document.createElement('div');
    log.className = 'bot-log';

    const addMsg = (who, text) => {
        const m = document.createElement('div');
        m.className = `bot-msg bot-msg-${who}`;
        m.textContent = text;
        log.appendChild(m);
        log.scrollTop = log.scrollHeight;
        return m;
    };

    if (!botHistory.length) {
        botHistory.push({ who: 'bot', text: "Hi! Ask me anything about what the speaker has said so far, e.g. \"What was the main point?\"" });
    }
    botHistory.forEach(m => addMsg(m.who, m.text));

    const row = document.createElement('form');
    row.className = 'bot-input-row';
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 500;
    input.placeholder = 'Ask about the talk...';
    const send = document.createElement('button');
    send.type = 'submit';
    send.className = 'vani-btn vani-btn-primary';
    send.textContent = 'Ask';
    row.append(input, send);

    row.addEventListener('submit', async (e) => {
        e.preventDefault();
        const question = input.value.trim();
        if (!question) return;
        input.value = '';
        botHistory.push({ who: 'user', text: question });
        addMsg('user', question);
        const pending = addMsg('bot', 'Thinking...');
        send.disabled = true;

        const transcript = [...spokenSentences, sentenceBuffer].filter(Boolean).join(' ');
        let reply;
        try {
            const res = await fetch('/ask', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ question, transcript: transcript.slice(-60000) }),
            });
            const data = await res.json();
            reply = res.ok ? data.answer : "Sorry, I couldn't answer that right now.";
        } catch (err) {
            reply = "I can't reach the server right now. Check your connection and try again.";
        }
        pending.textContent = reply;
        botHistory.push({ who: 'bot', text: reply });
        send.disabled = false;
        input.focus();
    });

    wrap.append(log, row);
    Vani.openModal('Vani Bot', wrap);
}

// 🎈 FLOATING EMOJI ANIMATION LOGIC
window.sendReaction = function(emoji) {
    // Send to the host's screen (rate-limited here and on the server).
    const now = Date.now();
    if (ws && ws.readyState === WebSocket.OPEN && now - lastReactionSent > 300) {
        lastReactionSent = now;
        ws.send(JSON.stringify({ type: 'reaction', emoji: emoji }));
    } else if (!ws || ws.readyState !== WebSocket.OPEN) {
        Vani.toast('Join a session to send reactions to the host.');
    }

    const floater = document.createElement('div');
    floater.innerText = emoji;
    floater.style.position = 'fixed';
    
    // Randomize starting position slightly around the center
    const randomLeft = Math.floor(Math.random() * 20) + 40; 
    floater.style.left = randomLeft + '%';
    
    floater.style.bottom = '80px';
    floater.style.fontSize = '35px';
    floater.style.pointerEvents = 'none'; // So it doesn't block clicks
    floater.style.transition = 'all 2s cubic-bezier(0.25, 1, 0.5, 1)';
    floater.style.opacity = '1';
    floater.style.zIndex = '99';
    document.body.appendChild(floater);

    // Trigger the float up and fade out
    setTimeout(() => {
        floater.style.bottom = '400px'; // How high it floats
        floater.style.opacity = '0';
        floater.style.transform = `translateX(${Math.random() * 100 - 50}px) rotate(${Math.random() * 45 - 20}deg)`;
    }, 50);

    // Clean up the DOM after animation finishes
    setTimeout(() => {
        floater.remove();
    }, 2000);
};

// 💾 EXPORT TRANSCRIPT LOGIC
window.exportTranscript = function(filename = "Vani_Transcript.txt") {
    if (!transcriptLines.length) {
        Vani.toast("No transcript to export yet.", 'error');
        return;
    }
    Vani.downloadText(filename, Vani.formatSession({
        ...(audienceSession || {}),
        text: transcriptLines.join('\n'),
    }));
};
