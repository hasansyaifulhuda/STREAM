const { google } = require('googleapis');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const dns = require('dns');

if (dns.setDefaultResultOrder) {
    dns.setDefaultResultOrder('ipv4first');
}

const httpsAgent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 30000,
    maxSockets: 100,
    maxFreeSockets: 10,
    timeout: 60000
});

const httpAgent = new http.Agent({
    keepAlive: true,
    keepAliveMsecs: 30000,
    maxSockets: 100
});

function loadEnvFile() {
    const envPath = path.join(__dirname, '.env');
    if (fs.existsSync(envPath)) {
        try {
            let content = fs.readFileSync(envPath, 'utf8');
            content = content.replace(/^\uFEFF/, '');
            content.split(/\r?\n/).forEach(line => {
                const trimmed = line.trim();
                if (trimmed && !trimmed.startsWith('#')) {
                    const eqIdx = trimmed.indexOf('=');
                    if (eqIdx > 0) {
                        const key = trimmed.substring(0, eqIdx).trim();
                        let val = trimmed.substring(eqIdx + 1).trim();
                        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
                            val = val.slice(1, -1);
                        }
                        process.env[key] = val;
                    }
                }
            });
        } catch (e) {}
    }
}
loadEnvFile();

process.on('uncaughtException', () => {});
process.on('unhandledRejection', () => {});

const uploadJobs = global._uploadJobs || new Map();
global._uploadJobs = uploadJobs;

const TMDB_KEYS = [
    '3fd2be6f0cd02802273d23139a7707f5',
    '15d2ea6d0daf1846e374d90317560d22',
    '84242e9f29b40258034a0219100e28a5',
    'c33fb3a4d6efdf81e1e912f27dd060db'
];

function getOAuth2Client() {
    const oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET
    );
    oauth2Client.setCredentials({
        refresh_token: process.env.GOOGLE_REFRESH_TOKEN
    });
    return oauth2Client;
}

async function getMetadataFile(drive) {
    const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
    if (!folderId) throw new Error("GOOGLE_DRIVE_FOLDER_ID tidak ditemukan");

    const q = `'${folderId}' in parents and name = 'metadata.json' and trashed = false`;
    const res = await drive.files.list({ q, fields: 'files(id, name)' });

    if (res.data.files && res.data.files.length > 0) {
        const fileId = res.data.files[0].id;
        const fileContent = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'text' });
        try {
            const data = typeof fileContent.data === 'string' ? JSON.parse(fileContent.data) : fileContent.data;
            return { fileId, data: Array.isArray(data) ? data : [] };
        } catch (e) {
            return { fileId, data: [] };
        }
    } else {
        const createRes = await drive.files.create({
            requestBody: {
                name: 'metadata.json',
                parents: [folderId],
                mimeType: 'application/json'
            },
            media: {
                mimeType: 'application/json',
                body: JSON.stringify([])
            },
            fields: 'id'
        });
        return { fileId: createRes.data.id, data: [] };
    }
}

async function saveMetadataFile(drive, dataList) {
    const { fileId } = await getMetadataFile(drive);
    await drive.files.update({
        fileId: fileId,
        media: {
            mimeType: 'application/json',
            body: JSON.stringify(dataList, null, 2)
        }
    });
}

function parseJsonBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (e) {
                reject(e);
            }
        });
        req.on('error', reject);
    });
}

function sanitizePosterUrl(url) {
    const defaultPoster = "https://images.unsplash.com/photo-1578632767115-351597cf2477?w=800";
    if (!url || typeof url !== 'string') return defaultPoster;
    url = url.trim();
    if (!url.startsWith('http://') && !url.startsWith('https://')) return defaultPoster;
    if (url.includes('drive.google.com') || url.includes('docs.google.com')) {
        const match = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/) || url.match(/id=([a-zA-Z0-9_-]+)/);
        if (match && match[1]) {
            return `https://lh3.googleusercontent.com/d/${match[1]}`;
        }
    }
    return url;
}

function cleanTitleForSearch(raw) {
    if (!raw) return '';
    return raw
        .replace(/https?:\/\/[^\s]+/gi, '')
        .replace(/\.(mp4|mkv|avi|mov|webm|flv)$/i, '')
        .replace(/[._-]/g, ' ')
        .replace(/\b(1080p|720p|480p|4k|hdr|web-dl|bluray|x264|hevc|h264|aac)\b/gi, '')
        .replace(/\b(19\d{2}|20\d{2})\b/g, '')
        .trim();
}

function httpGetJson(targetUrl, headers = {}) {
    return new Promise((resolve, reject) => {
        try {
            const parsed = new URL(targetUrl);
            const client = parsed.protocol === 'https:' ? https : http;
            const req = client.request(targetUrl, {
                method: 'GET',
                agent: parsed.protocol === 'https:' ? httpsAgent : httpAgent,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'application/json',
                    ...headers
                },
                timeout: 5000
            }, (res) => {
                let body = '';
                res.on('data', c => { body += c; });
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(body));
                    } catch (e) {
                        reject(e);
                    }
                });
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
            req.end();
        } catch (err) {
            reject(err);
        }
    });
}

async function fetchMetadataEngine(rawTitle) {
    const query = cleanTitleForSearch(rawTitle);
    const fallback = {
        title: query || "Untitled Movie",
        posterUrl: "https://images.unsplash.com/photo-1578632767115-351597cf2477?w=800",
        overview: "Sinopsis tidak ditemukan.",
        year: "2026",
        genre: "General"
    };

    if (!query) return fallback;

    for (const key of TMDB_KEYS) {
        for (const lang of ['id-ID', 'en-US']) {
            try {
                const tmdbUrl = `https://api.themoviedb.org/3/search/multi?api_key=${key}&query=${encodeURIComponent(query)}&language=${lang}`;
                const res = await httpGetJson(tmdbUrl);
                if (res && res.results && res.results.length > 0) {
                    const match = res.results.find(r => r.media_type === 'movie' || r.media_type === 'tv') || res.results[0];
                    return {
                        title: match.title || match.name || query,
                        posterUrl: match.poster_path ? `https://image.tmdb.org/t/p/w500${match.poster_path}` : fallback.posterUrl,
                        overview: match.overview || fallback.overview,
                        year: (match.release_date || match.first_air_date || '2026').substring(0, 4),
                        genre: match.media_type === 'tv' ? 'Serial TV / Anime' : 'Film / Movie'
                    };
                }
            } catch (e) {}
        }
    }

    try {
        const itunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=movie&limit=1`;
        const res = await httpGetJson(itunesUrl);
        if (res && res.results && res.results.length > 0) {
            const match = res.results[0];
            return {
                title: match.trackName || query,
                posterUrl: match.artworkUrl100 ? match.artworkUrl100.replace('100x100bb', '600x600bb') : fallback.posterUrl,
                overview: match.longDescription || match.shortDescription || fallback.overview,
                year: (match.releaseDate || '2026').substring(0, 4),
                genre: match.primaryGenreName || 'Movie'
            };
        }
    } catch (e) {}

    return fallback;
}

async function handleRequest(req, res) {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Range');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
    }

    if (pathname === '/api/login' && req.method === 'POST') {
        try {
            const body = await parseJsonBody(req);
            const expectedPassword = (process.env.ADMIN_PASSWORD || '').trim();
            const inputPassword = (body.password || '').trim();

            if (expectedPassword && inputPassword === expectedPassword) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ success: true, message: "Login Berhasil" }));
            } else {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ success: false, error: "Password Admin Salah" }));
            }
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: err.message }));
        }
    }

    if (pathname === '/api/movies' && req.method === 'GET') {
        try {
            const auth = getOAuth2Client();
            const drive = google.drive({ version: 'v3', auth });
            let { data: movies } = await getMetadataFile(drive);
            const validMovies = movies.filter(m => m.driveId && !m.driveId.startsWith('drive-') && !m.driveId.startsWith('demo-'));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ movies: validMovies }));
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: err.message, movies: [] }));
        }
    }

    if (pathname === '/api/tmdb-search' && req.method === 'GET') {
        try {
            const raw = parsedUrl.searchParams.get('q') || '';
            const data = await fetchMetadataEngine(raw);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: true, data }));
        } catch (err) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
                success: true,
                data: {
                    title: "Untitled Movie",
                    posterUrl: "https://images.unsplash.com/photo-1578632767115-351597cf2477?w=800",
                    overview: "Sinopsis tidak ditemukan.",
                    year: "2026",
                    genre: "General"
                }
            }));
        }
    }

    if (pathname === '/api/admin/health-check' && req.method === 'POST') {
        try {
            const auth = getOAuth2Client();
            const drive = google.drive({ version: 'v3', auth });
            const { data: movies } = await getMetadataFile(drive);

            const results = await Promise.all(movies.map(async (m) => {
                try {
                    const resFile = await drive.files.get({ fileId: m.driveId, fields: 'id, name, size, trashed' });
                    if (resFile.data.trashed) {
                        return { driveId: m.driveId, title: m.title, status: 'BROKEN', details: 'File Terhapus di Trash' };
                    }
                    const sizeMB = (parseInt(resFile.data.size || '0') / (1024 * 1024)).toFixed(1);
                    return { driveId: m.driveId, title: m.title, status: 'ONLINE', details: `${sizeMB} MB` };
                } catch (e) {
                    return { driveId: m.driveId, title: m.title, status: 'BROKEN', details: 'Link Rusak / ID 404' };
                }
            }));

            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: true, results }));
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: err.message }));
        }
    }

    if (pathname === '/api/upload/preview' && req.method === 'POST') {
        try {
            const body = await parseJsonBody(req);
            const { urls } = body;
            if (!urls || !Array.isArray(urls) || urls.length === 0) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: "Daftar URL kosong" }));
            }

            const results = [];
            for (let rawUrl of urls.slice(0, 10)) {
                const singleUrl = rawUrl.trim();
                if (!singleUrl) continue;
                const metadata = await fetchMetadataEngine(singleUrl);
                results.push({
                    url: singleUrl,
                    title: metadata.title,
                    poster: metadata.posterUrl,
                    genre: metadata.genre,
                    year: metadata.year,
                    description: metadata.overview
                });
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: true, items: results }));
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: err.message }));
        }
    }

    if (pathname === '/api/stream' && req.method === 'GET') {
        try {
            const driveId = parsedUrl.searchParams.get('id');
            if (!driveId || driveId.startsWith('demo-') || driveId.startsWith('drive-')) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'Drive ID tidak valid' }));
            }

            const auth = getOAuth2Client();
            const drive = google.drive({ version: 'v3', auth });

            const fileMeta = await drive.files.get({ fileId: driveId, fields: 'size, mimeType' });
            const fileSize = parseInt(fileMeta.data.size || '0', 10);
            const range = req.headers.range;

            if (range && fileSize > 0) {
                const parts = range.replace(/bytes=/, "").split("-");
                const start = parseInt(parts[0], 10);
                const maxChunk = 4 * 1024 * 1024;
                let end = parts[1] ? parseInt(parts[1], 10) : start + maxChunk - 1;
                if (end >= fileSize) end = fileSize - 1;

                const chunkSize = (end - start) + 1;

                res.writeHead(206, {
                    'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                    'Accept-Ranges': 'bytes',
                    'Content-Length': chunkSize,
                    'Content-Type': 'video/mp4',
                    'Cache-Control': 'no-cache, no-store, must-revalidate',
                    'Pragma': 'no-cache'
                });

                const streamRes = await drive.files.get(
                    { fileId: driveId, alt: 'media' },
                    { responseType: 'stream', headers: { Range: `bytes=${start}-${end}` } }
                );

                streamRes.data.pipe(res);
                req.on('close', () => {
                    try {
                        streamRes.data.destroy();
                    } catch (e) {}
                });
            } else {
                res.writeHead(200, {
                    'Content-Length': fileSize,
                    'Content-Type': 'video/mp4',
                    'Accept-Ranges': 'bytes'
                });

                const streamRes = await drive.files.get(
                    { fileId: driveId, alt: 'media' },
                    { responseType: 'stream' }
                );

                streamRes.data.pipe(res);
                req.on('close', () => {
                    try {
                        streamRes.data.destroy();
                    } catch (e) {}
                });
            }
            return;
        } catch (err) {
            if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message }));
            }
            return;
        }
    }

    if (pathname === '/api/movies/delete' && req.method === 'POST') {
        try {
            const body = await parseJsonBody(req);
            const { driveId, password } = body;
            const expectedPassword = (process.env.ADMIN_PASSWORD || '').trim();

            if (!expectedPassword || password !== expectedPassword) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: "Otorisasi Admin Gagal" }));
            }

            const auth = getOAuth2Client();
            const drive = google.drive({ version: 'v3', auth });

            try {
                await drive.files.delete({ fileId: driveId });
            } catch (e) {}

            let { data: currentList } = await getMetadataFile(drive);
            const updatedList = currentList.filter(m => m.driveId !== driveId);
            await saveMetadataFile(drive, updatedList);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: true, message: "Film terhapus" }));
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: err.message }));
        }
    }

    if (pathname === '/api/movies/update' && req.method === 'POST') {
        try {
            const body = await parseJsonBody(req);
            const { driveId, password, title, poster, genre, year, description } = body;
            const expectedPassword = (process.env.ADMIN_PASSWORD || '').trim();

            if (!expectedPassword || password !== expectedPassword) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: "Otorisasi Admin Gagal" }));
            }

            const auth = getOAuth2Client();
            const drive = google.drive({ version: 'v3', auth });

            let { data: currentList } = await getMetadataFile(drive);
            let found = false;

            const updatedList = currentList.map(item => {
                if (item.driveId === driveId) {
                    found = true;
                    return {
                        ...item,
                        title: title || item.title,
                        poster: sanitizePosterUrl(poster || item.poster),
                        genre: genre || item.genre,
                        year: year || item.year,
                        description: description !== undefined ? description : item.description
                    };
                }
                return item;
            });

            if (!found) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: "Film tidak ditemukan" }));
            }

            await saveMetadataFile(drive, up