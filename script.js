const novelTextElem = document.getElementById('novelText');
const readerView = document.getElementById('readerView');
const novelUrlInput = document.getElementById('novelUrl');
const prevBtn = document.getElementById('prevBtn');
const nextBtn = document.getElementById('nextBtn');
const fetchBtn = document.getElementById('fetchBtn');
const playBtn = document.getElementById('playBtn');
const playIcon = document.getElementById('playIcon');
const pauseIcon = document.getElementById('pauseIcon');
const loadingIcon = document.getElementById('loadingIcon');
const stopBtn = document.getElementById('stopBtn');
const voiceSelect = document.getElementById('voiceSelect');
const speedSelect = document.getElementById('speedSelect');
const progressBar = document.getElementById('progressBar');
const progressText = document.getElementById('progressText');
const percentageText = document.getElementById('percentageText');

// Ping-pong audio players
const audioA = new Audio();
const audioB = new Audio();
let activeAudio = audioA; // Track which audio is currently "main"

let chunks = [];
let currentChunkIndex = 0;
let isPlaying = false;
let chunkCache = new Map(); // Index -> BlobURL
const PREFETCH_COUNT = 4; // Number of chunks to prefetch ahead
const API_BASE = 'http://localhost:3001/api';

// Sync speed for both players
function applySpeed() {
    const rate = parseFloat(speedSelect.value);
    audioA.playbackRate = rate;
    audioB.playbackRate = rate;
}

speedSelect.addEventListener('change', () => {
    applySpeed();
    localStorage.setItem('novelReader_speed', speedSelect.value);
});

// Load saved speed
const savedSpeed = localStorage.getItem('novelReader_speed');
if (savedSpeed) {
    speedSelect.value = savedSpeed;
    // applySpeed() will be called when we initialize audio or play, 
    // but let's ensure base state is correct
}

// Load AI voices from backend
async function loadVoices() {
    try {
        const response = await fetch(`${API_BASE}/voices`);
        const voices = await response.json();
        voiceSelect.innerHTML = voices
            .map(voice => `<option value="${voice.ShortName}">${voice.FriendlyName}</option>`)
            .join('');

        // Restore saved voice
        const savedVoice = localStorage.getItem('novelReader_voice');
        if (savedVoice) {
            // Check if voice exists in the new list (it might be a different browser/environment or voice removed)
            const exists = voices.find(v => v.ShortName === savedVoice);
            if (exists) {
                voiceSelect.value = savedVoice;
            }
        }
    } catch (error) {
        console.error('Error loading voices:', error);
        voiceSelect.innerHTML = '<option>Error loading voices</option>';
    }
}

loadVoices();

function splitIntoChunks(text) {
    return text.split(/\n+/).filter(chunk => chunk.trim().length > 0);
}

function updateProgress() {
    if (chunks.length === 0) {
        progressBar.style.width = '0%';
        percentageText.textContent = '0%';
        progressText.textContent = 'Not started';
        return;
    }
    const percentage = Math.round((currentChunkIndex / chunks.length) * 100);
    progressBar.style.width = `${percentage}%`;
    percentageText.textContent = `${percentage}%`;
    progressText.textContent = `Reading chunk ${currentChunkIndex + 1} of ${chunks.length}`;
}

function clearCache() {
    chunkCache.forEach((url) => {
        if (url && url !== 'fetching') URL.revokeObjectURL(url);
    });
    chunkCache.clear();
}

async function fetchNovelContent(url) {
    if (!url) return;

    const selector = document.getElementById('customSelector').value.trim();

    // Show loading in button 
    fetchBtn.classList.add('animate-pulse', 'text-indigo-600');

    try {
        const response = await fetch(`${API_BASE}/fetch-novel`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, selector })
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || 'Failed to fetch novel');
        }

        const data = await response.json();
        if (data.text) {
            stopReading(); // Reset state
            novelTextElem.value = data.text;
            // Auto-play
            playPause();
        }
    } catch (error) {
        console.error('Fetch error:', error);
        alert(`Error: ${error.message}`);
    } finally {
        fetchBtn.classList.remove('animate-pulse', 'text-indigo-600');
    }
}

function navigateToChapter(direction) {
    const url = novelUrlInput.value.trim();
    if (!url) return;

    // Simple regex to find the chapter number at the end
    const regex = /(chapter-)(\d+)(\/?)$/i;
    const match = url.match(regex);

    if (match) {
        const prefix = match[1];
        const currentNum = parseInt(match[2]);
        const suffix = match[3] || '';
        const newNum = direction === 'next' ? currentNum + 1 : Math.max(1, currentNum - 1);
        const newUrl = url.replace(regex, `${prefix}${newNum}${suffix}`);

        novelUrlInput.value = newUrl;
        fetchNovelContent(newUrl);
    } else {
        alert('Could not detect chapter number in URL. Use a link like .../chapter-113');
    }
}

async function fetchChunk(index) {
    if (index >= chunks.length || chunkCache.has(index)) return chunkCache.get(index);

    // Mark as fetching to avoid duplicate requests
    chunkCache.set(index, 'fetching');

    try {
        const text = chunks[index];
        const voice = voiceSelect.value;
        const response = await fetch(`${API_BASE}/tts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, voice })
        });

        if (!response.ok) throw new Error('TTS fetch failed');

        const blob = await response.blob();

        // Check if voice changed while fetching
        if (voiceSelect.value !== voice) {
            return null;
        }

        const url = URL.createObjectURL(blob);
        chunkCache.set(index, url);
        return url;
    } catch (error) {
        if (voiceSelect.value !== voice) return null;
        console.error(`Error fetching chunk ${index}:`, error);
        chunkCache.delete(index);
        return null;
    }
}

async function prefetchNext() {
    for (let i = 1; i <= PREFETCH_COUNT; i++) {
        const nextIndex = currentChunkIndex + i;
        if (nextIndex < chunks.length && !chunkCache.has(nextIndex)) {
            fetchChunk(nextIndex);
        }
    }

    // PRIME THE OFFLOAD PLAYER
    // This is the key to low latency: load the NEXT chunk into the inactive audio player
    const nextUrl = chunkCache.get(currentChunkIndex + 1);
    const inactiveAudio = activeAudio === audioA ? audioB : audioA;

    // Only set if we have a valid URL and it's not already set
    if (nextUrl && nextUrl !== 'fetching' && inactiveAudio.src !== nextUrl) {
        inactiveAudio.src = nextUrl;
        inactiveAudio.playbackRate = parseFloat(speedSelect.value);
        // Browser will now decode header/metadata in background
    }
}

async function playChunk() {
    if (!isPlaying) return;

    if (currentChunkIndex >= chunks.length) {
        stopReading();
        return;
    }

    try {
        updateProgress();

        // Highlight and scroll
        document.querySelectorAll('.chunk').forEach(el => el.classList.remove('highlight'));
        const activeSpan = document.getElementById(`chunk-${currentChunkIndex}`);
        if (activeSpan) {
            activeSpan.classList.add('highlight');
            activeSpan.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }

        let url = chunkCache.get(currentChunkIndex);

        // If not in cache or still fetching, we must wait/fetch
        if (!url || url === 'fetching') {
            playIcon.classList.add('hidden');
            pauseIcon.classList.add('hidden');
            loadingIcon.classList.remove('hidden');

            const fetchingVoice = voiceSelect.value;
            url = await fetchChunk(currentChunkIndex);

            // If voice changed during fetch, abort this playback attempt
            if (voiceSelect.value !== fetchingVoice) return;

            if (!url) throw new Error('Failed to get chunk URL');
        }

        if (!isPlaying) return; // User might have paused while fetching

        // PING-PONG LOGIC
        // If the current URL is already loaded in the standby player, swap instantly
        // If not (first play, or jump), load it into the active player

        let targetAudio = activeAudio;
        const inactiveAudio = activeAudio === audioA ? audioB : audioA;

        if (inactiveAudio.src === url) {
            // Hot swap! The inactive player was already preloaded with this chunk
            targetAudio = inactiveAudio;
            activeAudio = targetAudio; // Swap global reference
        } else {
            // Cold start or jump: load into current active player
            targetAudio.src = url;
        }

        applySpeed(); // Ensure rate is correct before play

        try {
            await targetAudio.play();
        } catch (e) {
            console.warn("Autoplay blocked or playback error, retrying", e);
            // Fallback for edge cases
            targetAudio.src = url;
            await targetAudio.play();
        }

        loadingIcon.classList.add('hidden');
        pauseIcon.classList.remove('hidden');

        // Start prefetching next chunks (and priming the now-inactive player)
        prefetchNext();

    } catch (error) {
        console.error('Playback error:', error);
        if (isPlaying) {
            currentChunkIndex++;
            playChunk();
        }
    }
}

function handleAudioEnd() {
    if (isPlaying) {
        // Cleanup current chunk from cache to save memory
        const oldUrl = chunkCache.get(currentChunkIndex);
        // Don't revoke immediately if we want to allow backtracking, 
        // but for memory safety with many chunks we should eventually.
        // For ping-pong we need to be careful not to revoke what just finished 
        // if we intend to replay it, but here we move forward.

        // We defer revocation slightly or keep a small LRU, but for now strict cleanup:
        if (oldUrl && oldUrl !== 'fetching') {
            // We can check if any audio player currently holds this src before revoking?
            // Actually unsafe to revoke if it's currently assigned to a player tag that hasn't unloaded it.
            // Safer to just let garbage collection handle blobs or use a slightly larger cache window.
            // For this simple app, we can just not revoke explicitly or revoke chunks < current - 5
        }

        currentChunkIndex++;
        playChunk();
    }
}

// Attach listeners to BOTH players
audioA.onended = handleAudioEnd;
audioB.onended = handleAudioEnd;

function playPause() {
    if (isPlaying) {
        audioA.pause();
        audioB.pause();
        isPlaying = false;
        playIcon.classList.remove('hidden');
        pauseIcon.classList.add('hidden');
        loadingIcon.classList.add('hidden');
    } else {
        isPlaying = true;
        playIcon.classList.add('hidden');
        pauseIcon.classList.remove('hidden');

        const currentPlayer = activeAudio;
        if (currentPlayer.src && currentPlayer.paused && currentChunkIndex < chunks.length) {
            currentPlayer.play().catch(() => playChunk());
        } else {
            if (chunks.length === 0) {
                const rawText = novelTextElem.value;
                chunks = splitIntoChunks(rawText);

                // Switch to Reader Mode
                if (chunks.length > 0) {
                    novelTextElem.classList.add('hidden');
                    readerView.classList.remove('hidden');
                    readerView.innerHTML = chunks.map((text, i) =>
                        `<span id="chunk-${i}" class="chunk">${text}</span>`
                    ).join('<br><br>');
                }
            }
            if (chunks.length === 0) {
                isPlaying = false;
                playIcon.classList.remove('hidden');
                pauseIcon.classList.add('hidden');
                return;
            }
            playChunk();
        }
    }
}

function stopReading() {
    isPlaying = false;
    audioA.pause();
    audioB.pause();
    audioA.src = '';
    audioB.src = '';

    clearCache();
    currentChunkIndex = 0;
    chunks = [];

    // Switch back to Editor Mode
    readerView.classList.add('hidden');
    novelTextElem.classList.remove('hidden');

    playIcon.classList.remove('hidden');
    pauseIcon.classList.add('hidden');
    loadingIcon.classList.add('hidden');
    updateProgress();
}
playBtn.addEventListener('click', playPause);
stopBtn.addEventListener('click', stopReading);

// New features event listeners
fetchBtn.addEventListener('click', () => fetchNovelContent(novelUrlInput.value.trim()));
nextBtn.addEventListener('click', () => navigateToChapter('next'));
prevBtn.addEventListener('click', () => navigateToChapter('prev'));

document.getElementById('toggleAdvanced').addEventListener('click', () => {
    document.getElementById('advancedPanel').classList.toggle('hidden');
});

novelUrlInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') fetchNovelContent(novelUrlInput.value.trim());
});

// Click-to-play feature
readerView.addEventListener('click', (e) => {
    if (e.target.classList.contains('chunk')) {
        const index = parseInt(e.target.id.replace('chunk-', ''));
        if (!isNaN(index)) {
            // Stop both before jumping
            audioA.pause();
            audioB.pause();

            currentChunkIndex = index;
            if (!isPlaying) {
                playPause(); // Starts playback
            } else {
                playChunk(); // Jumps to new chunk
            }
        }
    }
});

voiceSelect.addEventListener('change', () => {
    if (chunks.length === 0) return;

    audioA.pause();
    audioB.pause();
    clearCache();

    // Force play mode if we have content
    isPlaying = true;
    playIcon.classList.add('hidden');
    pauseIcon.classList.remove('hidden');
    loadingIcon.classList.add('hidden');

    playChunk();

    // Save selection
    localStorage.setItem('novelReader_voice', voiceSelect.value);
});
