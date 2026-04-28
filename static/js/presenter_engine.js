// ❌ NOTICE: We removed the static import from the top of the file!

let ws;
let audioContext;
let processor;
let sourceNode;
let streamRef;
let offlineTranscriber = null;
let isOffline = !navigator.onLine;
let sentenceBuffer = ""; // 🧠 NEW: Stores words until a sentence finishes

// --- Microphone Detection ---
async function populateMicrophones() {
    try {
        // We only ask for basic device info first, to avoid triggering aggressive browser blocks
        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioInputs = devices.filter(device => device.kind === 'audioinput');
        const micSelect = document.getElementById('mic-select');
        
        if(micSelect) {
            micSelect.innerHTML = ''; 
            audioInputs.forEach((device, index) => {
                const option = document.createElement('option');
                option.value = device.deviceId;
                option.text = device.label || `Microphone ${index + 1}`;
                micSelect.appendChild(option);
            });
            
            // If no mics are found, give a fallback
            if (audioInputs.length === 0) {
                micSelect.innerHTML = '<option value="">Default System Mic</option>';
            }
        }
    } catch (err) {
        console.error("Error fetching mics. The browser might be blocking it:", err);
        const micSelect = document.getElementById('mic-select');
        if(micSelect) micSelect.innerHTML = '<option value="">Default System Mic</option>';
    }
}

// Run mic detection safely when page loads
window.addEventListener('load', populateMicrophones);

// --- Offline Engine Init (DYNAMIC IMPORT) ---
async function initOfflineEngine() {
    console.log("Loading Edge AI Model quietly in the background...");
    try {
        // ✅ DYNAMIC IMPORT: This won't crash the rest of your app if it fails!
        const { pipeline } = await import('https://cdn.jsdelivr.net/npm/@xenova/transformers@2.6.0');
        offlineTranscriber = await pipeline('automatic-speech-recognition', 'Xenova/whisper-base.en');
        console.log("Edge AI successfully loaded!");
    } catch(e) { 
        console.warn("Local Edge model skipped. Either offline or CDN blocked.", e); 
    }
}
initOfflineEngine();

window.addEventListener('offline', () => {
    isOffline = true;
    const statusElm = document.getElementById('status') || document.getElementById('status-badge');
    if (statusElm) {
        statusElm.className = 'status-offline';
        statusElm.innerText = 'Offline Mode Active';
        statusElm.style.color = '#eab308';
    }
    alert("Network connection lost! Initializing Zero-Downtime Edge Fallback...");
    window.location.href = "edge_test.html";
});

window.addEventListener('online', () => {
    isOffline = false;
});

// --- Main Engine Start ---
async function startEngine() {
    const startBtn = document.getElementById('startBtn');
    const stopBtn = document.getElementById('stopBtn');
    const status = document.getElementById('status') || document.getElementById('status-badge');
    const hint = document.getElementById('hint');
    
    // 🛡️ EDGE FALLBACK INTERCEPTOR
    if (!navigator.onLine || isOffline) {
        console.log("Network offline. Rerouting to Edge AI...");
        window.location.href = "edge_test.html";
        return; 
    }

    const langDropdown = document.getElementById('source-lang');
    const sourceLang = langDropdown ? langDropdown.value : 'en';

    // Connect to your Python server!
    ws = new WebSocket("ws://127.0.0.1:8000/ws/audio");

    ws.onopen = () => {
        if(status) {
            status.innerText = "🔴 LIVE RECORDING";
            status.style.color = "#ef4444";
        }
        if(startBtn) startBtn.disabled = true;
        if(stopBtn) stopBtn.disabled = false;
        if (hint) hint.style.display = 'none';

        ws.send(JSON.stringify({
            source: sourceLang, 
            presenter: "Host",
            room: "default"
        }));

        setupAudioPipeline();
    };

    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        const finalSpan = document.getElementById('final-span');
        const partialSpan = document.getElementById('partial-span');
        
        const originalText = data.original || data.text || '';

        if (data.type === 'partial') {
            if (partialSpan) partialSpan.innerText = originalText + " ";
            return;
        }

        if (data.type === 'final' || (!data.type && originalText !== "")) {
            if (finalSpan && originalText) {
                finalSpan.innerHTML += `<span style="margin-right: 5px; color: black;">${originalText}</span>`;
                const display = document.getElementById('transcript-display');
                if(display) display.scrollTop = display.scrollHeight;
            }
            if (partialSpan) partialSpan.innerText = '';
        }
    };
}

// --- Audio Pipeline ---
async function setupAudioPipeline() {
    const micSelect = document.getElementById('mic-select');
    const selectedMicId = micSelect ? micSelect.value : '';
    
    // Ask for the microphone *only* after they click Start
    const audioConstraints = selectedMicId 
        ? { audio: { deviceId: { exact: selectedMicId } } } 
        : { audio: true };

    try {
        streamRef = await navigator.mediaDevices.getUserMedia(audioConstraints);
        audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
        sourceNode = audioContext.createMediaStreamSource(streamRef);
        
        await audioContext.audioWorklet.addModule('/static/js/audio-processor.worklet.js');
        processor = new AudioWorkletNode(audioContext, 'audio-processor');
        
        processor.port.onmessage = (event) => {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(event.data.audioData);
            }
        };

        sourceNode.connect(processor);
        processor.connect(audioContext.destination);
    } catch (e) {
        console.error("Failed to start audio pipeline. Did you allow microphone access?", e);
        alert("Microphone access denied or failed. Please check your browser permissions.");
    }
}

// --- Engine Stop ---
function stopEngine() {
    if (processor) processor.disconnect();
    if (sourceNode) sourceNode.disconnect();
    if (audioContext) audioContext.close();
    if (streamRef) streamRef.getTracks().forEach(track => track.stop());
    
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "system", message: "Stream Ended" }));
    }
    
    if (ws) ws.close();

    const status = document.getElementById('status') || document.getElementById('status-badge');
    if(status) {
        status.innerText = "STOPPED";
        status.style.color = "#64748b";
    }
    const startBtn = document.getElementById('startBtn');
    const stopBtn = document.getElementById('stopBtn');
    if(startBtn) startBtn.disabled = false;
    if(stopBtn) stopBtn.disabled = true;
}

// 💾 EXPORT TRANSCRIPT LOGIC
window.exportTranscript = function(filename = "Vani_Transcript.txt") {
    const finalSpan = document.getElementById('final-span');
    if (!finalSpan || finalSpan.innerText.trim() === "") {
        alert("No transcript available to save yet!");
        return;
    }
    const rawText = finalSpan.innerText;
    const fileHeader = "=========================================\n" +
                       " VANI.AI - LIVE EVENT TRANSCRIPT\n" +
                       " Date: " + new Date().toLocaleString() + "\n" +
                       "=========================================\n\n";
    const fullText = fileHeader + rawText;
    const blob = new Blob([fullText], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
};

// --- Expose to HTML Buttons ---
window.startEngine = startEngine;
window.stopEngine = stopEngine;
// 🛑 Automatically stop the engine and close WebSockets if the user refreshes or closes the tab!
window.addEventListener('beforeunload', stopEngine);

// --- GEMINI AI SUMMARY INTEGRATION ---

// Since presenter_engine is a module, we attach it to the window so the HTML onclick can find it
window.generateAiSummary = async function() {
    const summaryContainer = document.getElementById('ai-summary-container');
    const summaryContent = document.getElementById('ai-summary-content');
    const summarizeBtn = document.getElementById('summarizeBtn');
    
    // Grab the transcribed text from the span
    const finalSpan = document.getElementById('final-span');
    const fullText = finalSpan.innerText.trim();

    // Check if there is actually text to summarize
    if (!fullText) {
        alert("The transcript is empty! Start the engine and speak first before generating a summary.");
        return;
    }

    // Update UI to show loading state
    summaryContainer.style.display = 'block';
    summaryContent.innerHTML = '<span style="color: #94a3b8;"><i class="fas fa-spinner fa-spin"></i> Gemini is analyzing the meeting transcript...</span>';
    summarizeBtn.disabled = true;
    summarizeBtn.style.opacity = '0.5';

    try {
        // Call your FastAPI backend
        const response = await fetch('/generate_summary', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ full_text: fullText })
        });

        const data = await response.json();
        
        if (response.ok) {
            // Print the Gemini result into the box
            summaryContent.innerText = data.summary;
        } else {
            summaryContent.innerText = "⚠️ Backend Error: " + (data.summary || "Failed to generate summary.");
        }
    } catch (error) {
        console.error("Summary Generation Error:", error);
        summaryContent.innerText = "⚠️ Network Error: Could not reach the server to generate the summary.";
    } finally {
        // Restore button state
        summarizeBtn.disabled = false;
        summarizeBtn.style.opacity = '1';
    }
};