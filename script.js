// ============================================
// Text-to-Speech Player — Core Engine
// ============================================

// --- DOM Elements ---
const novelTextElem = document.getElementById('novelText');
const readerView = document.getElementById('readerView');
const textAreaWrapper = document.getElementById('textAreaWrapper');
const textActions = document.getElementById('textActions');
const pasteBtn = document.getElementById('pasteBtn');
const clearBtn = document.getElementById('clearBtn');
const playBtn = document.getElementById('playBtn');
const playIcon = document.getElementById('playIcon');
const pauseIcon = document.getElementById('pauseIcon');
const loadingIcon = document.getElementById('loadingIcon');
const stopBtn = document.getElementById('stopBtn');
const skipBackBtn = document.getElementById('skipBackBtn');
const skipForwardBtn = document.getElementById('skipForwardBtn');
const voiceSelect = document.getElementById('voiceSelect');
const speedSelect = document.getElementById('speedSelect');
const autoScrollToggle = document.getElementById('autoScrollToggle');
const progressText = document.getElementById('progressText');
const progressBarFill = document.getElementById('progressBarFill');

const settingsBtn = document.getElementById('settingsBtn');
const settingsModal = document.getElementById('settingsModal');
const modalCloseBtn = document.getElementById('modalCloseBtn');
const modalScrollToggle = document.getElementById('modalScrollToggle');
const modalSpeedSelect = document.getElementById('modalSpeedSelect');
const modalVoiceSelect = document.getElementById('modalVoiceSelect');
const textSizeRange = document.getElementById('textSizeRange');
const textColorPicker = document.getElementById('textColorPicker');
const textOpacityRange = document.getElementById('textOpacityRange');

// --- Constants ---
const API_BASE = '/api';
const MAX_CHUNK_LENGTH = 500;
const PREFETCH_AHEAD = 2;    // How many chunks to prefetch ahead
const CACHE_BEHIND = 2;      // How many past chunks to keep in cache
const MAX_RETRIES = 2;

// --- Single Audio Element (no more ping-pong) ---
const audio = new Audio();

// --- State ---
let chunks = [];
let currentChunkIndex = 0;
let isPlaying = false;
let isAutoScrollEnabled = true;
let playbackSessionId = 0; // Incremented on each new play session to invalidate stale callbacks

// --- Audio Chunk Manager ---
const audioMap = new Map();        // chunkIndex → blobURL
const fetchPromises = new Map();   // chunkIndex → Promise<blobURL|null>
const abortControllers = new Map(); // chunkIndex → AbortController

// ============================================
// Utilities
// ============================================

function splitIntoChunks(text) {
    if (!text) return [];

    const paragraphs = text.split(/\n+/).filter(p => p.trim().length > 0);
    const result = [];

    for (let p of paragraphs) {
        p = p.trim();
        if (p.length <= MAX_CHUNK_LENGTH) {
            result.push(p);
        } else {
            const sentences = p.match(/[^.!?]+[.!?]+|\s*[^.!?]+$/g) || [p];
            let currentPart = '';

            for (const sentence of sentences) {
                if ((currentPart.length + sentence.length) <= MAX_CHUNK_LENGTH) {
                    currentPart += (currentPart ? ' ' : '') + sentence;
                } else {
                    if (currentPart) result.push(currentPart.trim());

                    if (sentence.length > MAX_CHUNK_LENGTH) {
                        let sub = sentence;
                        while (sub.length > MAX_CHUNK_LENGTH) {
                            result.push(sub.substring(0, MAX_CHUNK_LENGTH).trim());
                            sub = sub.substring(MAX_CHUNK_LENGTH);
                        }
                        currentPart = sub;
                    } else {
                        currentPart = sentence;
                    }
                }
            }
            if (currentPart.trim()) result.push(currentPart.trim());
        }
    }
    return result;
}

// ============================================
// UI State Helpers
// ============================================

function setPlayButtonState(state) {
    // state: 'play' | 'pause' | 'loading'
    playIcon.classList.toggle('hidden', state !== 'play');
    pauseIcon.classList.toggle('hidden', state !== 'pause');
    loadingIcon.classList.toggle('hidden', state !== 'loading');
}

function updateProgress() {
    if (chunks.length === 0) {
        progressText.textContent = 'Ready';
        progressBarFill.style.width = '0%';
        return;
    }
    const current = Math.min(currentChunkIndex + 1, chunks.length);
    progressText.textContent = `${current} / ${chunks.length}`;
    progressBarFill.style.width = `${(current / chunks.length) * 100}%`;
}

function highlightChunk(index) {
    document.querySelectorAll('.chunk.highlight').forEach(el => el.classList.remove('highlight'));

    // Mark played chunks
    for (let i = 0; i < index; i++) {
        const el = document.getElementById(`chunk-${i}`);
        if (el) el.classList.add('played');
    }

    const activeSpan = document.getElementById(`chunk-${index}`);
    if (activeSpan) {
        activeSpan.classList.remove('played');
        activeSpan.classList.add('highlight');
        if (isAutoScrollEnabled) {
            activeSpan.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }
}

function enterReaderMode() {
    novelTextElem.classList.add('hidden');
    textActions.classList.add('hidden');
    readerView.classList.remove('hidden');
    readerView.classList.add('custom-scrollbar');
    readerView.innerHTML = chunks
        .map((text, i) => `<span id="chunk-${i}" class="chunk" title="Click to jump to this chunk">${text}</span>`)
        .join('<br><br>');
}

function exitReaderMode() {
    readerView.classList.add('hidden');
    readerView.innerHTML = '';
    novelTextElem.classList.remove('hidden');
    textActions.classList.remove('hidden');
}

// ============================================
// Cache Management
// ============================================

function clearAllCache() {
    // Abort all in-flight fetches
    abortControllers.forEach(ctrl => ctrl.abort());
    abortControllers.clear();
    fetchPromises.clear();

    // Revoke all blob URLs
    audioMap.forEach(url => URL.revokeObjectURL(url));
    audioMap.clear();
}

function evictOldCache() {
    // Revoke blob URLs for chunks far behind the current position
    const evictBefore = currentChunkIndex - CACHE_BEHIND;
    for (const [index, url] of audioMap) {
        if (index < evictBefore) {
            URL.revokeObjectURL(url);
            audioMap.delete(index);
        }
    }
}

// ============================================
// Fetching Audio
// ============================================

async function fetchChunkAudio(index, sessionId) {
    if (index < 0 || index >= chunks.length) return null;

    // Already cached
    if (audioMap.has(index)) return audioMap.get(index);

    // Already fetching — wait for it
    if (fetchPromises.has(index)) return await fetchPromises.get(index);

    // Start a new fetch
    const voice = voiceSelect.value;
    const controller = new AbortController();
    abortControllers.set(index, controller);

    const promise = (async () => {
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            // Check if session is still valid
            if (sessionId !== playbackSessionId) return null;

            try {
                const timeoutId = setTimeout(() => controller.abort(), 30000);

                const response = await fetch(`${API_BASE}/tts`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ text: chunks[index], voice }),
                    signal: controller.signal,
                });

                clearTimeout(timeoutId);

                if (!response.ok) throw new Error(`TTS status ${response.status}`);

                const blob = await response.blob();

                // Validate session and voice haven't changed
                if (sessionId !== playbackSessionId || voiceSelect.value !== voice) {
                    return null;
                }

                const blobUrl = URL.createObjectURL(blob);
                audioMap.set(index, blobUrl);
                return blobUrl;
            } catch (err) {
                if (err.name === 'AbortError' || sessionId !== playbackSessionId) return null;

                console.error(`Chunk ${index} fetch attempt ${attempt + 1} failed:`, err.message);

                if (attempt < MAX_RETRIES) {
                    await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
                }
            }
        }
        return null;
    })();

    fetchPromises.set(index, promise);

    try {
        return await promise;
    } finally {
        fetchPromises.delete(index);
        abortControllers.delete(index);
    }
}

function prefetch(sessionId) {
    for (let i = 1; i <= PREFETCH_AHEAD; i++) {
        const idx = currentChunkIndex + i;
        if (idx < chunks.length && !audioMap.has(idx) && !fetchPromises.has(idx)) {
            fetchChunkAudio(idx, sessionId);
        }
    }
}

// ============================================
// Playback Engine
// ============================================

async function playChunk() {
    if (!isPlaying) return;

    const sessionId = playbackSessionId;

    if (currentChunkIndex >= chunks.length) {
        stopReading();
        return;
    }

    updateProgress();
    highlightChunk(currentChunkIndex);
    evictOldCache();

    // Get audio URL (from cache or fetch)
    let url = audioMap.get(currentChunkIndex);

    if (!url) {
        setPlayButtonState('loading');
        url = await fetchChunkAudio(currentChunkIndex, sessionId);

        // Session invalidated while fetching
        if (sessionId !== playbackSessionId) return;

        if (!url) {
            console.error(`Failed to get audio for chunk ${currentChunkIndex}`);
            // Skip this chunk and try next
            if (isPlaying) {
                currentChunkIndex++;
                playChunk();
            }
            return;
        }
    }

    if (!isPlaying || sessionId !== playbackSessionId) return;

    // Play the audio
    try {
        audio.src = url;
        audio.playbackRate = parseFloat(speedSelect.value);
        await audio.play();
        setPlayButtonState('pause');
    } catch (err) {
        console.warn('Playback error, retrying:', err.message);
        if (isPlaying && sessionId === playbackSessionId) {
            await new Promise(r => setTimeout(r, 500));
            try {
                audio.src = url;
                await audio.play();
                setPlayButtonState('pause');
            } catch (e) {
                console.error('Retry failed:', e.message);
                // Skip chunk
                currentChunkIndex++;
                if (isPlaying) playChunk();
                return;
            }
        }
    }

    // Start prefetching next chunks
    prefetch(sessionId);
}

// --- Audio Events ---

audio.addEventListener('ended', () => {
    if (!isPlaying) return;
    currentChunkIndex++;
    playChunk();
});

audio.addEventListener('error', (e) => {
    const error = e.target.error;
    console.error('Audio error:', error?.code, error?.message);

    if (isPlaying) {
        // Clear the bad cache entry and retry
        audioMap.delete(currentChunkIndex);
        setTimeout(() => {
            if (isPlaying) playChunk();
        }, 1000);
    }
});

// ============================================
// Public Controls
// ============================================

function playPause() {
    if (isPlaying) {
        // Pause
        audio.pause();
        isPlaying = false;
        setPlayButtonState('play');
    } else {
        // Play
        isPlaying = true;

        // If we had paused mid-chunk and audio has a src, resume
        if (audio.src && audio.paused && !audio.ended && chunks.length > 0) {
            audio.play()
                .then(() => setPlayButtonState('pause'))
                .catch(() => playChunk());
            return;
        }

        // Fresh start or no chunks yet
        if (chunks.length === 0) {
            const rawText = novelTextElem.value.trim();
            if (!rawText) {
                isPlaying = false;
                setPlayButtonState('play');
                return;
            }
            chunks = splitIntoChunks(rawText);
            if (chunks.length === 0) {
                isPlaying = false;
                setPlayButtonState('play');
                return;
            }
            currentChunkIndex = 0;
            playbackSessionId++;
            enterReaderMode();
        }

        playChunk();
    }
}

function stopReading() {
    isPlaying = false;
    playbackSessionId++;

    audio.pause();
    audio.removeAttribute('src');
    audio.load(); // Reset the audio element

    clearAllCache();
    currentChunkIndex = 0;
    chunks = [];

    exitReaderMode();
    setPlayButtonState('play');
    updateProgress();
}

function skipForward() {
    if (chunks.length === 0) return;
    if (currentChunkIndex >= chunks.length - 1) return;

    audio.pause();
    currentChunkIndex++;

    if (isPlaying) {
        playChunk();
    } else {
        updateProgress();
        highlightChunk(currentChunkIndex);
    }
}

function skipBack() {
    if (chunks.length === 0) return;
    if (currentChunkIndex <= 0) return;

    audio.pause();
    currentChunkIndex--;

    if (isPlaying) {
        playChunk();
    } else {
        updateProgress();
        highlightChunk(currentChunkIndex);
    }
}

async function pasteText() {
    try {
        const text = await navigator.clipboard.readText();
        if (text) {
            if (novelTextElem.value) {
                novelTextElem.value = novelTextElem.value + '\n' + text;
            } else {
                novelTextElem.value = text;
            }
            novelTextElem.dispatchEvent(new Event('input'));
            novelTextElem.scrollTop = novelTextElem.scrollHeight;
            novelTextElem.blur();
        }
    } catch (err) {
        console.warn('Clipboard read failed:', err);
        // Fallback: focus the textarea so user can Ctrl+V
        novelTextElem.focus();
    }
}

function clearText() {
    if (isPlaying) stopReading();
    novelTextElem.value = '';
    localStorage.removeItem('novelReader_text');
}

// ============================================
// Voice Loading
// ============================================

async function loadVoices() {
    try {
        const response = await fetch(`${API_BASE}/voices`);
        const voices = await response.json();
        voiceSelect.innerHTML = voices
            .map(v => `<option value="${v.ShortName}">${v.FriendlyName}</option>`)
            .join('');

        const savedVoice = localStorage.getItem('novelReader_voice');
        if (savedVoice) {
            const exists = voices.find(v => v.ShortName === savedVoice);
            if (exists) voiceSelect.value = savedVoice;
        }
    } catch (error) {
        console.error('Error loading voices:', error);
        voiceSelect.innerHTML = '<option>Error loading voices</option>';
    }
}

// ============================================
// Event Listeners
// ============================================

// Playback controls
playBtn.addEventListener('click', playPause);
stopBtn.addEventListener('click', stopReading);
skipForwardBtn.addEventListener('click', skipForward);
skipBackBtn.addEventListener('click', skipBack);

// Text actions
pasteBtn.addEventListener('click', pasteText);
clearBtn.addEventListener('click', clearText);

// Auto-Scroll Toggle
autoScrollToggle.addEventListener('click', () => {
    isAutoScrollEnabled = !isAutoScrollEnabled;
    autoScrollToggle.textContent = `Scroll: ${isAutoScrollEnabled ? 'ON' : 'OFF'}`;
    modalScrollToggle.textContent = isAutoScrollEnabled ? 'ON' : 'OFF';
    localStorage.setItem('novelReader_autoScroll', isAutoScrollEnabled);
});

// Settings Modal Controls
settingsBtn.addEventListener('click', () => {
    settingsModal.classList.remove('hidden');
});

modalCloseBtn.addEventListener('click', () => {
    settingsModal.classList.add('hidden');
});

// Close modal when clicking outside
settingsModal.addEventListener('click', (e) => {
    if (e.target === settingsModal) {
        settingsModal.classList.add('hidden');
    }
});

modalScrollToggle.addEventListener('click', () => {
    isAutoScrollEnabled = !isAutoScrollEnabled;
    autoScrollToggle.textContent = `Scroll: ${isAutoScrollEnabled ? 'ON' : 'OFF'}`;
    modalScrollToggle.textContent = isAutoScrollEnabled ? 'ON' : 'OFF';
    localStorage.setItem('novelReader_autoScroll', isAutoScrollEnabled);
});

modalSpeedSelect.addEventListener('change', () => {
    speedSelect.value = modalSpeedSelect.value;
    speedSelect.dispatchEvent(new Event('change'));
});

modalVoiceSelect.addEventListener('change', () => {
    voiceSelect.value = modalVoiceSelect.value;
    voiceSelect.dispatchEvent(new Event('change'));
});

textSizeRange.addEventListener('input', () => {
    const size = textSizeRange.value;
    novelTextElem.style.fontSize = `${size}rem`;
    readerView.style.fontSize = `${size}rem`;
    localStorage.setItem('novelReader_textSize', size);
});

textColorPicker.addEventListener('input', () => {
    const color = textColorPicker.value;
    novelTextElem.style.color = color;
    readerView.style.color = color;
    localStorage.setItem('novelReader_textColor', color);
});

textOpacityRange.addEventListener('input', () => {
    const opacity = textOpacityRange.value;
    novelTextElem.style.opacity = opacity;
    readerView.style.opacity = opacity;
    localStorage.setItem('novelReader_textOpacity', opacity);
});

// Speed change
speedSelect.addEventListener('change', () => {
    audio.playbackRate = parseFloat(speedSelect.value);
    localStorage.setItem('novelReader_speed', speedSelect.value);
});

// Voice change
voiceSelect.addEventListener('change', () => {
    localStorage.setItem('novelReader_voice', voiceSelect.value);

    if (chunks.length === 0) return;

    // Re-generate audio from current chunk with new voice
    audio.pause();
    clearAllCache();
    playbackSessionId++;

    isPlaying = true;
    setPlayButtonState('pause');
    playChunk();
});

// Save text on change
novelTextElem.addEventListener('input', () => {
    localStorage.setItem('novelReader_text', novelTextElem.value);
});

// Click-to-jump in reader view
readerView.addEventListener('click', (e) => {
    const chunkEl = e.target.closest('.chunk');
    if (!chunkEl) return;

    const index = parseInt(chunkEl.id.replace('chunk-', ''));
    if (isNaN(index) || index < 0 || index >= chunks.length) return;

    audio.pause();
    currentChunkIndex = index;

    // Clear played state for chunks after the jumped-to position
    for (let i = index; i < chunks.length; i++) {
        const el = document.getElementById(`chunk-${i}`);
        if (el) el.classList.remove('played');
    }

    if (!isPlaying) {
        playPause();
    } else {
        playChunk();
    }
});

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
    // Don't capture when typing in the textarea
    if (document.activeElement === novelTextElem) return;

    switch (e.code) {
        case 'Space':
            e.preventDefault();
            playPause();
            break;
        case 'Escape':
            e.preventDefault();
            stopReading();
            break;
        case 'ArrowRight':
            e.preventDefault();
            skipForward();
            break;
        case 'ArrowLeft':
            e.preventDefault();
            skipBack();
            break;
    }
});

// ============================================
// Initialization
// ============================================

// Restore saved text and settings
window.addEventListener('load', () => {
    const savedText = localStorage.getItem('novelReader_text');
    if (savedText) novelTextElem.value = savedText;

    // Text size
    const savedSize = localStorage.getItem('novelReader_textSize') || '1';
    textSizeRange.value = savedSize;
    novelTextElem.style.fontSize = `${savedSize}rem`;
    readerView.style.fontSize = `${savedSize}rem`;

    // Text color
    const savedColor = localStorage.getItem('novelReader_textColor') || '#e2e8f0';
    textColorPicker.value = savedColor;
    novelTextElem.style.color = savedColor;
    readerView.style.color = savedColor;

    // Text opacity
    const savedOpacity = localStorage.getItem('novelReader_textOpacity') || '1';
    textOpacityRange.value = savedOpacity;
    novelTextElem.style.opacity = savedOpacity;
    readerView.style.opacity = savedOpacity;

    // Modal scroll toggle sync
    modalScrollToggle.textContent = isAutoScrollEnabled ? 'ON' : 'OFF';
});

// Restore saved speed
const savedSpeed = localStorage.getItem('novelReader_speed');
if (savedSpeed) {
    speedSelect.value = savedSpeed;
    modalSpeedSelect.value = savedSpeed;
}

// Restore saved auto-scroll preference
const savedAutoScroll = localStorage.getItem('novelReader_autoScroll');
if (savedAutoScroll !== null) {
    isAutoScrollEnabled = savedAutoScroll === 'true';
    autoScrollToggle.textContent = `Scroll: ${isAutoScrollEnabled ? 'ON' : 'OFF'}`;
}

// Load voices and duplicate into modal voice select
loadVoices().then(() => {
    // After voices loaded, copy options to modal select
    modalVoiceSelect.innerHTML = voiceSelect.innerHTML;
    // Set modal voice to saved value if any
    const savedVoice = localStorage.getItem('novelReader_voice');
    if (savedVoice) modalVoiceSelect.value = savedVoice;
});

// Initial UI updates remain
updateProgress();
