const express = require('express');
const cors = require('cors');
const path = require('path');
const os = require('os');

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Serve static files from the current directory
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// --- TTS Engine Setup ---

const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
const crypto = require('crypto');

// Polyfill for msedge-tts which expects global crypto and WebSocket
if (!global.crypto) {
    global.crypto = crypto.webcrypto;
}
if (!global.WebSocket) {
    global.WebSocket = require('ws');
}

// Priority voices (High quality English Neural)
const PRIORITY_VOICES = [
    'en-US-AndrewNeural',
    'en-US-EmmaNeural',
    'en-US-BrianNeural',
    'en-US-AnaNeural',
    'en-US-AriaNeural',
    'en-US-ChristopherNeural',
    'en-US-EricNeural',
    'en-US-GuyNeural',
    'en-US-JennyNeural',
    'en-US-MichelleNeural',
    'en-US-RogerNeural',
    'en-US-SteffanNeural',
    'en-GB-SoniaNeural',
    'en-GB-RyanNeural'
];

// Get available voices
app.get('/api/voices', async (req, res) => {
    try {
        const tts = new MsEdgeTTS();
        const allVoices = await tts.getVoices();

        // Buckets
        const priority = [];
        const english = [];
        const others = [];

        // Helper to check if voice is in priority list
        const isPriority = (shortName) => PRIORITY_VOICES.includes(shortName);

        allVoices.forEach(v => {
            if (isPriority(v.ShortName)) {
                priority.push(v);
            } else if (v.Locale.startsWith('en-')) {
                english.push(v);
            } else {
                others.push(v);
            }
        });

        // Sort priority exactly as defined in the list
        priority.sort((a, b) => {
            return PRIORITY_VOICES.indexOf(a.ShortName) - PRIORITY_VOICES.indexOf(b.ShortName);
        });

        // Sort others alphabetically
        english.sort((a, b) => a.FriendlyName.localeCompare(b.FriendlyName));
        others.sort((a, b) => a.FriendlyName.localeCompare(b.FriendlyName));

        res.json([...priority, ...english, ...others]);
    } catch (error) {
        console.error('Error fetching voices:', error);
        res.status(500).json({ error: 'Failed to fetch voices' });
    }
});

// Stream TTS audio
app.post('/api/tts', async (req, res) => {
    let { text, voice } = req.body;

    if (!text) {
        return res.status(400).json({ error: 'Text is required' });
    }

    // Sanitize text: replace &nbsp; with space, remove other HTML entities and tags
    text = text
        .replace(/&nbsp;/gi, ' ')
        .replace(/&[a-zA-Z0-9#]+;/g, ' ') // Replace other HTML entities with space
        .replace(/<[^>]*>?/gm, '') // Remove HTML tags
        .trim();

    try {
        const voiceName = voice || 'en-US-AndrewNeural';
        console.log(`TTS: "${text.substring(0, 40)}..." [${voiceName}]`);

        res.setHeader('Content-Type', 'audio/mpeg');

        const comm = new MsEdgeTTS();
        await comm.setMetadata(voiceName, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);

        try {
            const output = await comm.toStream(text);
            const stream = output.audioStream;

            if (!stream) {
                console.error('No audio stream returned from Edge TTS');
                return res.status(500).json({ error: 'Failed to generate audio stream' });
            }

            stream.pipe(res);

            stream.on('error', (err) => {
                console.error('TTS stream error:', err);
                if (!res.headersSent) res.status(500).end();
            });

        } catch (streamError) {
            console.error('Core TTS error:', streamError);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Failed to synthesize speech' });
            }
        }

    } catch (error) {
        console.error('TTS Error:', error);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Failed to synthesize speech' });
        }
    }
});

// --- Start Server ---

app.listen(port, '0.0.0.0', () => {
    console.log(`Server running at http://localhost:${port}`);

    // Find and print local IP address
    try {
        const interfaces = os.networkInterfaces();
        for (const name of Object.keys(interfaces)) {
            for (const iface of interfaces[name]) {
                if (iface.family === 'IPv4' && !iface.internal) {
                    console.log(`Local Network: http://${iface.address}:${port}`);
                }
            }
        }
    } catch (e) {
        console.log('Could not determine local IP address');
    }
    setInterval(() => { }, 10000);
});
