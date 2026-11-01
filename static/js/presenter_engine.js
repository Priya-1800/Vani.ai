// ❌ NOTICE: We removed the static import from the top of the file!

let ws;
let audioContext;
let processor;
let sourceNode;
let streamRef;
let offlineTranscriber = null;
let isOffline = !navigator.onLine;
let sentenceBuffer = ""; // 🧠 NEW: Stores words until a sentence finishes
let framesSent = 0;       // Audio chunks pushed to the socket this session

// Reconnect state. Vercel closes every WebSocket when the function reaches its
// maxDuration (300 s in vercel.json), so long talks need a fresh socket every few
// minutes; networks also drop. The mic keeps running and the server opens a new
// Speechmatics session for each socket.
const MAX_RECONNECT_ATTEMPTS = 6;
let sessionConfig = null;  // handshake resent on every (re)connect
let hostStopped = true;    // true until Start, and again after Stop
let audioStarted = false;  // mic pipeline is set up once per session, not per socket
let reconnectAttempts = 0;
let reconnectTimer = null;

// The transcript as plain text is the source of truth for Save / Export / Summary;
// the on-screen span also holds error notes that shouldn't be exported.
let transcriptText = '';
let summaryText = '';
let currentSession = null;   // { id, startedAt, room, language } for this page's transcript
let savedSnapshot = '';      // transcript + summary at the last save, to detect unsaved changes
let reactionCounts = {};
const HEALTHY_MS = 10000; // an AI session that stayed up this long resets the retry budget
let healthySince = 0;      // when the current socket's Speechmatics session opened

// Live status line in the toolbar ("AI ready", "Streaming", "Mic blocked"...)
function setStatus(text, color) {
    const status = document.getElementById('status') || document.getElementById('status-badge');
    if (!status) return;
    status.innerText = text;
    if (color) status.style.color = color;
}

function showHostError(message) {
    const finalSpan = document.getElementById('final-span');
    if (!finalSpan) return;

    const line = document.createElement('div');
    line.style.cssText = 'margin: 8px 0; color: #b91c1c; font-size: 0.95rem; font-weight: 600;';
    line.innerText = `⚠️ ${message}`;
    finalSpan.appendChild(line);
}

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

// ==========================================
// 🎟️ INVITE CODE (this code is the room clients join)
// ==========================================
let roomCode = '';

window.toggleInvitePanel = function () {
    const panel = document.getElementById('invite-panel');
    const live = document.getElementById('live-area');
    const isOpen = panel.classList.toggle('is-visible');

    document.getElementById('inviteBtn').classList.toggle('is-active', isOpen);
    // Show the invite card or the transcript, not both at once.
    live.classList.toggle('is-visible', !isOpen);
};

window.generateInviteCode = function () {
    if (!hostStopped) {
        alert("Stop the stream before generating a new code, or your clients will lose the room.");
        return;
    }

    // No 0/O/1/I so the code can be read out loud without confusion.
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const pick = (n) => Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join('');

    roomCode = `${pick(3)}-${pick(3)}`;
    document.getElementById('invite-code').value = roomCode;

    const copyBtn = document.getElementById('copyLinkBtn');
    if (copyBtn) copyBtn.disabled = false;
};

window.copyInviteLink = async function () {
    if (!roomCode) return;

    const link = new URL('/audience.html', location.href);
    link.searchParams.set('code', roomCode);

    try {
        await navigator.clipboard.writeText(link.toString());
        const btn = document.getElementById('copyLinkBtn');
        const label = btn.innerHTML;
        btn.innerHTML = '<i class="fas fa-check"></i> Copied';
        setTimeout(() => { btn.innerHTML = label; }, 1800);
    } catch (e) {
        // Clipboard access needs https or localhost; just show the link instead.
        prompt("Copy this link for your clients:", link.toString());
    }
};


// --- Main Engine Start ---
async function startEngine() {
    const startBtn = document.getElementById('startBtn');
    const stopBtn = document.getElementById('stopBtn');
    const status = document.getElementById('status') || document.getElementById('status-badge');

    // 🛡️ EDGE FALLBACK INTERCEPTOR
    if (!navigator.onLine || isOffline) {
        console.log("Network offline. Rerouting to Edge AI...");
        window.location.href = "edge_test.html";
        return; 
    }

    // A code has to exist first, otherwise the room has nobody in it.
    if (!roomCode) {
        document.getElementById('invite-panel').classList.add('is-visible');
        document.getElementById('live-area').classList.remove('is-visible');
        document.getElementById('inviteBtn').classList.add('is-active');
        alert('Click "Get code" first and share it with your clients, then press Start.');
        return;
    }

    const langDropdown = document.getElementById('source-lang') || document.getElementById('language-select');
    const sourceLang = langDropdown ? langDropdown.value : 'en';

    // The room is fixed when streaming starts: a code generated mid-session would
    // silently split presenter and audience. Get code first, then Start.
    const room = roomCode;
    document.getElementById('invite-panel').classList.remove('is-visible');
    document.getElementById('inviteBtn').classList.remove('is-active');
    document.getElementById('live-area').classList.add('is-visible');

    const settings = VaniStore.getSettings();
    const profile = VaniStore.getProfile();
    sessionConfig = {
        source: sourceLang,
        presenter: profile.name || "Host",
        room: room,
        glossary: settings.glossary || [],
    };

    // Pressing Start again after Stop continues the same transcript.
    if (!currentSession) {
        currentSession = {
            id: VaniStore.newId(),
            startedAt: new Date().toISOString(),
            room: room,
            language: langDropdown ? langDropdown.options[langDropdown.selectedIndex].text : sourceLang,
        };
    }
    hostStopped = false;
    audioStarted = false;
    reconnectAttempts = 0;
    framesSent = 0;

    // Lock the buttons now so a second click can't open a parallel session while connecting.
    if (startBtn) startBtn.disabled = true;
    if (stopBtn) stopBtn.disabled = false;
    setStatus('Connecting...', '#3b82f6');

    openPresenterSocket();
}

function openPresenterSocket() {
    // Same host the page was served from, so local dev and Vercel both work (wss on https).
    const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${wsProtocol}//${location.host}/ws/audio`);
    ws = socket;

    socket.onopen = () => {
        healthySince = 0;
        socket.send(JSON.stringify(sessionConfig));

        if (audioStarted) {
            setStatus('Reconnected · starting AI...', '#3b82f6');
            return;
        }
        audioStarted = true;
        setStatus('Connecting to AI...', '#3b82f6');

        const hostHint = document.getElementById('host-hint');
        if (hostHint) hostHint.style.display = 'none';

        setupAudioPipeline();

        // A silent microphone used to look like a broken transcriber; say it out loud.
        setTimeout(() => {
            if (!hostStopped && framesSent === 0) {
                setStatus('No mic audio', '#ef4444');
                showHostError('No audio is reaching the server. Check the microphone chosen in the toolbar (or a muted tab / wrong input device), then press Stop and Start again.');
            }
        }, 5000);
    };

    socket.onmessage = handlePresenterMessage;

    socket.onclose = () => {
        // Ignore closes we caused (Stop) and closes of sockets already replaced.
        if (hostStopped || ws !== socket) return;

        // Only a Speechmatics session that stayed up resets the retry budget, so a
        // server that keeps failing right after "connected" can't cause a tight loop.
        if (healthySince && Date.now() - healthySince > HEALTHY_MS) reconnectAttempts = 0;

        const partialSpan = document.getElementById('partial-span');
        if (partialSpan) partialSpan.innerText = '';

        if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
            stopEngine();
            setStatus('Disconnected', '#ef4444');
            showHostError('Lost the connection to the server and could not reconnect. Check your network, then press Start again.');
            return;
        }

        // Retry the first drop immediately (the routine maxDuration cut) to lose as
        // little audio as possible, then back off.
        const delay = reconnectAttempts === 0 ? 0 : Math.min(500 * 2 ** reconnectAttempts, 10000);
        reconnectAttempts += 1;
        setStatus('Reconnecting...', '#eab308');
        reconnectTimer = setTimeout(openPresenterSocket, delay);
    };
}

function handlePresenterMessage(event) {
    const data = JSON.parse(event.data);
    const finalSpan = document.getElementById('final-span');
    const partialSpan = document.getElementById('partial-span');

    // Server-side progress reports from the Python/Speechmatics pipeline.
    if (data.type === 'status') {
        if (data.stage === 'error') {
            setStatus('AI error', '#ef4444');
            showHostError(data.message || 'Speechmatics reported an error.');
        } else if (data.stage === 'connected') {
            healthySince = Date.now();
            setStatus('AI ready · speak now', '#3b82f6');
        } else if (data.stage === 'audio') {
            setStatus('Streaming · live', '#10b981');
        }
        return;
    }

    if (data.type === 'reaction') {
        showHostReaction(data.emoji);
        return;
    }

    const originalText = data.original || data.text || '';

    if (data.type === 'partial') {
        if (partialSpan) partialSpan.innerText = originalText + " ";
        return;
    }

    if (data.type === 'final' || (!data.type && originalText !== "")) {
        if (finalSpan && originalText) {
            const before = transcriptText;
            transcriptText = Vani.joinText(transcriptText, originalText);
            finalSpan.appendChild(document.createTextNode(transcriptText.slice(before.length)));
            const display = document.getElementById('transcript-display');
            if(display) display.scrollTop = display.scrollHeight;
        }
        if (partialSpan) partialSpan.innerText = '';
    }
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

        // Capture at the device's native rate; the worklet downsamples to 16 kHz.
        // Forcing the context to 16 kHz makes Chrome resample the mic stream at
        // the wrong speed, which Speechmatics then hears as gibberish.
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        sourceNode = audioContext.createMediaStreamSource(streamRef);
        
        await audioContext.audioWorklet.addModule('/static/js/audio-processor.worklet.js');
        processor = new AudioWorkletNode(audioContext, 'audio-processor');
        
        processor.port.onmessage = (event) => {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(event.data.audioData);
                framesSent += 1;
                if (framesSent === 12) setStatus('Mic live · streaming', '#10b981');
            }
        };

        console.log(`🎙️ Mic at ${audioContext.sampleRate} Hz, sending 16 kHz PCM over the socket.`);

        sourceNode.connect(processor);
        processor.connect(audioContext.destination);
    } catch (e) {
        console.error("Failed to start audio pipeline. Did you allow microphone access?", e);
        setStatus('Mic blocked', '#ef4444');
        showHostError("Microphone could not start. Allow mic access for this site, then press Stop and Start again.");
        alert("Microphone access denied or failed. Please check your browser permissions.");
    }
}

// --- Engine Stop ---
function stopEngine() {
    hostStopped = true;
    audioStarted = false;
    clearTimeout(reconnectTimer);

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

    if (VaniStore.getSettings().autoSave && hasUnsavedChanges()) {
        saveTranscript({ quiet: true });
    }
}

// 💾 EXPORT TRANSCRIPT LOGIC
window.exportTranscript = function(filename = "Vani_Transcript.txt") {
    if (!transcriptText.trim()) {
        Vani.toast("No transcript to export yet.", 'error');
        return;
    }
    Vani.downloadText(filename, Vani.formatSession(buildSession()));
};

// ==========================================
// 💾 SAVE / HISTORY / NEW TRANSCRIPTION
// ==========================================
function buildSession() {
    const profile = VaniStore.getProfile();
    const base = currentSession || { id: VaniStore.newId(), startedAt: new Date().toISOString(), room: roomCode };
    currentSession = base;
    return {
        ...base,
        role: 'host',
        host: profile.name || '',
        text: transcriptText.trim(),
        summary: summaryText,
    };
}

function hasUnsavedChanges() {
    return transcriptText.trim() !== '' && (transcriptText + summaryText) !== savedSnapshot;
}

function saveTranscript(options = {}) {
    if (!transcriptText.trim()) {
        if (!options.quiet) Vani.toast("Nothing to save yet. Press Start and speak first.", 'error');
        return false;
    }
    if (!VaniStore.saveSession(buildSession())) {
        Vani.toast("Could not save: browser storage is full or blocked.", 'error');
        return false;
    }
    savedSnapshot = transcriptText + summaryText;
    Vani.toast(options.quiet ? "Transcript auto-saved to History." : "Saved. Find it under History.", 'success');
    return true;
}

function newTranscription() {
    const startFresh = () => {
        if (!hostStopped) stopEngine();
        location.reload();
    };
    if (!hasUnsavedChanges()) {
        if (hostStopped || confirm("Stop the live session and start a new transcription?")) startFresh();
        return;
    }
    Vani.openModal('Start a new transcription?', 'The current transcript has unsaved changes.', [
        { label: 'Cancel', onClick: close => close() },
        { label: 'Discard', kind: 'danger', onClick: () => { savedSnapshot = transcriptText + summaryText; startFresh(); } },
        { label: 'Save and start new', kind: 'primary', onClick: () => { if (saveTranscript()) startFresh(); } },
    ]);
}

// ==========================================
// ⚙️ SETTINGS AND 👤 PROFILE
// ==========================================
function field(labelText, input, hint) {
    const wrap = document.createElement('div');
    wrap.className = 'vani-field';
    const label = document.createElement('label');
    label.textContent = labelText;
    if (input.id) label.htmlFor = input.id;
    wrap.append(label, input);
    if (hint) {
        const small = document.createElement('small');
        small.textContent = hint;
        wrap.appendChild(small);
    }
    return wrap;
}

function openSettings() {
    const settings = VaniStore.getSettings();
    const form = document.createElement('div');

    const glossary = document.createElement('textarea');
    glossary.id = 'set-glossary';
    glossary.rows = 3;
    glossary.placeholder = 'e.g. Vani.ai, Speechmatics, Kubernetes';
    glossary.value = (settings.glossary || []).join(', ');

    const lang = document.createElement('select');
    lang.id = 'set-language';
    const pageLang = document.getElementById('language-select');
    if (pageLang) {
        [...pageLang.options].forEach(o => lang.add(new Option(o.text, o.value)));
        lang.value = settings.defaultLanguage || pageLang.value;
    }

    const autoWrap = document.createElement('label');
    autoWrap.className = 'vani-check';
    const auto = document.createElement('input');
    auto.type = 'checkbox';
    auto.checked = settings.autoSave !== false;
    autoWrap.append(auto, document.createTextNode('Save the transcript automatically when I press Stop'));

    form.append(
        field('Glossary', glossary, 'Names and technical words the speech engine should recognise. Separate with commas. Applies the next time you press Start.'),
        field('Default spoken language', lang),
        autoWrap,
    );

    Vani.openModal('Settings', form, [
        { label: 'Cancel', onClick: close => close() },
        {
            label: 'Save settings', kind: 'primary', onClick: close => {
                const words = glossary.value.split(/[,\n]/).map(w => w.trim()).filter(Boolean).slice(0, 100);
                VaniStore.saveSettings({ glossary: words, defaultLanguage: lang.value, autoSave: auto.checked });
                if (pageLang && hostStopped) pageLang.value = lang.value;
                close();
                Vani.toast('Settings saved.', 'success');
            }
        },
    ]);
}

function openProfile() {
    const profile = VaniStore.getProfile();
    const form = document.createElement('div');

    const name = document.createElement('input');
    name.type = 'text';
    name.id = 'prof-name';
    name.maxLength = 60;
    name.placeholder = 'e.g. Priya Thakur';
    name.value = profile.name;

    const org = document.createElement('input');
    org.type = 'text';
    org.id = 'prof-org';
    org.maxLength = 80;
    org.placeholder = 'e.g. Pune Institute';
    org.value = profile.organization;

    form.append(
        field('Your name', name, 'Shown in the sidebar and on exported and saved transcripts.'),
        field('Organization', org),
    );
    const note = document.createElement('p');
    note.className = 'vani-muted';
    note.textContent = 'Stored in this browser only. Vani.ai has no accounts.';
    form.appendChild(note);

    Vani.openModal('Profile', form, [
        { label: 'Cancel', onClick: close => close() },
        {
            label: 'Save profile', kind: 'primary', onClick: close => {
                VaniStore.saveProfile({ name: name.value.trim(), organization: org.value.trim() });
                renderProfileName();
                close();
                Vani.toast('Profile saved.', 'success');
            }
        },
    ]);
}

function renderProfileName() {
    const el = document.getElementById('profile-name');
    if (!el) return;
    const p = VaniStore.getProfile();
    el.textContent = p.name ? `Signed in as ${p.name}${p.organization ? ' · ' + p.organization : ''}` : '';
}

function applySavedPreferences() {
    renderProfileName();
    const settings = VaniStore.getSettings();
    const pageLang = document.getElementById('language-select');
    if (pageLang && settings.defaultLanguage) pageLang.value = settings.defaultLanguage;
}
window.addEventListener('load', applySavedPreferences);

// ==========================================
// 🎈 AUDIENCE REACTIONS ON THE HOST SCREEN
// ==========================================
function showHostReaction(emoji) {
    if (!emoji) return;
    reactionCounts[emoji] = (reactionCounts[emoji] || 0) + 1;

    const tally = document.getElementById('reaction-tally');
    if (tally) {
        tally.textContent = Object.entries(reactionCounts).map(([e, n]) => `${e} ${n}`).join('   ');
        tally.classList.add('is-visible');
    }

    const el = document.createElement('div');
    el.className = 'host-reaction';
    el.textContent = emoji;
    el.style.right = `${40 + Math.random() * 80}px`;
    document.body.appendChild(el);
    requestAnimationFrame(() => {
        el.style.transform = `translate(${Math.random() * 60 - 30}px, -280px)`;
        el.style.opacity = '0';
    });
    setTimeout(() => el.remove(), 2300);
}

// --- Expose to HTML Buttons ---
window.startEngine = startEngine;
window.stopEngine = stopEngine;
window.saveTranscript = saveTranscript;
window.newTranscription = newTranscription;
window.openSettings = openSettings;
window.openProfile = openProfile;
// 🛑 Automatically stop the engine and close WebSockets if the user refreshes or closes the tab!
window.addEventListener('beforeunload', stopEngine);

// --- GEMINI AI SUMMARY INTEGRATION ---

// Since presenter_engine is a module, we attach it to the window so the HTML onclick can find it
window.generateAiSummary = async function() {
    const summaryContainer = document.getElementById('ai-summary-container');
    const summaryContent = document.getElementById('ai-summary-content');
    const summarizeBtn = document.getElementById('summarizeBtn');
    
    // Grab the transcribed text from the span
    const fullText = transcriptText.trim();

    // Check if there is actually text to summarize
    if (!fullText) {
        Vani.toast("The transcript is empty. Press Start and speak first.", 'error');
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
            summaryText = data.summary;
            summaryContent.innerText = data.source === 'fallback'
                ? "⚠️ Gemini is unavailable right now, so this is a basic summary made from the transcript.\n\n" + data.summary
                : data.summary;
        } else {
            const detail = Array.isArray(data.detail) ? data.detail.map(d => d.msg).join('; ') : data.detail;
            summaryContent.innerText = "⚠️ Could not generate the summary: " + (detail || response.statusText);
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