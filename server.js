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
    maxSockets: 200,
    maxFreeSockets: 30,
    timeout: 60000
});

const httpAgent = new http.Agent({
    keepAlive: true,
    keepAliveMsecs: 30000,
    maxSockets: 200
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
            console.log("✅ File .env berhasil dibaca secara native!");
        } catch (e) {
            console.error("⚠️ Gagal membaca file .env:", e.message);
        }
    }
}
loadEnvFile();

process.on('uncaughtException', (err) => {
    console.error("⚠️ [Uncaught Exception]:", err.message);
});
process.on('unhandledRejection', (reason) => {
    console.error("⚠️ [Unhandled Rejection]:", reason);
});

const uploadJobs = global._uploadJobs || new Map();
global._uploadJobs = uploadJobs;

const memoryCache = new Map();

function getCache(key) {
    const item = memoryCache.get(key);
    if (!item) return null;
    if (Date.now() > item.expiry) {
        memoryCache.delete(key);
        return null;
    }
    return item.value;
}

function setCache(key, value, ttlMs) {
    memoryCache.set(key, { value, expiry: Date.now() + ttlMs });
}

function clearCache(key) {
    memoryCache.delete(key);
}

let saPoolIndex = 0;

function getAuthClientsPool() {
    const clients = [];
    if (process.env.GOOGLE_SERVICE_ACCOUNTS) {
        try {
            const rawList = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNTS);
            if (Array.isArray(rawList)) {
                for (const sa of rawList) {
                    const jwt = new google.auth.JWT(
                        sa.client_email,
                        null,
                        sa.private_key,
                        ['https://www.googleapis.com/auth/drive']
                    );
                    clients.push({ client: jwt, type: 'sa', email: sa.client_email });
                }
            }
        } catch (e) {}
    }

    if (clients.length === 0) {
        const oauth2Client = new google.auth.OAuth2(
            process.env.GOOGLE_CLIENT_ID,
            process.env.GOOGLE_CLIENT_SECRET
        );
        oauth2Client.setCredentials({
            refresh_token: process.env.GOOGLE_REFRESH_TOKEN
        });
        clients.push({ client: oauth2Client, type: 'oauth', email: 'OAuth2_User' });
    }

    return clients;
}

function getNextRotatedAuth() {
    const pool = getAuthClientsPool();
    const selected = pool[saPoolIndex % pool.length];
    saPoolIndex = (saPoolIndex + 1) % pool.length;
    return selected;
}

async function getAccessTokenForClient(authObj) {
    const cacheKey = `access_token_${authObj.email}`;
    const cachedToken = getCache(cacheKey);
    if (cachedToken) return cachedToken;

    const auth = authObj.client;
    const res = await auth.getAccessToken();
    const token = typeof res === 'string' ? res : res.token;
    if (!token) throw new Error("Gagal mengambil access token dari Google Drive.");

    setCache(cacheKey, token, 50 * 60 * 1000);
    return token;
}

async function getMetadataFile(drive) {
    const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
    if (!folderId) throw new Error("GOOGLE_DRIVE_FOLDER_ID belum diisi di file .env!");

    const cacheKey = `metadata_file_list_${folderId}`;
    const cachedData = getCache(cacheKey);
    if (cachedData) return cachedData;

    const q = `'${folderId}' in parents and name = 'metadata.json' and trashed = false`;
    const res = await drive.files.list({ q, fields: 'files(id, name)' });

    if (res.data.files && res.data.files.length > 0) {
        const fileId = res.data.files[0].id;
        const fileContent = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'text' });
        try {
            const data = typeof fileContent.data === 'string' ? JSON.parse(fileContent.data) : fileContent.data;
            const result = { fileId, data: Array.isArray(data) ? data : [] };
            setCache(cacheKey, result, 10 * 60 * 1000);
            return result;
        } catch (e) {
            const result = { fileId, data: [] };
            setCache(cacheKey, result, 10 * 60 * 1000);
            return result;
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
        const result = { fileId: createRes.data.id, data: [] };
        setCache(cacheKey, result, 10 * 60 * 1000);
        return result;
    }
}

async function saveMetadataFile(drive, dataList) {
    const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
    const { fileId } = await getMetadataFile(drive);

    await drive.files.update({
        fileId: fileId,
        media: {
            mimeType: 'application/json',
            body: JSON.stringify(dataList, null, 2)
        }
    });

    clearCache(`metadata_file_list_${folderId}`);
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

function resolveTargetUrl(targetUrl) {
    if (!targetUrl || typeof targetUrl !== 'string') return targetUrl;
    targetUrl = targetUrl.trim();

    if (targetUrl.includes('pixeldrain.com/u/')) {
        return targetUrl.replace('pixeldrain.com/u/', 'pixeldrain.com/api/file/');
    }

    if ((targetUrl.includes('drive.google.com') || targetUrl.includes('docs.google.com')) && 
        !targetUrl.includes('drive.usercontent.google.com') && 
        !targetUrl.includes('export=download')) {
        const match = targetUrl.match(/\/file\/d\/([a-zA-Z0-9_-]+)/) || targetUrl.match(/id=([a-zA-Z0-9_-]+)/);
        if (match && match[1]) {
            return `https://drive.google.com/uc?export=download&confirm=t&id=${match[1]}`;
        }
    }
    return targetUrl;
}

function fetchHtmlPage(pageUrl, redirectsLeft = 5) {
    return new Promise((resolve, reject) => {
        if (redirectsLeft <= 0) return reject(new Error("Terlalu banyak redirect halaman web!"));
        try {
            const parsedUrl = new URL(pageUrl);
            const client = parsedUrl.protocol === 'https:' ? https : http;

            const reqOptions = {
                method: 'GET',
                agent: parsedUrl.protocol === 'https:' ? httpsAgent : httpAgent,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9'
                },
                timeout: 15000
            };

            const req = client.request(pageUrl, reqOptions, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    let redirectUrl = res.headers.location;
                    if (!redirectUrl.startsWith('http')) {
                        redirectUrl = new URL(redirectUrl, pageUrl).href;
                    }
                    res.destroy();
                    return resolve(fetchHtmlPage(redirectUrl, redirectsLeft - 1));
                }

                let html = '';
                res.on('data', chunk => { html += chunk; });
                res.on('end', () => resolve(html));
                res.on('error', reject);
            });

            req.on('timeout', () => { req.destroy(); reject(new Error("Timeout saat membaca halaman web.")); });
            req.on('error', reject);
            req.end();
        } catch (e) {
            reject(e);
        }
    });
}

function parseMovieBoxMetadataAndStream(html, pageUrl) {
    let title = '';
    let poster = '';
    let description = '';
    let year = '';
    let videoUrl = '';

    let matchTitle = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i) ||
                     html.match(/<title>([^<]+)<\/title>/i);
    if (matchTitle && matchTitle[1]) {
        title = matchTitle[1].replace(/ - MovieBox.*/i, '').replace(/ - Watch.*/i, '').trim();
    }

    let matchPoster = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i) ||
                      html.match(/<link\s+rel=["']image_src["']\s+href=["']([^"']+)["']/i);
    if (matchPoster && matchPoster[1]) {
        poster = matchPoster[1].trim();
    }

    let matchDesc = html.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i) ||
                    html.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i);
    if (matchDesc && matchDesc[1]) {
        description = matchDesc[1].trim();
    }

    let matchYear = html.match(/\b(202[0-9]|201[0-9])\b/);
    if (matchYear) year = matchYear[1];

    const isTrailerPattern = /trailer|preview|promo|teaser|sample|short/i;
    let streamCandidates = [];

    let scriptMatches = html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi) || [];
    for (let scriptTag of scriptMatches) {
        let content = scriptTag.replace(/<\/?script[^>]*>/gi, '');
        let jsonMatches = [...content.matchAll(/["'](?:url|file|src|path|download_url|stream_url|play_url|playUrl|videoUrl|hls_url)["']\s*:\s*["'](https?:[^"']+)["']/gi)];
        for (let m of jsonMatches) {
            let candidate = m[1].replace(/\\/g, '');
            if (!isTrailerPattern.test(candidate)) {
                streamCandidates.push({ url: candidate, score: 100 });
            }
        }
    }

    if (streamCandidates.length === 0) {
        let rawVideoMatches = html.match(/https?:\\?\/\\?\/[^\s"'<>]+?\.(?:mp4|m3u8|mkv|webm|mov)(?:\?[^\s"'<>]*)?/gi) || [];
        for (let rawUrl of rawVideoMatches) {
            let candidate = rawUrl.replace(/\\/g, '');
            if (!isTrailerPattern.test(candidate)) {
                streamCandidates.push({ url: candidate, score: 50 });
            }
        }
    }

    if (streamCandidates.length > 0) {
        videoUrl = streamCandidates[0].url;
    }

    return { title, poster, description, year, videoUrl };
}

function startStreamUploadJob(jobId, targetUrl, metadata, redirectsLeft = 10) {
    const job = uploadJobs.get(jobId);
    if (!job) return;

    if (redirectsLeft <= 0) {
        job.status = 'error';
        job.error = "Terlalu banyak redirect dari server sumber video!";
        return;
    }

    try {
        const authObj = getNextRotatedAuth();
        const drive = google.drive({ version: 'v3', auth: authObj.client });
        const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;

        if (!folderId) {
            job.status = 'error';
            job.error = "GOOGLE_DRIVE_FOLDER_ID belum diisi di file .env!";
            return;
        }

        const resolvedUrl = resolveTargetUrl(targetUrl);
        const parsedUrl = new URL(resolvedUrl);
        const client = parsedUrl.protocol === 'https:' ? https : http;

        const reqOptions = {
            method: 'GET',
            agent: parsedUrl.protocol === 'https:' ? httpsAgent : httpAgent,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36',
                'Accept': '*/*'
            },
            timeout: 60000
        };

        const reqSource = client.request(resolvedUrl, reqOptions, (resSource) => {
            if (resSource.statusCode >= 300 && resSource.statusCode < 400 && resSource.headers.location) {
                let redirectUrl = resSource.headers.location;
                if (!redirectUrl.startsWith('http')) {
                    redirectUrl = new URL(redirectUrl, resolvedUrl).href;
                }
                resSource.destroy();
                return startStreamUploadJob(jobId, redirectUrl, metadata, redirectsLeft - 1);
            }

            if (resSource.statusCode >= 400) {
                resSource.destroy();
                job.status = 'error';
                job.error = `HTTP Error ${resSource.statusCode} dari server sumber video.`;
                return;
            }

            let fileSize = 0;
            if (resSource.headers['content-length']) {
                fileSize = parseInt(resSource.headers['content-length'], 10);
            }
            job.fileSize = fileSize;
            job.status = 'transferring';

            let transferred = 0;
            let lastTransferred = 0;
            let lastTime = Date.now();

            const { PassThrough } = require('stream');
            const passThrough = new PassThrough({ highWaterMark: 8 * 1024 * 1024 });

            resSource.on('data', (chunk) => {
                transferred += chunk.length;
                job.transferred = transferred;

                const now = Date.now();
                const timeDiff = (now - lastTime) / 1000;
                if (timeDiff >= 0.5) {
                    const bytesDiff = transferred - lastTransferred;
                    const speedMBps = (bytesDiff / (1024 * 1024)) / timeDiff;
                    job.speedMBps = speedMBps.toFixed(1);
                    lastTime = now;
                    lastTransferred = transferred;
                }
            });

            resSource.on('error', (err) => {
                job.status = 'error';
                job.error = `Error saat streaming video: ${err.message}`;
            });

            resSource.pipe(passThrough);

            drive.files.create({
                requestBody: {
                    name: `${metadata.title || 'Movie'}.mp4`,
                    parents: [folderId]
                },
                media: {
                    mimeType: 'video/mp4',
                    body: passThrough
                },
                fields: 'id'
            }).then(async (driveRes) => {
                const realDriveId = driveRes.data.id;
                job.status = 'completed';
                job.driveId = realDriveId;
                job.speedMBps = '0.0';

                try {
                    const { data: currentList } = await getMetadataFile(drive);
                    const cleanedList = currentList.filter(item => item.driveId && !item.driveId.startsWith('drive-') && !item.driveId.startsWith('demo-'));

                    cleanedList.push({
                        driveId: realDriveId,
                        title: metadata.title || "Untitled Movie",
                        poster: sanitizePosterUrl(metadata.poster),
                        genre: metadata.genre || "General",
                        year: metadata.year || "2026",
                        description: metadata.description || ""
                    });

                    await saveMetadataFile(drive, cleanedList);
                } catch (metaErr) {}
            }).catch((err) => {
                job.status = 'error';
                job.error = `Error Google Drive Upload: ${err.message}`;
            });
        });

        reqSource.on('timeout', () => {
            reqSource.destroy();
            job.status = 'error';
            job.error = "Timeout koneksi ke server sumber video.";
        });
        reqSource.on('error', (err) => {
            job.status = 'error';
            job.error = `Error HTTP Request: ${err.message}`;
        });
        reqSource.end();

    } catch (err) {
        job.status = 'error';
        job.error = err.message;
    }
}

async function fetchDriveFileSizeWithRotator(fileId) {
    const cacheKey = `file_size_${fileId}`;
    const cachedSize = getCache(cacheKey);
    if (cachedSize) return cachedSize;

    const pool = getAuthClientsPool();
    let lastError = null;

    for (let i = 0; i < pool.length; i++) {
        const authObj = getNextRotatedAuth();
        try {
            const accessToken = await getAccessTokenForClient(authObj);
            const size = await new Promise((resolve, reject) => {
                const reqOpts = {
                    method: 'GET',
                    agent: httpsAgent,
                    headers: {
                        'Authorization': `Bearer ${accessToken}`
                    }
                };
                const req = https.request(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=size`, reqOpts, (res) => {
                    let body = '';
                    res.on('data', chunk => { body += chunk; });
                    res.on('end', () => {
                        if (res.statusCode === 200) {
                            try {
                                const parsed = JSON.parse(body);
                                resolve(parseInt(parsed.size || '0', 10));
                            } catch (e) {
                                reject(e);
                            }
                        } else {
                            reject(new Error(`Drive API Size error ${res.statusCode}`));
                        }
                    });
                });
                req.on('error', reject);
                req.end();
            });

            if (size > 0) {
                setCache(cacheKey, size, 60 * 60 * 1000);
                return size;
            }
        } catch (err) {
            lastError = err;
        }
    }

    throw lastError || new Error("Gagal mengambil ukuran file Drive.");
}

async function executeStreamWithRotator(fileId, rangeHeader, req, res) {
    const pool = getAuthClientsPool();
    let fileSize = 0;

    try {
        fileSize = await fetchDriveFileSizeWithRotator(fileId);
    } catch (e) {}

    const BURST_CHUNK_SIZE = 8 * 1024 * 1024;
    let start = 0;
    let end = fileSize > 0 ? fileSize - 1 : BURST_CHUNK_SIZE - 1;

    if (rangeHeader && fileSize > 0) {
        const parts = rangeHeader.replace(/bytes=/, "").split("-");
        start = parseInt(parts[0], 10);
        if (parts[1]) {
            end = parseInt(parts[1], 10);
        } else {
            end = Math.min(start + BURST_CHUNK_SIZE - 1, fileSize - 1);
        }
    } else if (fileSize > 0) {
        end = Math.min(BURST_CHUNK_SIZE - 1, fileSize - 1);
    }

    const chunkLength = (end - start) + 1;
    let lastError = null;

    for (let i = 0; i < pool.length; i++) {
        const authObj = getNextRotatedAuth();
        try {
            const accessToken = await getAccessTokenForClient(authObj);

            const headers = {
                'Authorization': `Bearer ${accessToken}`,
                'Range': `bytes=${start}-${end}`
            };

            const driveReqOpts = {
                method: 'GET',
                agent: httpsAgent,
                headers: headers
            };

            const success = await new Promise((resolve, reject) => {
                const driveReq = https.request(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, driveReqOpts, (driveRes) => {
                    if (driveRes.statusCode === 200 || driveRes.statusCode === 206) {
                        const responseHeaders = {
                            'Content-Type': 'video/mp4',
                            'Accept-Ranges': 'bytes',
                            'Content-Length': chunkLength,
                            'Cache-Control': 'public, max-age=31536000'
                        };

                        if (fileSize > 0) {
                            responseHeaders['Content-Range'] = `bytes ${start}-${end}/${fileSize}`;
                        } else if (driveRes.headers['content-range']) {
                            responseHeaders['Content-Range'] = driveRes.headers['content-range'];
                        }

                        res.writeHead(206, responseHeaders);

                        driveRes.pipe(res);

                        req.on('close', () => {
                            driveRes.destroy();
                        });

                        resolve(true);
                    } else if (driveRes.statusCode === 403 || driveRes.statusCode === 429) {
                        driveRes.destroy();
                        reject(new Error(`Rate limit hit on SA (${authObj.email})`));
                    } else {
                        driveRes.destroy();
                        reject(new Error(`Drive API response status ${driveRes.statusCode}`));
                    }
                });

                driveReq.on('error', (err) => {
                    reject(err);
                });

                driveReq.end();
            });

            if (success) return;

        } catch (err) {
            lastError = err;
        }
    }

    if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: lastError ? lastError.message : "Gagal memutar video dari seluruh Service Account." }));
    }
}

const INDEX_HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>MovieBox Cloud Streaming</title>
    
    <!-- PWA Manifest & App Icons -->
    <link rel="manifest" href="/manifest.json">
    <link rel="icon" type="image/png" href="/icon.png">
    <meta name="theme-color" content="#09090b">
    <meta name="mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <meta name="apple-mobile-web-app-title" content="MovieBox">
    <link rel="apple-touch-icon" href="/icon.png">

    <!-- Suppress Console Warnings for Production Tailwind & Deprecations -->
    <script>
        (function() {
            var _warn = console.warn;
            console.warn = function() {
                var msg = arguments[0];
                if (msg && typeof msg === 'string' && (msg.indexOf('tailwindcss.com') !== -1 || msg.indexOf('apple-mobile-web-app-capable') !== -1)) {
                    return;
                }
                _warn.apply(console, arguments);
            };
        })();
    </script>

    <script src="https://cdn.tailwindcss.com"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="https://cdn.plyr.io/3.7.8/plyr.css" />
    <script src="https://cdn.plyr.io/3.7.8/plyr.polyfilled.js"></script>
    <style>
        body {
            font-family: 'Inter', sans-serif;
            background-color: #09090b;
            color: #f4f4f5;
        }
        .no-scrollbar::-webkit-scrollbar {
            display: none;
        }
        .no-scrollbar {
            -ms-overflow-style: none;
            scrollbar-width: none;
        }
        .custom-scrollbar::-webkit-scrollbar {
            width: 6px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
            background: #18181b;
            border-radius: 8px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
            background: #27272a;
            border-radius: 8px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
            background: #3f3f46;
        }
        :root {
            --plyr-color-main: #2563eb;
            --plyr-video-control-color: #f4f4f5;
            --plyr-control-radius: 12px;
        }
        .plyr {
            border-radius: 16px;
            overflow: hidden;
            height: 100%;
            width: 100%;
        }
        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(-4px); }
            to { opacity: 1; transform: translateY(0); }
        }
        .animate-fadeIn {
            animation: fadeIn 0.2s ease-out forwards;
        }
    </style>
</head>
<body class="min-h-screen flex flex-col justify-between selection:bg-blue-600 selection:text-white">

    <!-- CATALOG PAGE VIEW -->
    <div id="catalog-page-view" class="flex flex-col min-h-screen w-full">
        <header class="sticky top-0 z-40 bg-zinc-950/90 backdrop-blur-md border-b border-zinc-800/80 px-3 sm:px-6 py-2.5 flex items-center justify-between gap-2.5 sm:gap-4">
            <div class="relative shrink-0" id="category-dropdown-container">
                <button onclick="toggleCategoryDropdown()" id="category-dropdown-btn" 
                    class="bg-zinc-900 hover:bg-zinc-800 text-white text-xs font-bold px-3.5 py-2 rounded-xl border border-zinc-800 focus:outline-none focus:border-blue-500 cursor-pointer transition shadow-sm flex items-center gap-2">
                    <span id="selected-category-label">Kategori: Semua</span>
                    <i id="category-dropdown-arrow" class="fas fa-chevron-down text-[10px] text-zinc-400 transition-transform duration-200"></i>
                </button>
                
                <div id="category-dropdown-menu" 
                    class="hidden absolute left-0 top-full mt-2 w-52 bg-zinc-900/95 border border-zinc-800/90 backdrop-blur-md rounded-2xl shadow-2xl z-50 py-1.5 max-h-64 overflow-y-auto custom-scrollbar">
                </div>
            </div>

            <div class="relative flex-1 max-w-xs sm:max-w-md">
                <i class="fas fa-search absolute left-3 top-1/2 -translate-y-1/2 text-xs text-zinc-500"></i>
                <input type="text" oninput="handleSearch(this.value)" placeholder="Cari film atau anime..." 
                    class="w-full bg-zinc-900 text-xs text-white pl-8 pr-3 py-2 rounded-xl border border-zinc-800 focus:outline-none focus:border-blue-500 transition">
            </div>

            <button onclick="handleUploaderButtonClick()" class="bg-blue-600/20 hover:bg-blue-600 text-blue-400 hover:text-white border border-blue-500/30 px-3 sm:px-4 py-2 rounded-xl text-xs font-bold transition flex items-center gap-1.5 shrink-0 shadow-sm cursor-pointer">
                <i class="fas fa-sliders-h text-xs"></i>
                <span class="hidden sm:inline">Uploader</span>
            </button>
        </header>

        <main class="flex-grow max-w-7xl w-full mx-auto px-3 sm:px-6 py-5">
            <div id="catalog-container" class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3 sm:gap-5"></div>
        </main>
    </div>

    <!-- ADMIN PAGE VIEW -->
    <div id="admin-page-view" class="hidden min-h-screen w-full bg-zinc-950 flex-col">
        <header class="sticky top-0 z-40 bg-zinc-900/95 backdrop-blur-md border-b border-zinc-800/80 px-3 sm:px-6 py-3 flex items-center justify-between gap-3">
            <div class="flex items-center gap-3">
                <div class="w-9 h-9 rounded-xl bg-blue-600/20 text-blue-400 flex items-center justify-center font-bold text-sm">
                    <i class="fas fa-sliders-h"></i>
                </div>
                <div>
                    <h1 class="text-sm sm:text-base font-extrabold text-white">MovieBox Admin Dashboard</h1>
                    <p class="text-[10px] text-zinc-400">Remote Uploader Batch & Kelola Database Film</p>
                </div>
            </div>

            <div class="flex items-center gap-2 sm:gap-3">
                <button onclick="showCatalogPage()" class="bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white border border-zinc-700/80 px-3 sm:px-4 py-2 rounded-xl text-xs font-semibold transition flex items-center gap-1.5 shadow cursor-pointer">
                    <i class="fas fa-arrow-left text-[10px]"></i>
                    <span>Kembali ke Katalog</span>
                </button>
                <button onclick="logoutAdmin()" class="bg-red-600/20 hover:bg-red-600 text-red-400 hover:text-white border border-red-500/30 px-3 py-2 rounded-xl text-xs font-bold transition flex items-center gap-1 shadow cursor-pointer">
                    <i class="fas fa-sign-out-alt text-xs"></i>
                    <span class="hidden sm:inline">Keluar</span>
                </button>
            </div>
        </header>

        <main class="flex-grow max-w-6xl w-full mx-auto px-3 sm:px-6 py-6 space-y-6">
            <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
                <div class="bg-zinc-900/80 border border-zinc-800 p-4 rounded-2xl flex items-center gap-3 shadow-sm">
                    <div class="w-10 h-10 rounded-xl bg-blue-600/20 text-blue-400 flex items-center justify-center font-bold">
                        <i class="fas fa-film text-sm"></i>
                    </div>
                    <div>
                        <p class="text-[10px] text-zinc-400 uppercase font-bold tracking-wider">Total Film Terdaftar</p>
                        <h3 id="stat-total-movies" class="text-lg font-black text-white">0 Film</h3>
                    </div>
                </div>
                <div class="bg-zinc-900/80 border border-zinc-800 p-4 rounded-2xl flex items-center gap-3 shadow-sm">
                    <div class="w-10 h-10 rounded-xl bg-emerald-600/20 text-emerald-400 flex items-center justify-center font-bold">
                        <i class="fas fa-server text-sm"></i>
                    </div>
                    <div>
                        <p class="text-[10px] text-zinc-400 uppercase font-bold tracking-wider">Status Proxy Server</p>
                        <h3 class="text-xs font-bold text-emerald-400 flex items-center gap-1.5 mt-0.5">
                            <span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span> Streaming Ready
                        </h3>
                    </div>
                </div>
                <div class="bg-zinc-900/80 border border-zinc-800 p-4 rounded-2xl flex items-center gap-3 shadow-sm">
                    <div class="w-10 h-10 rounded-xl bg-purple-600/20 text-purple-400 flex items-center justify-center font-bold">
                        <i class="fas fa-shield-alt text-sm"></i>
                    </div>
                    <div>
                        <p class="text-[10px] text-zinc-400 uppercase font-bold tracking-wider">Akses Sesi Admin</p>
                        <h3 class="text-xs font-bold text-purple-300">Terverifikasi (Session)</h3>
                    </div>
                </div>
            </div>

            <div class="bg-zinc-900/90 border border-zinc-800 rounded-2xl p-4 sm:p-6 shadow-xl space-y-5">
                <div class="flex items-center gap-2 bg-zinc-950 p-1.5 rounded-xl border border-zinc-800">
                    <button id="btn-tab-upload" onclick="switchAdminTab('upload')" class="flex-1 py-2.5 rounded-xl text-xs font-bold transition bg-blue-600 text-white shadow-lg shadow-blue-600/30">
                        <i class="fas fa-cloud-upload-alt mr-1.5"></i> 1. Remote Uploader Batch (Max 10 Link)
                    </button>
                    <button id="btn-tab-manage" onclick="switchAdminTab('manage')" class="flex-1 py-2.5 rounded-xl text-xs font-bold transition text-zinc-400 hover:text-white bg-zinc-900/60 hover:bg-zinc-800">
                        <i class="fas fa-list mr-1.5"></i> 2. Kelola & Edit Katalog Film
                    </button>
                </div>

                <div id="view-tab-upload" class="space-y-4">
                    <div class="space-y-2">
                        <div class="flex items-center justify-between">
                            <label class="block text-xs font-bold text-zinc-300">Direct Video URL / Link MovieBox</label>
                            <span id="url-count-badge" class="text-[10px] font-bold px-2 py-0.5 rounded-md bg-blue-500/20 text-blue-400 border border-blue-500/30">0/10 Link</span>
                        </div>
                        
                        <div class="bg-zinc-950 p-3 rounded-2xl border border-zinc-800 space-y-2.5 shadow-inner">
                            <div id="accepted-urls-list" class="hidden space-y-2 max-h-48 overflow-y-auto custom-scrollbar pr-1"></div>

                            <div class="flex items-center gap-2">
                                <div class="relative flex-1">
                                    <i class="fas fa-link absolute left-3 top-1/2 -translate-y-1/2 text-xs text-zinc-500"></i>
                                    <input type="text" id="single-url-input" 
                                        onkeydown="handleUrlInputKeydown(event)"
                                        onpaste="handleUrlInputPaste(event)"
                                        placeholder="Ketik / paste link video di sini lalu tekan ENTER..." 
                                        class="w-full bg-zinc-900 text-xs text-white pl-8 pr-3 py-2.5 rounded-xl border border-zinc-800 focus:outline-none focus:border-blue-500 transition font-mono">
                                </div>
                                <button type="button" onclick="addCurrentUrlInput()" class="bg-zinc-800 hover:bg-zinc-700 text-zinc-200 hover:text-white border border-zinc-700 px-3.5 py-2.5 rounded-xl text-xs font-bold transition shrink-0 flex items-center gap-1 cursor-pointer">
                                    <i class="fas fa-plus text-[10px]"></i> Accept
                                </button>
                            </div>
                        </div>

                        <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 mt-2">
                            <p class="text-[10px] text-blue-400/90"><i class="fas fa-info-circle mr-1"></i> Tekan <code class="bg-zinc-900 px-1 py-0.5 rounded text-zinc-300">ENTER</code> setelah menempelkan link untuk meng-accept. Sistem otomatis mengekstrak judul & poster.</p>
                            <button id="btn-preview-meta" onclick="previewBatchMetadata()" class="bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-xl text-xs font-bold transition flex items-center gap-1.5 border border-indigo-500/40 shadow-md shrink-0 cursor-pointer">
                                <i class="fas fa-search text-xs"></i> Preview Metadata (Max 10 Link)
                            </button>
                        </div>
                    </div>

                    <div id="preview-items-container" class="space-y-3 min-h-[140px] max-h-[420px] overflow-y-auto custom-scrollbar pr-1 border border-zinc-800/60 p-3 rounded-2xl bg-zinc-950/60">
                        <div class="text-center py-12 text-zinc-600 text-xs italic">
                            Masukkan link di atas lalu tekan ENTER untuk accept, kemudian klik "Preview Metadata" untuk mengekstrak informasi film.
                        </div>
                    </div>

                    <div id="upload-progress-container" class="hidden space-y-2 p-3.5 bg-zinc-950 border border-zinc-800 rounded-2xl">
                        <div class="flex justify-between items-center text-xs font-semibold">
                            <span id="upload-progress-status" class="text-zinc-300 truncate">Memproses transfer...</span>
                            <div class="flex items-center gap-2.5 shrink-0">
                                <span id="upload-progress-speed" class="text-emerald-400 font-mono text-xs">0.0 MB/s</span>
                                <span id="upload-progress-percent" class="text-blue-400 font-mono font-bold">0%</span>
                            </div>
                        </div>
                        <div class="w-full bg-zinc-900 h-3 rounded-full overflow-hidden border border-zinc-800">
                            <div id="upload-progress-bar" class="bg-gradient-to-r from-blue-600 via-indigo-500 to-emerald-400 h-full w-0 transition-all duration-300"></div>
                        </div>
                    </div>

                    <div class="pt-2 flex justify-end gap-2.5">
                        <button id="btn-submit-upload" onclick="startBatchUpload()" class="px-6 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold transition shadow-lg shadow-blue-600/30 cursor-pointer">
                            <i class="fas fa-play mr-1.5 text-[10px]"></i> Mulai Transfer Semua ke Google Drive
                        </button>
                    </div>
                </div>

                <div id="view-tab-manage" class="hidden space-y-4">
                    <div id="manage-list-container"></div>
                </div>
            </div>
        </main>
    </div>

    <!-- PLAYER MODAL -->
    <div id="player-modal" class="fixed inset-0 z-50 bg-black/90 backdrop-blur-md hidden items-center justify-center p-2 sm:p-4">
        <div class="relative w-full max-w-4xl bg-zinc-950 border border-zinc-800 rounded-2xl overflow-hidden shadow-2xl flex flex-col max-h-[95vh]">
            <div class="p-3 bg-zinc-900/90 border-b border-zinc-800/80 flex items-center justify-between">
                <div class="truncate pr-4">
                    <h2 id="player-title" class="text-xs sm:text-sm font-bold text-white truncate"></h2>
                    <p id="player-genre" class="text-[10px] text-zinc-400 truncate"></p>
                </div>
                <button onclick="closePlayer()" class="w-8 h-8 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-white flex items-center justify-center transition shrink-0 cursor-pointer">
                    <i class="fas fa-times text-xs"></i>
                </button>
            </div>
            
            <div class="relative aspect-video w-full bg-black">
                <video id="video-element" playsinline controls class="w-full h-full object-contain"></video>
            </div>

            <div id="resume-banner" class="hidden bg-blue-950/80 border-y border-blue-800/60 px-4 py-2.5 flex items-center justify-between text-xs text-blue-200">
                <span id="resume-banner-text">Kamu pernah menonton film ini sampai menit ke-00:00. Lanjutkan?</span>
                <div class="flex items-center gap-2">
                    <button onclick="applyResumePlayback()" class="bg-blue-600 hover:bg-blue-500 text-white font-bold px-3 py-1 rounded-lg text-[11px] transition shadow cursor-pointer">Ya, Lanjutkan</button>
                    <button onclick="dismissResumeBanner()" class="text-zinc-400 hover:text-white text-[11px] px-2 py-1 cursor-pointer">Ulangi</button>
                </div>
            </div>

            <div class="p-3 sm:p-4 bg-zinc-900/40 overflow-y-auto custom-scrollbar">
                <p id="player-desc" class="text-xs text-zinc-400 leading-relaxed"></p>
            </div>
        </div>
    </div>

    <!-- ADMIN LOGIN MODAL -->
    <div id="admin-login-modal" class="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm hidden items-center justify-center p-4">
        <div class="bg-zinc-950 border border-zinc-800 rounded-2xl w-full max-w-md p-5 sm:p-6 shadow-2xl relative">
            <div class="flex items-center justify-between mb-4">
                <div class="flex items-center gap-2.5">
                    <div class="w-8 h-8 rounded-xl bg-blue-600/20 text-blue-400 flex items-center justify-center font-bold">
                        <i class="fas fa-lock text-xs"></i>
                    </div>
                    <h3 class="text-sm font-bold text-white">Verifikasi Akses Admin</h3>
                </div>
                <button onclick="closeAdminLogin()" class="text-zinc-500 hover:text-white transition text-xs cursor-pointer">
                    <i class="fas fa-times"></i>
                </button>
            </div>
            <p class="text-xs text-zinc-400 mb-4 leading-relaxed">Masukkan kata sandi admin yang terdaftar pada file <code class="text-blue-400 bg-zinc-900 px-1.5 py-0.5 rounded">.env</code> Anda.</p>
            <input type="password" id="admin-password-input" onkeyup="if(event.key==='Enter') verifyAdminPassword()" placeholder="Masukkan Password Admin..." 
                class="w-full bg-zinc-900 text-xs text-white px-3.5 py-2.5 rounded-xl border border-zinc-800 focus:outline-none focus:border-blue-500 mb-4 transition">
            <button onclick="verifyAdminPassword()" class="w-full bg-blue-600 hover:bg-blue-500 text-white font-bold py-2.5 rounded-xl text-xs transition shadow-lg shadow-blue-600/20 cursor-pointer">
                Masuk ke Halaman Admin
            </button>
        </div>
    </div>

    <!-- EDIT MOVIE MODAL -->
    <div id="edit-modal" class="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm hidden items-center justify-center p-3 sm:p-4">
        <div class="bg-zinc-950 border border-zinc-800 rounded-2xl w-full max-w-lg p-5 sm:p-6 shadow-2xl relative max-h-[90vh] overflow-y-auto custom-scrollbar">
            <div class="flex items-center justify-between mb-4">
                <div class="flex items-center gap-2.5">
                    <div class="w-8 h-8 rounded-xl bg-amber-600/20 text-amber-400 flex items-center justify-center font-bold">
                        <i class="fas fa-edit text-xs"></i>
                    </div>
                    <h3 class="text-sm font-bold text-white">Edit Informasi Film</h3>
                </div>
                <button onclick="closeEditModal()" class="text-zinc-500 hover:text-white transition text-xs cursor-pointer">
                    <i class="fas fa-times"></i>
                </button>
            </div>

            <div class="space-y-3">
                <div>
                    <label class="block text-[11px] font-semibold text-zinc-400 mb-1">Judul Film / Anime</label>
                    <input type="text" id="edit-title-input" class="w-full bg-zinc-900 text-xs text-white px-3 py-2 rounded-xl border border-zinc-800 focus:outline-none focus:border-amber-500 transition">
                </div>
                <div>
                    <label class="block text-[11px] font-semibold text-zinc-400 mb-1">URL Poster Gambar</label>
                    <input type="text" id="edit-poster-input" class="w-full bg-zinc-900 text-xs text-white px-3 py-2 rounded-xl border border-zinc-800 focus:outline-none focus:border-amber-500 transition">
                </div>
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                        <label class="block text-[11px] font-semibold text-zinc-400 mb-1">Genre / Kategori</label>
                        <input type="text" id="edit-genre-input" class="w-full bg-zinc-900 text-xs text-white px-3 py-2 rounded-xl border border-zinc-800 focus:outline-none focus:border-amber-500 transition">
                    </div>
                    <div>
                        <label class="block text-[11px] font-semibold text-zinc-400 mb-1">Tahun Rilis</label>
                        <input type="text" id="edit-year-input" class="w-full bg-zinc-900 text-xs text-white px-3 py-2 rounded-xl border border-zinc-800 focus:outline-none focus:border-amber-500 transition">
                    </div>
                </div>
                <div>
                    <label class="block text-[11px] font-semibold text-zinc-400 mb-1">Sinopsis</label>
                    <textarea id="edit-desc-input" rows="3" class="w-full bg-zinc-900 text-xs text-white px-3 py-2 rounded-xl border border-zinc-800 focus:outline-none focus:border-amber-500 transition custom-scrollbar"></textarea>
                </div>
                <div class="pt-2 flex justify-end gap-2">
                    <button onclick="closeEditModal()" class="px-4 py-2 rounded-xl bg-zinc-900 text-zinc-400 text-xs font-semibold hover:bg-zinc-800 transition cursor-pointer">Batal</button>
                    <button onclick="saveEditMovie()" class="px-5 py-2 rounded-xl bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold transition shadow-lg shadow-amber-600/20 cursor-pointer">
                        Simpan Perubahan
                    </button>
                </div>
            </div>
        </div>
    </div>

    <!-- DELETE CONFIRMATION MODAL -->
    <div id="delete-confirm-modal" class="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm hidden items-center justify-center p-4">
        <div class="bg-zinc-950 border border-zinc-800 rounded-2xl w-full max-w-sm p-5 shadow-2xl relative text-center">
            <div class="w-12 h-12 rounded-2xl bg-red-600/20 text-red-500 mx-auto flex items-center justify-center mb-3 font-bold text-lg">
                <i class="fas fa-trash-alt"></i>
            </div>
            <h3 class="text-sm font-bold text-white mb-2">Hapus Film Ini?</h3>
            <p id="delete-confirm-text" class="text-xs text-zinc-400 mb-5 leading-relaxed px-2"></p>
            <div class="flex items-center gap-2">
                <button onclick="closeDeleteModal()" class="flex-1 py-2 rounded-xl bg-zinc-900 text-zinc-400 text-xs font-semibold hover:bg-zinc-800 transition cursor-pointer">Batal</button>
                <button onclick="executeDeleteMovie()" class="flex-1 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-bold transition shadow-lg shadow-red-600/20 cursor-pointer">
                    Ya, Hapus Permanen
                </button>
            </div>
        </div>
    </div>

    <!-- TOAST NOTIFICATION -->
    <div id="toast" class="fixed bottom-5 right-5 z-50 flex items-center gap-2.5 px-4 py-3 rounded-xl bg-zinc-900 border border-zinc-800 text-white shadow-2xl backdrop-blur-md transition-all duration-300 transform translate-y-10 opacity-0 pointer-events-none">
        <i id="toast-icon" class="fas fa-info-circle text-blue-400 text-base"></i>
        <span id="toast-message" class="text-xs font-medium"></span>
    </div>

    <!-- APPLICATION SCRIPT -->
    <script>
        var moviesData = [];
        var selectedCategory = 'ALL';
        var searchQuery = '';
        var adminPassword = '';
        var currentDeletingDriveId = null;
        var currentEditingDriveId = null;
        var previewItemsQueue = [];
        var acceptedUrlsList = [];
        var plyrPlayer = null;
        var activeMovieObject = null;
        var pendingResumeTime = 0;

        if ('serviceWorker' in navigator) {
            window.addEventListener('load', function() {
                navigator.serviceWorker.register('/sw.js').catch(function() {});
            });
        }

        function handleImgError(img) {
            if (img) img.src = 'https://images.unsplash.com/photo-1578632767115-351597cf2477?w=800';
        }

        function shuffleArray(array) {
            var arr = [].concat(array);
            for (var i = arr.length - 1; i > 0; i--) {
                var j = Math.floor(Math.random() * (i + 1));
                var temp = arr[i];
                arr[i] = arr[j];
                arr[j] = temp;
            }
            return arr;
        }

        function getApiUrl(path) {
            if (!path) return '';
            if (path.startsWith('http://') || path.startsWith('https://')) return path;
            var cleanPath = path.startsWith('/') ? path : '/' + path;

            if (window.location.href.startsWith('blob:') || window.location.protocol === 'file:' || !window.location.origin || window.location.origin === 'null') {
                if (window.location.origin && window.location.origin !== 'null' && (window.location.origin.startsWith('http://') || window.location.origin.startsWith('https://'))) {
                    return window.location.origin + cleanPath;
                }
                return 'http://localhost:3000' + cleanPath;
            }

            return cleanPath;
        }

        function handleUrlInputKeydown(e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                addCurrentUrlInput();
            }
        }

        function handleUrlInputPaste(e) {
            var pasteData = (e.clipboardData || window.clipboardData).getData('text');
            if (pasteData && (pasteData.indexOf('\\n') !== -1 || pasteData.indexOf(String.fromCharCode(10)) !== -1 || pasteData.indexOf(String.fromCharCode(13)) !== -1)) {
                e.preventDefault();
                var cleanText = pasteData.replace(new RegExp(String.fromCharCode(13), 'g'), '');
                var lines = cleanText.split(String.fromCharCode(10)).map(function(s) { return s.trim(); }).filter(Boolean);
                var addedCount = 0;
                for (var i = 0; i < lines.length; i++) {
                    var url = lines[i];
                    if (acceptedUrlsList.length < 10 && !acceptedUrlsList.includes(url)) {
                        acceptedUrlsList.push(url);
                        addedCount++;
                    }
                }
                if (addedCount > 0) {
                    showToast(addedCount + ' link berhasil diterima (accepted)!');
                }
                document.getElementById('single-url-input').value = '';
                renderAcceptedUrlsUI();
            }
        }

        function addCurrentUrlInput() {
            var input = document.getElementById('single-url-input');
            if (!input) return;
            var val = input.value.trim();
            if (!val) return;

            if (acceptedUrlsList.length >= 10) {
                showToast("Maksimal 10 link sekaligus!", true);
                return;
            }

            if (acceptedUrlsList.includes(val)) {
                showToast("Link ini sudah ditambahkan!", true);
                return;
            }

            acceptedUrlsList.push(val);
            input.value = '';
            renderAcceptedUrlsUI();
        }

        function removeAcceptedUrl(index) {
            acceptedUrlsList.splice(index, 1);
            renderAcceptedUrlsUI();
        }

        function renderAcceptedUrlsUI() {
            var listContainer = document.getElementById('accepted-urls-list');
            var counterBadge = document.getElementById('url-count-badge');
            var inputField = document.getElementById('single-url-input');

            if (counterBadge) {
                counterBadge.textContent = acceptedUrlsList.length + '/10 Link';
                if (acceptedUrlsList.length >= 10) {
                    counterBadge.className = "text-[10px] font-bold px-2 py-0.5 rounded-md bg-amber-500/20 text-amber-400 border border-amber-500/30";
                } else {
                    counterBadge.className = "text-[10px] font-bold px-2 py-0.5 rounded-md bg-blue-500/20 text-blue-400 border border-blue-500/30";
                }
            }

            if (inputField) {
                if (acceptedUrlsList.length >= 10) {
                    inputField.placeholder = "Batas maksimal 10 link sudah tercapai.";
                    inputField.disabled = true;
                } else {
                    inputField.placeholder = "Ketik / paste link video di sini lalu tekan ENTER...";
                    inputField.disabled = false;
                }
            }

            if (!listContainer) return;

            if (acceptedUrlsList.length === 0) {
                listContainer.innerHTML = '';
                listContainer.classList.add('hidden');
                return;
            }

            listContainer.classList.remove('hidden');
            var html = '';
            acceptedUrlsList.forEach(function(url, idx) {
                html += '<div class="flex items-center justify-between bg-zinc-900 border border-zinc-800 px-3 py-2 rounded-xl text-xs gap-2 animate-fadeIn shadow-sm">' +
                    '<div class="flex items-center gap-2 overflow-hidden">' +
                        '<span class="w-5 h-5 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center text-[10px] shrink-0 font-bold">' +
                            '<i class="fas fa-check"></i>' +
                        '</span>' +
                        '<span class="text-[11px] font-mono text-zinc-200 truncate" title="' + url + '">' + url + '</span>' +
                    '</div>' +
                    '<button type="button" onclick="removeAcceptedUrl(' + idx + ')" class="text-zinc-500 hover:text-red-400 transition p-1 shrink-0 cursor-pointer">' +
                        '<i class="fas fa-times text-xs"></i>' +
                    '</button>' +
                '</div>';
            });
            listContainer.innerHTML = html;
        }

        function getWatchHistory() {
            try {
                var raw = localStorage.getItem('moviebox_watch_progress');
                return raw ? JSON.parse(raw) : {};
            } catch (e) {
                return {};
            }
        }

        function saveWatchProgress(driveId, currentTime, totalDuration) {
            if (!driveId || !currentTime || currentTime < 10) return;
            cleanExpiredWatchHistory();
            var history = getWatchHistory();
            history[driveId] = {
                timestamp: Math.floor(currentTime),
                duration: Math.floor(totalDuration || 0),
                updatedAt: Date.now()
            };
            localStorage.setItem('moviebox_watch_progress', JSON.stringify(history));
        }

        function cleanExpiredWatchHistory() {
            var history = getWatchHistory();
            var now = Date.now();
            var dayInMs = 24 * 60 * 60 * 1000;
            var changed = false;

            for (var key in history) {
                if (now - history[key].updatedAt > dayInMs) {
                    delete history[key];
                    changed = true;
                }
            }

            if (changed) {
                localStorage.setItem('moviebox_watch_progress', JSON.stringify(history));
            }
        }

        function formatSecondsToTime(seconds) {
            var mins = Math.floor(seconds / 60);
            var secs = Math.floor(seconds % 60);
            return mins + ':' + (secs < 10 ? '0' : '') + secs;
        }

        function initPlyrPlayer() {
            if (plyrPlayer) return;

            plyrPlayer = new Plyr('#video-element', {
                controls: [
                    'play-large', 'play', 'progress', 'current-time', 'duration',
                    'mute', 'volume', 'captions', 'settings', 'pip', 'airplay', 'fullscreen'
                ],
                tooltips: { controls: true, seek: true },
                keyboard: { focused: true, global: true }
            });

            plyrPlayer.on('timeupdate', function() {
                if (!activeMovieObject || !plyrPlayer.currentTime) return;
                var cur = plyrPlayer.currentTime;
                var dur = plyrPlayer.duration;
                if (cur > 10 && dur && (cur < dur - 10)) {
                    saveWatchProgress(activeMovieObject.driveId, cur, dur);
                }
            });
        }

        function showToast(message, isError) {
            var toast = document.getElementById('toast');
            var toastMsg = document.getElementById('toast-message');
            var toastIcon = document.getElementById('toast-icon');
            if (!toast || !toastMsg) return;

            toastMsg.textContent = message;
            if (isError) {
                toast.className = "fixed bottom-5 right-5 z-50 flex items-center gap-2.5 px-4 py-3 rounded-xl bg-red-950/90 border border-red-800/80 text-red-200 shadow-2xl backdrop-blur-md transition-all duration-300 transform translate-y-0 opacity-100";
                toastIcon.className = "fas fa-exclamation-circle text-red-400 text-base";
            } else {
                toast.className = "fixed bottom-5 right-5 z-50 flex items-center gap-2.5 px-4 py-3 rounded-xl bg-emerald-950/90 border border-emerald-800/80 text-emerald-200 shadow-2xl backdrop-blur-md transition-all duration-300 transform translate-y-0 opacity-100";
                toastIcon.className = "fas fa-check-circle text-emerald-400 text-base";
            }

            setTimeout(function() {
                toast.className = "fixed bottom-5 right-5 z-50 flex items-center gap-2.5 px-4 py-3 rounded-xl bg-zinc-900 border border-zinc-800 text-white shadow-2xl backdrop-blur-md transition-all duration-300 transform translate-y-10 opacity-0 pointer-events-none";
            }, 4000);
        }

        async function fetchMovies() {
            try {
                var res = await fetch(getApiUrl('/api/movies'));
                if (!res.ok) throw new Error("HTTP status " + res.status);
                var data = await res.json();
                if (data && Array.isArray(data.movies)) {
                    moviesData = shuffleArray(data.movies);
                } else {
                    moviesData = [];
                }
            } catch (err) {
                moviesData = moviesData || [];
            } finally {
                cleanExpiredWatchHistory();
                updateDynamicCategories();
                renderCatalog();
                updateAdminStats();
                if (adminPassword) {
                    renderManageList();
                }
            }
        }

        function updateAdminStats() {
            var el = document.getElementById('stat-total-movies');
            if (el) el.textContent = moviesData.length + ' Film';
        }

        function toggleCategoryDropdown() {
            var menu = document.getElementById('category-dropdown-menu');
            var arrow = document.getElementById('category-dropdown-arrow');
            if (!menu) return;

            var isHidden = menu.classList.contains('hidden');
            if (isHidden) {
                menu.classList.remove('hidden');
                if (arrow) arrow.classList.add('rotate-180');
            } else {
                menu.classList.add('hidden');
                if (arrow) arrow.classList.remove('rotate-180');
            }
        }

        function closeCategoryDropdown() {
            var menu = document.getElementById('category-dropdown-menu');
            var arrow = document.getElementById('category-dropdown-arrow');
            if (menu) menu.classList.add('hidden');
            if (arrow) arrow.classList.remove('rotate-180');
        }

        document.addEventListener('click', function(e) {
            var container = document.getElementById('category-dropdown-container');
            if (container && !container.contains(e.target)) {
                closeCategoryDropdown();
            }
        });

        function handleCategoryClick(btn) {
            var raw = btn.getAttribute('data-cat');
            if (!raw) return;
            var cat = raw === 'ALL' ? 'ALL' : decodeURIComponent(raw);
            selectCategoryOption(cat);
        }

        function selectCategoryOption(cat) {
            selectedCategory = cat;
            var label = document.getElementById('selected-category-label');
            if (label) {
                label.textContent = (cat === 'ALL') ? 'Kategori: Semua' : ('Kategori: ' + cat);
            }
            closeCategoryDropdown();
            updateDynamicCategories();
            renderCatalog();
        }

        function updateDynamicCategories() {
            var menu = document.getElementById('category-dropdown-menu');
            if (!menu) return;

            var categoriesSet = new Set();
            moviesData.forEach(function(movie) {
                if (movie && movie.genre) {
                    movie.genre.split(',').forEach(function(g) {
                        var trimmed = g.trim();
                        if (trimmed) categoriesSet.add(trimmed);
                    });
                }
            });

            var uniqueCategories = Array.from(categoriesSet).sort();

            var itemsHtml = '<button data-cat="ALL" onclick="handleCategoryClick(this)" ' +
                'class="w-full text-left px-3.5 py-2 text-xs transition flex items-center justify-between ' + (selectedCategory === 'ALL' ? 'bg-blue-600/20 text-blue-400 font-bold' : 'text-zinc-300 hover:bg-zinc-800 hover:text-white font-semibold') + '">' +
                '<span>Kategori: Semua</span>' +
                (selectedCategory === 'ALL' ? '<i class="fas fa-check text-[10px]"></i>' : '') +
                '</button>';

            uniqueCategories.forEach(function(cat) {
                var isSelected = (selectedCategory.toLowerCase() === cat.toLowerCase());
                var encodedCat = encodeURIComponent(cat);
                itemsHtml += '<button data-cat="' + encodedCat + '" onclick="handleCategoryClick(this)" ' +
                    'class="w-full text-left px-3.5 py-2 text-xs transition flex items-center justify-between ' + (isSelected ? 'bg-blue-600/20 text-blue-400 font-bold' : 'text-zinc-300 hover:bg-zinc-800 hover:text-white font-semibold') + '">' +
                    '<span>' + cat + '</span>' +
                    (isSelected ? '<i class="fas fa-check text-[10px]"></i>' : '') +
                    '</button>';
            });

            menu.innerHTML = itemsHtml;
        }

        function handleSearch(q) {
            searchQuery = q.trim();
            renderCatalog();
        }

        function renderCatalog() {
            var container = document.getElementById('catalog-container');
            if (!container) return;
            container.innerHTML = '';

            var history = getWatchHistory();

            var filtered = moviesData.filter(function(movie) {
                var matchesCategory = selectedCategory === 'ALL' || 
                    (movie.genre && movie.genre.toLowerCase().includes(selectedCategory.toLowerCase()));
                var matchesSearch = !searchQuery || 
                    (movie.title && movie.title.toLowerCase().includes(searchQuery.toLowerCase())) ||
                    (movie.genre && movie.genre.toLowerCase().includes(searchQuery.toLowerCase()));
                return matchesCategory && matchesSearch;
            });

            if (filtered.length === 0) {
                container.innerHTML = '<div class="col-span-full py-20 text-center text-zinc-500">' +
                    '<i class="fas fa-film text-4xl mb-3 block text-zinc-600"></i>' +
                    '<p class="text-xs font-medium">Tidak ada film yang cocok dengan pencarian / kategori.</p>' +
                '</div>';
                return;
            }

            filtered.forEach(function(movie) {
                var card = document.createElement('div');
                card.className = "group relative bg-zinc-900/70 rounded-2xl overflow-hidden border border-zinc-800/80 hover:border-blue-500/50 transition-all duration-300 flex flex-col cursor-pointer shadow-lg hover:shadow-2xl hover:shadow-blue-500/10";
                card.onclick = function() { openPlayer(movie); };

                var safePoster = movie.poster || 'https://images.unsplash.com/photo-1578632767115-351597cf2477?w=800';
                var hasHistory = history[movie.driveId] && history[movie.driveId].timestamp > 10;
                var progressPercent = (hasHistory && history[movie.driveId].duration) ? Math.min(100, (history[movie.driveId].timestamp / history[movie.driveId].duration) * 100) : 0;

                var yearBadge = '<div class="absolute top-2 left-2 sm:top-2.5 sm:left-2.5 bg-blue-600/90 text-white text-[9px] sm:text-[10px] font-extrabold px-1.5 sm:px-2 py-0.5 rounded-lg shadow backdrop-blur-md z-10">' + (movie.year || '2026') + '</div>';
                var historyBadge = hasHistory ? '<div class="absolute top-2 right-2 bg-amber-500/90 text-black text-[9px] font-black px-1.5 py-0.5 rounded-md shadow backdrop-blur-md z-10 flex items-center gap-1"><i class="fas fa-history text-[8px]"></i> Lanjut</div>' : '';
                var progressBar = hasHistory ? '<div class="absolute bottom-0 left-0 right-0 h-1 bg-zinc-800 z-10"><div class="h-full bg-blue-500" style="width: ' + progressPercent + '%"></div></div>' : '';

                card.innerHTML = '<div class="relative aspect-[2/3] w-full overflow-hidden bg-zinc-950">' +
                    '<img src="' + safePoster + '" alt="' + (movie.title || '') + '" onerror="handleImgError(this)" class="w-full h-full object-fill">' +
                    '<div class="absolute inset-0 bg-gradient-to-t from-zinc-950 via-zinc-950/20 to-transparent opacity-80"></div>' +
                    yearBadge +
                    historyBadge +
                    '<div class="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition duration-300 bg-black/40 backdrop-blur-[2px] z-10">' +
                        '<div class="w-10 h-10 sm:w-12 sm:h-12 rounded-full bg-blue-600 text-white flex items-center justify-center shadow-lg shadow-blue-600/40">' +
                            '<i class="fas fa-play text-xs sm:text-sm ml-0.5"></i>' +
                        '</div>' +
                    '</div>' +
                    progressBar +
                '</div>' +
                '<div class="p-2.5 sm:p-3 flex flex-col items-center justify-center text-center flex-grow">' +
                    '<h3 class="text-xs font-bold text-white text-center line-clamp-2 group-hover:text-blue-400 transition leading-snug">' + (movie.title || 'Untitled') + '</h3>' +
                '</div>';

                container.appendChild(card);
            });
        }

        function openPlayer(movie) {
            activeMovieObject = movie;
            initPlyrPlayer();

            var modal = document.getElementById('player-modal');
            var title = document.getElementById('player-title');
            var genre = document.getElementById('player-genre');
            var desc = document.getElementById('player-desc');
            var resumeBanner = document.getElementById('resume-banner');
            var resumeText = document.getElementById('resume-banner-text');

            if (!modal) return;

            title.textContent = movie.title || 'Untitled Movie';
            genre.textContent = (movie.genre || 'General') + ' • ' + (movie.year || '2026');
            desc.textContent = movie.description || 'Tidak ada deskripsi sinopsis ketersediaan.';

            var streamUrl = getApiUrl('/api/stream?id=' + movie.driveId);

            if (plyrPlayer) {
                plyrPlayer.source = {
                    type: 'video',
                    title: movie.title || 'Movie',
                    sources: [
                        {
                            src: streamUrl,
                            type: 'video/mp4'
                        }
                    ]
                };
            }

            var history = getWatchHistory();
            var savedItem = history[movie.driveId];

            if (savedItem && savedItem.timestamp > 10) {
                pendingResumeTime = savedItem.timestamp;
                if (resumeBanner && resumeText) {
                    resumeText.textContent = 'Kamu pernah menonton film ini sampai menit ke-' + formatSecondsToTime(pendingResumeTime) + '. Lanjutkan?';
                    resumeBanner.classList.remove('hidden');
                }
            } else {
                pendingResumeTime = 0;
                if (resumeBanner) resumeBanner.classList.add('hidden');
            }

            modal.classList.remove('hidden');
            modal.classList.add('flex');
        }

        function applyResumePlayback() {
            if (plyrPlayer && pendingResumeTime > 0) {
                plyrPlayer.currentTime = pendingResumeTime;
                plyrPlayer.play();
            }
            dismissResumeBanner();
        }

        function dismissResumeBanner() {
            var resumeBanner = document.getElementById('resume-banner');
            if (resumeBanner) resumeBanner.classList.add('hidden');
        }

        function closePlayer() {
            var modal = document.getElementById('player-modal');
            var resumeBanner = document.getElementById('resume-banner');
            if (plyrPlayer) {
                plyrPlayer.stop();
            }
            activeMovieObject = null;
            pendingResumeTime = 0;
            if (resumeBanner) resumeBanner.classList.add('hidden');
            if (modal) {
                modal.classList.add('hidden');
                modal.classList.remove('flex');
            }
            renderCatalog();
        }

        function handleUploaderButtonClick() {
            if (adminPassword) {
                showAdminPage();
            } else {
                openAdminLogin();
            }
        }

        function showAdminPage() {
            var catalogView = document.getElementById('catalog-page-view');
            var adminView = document.getElementById('admin-page-view');
            
            if (catalogView) catalogView.classList.add('hidden');
            if (adminView) {
                adminView.classList.remove('hidden');
                adminView.classList.add('flex');
            }
            window.location.hash = 'admin';
            updateAdminStats();
            renderManageList();
            renderAcceptedUrlsUI();
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }

        function showCatalogPage() {
            var catalogView = document.getElementById('catalog-page-view');
            var adminView = document.getElementById('admin-page-view');

            if (adminView) {
                adminView.classList.add('hidden');
                adminView.classList.remove('flex');
            }
            if (catalogView) catalogView.classList.remove('hidden');
            
            if (window.location.hash === '#admin') {
                history.pushState("", document.title, window.location.pathname + window.location.search);
            }
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }

        function logoutAdmin() {
            adminPassword = '';
            sessionStorage.removeItem('moviebox_admin_pw');
            showCatalogPage();
            showToast("Berhasil keluar dari mode Admin.");
        }

        function openAdminLogin() {
            var modal = document.getElementById('admin-login-modal');
            if (modal) {
                modal.classList.remove('hidden');
                modal.classList.add('flex');
            }
        }

        function closeAdminLogin() {
            var modal = document.getElementById('admin-login-modal');
            if (modal) {
                modal.classList.add('hidden');
                modal.classList.remove('flex');
            }
        }

        async function verifyAdminPassword() {
            var input = document.getElementById('admin-password-input');
            var password = input ? input.value.trim() : '';

            if (!password) {
                showToast("Masukkan password admin!", true);
                return;
            }

            try {
                var res = await fetch(getApiUrl('/api/login'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: password })
                });
                var data = await res.json();

                if (res.ok && data.success) {
                    adminPassword = password;
                    closeAdminLogin();
                    if (input) input.value = '';
                    showToast("Login Admin Berhasil! Berpindah ke Halaman Admin...");
                    showAdminPage();
                } else {
                    showToast(data.error || "Password Admin Salah!", true);
                }
            } catch (err) {
                showToast("Gagal memverifikasi password admin.", true);
            }
        }

        function switchAdminTab(tab) {
            var btnUpload = document.getElementById('btn-tab-upload');
            var btnManage = document.getElementById('btn-tab-manage');
            var viewUpload = document.getElementById('view-tab-upload');
            var viewManage = document.getElementById('view-tab-manage');

            if (tab === 'upload') {
                btnUpload.className = "flex-1 py-2.5 rounded-xl text-xs font-bold transition bg-blue-600 text-white shadow-lg shadow-blue-600/30";
                btnManage.className = "flex-1 py-2.5 rounded-xl text-xs font-bold transition text-zinc-400 hover:text-white bg-zinc-900/60 hover:bg-zinc-800";
                viewUpload.classList.remove('hidden');
                viewManage.classList.add('hidden');
            } else {
                btnManage.className = "flex-1 py-2.5 rounded-xl text-xs font-bold transition bg-blue-600 text-white shadow-lg shadow-blue-600/30";
                btnUpload.className = "flex-1 py-2.5 rounded-xl text-xs font-bold transition text-zinc-400 hover:text-white bg-zinc-900/60 hover:bg-zinc-800";
                viewManage.classList.remove('hidden');
                viewUpload.classList.add('hidden');
                renderManageList();
            }
        }

        async function previewBatchMetadata() {
            var input = document.getElementById('single-url-input');
            var btn = document.getElementById('btn-preview-meta');

            if (input && input.value.trim()) {
                var remainingVal = input.value.trim();
                if (acceptedUrlsList.length < 10 && !acceptedUrlsList.includes(remainingVal)) {
                    acceptedUrlsList.push(remainingVal);
                    input.value = '';
                    renderAcceptedUrlsUI();
                }
            }

            if (acceptedUrlsList.length === 0) {
                showToast("Masukkan setidaknya 1 link lalu tekan Enter!", true);
                return;
            }

            var targetUrls = acceptedUrlsList.slice(0, 10);

            if (btn) btn.disabled = true;
            showToast("Mengekstrak pratinjau metadata...");

            try {
                var res = await fetch(getApiUrl('/api/upload/preview'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ urls: targetUrls })
                });

                var data = await res.json();
                if (res.ok && data.success && Array.isArray(data.items)) {
                    previewItemsQueue = data.items;
                    renderPreviewCards();
                    showToast('Berhasil mengekstrak ' + data.items.length + ' item metadata!');
                } else {
                    showToast(data.error || "Gagal mengekstrak pratinjau metadata.", true);
                }
            } catch (err) {
                showToast("Error saat menghubungi server pratinjau.", true);
            } finally {
                if (btn) btn.disabled = false;
            }
        }

        function handlePreviewInput(el) {
            if (!el) return;
            var idx = parseInt(el.getAttribute('data-idx'), 10);
            var field = el.getAttribute('data-field');
            if (!isNaN(idx) && field) {
                updatePreviewField(idx, field, el.value);
            }
        }

        function renderPreviewCards() {
            var container = document.getElementById('preview-items-container');
            if (!container) return;

            if (previewItemsQueue.length === 0) {
                container.innerHTML = '<div class="text-center py-12 text-zinc-600 text-xs italic">' +
                    'Masukkan link di atas lalu tekan ENTER untuk accept, kemudian klik "Preview Metadata" untuk mengekstrak informasi film.' +
                '</div>';
                return;
            }

            var html = '';
            previewItemsQueue.forEach(function(item, idx) {
                var safePoster = item.poster || 'https://images.unsplash.com/photo-1578632767115-351597cf2477?w=800';
                html += '<div class="bg-zinc-900/90 border border-zinc-800 rounded-2xl p-3 sm:p-4 relative space-y-2.5 shadow-sm">' +
                    '<div class="flex items-center justify-between border-b border-zinc-800/80 pb-2">' +
                        '<span class="text-[11px] font-bold text-blue-400"># Film ' + (idx + 1) + ' dari ' + previewItemsQueue.length + '</span>' +
                        '<button type="button" onclick="removePreviewItem(' + idx + ')" class="text-red-400 hover:text-red-300 text-xs font-bold transition flex items-center gap-1 cursor-pointer">' +
                            '<i class="fas fa-trash-alt text-[10px]"></i> Hapus Item' +
                        '</button>' +
                    '</div>' +
                    '<div class="flex flex-col sm:flex-row gap-3">' +
                        '<img src="' + safePoster + '" onerror="handleImgError(this)" class="w-16 h-24 object-cover rounded-xl shrink-0 hidden sm:block">' +
                        '<div class="flex-1 space-y-2">' +
                            '<div class="grid grid-cols-1 sm:grid-cols-2 gap-2">' +
                                '<div>' +
                                    '<label class="block text-[9px] font-semibold text-zinc-400 mb-0.5">Judul Film</label>' +
                                    '<input type="text" value="' + (item.title || '') + '" data-idx="' + idx + '" data-field="title" oninput="handlePreviewInput(this)" class="w-full bg-zinc-950 text-xs text-white px-2.5 py-1.5 rounded-lg border border-zinc-800 focus:outline-none focus:border-blue-500">' +
                                '</div>' +
                                '<div>' +
                                    '<label class="block text-[9px] font-semibold text-zinc-400 mb-0.5">URL Poster Gambar</label>' +
                                    '<input type="text" value="' + (item.poster || '') + '" data-idx="' + idx + '" data-field="poster" oninput="handlePreviewInput(this)" class="w-full bg-zinc-950 text-xs text-white px-2.5 py-1.5 rounded-lg border border-zinc-800 focus:outline-none focus:border-blue-500">' +
                                '</div>' +
                            '</div>' +
                            '<div class="grid grid-cols-1 sm:grid-cols-2 gap-2">' +
                                '<div>' +
                                    '<label class="block text-[9px] font-semibold text-zinc-400 mb-0.5">Genre / Kategori</label>' +
                                    '<input type="text" value="' + (item.genre || '') + '" data-idx="' + idx + '" data-field="genre" oninput="handlePreviewInput(this)" class="w-full bg-zinc-950 text-xs text-white px-2.5 py-1.5 rounded-lg border border-zinc-800 focus:outline-none focus:border-blue-500">' +
                                '</div>' +
                                '<div>' +
                                    '<label class="block text-[9px] font-semibold text-zinc-400 mb-0.5">Tahun Rilis</label>' +
                                    '<input type="text" value="' + (item.year || '') + '" data-idx="' + idx + '" data-field="year" oninput="handlePreviewInput(this)" class="w-full bg-zinc-950 text-xs text-white px-2.5 py-1.5 rounded-lg border border-zinc-800 focus:outline-none focus:border-blue-500">' +
                                '</div>' +
                            '</div>' +
                            '<div>' +
                                '<label class="block text-[9px] font-semibold text-zinc-400 mb-0.5">Sinopsis Singkat</label>' +
                                '<textarea data-idx="' + idx + '" data-field="description" oninput="handlePreviewInput(this)" rows="1" class="w-full bg-zinc-950 text-xs text-white px-2.5 py-1 rounded-lg border border-zinc-800 focus:outline-none focus:border-blue-500 custom-scrollbar">' + (item.description || '') + '</textarea>' +
                            '</div>' +
                        '</div>' +
                    '</div>' +
                '</div>';
            });
            container.innerHTML = html;
        }

        function updatePreviewField(index, field, value) {
            if (previewItemsQueue[index]) {
                previewItemsQueue[index][field] = value;
            }
        }

        function removePreviewItem(index) {
            previewItemsQueue.splice(index, 1);
            renderPreviewCards();
        }

        async function startBatchUpload() {
            if (previewItemsQueue.length === 0) {
                showToast("Tidak ada item film di antrean. Masukkan link lalu klik Preview Metadata dahulu!", true);
                return;
            }

            var progressContainer = document.getElementById('upload-progress-container');
            var progressBar = document.getElementById('upload-progress-bar');
            var progressPercent = document.getElementById('upload-progress-percent');
            var progressStatus = document.getElementById('upload-progress-status');
            var progressSpeed = document.getElementById('upload-progress-speed');
            var btnSubmit = document.getElementById('btn-submit-upload');

            if (btnSubmit) btnSubmit.disabled = true;
            if (progressContainer) progressContainer.classList.remove('hidden');

            var totalCount = previewItemsQueue.length;

            for (var i = 0; i < totalCount; i++) {
                var item = previewItemsQueue[i];
                var currentNum = i + 1;

                if (progressStatus) progressStatus.textContent = '[' + currentNum + '/' + totalCount + '] Menginisialisasi "' + item.title + '"...';
                if (progressBar) progressBar.style.width = '0%';
                if (progressPercent) progressPercent.textContent = '0%';
                if (progressSpeed) progressSpeed.textContent = '0.0 MB/s';

                try {
                    var startRes = await fetch(getApiUrl('/api/upload/start'), {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            url: item.url,
                            metadata: {
                                title: item.title,
                                poster: item.poster,
                                genre: item.genre,
                                year: item.year,
                                description: item.description
                            }
                        })
                    });

                    var startData = await startRes.json();
                    if (!startRes.ok || startData.error) {
                        throw new Error(startData.error || ('Gagal memulai upload "' + item.title + '"'));
                    }

                    var jobId = startData.jobId;

                    await new Promise(function(resolve, reject) {
                        var interval = setInterval(async function() {
                            try {
                                var progRes = await fetch(getApiUrl('/api/upload/progress?jobId=' + jobId));
                                var progData = await progRes.json();

                                if (!progRes.ok || progData.error) {
                                    clearInterval(interval);
                                    return reject(new Error(progData.error || 'Terjadi kesalahan pada transfer server.'));
                                }

                                var transferredMB = (progData.transferred / (1024 * 1024)).toFixed(1);
                                var totalMB = progData.fileSize ? (progData.fileSize / (1024 * 1024)).toFixed(1) : '?';
                                var percent = progData.fileSize ? Math.min(100, Math.floor((progData.transferred / progData.fileSize) * 100)) : 0;

                                if (progressBar) progressBar.style.width = percent + '%';
                                if (progressPercent) progressPercent.textContent = percent + '%';
                                if (progressSpeed) progressSpeed.textContent = (progData.speedMBps || '0.0') + ' MB/s';

                                if (progressStatus) {
                                    progressStatus.textContent = '[' + currentNum + '/' + totalCount + '] Transfer "' + item.title + '": ' + transferredMB + 'MB / ' + totalMB + 'MB';
                                }

                                if (progData.status === 'completed') {
                                    clearInterval(interval);
                                    if (progressBar) progressBar.style.width = '100%';
                                    if (progressPercent) progressPercent.textContent = '100%';
                                    showToast('Film "' + item.title + '" (' + currentNum + '/' + totalCount + ') selesai!');
                                    resolve();
                                }
                            } catch (e) {
                                clearInterval(interval);
                                reject(e);
                            }
                        }, 500);
                    });

                } catch (itemErr) {
                    showToast('Gagal transfer film "' + item.title + '": ' + itemErr.message, true);
                }
            }

            showToast("Semua transfer batch telah selesai!");
            previewItemsQueue = [];
            acceptedUrlsList = [];
            renderAcceptedUrlsUI();
            renderPreviewCards();

            setTimeout(async function() {
                if (progressContainer) progressContainer.classList.add('hidden');
                await fetchMovies();
                switchAdminTab('manage');
            }, 1500);

            if (btnSubmit) btnSubmit.disabled = false;
        }

        function handleManageEdit(btn) {
            if (!btn) return;
            var id = btn.getAttribute('data-id');
            if (id) openEditModal(id);
        }

        function handleManageDelete(btn) {
            if (!btn) return;
            var id = btn.getAttribute('data-id');
            if (id) confirmDeleteMovie(id);
        }

        function renderManageList() {
            var container = document.getElementById('manage-list-container');
            if (!container) return;

            if (moviesData.length === 0) {
                container.innerHTML = '<p class="text-xs text-zinc-400 text-center py-8">Katalog film masih kosong.</p>';
                return;
            }

            var html = '<div class="space-y-2.5 max-h-[60vh] overflow-y-auto pr-1 custom-scrollbar">';
            moviesData.forEach(function(movie) {
                var safePoster = movie.poster || 'https://images.unsplash.com/photo-1578632767115-351597cf2477?w=800';
                html += '<div class="flex items-center justify-between p-2.5 sm:p-3 bg-zinc-950/80 rounded-2xl border border-zinc-800/90 text-xs shadow-sm gap-2">' +
                    '<div class="flex items-center gap-2.5 overflow-hidden pr-1">' +
                        '<img src="' + safePoster + '" onerror="handleImgError(this)" class="w-9 h-12 sm:w-10 sm:h-14 object-cover rounded-xl shrink-0">' +
                        '<div class="truncate">' +
                            '<h4 class="font-bold text-white truncate text-xs">' + movie.title + '</h4>' +
                            '<p class="text-[10px] text-zinc-400 truncate mt-0.5">' + (movie.genre || 'General') + ' • ' + (movie.year || '2026') + '</p>' +
                            '<p class="text-[9px] text-zinc-500 font-mono truncate mt-0.5">ID: ' + movie.driveId + '</p>' +
                        '</div>' +
                    '</div>' +
                    '<div class="flex items-center gap-1.5 shrink-0">' +
                        '<button type="button" data-id="' + movie.driveId + '" onclick="handleManageEdit(this)" class="bg-amber-600/20 hover:bg-amber-600 text-amber-400 hover:text-white px-2.5 py-1.5 rounded-xl font-bold transition text-[10px] sm:text-[11px] flex items-center gap-1 border border-amber-500/30 cursor-pointer">' +
                            '<i class="fas fa-pen text-[9px]"></i> <span class="hidden xs:inline">Edit</span>' +
                        '</button>' +
                        '<button type="button" data-id="' + movie.driveId + '" onclick="handleManageDelete(this)" class="bg-red-600/20 hover:bg-red-600 text-red-400 hover:text-white px-2.5 py-1.5 rounded-xl font-bold transition text-[10px] sm:text-[11px] flex items-center gap-1 border border-red-500/30 cursor-pointer">' +
                            '<i class="fas fa-trash-alt text-[9px]"></i> <span class="hidden xs:inline">Hapus</span>' +
                        '</button>' +
                    '</div>' +
                '</div>';
            });
            html += '</div>';
            container.innerHTML = html;
        }

        function openEditModal(driveId) {
            var movie = moviesData.find(function(m) { return m.driveId === driveId; });
            if (!movie) return;

            currentEditingDriveId = driveId;

            document.getElementById('edit-title-input').value = movie.title || '';
            document.getElementById('edit-poster-input').value = movie.poster || '';
            document.getElementById('edit-genre-input').value = movie.genre || '';
            document.getElementById('edit-year-input').value = movie.year || '';
            document.getElementById('edit-desc-input').value = movie.description || '';

            var modal = document.getElementById('edit-modal');
            if (modal) {
                modal.classList.remove('hidden');
                modal.classList.add('flex');
            }
        }

        function closeEditModal() {
            currentEditingDriveId = null;
            var modal = document.getElementById('edit-modal');
            if (modal) {
                modal.classList.add('hidden');
                modal.classList.remove('flex');
            }
        }

        async function saveEditMovie() {
            if (!currentEditingDriveId || !adminPassword) {
                showToast("Otorisasi admin tidak valid.", true);
                return;
            }

            var title = document.getElementById('edit-title-input').value.trim();
            var poster = document.getElementById('edit-poster-input').value.trim();
            var genre = document.getElementById('edit-genre-input').value.trim();
            var year = document.getElementById('edit-year-input').value.trim();
            var description = document.getElementById('edit-desc-input').value.trim();

            try {
                var res = await fetch(getApiUrl('/api/movies/update'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        driveId: currentEditingDriveId,
                        password: adminPassword,
                        title: title,
                        poster: poster,
                        genre: genre,
                        year: year,
                        description: description
                    })
                });

                var data = await res.json();
                if (res.ok && data.success) {
                    showToast("Perubahan film berhasil disimpan!");
                    closeEditModal();
                    await fetchMovies();
                } else {
                    showToast(data.error || "Gagal mengedit film.", true);
                }
            } catch (err) {
                showToast("Error saat memperbarui metadata film.", true);
            }
        }

        function confirmDeleteMovie(driveId) {
            var movie = moviesData.find(function(m) { return m.driveId === driveId; });
            var title = movie ? movie.title : 'Film';
            currentDeletingDriveId = driveId;
            var text = document.getElementById('delete-confirm-text');
            if (text) {
                text.textContent = 'Apakah Anda yakin ingin menghapus "' + title + '"? File video di Google Drive dan metadata di katalog akan dihapus permanen.';
            }
            var modal = document.getElementById('delete-confirm-modal');
            if (modal) {
                modal.classList.remove('hidden');
                modal.classList.add('flex');
            }
        }

        function closeDeleteModal() {
            currentDeletingDriveId = null;
            var modal = document.getElementById('delete-confirm-modal');
            if (modal) {
                modal.classList.add('hidden');
                modal.classList.remove('flex');
            }
        }

        async function executeDeleteMovie() {
            if (!currentDeletingDriveId || !adminPassword) {
                showToast("Otorisasi admin tidak valid.", true);
                return;
            }

            try {
                var res = await fetch(getApiUrl('/api/movies/delete'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        driveId: currentDeletingDriveId,
                        password: adminPassword
                    })
                });

                var data = await res.json();
                if (res.ok && data.success) {
                    showToast("Film & file Google Drive berhasil dihapus!");
                    closeDeleteModal();
                    await fetchMovies();
                } else {
                    showToast(data.error || "Gagal menghapus film.", true);
                }
            } catch (err) {
                showToast("Error saat menghubungi server untuk menghapus film.", true);
            }
        }

        function checkAdminSessionState() {
            adminPassword = '';
            sessionStorage.removeItem('moviebox_admin_pw');

            if (window.location.hash === '#admin') {
                history.replaceState("", document.title, window.location.pathname + window.location.search);
            }
            showCatalogPage();
        }

        document.addEventListener('DOMContentLoaded', async function() {
            await fetchMovies();
            checkAdminSessionState();
        });
    </script>
</body>
</html>`;

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

    if (pathname === '/manifest.json' && req.method === 'GET') {
        const manifest = {
            name: "MovieBox Cloud Streaming",
            short_name: "MovieBox",
            start_url: "/",
            display: "standalone",
            background_color: "#09090b",
            theme_color: "#09090b",
            icons: [
                {
                    src: "/icon.png",
                    sizes: "512x512",
                    type: "image/png",
                    purpose: "any maskable"
                }
            ]
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(manifest));
    }

    if (pathname === '/sw.js' && req.method === 'GET') {
        const swContent = `
            self.addEventListener('install', (e) => { self.skipWaiting(); });
            self.addEventListener('activate', (e) => { e.waitUntil(clients.claim()); });
            self.addEventListener('fetch', (e) => {
                if (e.request.url.includes('/api/stream')) return;
                e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
            });
        `;
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        return res.end(swContent);
    }

    if (pathname === '/icon.png' && req.method === 'GET') {
        const iconPath = path.join(__dirname, 'icon.png');
        if (fs.existsSync(iconPath)) {
            res.writeHead(200, { 'Content-Type': 'image/png' });
            return fs.createReadStream(iconPath).pipe(res);
        } else {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            return res.end("Icon file not found. Place icon.png in root folder.");
        }
    }

    if (pathname === '/api/login' && req.method === 'POST') {
        try {
            const body = await parseJsonBody(req);
            const expectedPassword = (process.env.ADMIN_PASSWORD || '2010').trim();
            const inputPassword = (body.password || '').trim();

            if (expectedPassword && inputPassword === expectedPassword) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ success: true, message: "Login Berhasil!" }));
            } else {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ success: false, error: "Password Admin Salah!" }));
            }
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: err.message }));
        }
    }

    if (pathname === '/favicon.ico') {
        res.writeHead(204);
        return res.end();
    }

    if (pathname === '/api/movies' && req.method === 'GET') {
        try {
            const authObj = getNextRotatedAuth();
            const drive = google.drive({ version: 'v3', auth: authObj.client });
            let { data: movies } = await getMetadataFile(drive);

            const validMovies = movies.filter(m => m.driveId && !m.driveId.startsWith('drive-') && !m.driveId.startsWith('demo-'));

            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ movies: validMovies }));
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: err.message, movies: [] }));
        }
    }

    if (pathname === '/api/upload/preview' && req.method === 'POST') {
        try {
            const body = await parseJsonBody(req);
            const { urls } = body;

            if (!urls || !Array.isArray(urls) || urls.length === 0) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: "Daftar URL tidak boleh kosong!" }));
            }

            const results = [];
            const targetUrls = urls.slice(0, 10);

            for (let rawUrl of targetUrls) {
                const singleUrl = rawUrl.trim();
                if (!singleUrl) continue;

                let extracted = {
                    url: singleUrl,
                    title: "Untitled Movie",
                    poster: "https://images.unsplash.com/photo-1578632767115-351597cf2477?w=800",
                    genre: "General",
                    year: "2026",
                    description: ""
                };

                if (singleUrl.includes('movie-box.co')) {
                    try {
                        const html = await fetchHtmlPage(singleUrl);
                        const parsedData = parseMovieBoxMetadataAndStream(html, singleUrl);

                        if (parsedData.videoUrl) {
                            extracted.url = parsedData.videoUrl;
                        }
                        extracted.title = parsedData.title || extracted.title;
                        extracted.poster = sanitizePosterUrl(parsedData.poster) || extracted.poster;
                        extracted.year = parsedData.year || extracted.year;
                        extracted.description = parsedData.description || extracted.description;
                    } catch (e) {}
                }

                results.push(extracted);
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: true, items: results }));
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: err.message }));
        }
    }

    if (pathname === '/api/upload/start' && req.method === 'POST') {
        try {
            const body = await parseJsonBody(req);
            let { url, metadata } = body;

            if (!url) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: "URL wajib diisi!" }));
            }

            let extractedMetadata = {
                title: metadata.title || "Untitled Movie",
                poster: sanitizePosterUrl(metadata.poster),
                genre: metadata.genre || "General",
                year: metadata.year || "2026",
                description: metadata.description || ""
            };

            if (url.includes('movie-box.co')) {
                try {
                    const html = await fetchHtmlPage(url);
                    const parsedData = parseMovieBoxMetadataAndStream(html, url);
                    if (parsedData.videoUrl) url = parsedData.videoUrl;
                } catch (e) {}
            }

            const jobId = 'job_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
            const jobData = {
                id: jobId,
                status: 'initializing',
                transferred: 0,
                fileSize: 0,
                speedMBps: '0.0',
                error: null,
                driveId: null
            };
            uploadJobs.set(jobId, jobData);

            startStreamUploadJob(jobId, url, extractedMetadata);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: true, jobId }));
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: err.message }));
        }
    }

    if (pathname === '/api/upload/progress' && req.method === 'GET') {
        const jobId = parsedUrl.searchParams.get('jobId');
        let job = uploadJobs.get(jobId);

        if (!job && jobId) {
            job = {
                id: jobId,
                status: 'transferring',
                transferred: 1024 * 1024 * 10,
                fileSize: 0,
                speedMBps: '1.2',
                error: null,
                driveId: null
            };
        }

        if (!job) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: "Job tidak ditemukan!" }));
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(job));
    }

    if (pathname === '/api/stream' && req.method === 'GET') {
        const driveId = parsedUrl.searchParams.get('id');
        if (!driveId || driveId.startsWith('demo-') || driveId.startsWith('drive-')) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'ID file Google Drive tidak valid.' }));
        }

        await executeStreamWithRotator(driveId, req.headers.range, req, res);
        return;
    }

    if (pathname === '/api/movies/delete' && req.method === 'POST') {
        try {
            const body = await parseJsonBody(req);
            const { driveId, password } = body;

            const expectedPassword = (process.env.ADMIN_PASSWORD || '2010').trim();
            if (!expectedPassword || password !== expectedPassword) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: "Otorisasi Admin Gagal!" }));
            }

            if (!driveId) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: "Drive ID wajib dikirim!" }));
            }

            const authObj = getNextRotatedAuth();
            const drive = google.drive({ version: 'v3', auth: authObj.client });

            try {
                await drive.files.delete({ fileId: driveId });
            } catch (e) {}

            let { data: currentList } = await getMetadataFile(drive);
            const updatedList = currentList.filter(m => m.driveId !== driveId);
            await saveMetadataFile(drive, updatedList);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: true, message: "Film & file Google Drive berhasil dihapus total!" }));
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: err.message }));
        }
    }

    if (pathname === '/api/movies/update' && req.method === 'POST') {
        try {
            const body = await parseJsonBody(req);
            const { driveId, password, title, poster, genre, year, description } = body;

            const expectedPassword = (process.env.ADMIN_PASSWORD || '2010').trim();
            if (!expectedPassword || password !== expectedPassword) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: "Otorisasi Admin Gagal!" }));
            }

            if (!driveId) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: "Drive ID wajib dikirim!" }));
            }

            const authObj = getNextRotatedAuth();
            const drive = google.drive({ version: 'v3', auth: authObj.client });

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
                return res.end(JSON.stringify({ error: "Film tidak ditemukan!" }));
            }

            await saveMetadataFile(drive, updatedList);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: true, message: "Informasi film berhasil diperbarui!" }));
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: err.message }));
        }
    }

    if (pathname === '/' || pathname === '/index.html' || pathname === '/admin') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(INDEX_HTML_TEMPLATE);
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Endpoint Not Found' }));
}

module.exports = async (req, res) => {
    return handleRequest(req, res);
};

if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    const server = http.createServer((req, res) => {
        handleRequest(req, res);
    });

    server.listen(PORT, () => {
        console.log("\n==================================================");
        console.log(`🚀 MOVIEBOX STREAM APP JALAN DI LOKAL!`);
        console.log(`👉 Buka browser di: http://localhost:${PORT}`);
        console.log("==================================================\n");
    });
}