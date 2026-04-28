let ws;
let isPaused = false;
let sentenceBuffer = ""; // Buffer to hold the current sentence being formed

// 🪄 THE HACKATHON CHEAT CODE: Free, instant browser-side translation (WITH TIMEOUT FAIL-SAFE)
async function fetchTranslation(text, targetLang) {
    if (!text || targetLang === 'en') return text;
    
    try {
        // Create an AbortController to kill the request if it takes longer than 2 seconds
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2000);

        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=${targetLang}&dt=t&q=${encodeURIComponent(text)}`;
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

function joinStream() {
    // 🛡️ EDGE FALLBACK INTERCEPTOR
    if (!navigator.onLine) {
        alert("No internet connection detected. Switching to local Edge processing...");
        window.location.href = "edge_test.html";
        return; // Stops the WebSocket from trying to connect
    }
    
    const name = document.getElementById('viewer-name').value;
    const roomLink = document.getElementById('room-link').value;
    const joinBtn = document.getElementById('joinBtn');
    const statusBadge = document.getElementById('status-badge');
    
    if (!roomLink) {
        document.getElementById('room-link').value = "default";
    }

    joinBtn.disabled = true;
    joinBtn.innerText = "Connecting...";

    const room = document.getElementById('room-link').value || "default";
    
    const ws = new WebSocket(`wss://https://vani-ai-rq34.onrender.com/ws/audience/${room_id}`);

    ws.onopen = () => {
        statusBadge.innerText = "LIVE STREAM CONNECTED";
        statusBadge.className = "status-live";
        joinBtn.innerText = "Joined";
        
        const hint = document.getElementById('aud-hint');
        if (hint) hint.style.display = "none";
    };

    ws.onmessage = async (event) => {
        if (isPaused) return; 

        try {
            const data = JSON.parse(event.data);
            
            // 🛑 Catch the stream ended signal
            if (data.type === 'system' && data.message === 'Stream Ended') {
                const statusBadge = document.getElementById('status-badge');
                if (statusBadge) {
                    statusBadge.innerText = "STREAM ENDED";
                    statusBadge.className = "status-offline";
                    statusBadge.style.background = "#64748b";
                }
                return;
            }

            const finalSpan = document.getElementById('final-span');
            const partialSpan = document.getElementById('partial-span');
            const display = document.getElementById('live-transcript');
            
            const langDropdown = document.getElementById('target-lang');
            const targetLang = langDropdown ? langDropdown.value : 'hi';
            
            const translateCheckbox = document.getElementById('aud-translate-toggle');
            const showTranslation = translateCheckbox && translateCheckbox.checked;

            const incomingText = data.original || data.text || "";
            const speakerName = data.speaker || "Speaker"; 
            const cleanText = incomingText.trim();

            if (!cleanText) return;

            // 1. Handle fast typing text (Grey)
            if (data.type === 'partial') {
                if (partialSpan) partialSpan.innerText = sentenceBuffer + " " + cleanText;
                return;
            }

            // 2. Handle final locked-in chunks
            if (data.type === 'final' || (!data.type && cleanText !== "")) {
                
                // Add the new word/chunk to our buffer
                sentenceBuffer += (sentenceBuffer === "" ? "" : " ") + cleanText;

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
                                    <i class="fas fa-microphone-alt" style="margin-right: 3px;"></i>${speakerName}
                                </span>
                                <span style="color: #0f172a;">${completeSentence}</span>
                            </div>`;

                    // Translate ONLY the complete sentence (saves API calls & improves accuracy!)
                    if (showTranslation) {
                        const translatedText = await fetchTranslation(completeSentence, targetLang);
                        blockHTML += `
                            <div style="margin-top: 6px; color: #2563eb; font-size: 14px; line-height: 1.5; padding-left: 12px; border-left: 2px solid #bfdbfe; font-weight: 500; margin-left: 2px;">
                                ${translatedText}
                            </div>`;
                    }

                    blockHTML += `</div>`;

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

    ws.onclose = () => {
        statusBadge.innerText = "CONNECTION LOST";
        statusBadge.className = "status-offline";
        joinBtn.disabled = false;
        joinBtn.innerText = "Reconnect";
    };
}

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

function openAudienceBot() {
    alert("Vani Bot: Do you need a live summary or translation help?");
}

// 🎈 FLOATING EMOJI ANIMATION LOGIC
window.sendReaction = function(emoji) {
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
    const finalSpan = document.getElementById('final-span');
    
    if (!finalSpan || finalSpan.innerText.trim() === "") {
        alert("No transcript available to save yet!");
        return;
    }

    // Grab the visible text (this automatically strips out the HTML tags!)
    const rawText = finalSpan.innerText;
    
    // Add a beautiful header to the text file
    const fileHeader = "=========================================\n" +
                       " VANI.AI - LIVE EVENT TRANSCRIPT\n" +
                       " Date: " + new Date().toLocaleString() + "\n" +
                       "=========================================\n\n";

    const fullText = fileHeader + rawText;

    // Create a virtual file (Blob) in the browser
    const blob = new Blob([fullText], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    
    // Create a hidden link, click it, and destroy it
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
};
