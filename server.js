const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');

const app = express();
const port = 3001;

app.use(cors());
app.use(express.json());

// Serve static files from the current directory
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});



const { Communicate, listVoices } = require('edge-tts-universal');

// ... existing code ...

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
        const allVoices = await listVoices();

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
    const { text, voice } = req.body;

    if (!text) {
        return res.status(400).json({ error: 'Text is required' });
    }

    try {
        const voiceName = voice || 'en-US-AndrewNeural'; // Default to a high quality voice
        console.log(`Synthesizing with Edge TTS: "${text.substring(0, 30)}..." using ${voiceName}`);

        res.setHeader('Content-Type', 'audio/mpeg');

        const comm = new Communicate(text, { voice: voiceName });

        for await (const chunk of comm.stream()) {
            if (chunk.type === 'audio') {
                res.write(chunk.data);
            }
        }
        res.end();

    } catch (error) {
        console.error('TTS Error:', error);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Failed to synthesize speech' });
        }
    }
});

// Fetch novel content from URL
app.post('/api/fetch-novel', async (req, res) => {
    const { url, selector } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }

    try {
        console.log(`Fetching novel from: ${url}`);
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
            },
            timeout: 10000
        });

        const html = response.data;
        const $ = cheerio.load(html);

        // EXTRACTION STRATEGY 1: JSON Data (for Next.js/heavy JS sites)
        const nextData = $('#__NEXT_DATA__').html();
        if (nextData) {
            try {
                const parsed = JSON.parse(nextData);
                const pageProps = parsed.props?.pageProps;
                if (pageProps) {
                    const chapterDetail = pageProps.chapterDetail || pageProps.post || pageProps.chapter;
                    if (chapterDetail && (chapterDetail.content || chapterDetail.body)) {
                        console.log('Successfully extracted content from JSON data');
                        const contentHtml = chapterDetail.content || chapterDetail.body;
                        const $content = cheerio.load(contentHtml);
                        const jsonParagraphs = [];
                        $content('p, div').each((i, el) => {
                            const t = $content(el).text().trim();
                            if (t.length > 20) jsonParagraphs.push(t);
                        });
                        if (jsonParagraphs.length > 0) {
                            return res.json({ text: jsonParagraphs.join('\n\n') });
                        }
                    }
                }
            } catch (e) {
                console.log('Found NEXT_DATA but failed to parse it');
            }
        }

        // EXTRACTION STRATEGY 2: CSS Selectors
        $('script, style, ins, .ads, #ads, .notification, footer, header, nav').remove();

        const paragraphs = [];
        const targetSelectors = selector ? [selector] : [
            '#reader-container',
            '.chapter-content',
            '#chapter-content',
            '.read-container',
            '#content',
            '.entry-content',
            'main article'
        ];

        let foundContent = false;
        for (const sel of targetSelectors) {
            const container = $(sel);
            if (container.length > 0) {
                container.find('p, div').each((i, el) => {
                    const text = $(el).text().trim();
                    if (text.length > 10) paragraphs.push(text);
                });

                if (paragraphs.length > 0) {
                    foundContent = true;
                    console.log(`Found content using selector: ${sel}`);
                    break;
                }
            }
        }

        if (!foundContent) {
            console.log('No specific container found, falling back to all paragraphs');
            $('p').each((i, el) => {
                const text = $(el).text().trim();
                if (text && text.length > 40) paragraphs.push(text);
            });
        }

        const fullText = paragraphs.join('\n\n');

        if (!fullText || fullText.length < 50) {
            return res.status(404).json({ error: 'Could not find readable content. The site might be JS-heavy or protected.' });
        }

        res.json({ text: fullText });

    } catch (error) {
        console.error('Fetch Error:', error.message);
        res.status(500).json({ error: `Failed to fetch: ${error.message}` });
    }
});

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
