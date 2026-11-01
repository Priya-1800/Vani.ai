// Shared helpers for the host and client pages: browser storage for saved
// sessions, settings and profile, plus a small modal and toast.
// Everything is stored in this browser only (localStorage); there are no accounts.

(function () {
    const KEYS = {
        sessions: 'vani.sessions',
        settings: 'vani.settings',
        profile: 'vani.profile',
    };
    const MAX_SESSIONS = 50;

    function read(key, fallback) {
        try {
            const raw = localStorage.getItem(key);
            return raw ? JSON.parse(raw) : fallback;
        } catch (e) {
            return fallback;
        }
    }

    function write(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
            return true;
        } catch (e) {
            console.warn('Could not write to localStorage', e);
            return false;
        }
    }

    const VaniStore = {
        listSessions(role) {
            const all = read(KEYS.sessions, []);
            return role ? all.filter(s => s.role === role) : all;
        },
        getSession(id) {
            return read(KEYS.sessions, []).find(s => s.id === id) || null;
        },
        // Insert or update by id; newest first, capped so storage can't fill up.
        saveSession(session) {
            const all = read(KEYS.sessions, []).filter(s => s.id !== session.id);
            all.unshift({ ...session, savedAt: new Date().toISOString() });
            return write(KEYS.sessions, all.slice(0, MAX_SESSIONS));
        },
        // Host transcripts auto-saved by older versions; Saved shows manual saves only.
        removeAutoSaved() {
            const all = read(KEYS.sessions, []);
            const kept = all.filter(s => !(s.role === 'host' && s.autoSaved));
            if (kept.length !== all.length) write(KEYS.sessions, kept);
        },
        deleteSession(id) {
            write(KEYS.sessions, read(KEYS.sessions, []).filter(s => s.id !== id));
        },
        getSettings() {
            const { autoSave, ...settings } = read(KEYS.settings, {});  // autoSave was removed
            return { glossary: [], defaultLanguage: '', ...settings };
        },
        saveSettings(settings) {
            return write(KEYS.settings, settings);
        },
        getProfile() {
            return { name: '', organization: '', ...read(KEYS.profile, {}) };
        },
        saveProfile(profile) {
            return write(KEYS.profile, profile);
        },
        newId() {
            return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        },
    };

    function escapeHtml(text) {
        return String(text ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // Join transcript chunks without a space before punctuation ("Hello." not "Hello .").
    function joinText(current, next) {
        const piece = String(next ?? '').trim();
        if (!piece) return current;
        if (!current) return piece;
        return /^[.,!?;:)\]}%…]/.test(piece) ? current + piece : current + ' ' + piece;
    }

    function toast(message, kind = 'info') {
        let host = document.getElementById('vani-toasts');
        if (!host) {
            host = document.createElement('div');
            host.id = 'vani-toasts';
            document.body.appendChild(host);
        }
        const el = document.createElement('div');
        el.className = `vani-toast vani-toast-${kind}`;
        el.textContent = message;
        host.appendChild(el);
        setTimeout(() => el.classList.add('is-leaving'), 2600);
        setTimeout(() => el.remove(), 3000);
    }

    // Minimal modal: openModal(title, bodyElement, [{label, kind, onClick}]) -> close()
    function openModal(title, body, actions = []) {
        closeModal();
        const overlay = document.createElement('div');
        overlay.className = 'vani-modal-overlay';
        overlay.id = 'vani-modal';

        const card = document.createElement('div');
        card.className = 'vani-modal';
        card.setAttribute('role', 'dialog');
        card.setAttribute('aria-modal', 'true');

        const header = document.createElement('div');
        header.className = 'vani-modal-header';
        const h = document.createElement('h3');
        h.textContent = title;
        const x = document.createElement('button');
        x.className = 'vani-modal-close';
        x.setAttribute('aria-label', 'Close');
        x.innerHTML = '<i class="fas fa-times"></i>';
        x.onclick = closeModal;
        header.append(h, x);

        const content = document.createElement('div');
        content.className = 'vani-modal-body';
        if (typeof body === 'string') content.textContent = body;
        else if (body) content.appendChild(body);

        card.append(header, content);

        if (actions.length) {
            const footer = document.createElement('div');
            footer.className = 'vani-modal-footer';
            actions.forEach(a => {
                const b = document.createElement('button');
                b.className = `vani-btn vani-btn-${a.kind || 'ghost'}`;
                b.textContent = a.label;
                b.onclick = () => a.onClick && a.onClick(closeModal);
                footer.appendChild(b);
            });
            card.appendChild(footer);
        }

        overlay.appendChild(card);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
        document.addEventListener('keydown', escListener);
        document.body.appendChild(overlay);

        const firstInput = card.querySelector('input, textarea, select');
        if (firstInput) firstInput.focus();
        return closeModal;
    }

    function escListener(e) {
        if (e.key === 'Escape') closeModal();
    }

    function closeModal() {
        const existing = document.getElementById('vani-modal');
        if (existing) existing.remove();
        document.removeEventListener('keydown', escListener);
    }

    function downloadText(filename, text) {
        const blob = new Blob([text], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    }

    function formatSession(s) {
        const lines = [
            '=========================================',
            ' VANI.AI - LIVE EVENT TRANSCRIPT',
            ` Date: ${new Date(s.startedAt || s.savedAt).toLocaleString()}`,
        ];
        if (s.host) lines.push(` Host: ${s.host}`);
        if (s.room) lines.push(` Room: ${s.room}`);
        if (s.language) lines.push(` Language: ${s.language}`);
        lines.push('=========================================', '', s.text || '');
        if (s.summary) lines.push('', '----- SUMMARY -----', s.summary);
        return lines.join('\n');
    }

    // History list: view, download or delete saved sessions for one role.
    function openHistory(role) {
        const wrap = document.createElement('div');

        function render() {
            wrap.innerHTML = '';
            // The host's Saved list shows only transcripts saved with the Save button.
            const sessions = VaniStore.listSessions(role).filter(s => !(role === 'host' && s.autoSaved));
            if (!sessions.length) {
                const p = document.createElement('p');
                p.className = 'vani-muted';
                p.textContent = role === 'host'
                    ? 'No saved transcripts yet. Press the Save button under the transcript to keep one here.'
                    : 'No saved sessions yet. Sessions are saved here automatically when you leave or the host ends the stream.';
                wrap.appendChild(p);
                return;
            }
            sessions.forEach(s => {
                const row = document.createElement('div');
                row.className = 'vani-history-row';

                const info = document.createElement('div');
                info.className = 'vani-history-info';
                const title = document.createElement('strong');
                title.textContent = s.room ? `Room ${s.room}` : 'Session';
                const meta = document.createElement('span');
                const words = (s.text || '').split(/\s+/).filter(Boolean).length;
                meta.textContent = `${new Date(s.startedAt || s.savedAt).toLocaleString()} · ${words} words`;
                const preview = document.createElement('p');
                preview.textContent = (s.text || '').slice(0, 140) + ((s.text || '').length > 140 ? '…' : '');
                info.append(title, meta, preview);

                const buttons = document.createElement('div');
                buttons.className = 'vani-history-actions';
                const mk = (icon, label, fn) => {
                    const b = document.createElement('button');
                    b.className = 'vani-icon-btn';
                    b.title = label;
                    b.setAttribute('aria-label', label);
                    b.innerHTML = `<i class="fas ${icon}"></i>`;
                    b.onclick = fn;
                    return b;
                };
                buttons.append(
                    mk('fa-eye', 'View', () => viewSession(s)),
                    mk('fa-download', 'Download', () => downloadText(`Vani_${s.room || 'session'}_${(s.startedAt || '').slice(0, 10)}.txt`, formatSession(s))),
                    mk('fa-trash', 'Delete', () => {
                        if (confirm('Delete this saved session?')) { VaniStore.deleteSession(s.id); render(); }
                    }),
                );
                row.append(info, buttons);
                wrap.appendChild(row);
            });
        }

        function viewSession(s) {
            const pre = document.createElement('pre');
            pre.className = 'vani-transcript-view';
            pre.textContent = formatSession(s);
            openModal(s.room ? `Room ${s.room}` : 'Session', pre, [
                { label: 'Back to saved', onClick: () => openHistory(role) },
                { label: 'Download', kind: 'primary', onClick: () => downloadText(`Vani_${s.room || 'session'}.txt`, formatSession(s)) },
            ]);
        }

        render();
        openModal(role === 'host' ? 'Saved transcripts' : 'My saved sessions', wrap, [{ label: 'Close', onClick: c => c() }]);
    }

    window.VaniStore = VaniStore;
    window.Vani = { escapeHtml, joinText, toast, openModal, closeModal, downloadText, formatSession, openHistory };
})();
