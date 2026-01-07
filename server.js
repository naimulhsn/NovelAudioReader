const express = require('express');
const cors = require('cors');
// const axios = require('axios'); // Removed
const cheerio = require('cheerio');
const path = require('path');

// const { chromium } = require('playwright'); // Removed

const app = express();
const port = process.env.PORT || 3001;

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

        // Dynamic import for got-scraping (ESM only package)
        const { gotScraping } = await import('got-scraping');

        const response = await gotScraping({
            url,
            headerGeneratorOptions: {
                browsers: [
                    { name: 'chrome', minVersion: 120 },
                    { name: 'firefox', minVersion: 120 }
                ],
                devices: ['desktop'],
                locales: ['en-US'],
                operatingSystems: ['windows', 'linux'],
            }
        });

        const html = response.body;
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
            'main article',
            '.prose',
            '.text-content'
        ];

        let foundContent = false;
        for (const sel of targetSelectors) {
            const container = $(sel);
            if (container.length > 0) {
                container.find('p, div, h1, h2, h3').each((i, el) => {
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
            console.log('Standard fetch failed. Attempting lightweight CSR bypass via Jina AI...');

            try {
                // Jina AI (r.jina.ai) renders JS and returns Markdown
                // This offloads the browser rendering to their servers
                const jinaUrl = `https://r.jina.ai/${url}`;
                const jinaResponse = await gotScraping({
                    url: jinaUrl,
                    headerGeneratorOptions: {
                        browsers: [{ name: 'chrome', minVersion: 120 }],
                        devices: ['desktop'],
                        locales: ['en-US'],
                        operatingSystems: ['windows'],
                    }
                });

                const jinaText = jinaResponse.body;

                // Jina returns Markdown. heavily simplify it to just text
                // Remove links, images, etc? Or just return as is?
                // The current frontend expects "text".
                // Let's do some basic cleanup of the markdown to plain text if possible,
                // or just return the markdown if it's readable.

                // Simple cleanup regex for markdown links/images to text
                const cleanText = jinaText
                    .replace(/!\[.*?\]\(.*?\)/g, '') // Remove images
                    .replace(/\[([^\]]+)\]\(.*?\)/g, '$1') // Keep link text
                    .replace(/#{1,6}\s?/g, '') // Remove headers
                    .replace(/\*\*/g, '') // Remove bold
                    .replace(/\*/g, '') // Remove italic
                    .trim();

                if (cleanText.length > 50) {
                    console.log('Successfully fetched content via Jina AI');
                    return res.json({ text: cleanText });
                }

            } catch (jinaError) {
                console.error('Jina AI fallback failed:', jinaError.message);
            }

            return res.status(404).json({ error: 'Could not find readable content. The site is likely a complex SPA prevented from scraping.' });
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
