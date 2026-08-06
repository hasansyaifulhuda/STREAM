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
            console.log("✅ File .env berhasil dimuat.");
        } catch (e) {}
    }
}
loadEnvFile();

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
        const result = { fileId: null, data: [] };
        setCache(cacheKey, result, 10 * 60 * 1000);
        return result;
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
                    headers: { 'Authorization': `Bearer ${accessToken}` }
                };
                const req = https.request(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=size`, reqOpts, (res) => {
                    let body = '';
                    res.on('data', chunk => { body += chunk; });
                    res.on('end', () => {
                        if (res.statusCode === 200) {
                            try {
                                const parsed = JSON.parse(body);
                                resolve(parseInt(parsed.size || '0', 10));
                            } catch (e) { reject(e); }
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

                driveReq.on('error', (err) => { reject(err); });
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
    <title>Shanz Stream - Portal</title>
    
    <link rel="manifest" href="/manifest.json">
    <link rel="icon" type="image/png" href="/icon.png">
    <meta name="theme-color" content="#09090b">

    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="https://cdn.plyr.io/3.7.8/plyr.css" />
    <script src="https://cdn.plyr.io/3.7.8/plyr.polyfilled.js"></script>

    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: 'Inter', sans-serif;
            background-color: #09090b;
            color: #f4f4f5;
            min-height: 100vh;
            display: flex;
            flex-direction: column;
        }

        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-track { background: #18181b; }
        ::-webkit-scrollbar-thumb { background: #27272a; border-radius: 8px; }
        ::-webkit-scrollbar-thumb:hover { background: #3f3f46; }

        header {
            position: sticky;
            top: 0;
            z-index: 40;
            background-color: rgba(9, 9, 11, 0.92);
            border-bottom: 1px solid #27272a;
            padding: 10px 16px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            backdrop-filter: blur(10px);
        }

        .dropdown-container { position: relative; flex-shrink: 0; }
        .btn-dropdown {
            background-color: #18181b;
            color: #ffffff;
            font-size: 12px;
            font-weight: 700;
            padding: 8px 14px;
            border-radius: 10px;
            border: 1px solid #27272a;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 8px;
            transition: all 0.2s;
        }
        .btn-dropdown:hover { background-color: #27272a; }

        .dropdown-menu {
            position: absolute;
            left: 0;
            top: 100%;
            margin-top: 6px;
            width: 200px;
            background-color: #18181b;
            border: 1px solid #27272a;
            border-radius: 12px;
            box-shadow: 0 20px 25px -5px rgba(0,0,0,0.5);
            z-index: 50;
            padding: 6px 0;
            max-height: 240px;
            overflow-y: auto;
        }
        .dropdown-item {
            width: 100%;
            text-align: left;
            padding: 8px 14px;
            font-size: 12px;
            color: #d4d4d8;
            background: none;
            border: none;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: space-between;
        }
        .dropdown-item:hover { background-color: #27272a; color: #ffffff; }
        .dropdown-item.active { background-color: rgba(37, 99, 235, 0.2); color: #60a5fa; font-weight: 700; }

        .search-box { position: relative; flex: 1; max-width: 400px; }
        .search-input {
            width: 100%;
            background-color: #18181b;
            color: #ffffff;
            border: 1px solid #27272a;
            border-radius: 10px;
            padding: 8px 12px 8px 32px;
            font-size: 12px;
            outline: none;
            transition: border-color 0.2s;
        }
        .search-input:focus { border-color: #2563eb; }
        .search-icon { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); font-size: 12px; color: #71717a; }

        .count-badge {
            font-size: 12px;
            font-weight: 700;
            color: #a1a1aa;
            background-color: #18181b;
            border: 1px solid #27272a;
            padding: 8px 12px;
            border-radius: 10px;
            display: flex;
            align-items: center;
            gap: 6px;
            flex-shrink: 0;
        }

        main { flex-grow: 1; padding: 24px 16px; max-width: 1280px; width: 100%; margin: 0 auto; }
        .catalog-grid {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 16px;
        }
        @media (min-width: 640px) { .catalog-grid { grid-template-columns: repeat(3, 1fr); gap: 18px; } }
        @media (min-width: 768px) { .catalog-grid { grid-template-columns: repeat(4, 1fr); gap: 20px; } }
        @media (min-width: 1024px) { .catalog-grid { grid-template-columns: repeat(5, 1fr); gap: 20px; } }
        @media (min-width: 1280px) { .catalog-grid { grid-template-columns: repeat(6, 1fr); gap: 20px; } }

        .movie-card {
            position: relative;
            background-color: rgba(24, 24, 27, 0.7);
            border: 1px solid #27272a;
            border-radius: 14px;
            overflow: hidden;
            cursor: pointer;
            transition: all 0.25s ease;
            display: flex;
            flex-direction: column;
        }
        .movie-card:hover {
            border-color: rgba(37, 99, 235, 0.6);
            transform: translateY(-3px);
            box-shadow: 0 12px 24px rgba(0, 0, 0, 0.5);
        }

        .poster-box {
            position: relative;
            width: 100%;
            aspect-ratio: 3/4;
            background-color: #000000;
            overflow: hidden;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .poster-box img {
            width: 100%;
            height: 100%;
            object-fit: cover;
            object-position: center;
            transition: transform 0.3s;
        }
        .movie-card:hover .poster-box img { transform: scale(1.05); }

        .year-badge {
            position: absolute;
            top: 8px;
            left: 8px;
            background-color: rgba(37, 99, 235, 0.9);
            color: #ffffff;
            font-size: 10px;
            font-weight: 800;
            padding: 2px 6px;
            border-radius: 6px;
            z-index: 10;
        }
        .episodes-badge {
            position: absolute;
            top: 8px;
            right: 8px;
            background-color: rgba(168, 85, 247, 0.9);
            color: #ffffff;
            font-size: 10px;
            font-weight: 800;
            padding: 2px 6px;
            border-radius: 6px;
            z-index: 10;
        }

        .movie-info {
            padding: 12px 10px;
            text-align: center;
            flex-grow: 1;
            display: flex;
            flex-direction: column;
            justify-content: center;
        }
        .movie-title {
            font-size: 12px;
            font-weight: 700;
            color: #ffffff;
            display: -webkit-box;
            -webkit-line-clamp: 2;
            -webkit-box-orient: vertical;
            overflow: hidden;
            line-height: 1.3;
        }

        /* Modal & Episode Selector */
        #player-modal, #series-modal {
            position: fixed;
            top: 0; left: 0; right: 0; bottom: 0;
            z-index: 1000;
            background-color: rgba(0, 0, 0, 0.88);
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 12px;
            backdrop-filter: blur(5px);
        }
        .hidden { display: none !important; }

        .modal-card {
            position: relative;
            width: 100%;
            max-width: 860px;
            max-height: 92vh;
            background-color: #09090b;
            border: 1px solid #27272a;
            border-radius: 16px;
            overflow: hidden;
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.7);
            display: flex;
            flex-direction: column;
        }

        .modal-header {
            padding: 12px 16px;
            background-color: rgba(24, 24, 27, 0.9);
            border-bottom: 1px solid #27272a;
            display: flex;
            align-items: center;
            justify-content: space-between;
            flex-shrink: 0;
        }
        .modal-title { font-size: 14px; font-weight: 700; color: #ffffff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .modal-sub { font-size: 11px; color: #a1a1aa; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        
        .close-btn {
            background-color: #27272a;
            color: #a1a1aa;
            border: none;
            width: 30px;
            height: 30px;
            border-radius: 8px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
        }
        .close-btn:hover { background-color: #3f3f46; color: #ffffff; }

        .modal-video-wrapper {
            position: relative;
            width: 100%;
            background-color: #000;
            flex: 1 1 auto;
            display: flex;
            align-items: center;
            justify-content: center;
            overflow: hidden;
            max-height: 60vh;
        }
        #video-element { width: 100%; height: 100%; max-height: 60vh; object-fit: contain; }

        .resume-banner {
            background-color: rgba(30, 58, 138, 0.8);
            border-top: 1px solid #1e40af;
            border-bottom: 1px solid #1e40af;
            padding: 10px 16px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            font-size: 12px;
            color: #bfdbfe;
            flex-shrink: 0;
        }
        .resume-btn {
            background-color: #2563eb;
            color: #ffffff;
            font-weight: 700;
            padding: 4px 10px;
            border-radius: 6px;
            font-size: 11px;
            border: none;
            cursor: pointer;
        }

        .modal-footer {
            padding: 12px 16px;
            background-color: rgba(24, 24, 27, 0.4);
            overflow-y: auto;
            max-height: 120px;
            flex-shrink: 0;
            border-top: 1px solid #27272a;
            font-size: 12px;
            color: #a1a1aa;
            line-height: 1.4;
        }

        /* Series Modal List */
        .series-list-container {
            padding: 16px;
            overflow-y: auto;
            max-height: 60vh;
            display: flex;
            flex-direction: column;
            gap: 8px;
        }
        .episode-item {
            background-color: #18181b;
            border: 1px solid #27272a;
            border-radius: 10px;
            padding: 10px 14px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            cursor: pointer;
            transition: all 0.2s;
        }
        .episode-item:hover { background-color: #27272a; border-color: #3b82f6; }

        /* Plyr Overrides */
        :root {
            --plyr-color-main: #2563eb;
            --plyr-video-control-color: #f4f4f5;
            --plyr-control-radius: 8px;
        }
        .plyr { width: 100%; height: 100%; max-height: 60vh; }
        .plyr__volume { display: flex !important; align-items: center !important; }
        .plyr__volume input[data-plyr="volume"] { display: block !important; width: 60px !important; max-width: 60px !important; margin-left: 6px !important; }
        #boost-btn { background: transparent !important; border: none !important; border-radius: 6px !important; padding: 6px 8px !important; font-size: 12px !important; color: #fff; cursor: pointer; }
        #boost-btn:hover { background: rgba(255,255,255,0.1) !important; }

        #toast {
            position: fixed;
            bottom: 20px;
            right: 20px;
            z-index: 2000;
            background-color: #18181b;
            border: 1px solid #27272a;
            color: #ffffff;
            padding: 10px 16px;
            border-radius: 10px;
            font-size: 12px;
            display: flex;
            align-items: center;
            gap: 8px;
            box-shadow: 0 10px 15px -3px rgba(0,0,0,0.5);
            transition: all 0.3s;
            opacity: 0;
            transform: translateY(20px);
            pointer-events: none;
        }
        #toast.show { opacity: 1; transform: translateY(0); pointer-events: auto; }
    </style>
</head>
<body>

    <header>
        <div class="dropdown-container" id="category-dropdown-container">
            <button onclick="toggleCategoryDropdown()" id="category-dropdown-btn" class="btn-dropdown">
                <span id="selected-category-label">Kategori: Semua</span>
                <i id="category-dropdown-arrow" class="fas fa-chevron-down" style="font-size:10px;"></i>
            </button>
            <div id="category-dropdown-menu" class="dropdown-menu hidden"></div>
        </div>

        <div class="search-box">
            <i class="fas fa-search search-icon"></i>
            <input type="text" oninput="handleSearch(this.value)" placeholder="Cari film atau anime..." class="search-input">
        </div>

        <div class="count-badge">
            <i class="fas fa-film" style="color:#2563eb;"></i>
            <span id="total-movies-count" style="color:#ffffff; font-weight:800;">0</span> Judul
        </div>
    </header>

    <main>
        <div id="catalog-container" class="catalog-grid"></div>
    </main>

    <!-- Series / Anime Episode Selector Modal -->
    <div id="series-modal" class="hidden">
        <div class="modal-card" style="max-width: 500px;">
            <div class="modal-header">
                <div>
                    <div id="series-modal-title" class="modal-title">Judul Series</div>
                    <div id="series-modal-sub" class="modal-sub">Pilih Episode</div>
                </div>
                <button onclick="closeSeriesModal()" class="close-btn"><i class="fas fa-times"></i></button>
            </div>
            <div id="series-episodes-list" class="series-list-container"></div>
        </div>
    </div>

    <!-- Modal Player -->
    <div id="player-modal" class="hidden">
        <div class="modal-card">
            <div class="modal-header">
                <div style="overflow:hidden; padding-right:12px;">
                    <div id="player-title" class="modal-title"></div>
                    <div id="player-genre" class="modal-sub"></div>
                </div>
                <button onclick="closePlayer()" class="close-btn"><i class="fas fa-times"></i></button>
            </div>
            
            <div class="modal-video-wrapper">
                <video id="video-element" playsinline controls></video>
            </div>

            <div id="resume-banner" class="resume-banner hidden">
                <span id="resume-banner-text">Kamu pernah menonton film ini sampai menit ke-00:00. Lanjutkan?</span>
                <div style="display:flex; gap:8px;">
                    <button onclick="applyResumePlayback()" class="resume-btn">Ya, Lanjutkan</button>
                    <button onclick="dismissResumeBanner()" style="background:none; border:none; color:#93c5fd; font-size:11px; cursor:pointer;">Ulangi</button>
                </div>
            </div>

            <div class="modal-footer">
                <p id="player-desc"></p>
            </div>
        </div>
    </div>

    <div id="toast">
        <i id="toast-icon" class="fas fa-info-circle" style="color:#60a5fa;"></i>
        <span id="toast-message"></span>
    </div>

    <script>
        var rawMoviesData = [];
        var groupedCatalog = [];
        var selectedCategory = 'ALL';
        var searchQuery = '';
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

        function getApiUrl(path) {
            if (!path) return '';
            if (path.indexOf('http://') === 0 || path.indexOf('https://') === 0) return path;
            return path.indexOf('/') === 0 ? path : '/' + path;
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
            var history = getWatchHistory();
            history[driveId] = {
                timestamp: Math.floor(currentTime),
                duration: Math.floor(totalDuration || 0),
                updatedAt: Date.now()
            };
            localStorage.setItem('moviebox_watch_progress', JSON.stringify(history));
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
                keyboard: { focused: true, global: true },
                volume: 1.0,
                hideVolume: false
            });

            var audioContext = null;
            var gainNode = null;
            var sourceNode = null;
            var boostFactor = 1.0;

            function applyVolumeBoost(volume) {
                try {
                    if (!audioContext) {
                        audioContext = new (window.AudioContext || window.webkitAudioContext)();
                        gainNode = audioContext.createGain();
                        gainNode.connect(audioContext.destination);
                    }
                    var video = document.getElementById('video-element');
                    if (!video) return;
                    if (sourceNode) {
                        try { sourceNode.disconnect(); } catch(e) {}
                        sourceNode = null;
                    }
                    if (video.captureStream) {
                        var stream = video.captureStream();
                        sourceNode = audioContext.createMediaStreamSource(stream);
                        sourceNode.connect(gainNode);
                        gainNode.gain.value = volume * boostFactor;
                    }
                } catch (e) {}
            }

            window.setBoostVolume = function(factor) {
                boostFactor = Math.min(Math.max(factor, 1.0), 2.0);
                var video = document.getElementById('video-element');
                if (video) applyVolumeBoost(video.volume);
                return boostFactor;
            };

            plyrPlayer.on('timeupdate', function() {
                if (!activeMovieObject || !plyrPlayer.currentTime) return;
                var cur = plyrPlayer.currentTime;
                var dur = plyrPlayer.duration;
                if (cur > 10 && dur && (cur < dur - 10)) {
                    saveWatchProgress(activeMovieObject.driveId, cur, dur);
                }
            });

            addBoostButton();

            function addBoostButton() {
                var container = document.querySelector('.plyr__controls');
                if (!container) {
                    setTimeout(addBoostButton, 500);
                    return;
                }
                if (document.getElementById('boost-btn')) return;

                var boostBtn = document.createElement('button');
                boostBtn.id = 'boost-btn';
                boostBtn.setAttribute('type', 'button');
                boostBtn.setAttribute('aria-label', 'Boost Volume');
                boostBtn.innerHTML = '<i class="fas fa-volume-up"></i> <span style="font-size:9px;margin-left:2px;">1x</span>';

                var boostLevel = 1.0;
                boostBtn.onclick = function() {
                    boostLevel += 0.25;
                    if (boostLevel > 2.0) boostLevel = 1.0;
                    boostBtn.innerHTML = '<i class="fas fa-volume-up"></i> <span style="font-size:9px;margin-left:2px;">' + boostLevel.toFixed(1) + 'x</span>';
                    boostBtn.style.color = (boostLevel === 1.0) ? '#ffffff' : '#f59e0b';
                    window.setBoostVolume(boostLevel);
                    showToast('Volume Boost: ' + boostLevel.toFixed(1) + 'x');
                };

                var fullscreenBtn = container.querySelector('.plyr__control[data-plyr="fullscreen"]');
                if (fullscreenBtn) container.insertBefore(boostBtn, fullscreenBtn);
                else container.appendChild(boostBtn);
            }
        }

        function showToast(message) {
            var toast = document.getElementById('toast');
            var toastMsg = document.getElementById('toast-message');
            if (!toast || !toastMsg) return;
            toastMsg.textContent = message;
            toast.className = "show";
            setTimeout(function() { toast.className = ""; }, 3000);
        }

        function fetchMovies() {
            try {
                fetch(getApiUrl('/api/movies'))
                    .then(function(res) {
                        if (!res.ok) throw new Error("HTTP " + res.status);
                        return res.json();
                    })
                    .then(function(data) {
                        if (data && Array.isArray(data.movies)) {
                            rawMoviesData = data.movies;
                        } else if (data && Array.isArray(data)) {
                            rawMoviesData = data;
                        } else {
                            rawMoviesData = [];
                        }
                        processAndGroupCatalog();
                        updateDynamicCategories();
                        renderCatalog();
                    })
                    .catch(function() {
                        rawMoviesData = [];
                        processAndGroupCatalog();
                        updateDynamicCategories();
                        renderCatalog();
                    });
            } catch (e) {
                renderCatalog();
            }
        }

        function processAndGroupCatalog() {
            var map = {};
            for (var i = 0; i < rawMoviesData.length; i++) {
                var m = rawMoviesData[i];
                if (!m) continue;
                
                if (m.type === 'series' && Array.isArray(m.episodes)) {
                    var titleKey = (m.title || 'Untitled').trim().toLowerCase();
                    if (!map[titleKey]) {
                        map[titleKey] = {
                            isSeries: true,
                            title: m.title,
                            poster: m.poster,
                            genre: m.genre || 'Series / Anime',
                            year: m.year || '2026',
                            description: m.description,
                            episodes: []
                        };
                    }
                    for (var e = 0; e < m.episodes.length; e++) {
                        var ep = m.episodes[e];
                        map[titleKey].episodes.push({
                            driveId: ep.driveId,
                            episodeNumber: ep.episodeNumber || (e + 1),
                            episodeTitle: ep.episodeTitle || ('Episode ' + (e + 1)),
                            description: m.description
                        });
                    }
                } else if (m.type === 'franchise' && Array.isArray(m.movies)) {
                    var titleKey = (m.title || 'Untitled').trim().toLowerCase();
                    if (!map[titleKey]) {
                        map[titleKey] = {
                            isSeries: true,
                            title: m.title,
                            poster: m.poster,
                            genre: m.genre || 'Franchise',
                            year: m.year || '2026',
                            description: m.description,
                            episodes: []
                        };
                    }
                    for (var f = 0; f < m.movies.length; f++) {
                        var mov = m.movies[f];
                        map[titleKey].episodes.push({
                            driveId: mov.driveId,
                            episodeNumber: mov.part || (f + 1),
                            episodeTitle: mov.title + (mov.year ? ' (' + mov.year + ')' : ''),
                            description: m.description
                        });
                    }
                } else if (m.type === 'movie' || m.driveId) {
                    var uniqueKey = 'movie_' + (m.driveId || i);
                    map[uniqueKey] = {
                        isSeries: false,
                        title: m.title,
                        poster: m.poster,
                        genre: m.genre || 'Movie',
                        year: m.year || '2026',
                        description: m.description,
                        driveId: m.driveId
                    };
                }
            }

            groupedCatalog = [];
            for (var k in map) {
                if (map[k].isSeries && map[k].episodes.length > 0) {
                    map[k].episodes.sort(function(a, b) { return a.episodeNumber - b.episodeNumber; });
                }
                groupedCatalog.push(map[k]);
            }
        }

        function toggleCategoryDropdown() {
            var menu = document.getElementById('category-dropdown-menu');
            var arrow = document.getElementById('category-dropdown-arrow');
            if (!menu) return;
            if (menu.className.indexOf('hidden') !== -1) {
                menu.className = 'dropdown-menu';
                if (arrow) arrow.style.transform = 'rotate(180deg)';
            } else {
                menu.className = 'dropdown-menu hidden';
                if (arrow) arrow.style.transform = 'rotate(0deg)';
            }
        }

        function selectCategoryOption(cat) {
            selectedCategory = cat;
            var label = document.getElementById('selected-category-label');
            if (label) label.textContent = (cat === 'ALL') ? 'Kategori: Semua' : ('Kategori: ' + cat);
            var menu = document.getElementById('category-dropdown-menu');
            var arrow = document.getElementById('category-dropdown-arrow');
            if (menu) menu.className = 'dropdown-menu hidden';
            if (arrow) arrow.style.transform = 'rotate(0deg)';
            renderCatalog();
        }

        function updateDynamicCategories() {
            var menu = document.getElementById('category-dropdown-menu');
            if (!menu) return;
            var categoriesObj = {};
            for (var i = 0; i < rawMoviesData.length; i++) {
                var m = rawMoviesData[i];
                if (m && m.genre) {
                    var parts = m.genre.split(',');
                    for (var j = 0; j < parts.length; j++) {
                        var trimmed = parts[j].trim();
                        if (trimmed) categoriesObj[trimmed] = true;
                    }
                }
            }
            var uniqueCategories = [];
            for (var k in categoriesObj) uniqueCategories.push(k);
            uniqueCategories.sort();

            menu.innerHTML = '';
            var allBtn = document.createElement('button');
            allBtn.className = 'dropdown-item' + (selectedCategory === 'ALL' ? ' active' : '');
            allBtn.innerHTML = '<span>Kategori: Semua</span>';
            allBtn.onclick = function() { selectCategoryOption('ALL'); };
            menu.appendChild(allBtn);

            for (var x = 0; x < uniqueCategories.length; x++) {
                (function(catName) {
                    var btn = document.createElement('button');
                    var isActive = (selectedCategory.toLowerCase() === catName.toLowerCase());
                    btn.className = 'dropdown-item' + (isActive ? ' active' : '');
                    btn.innerHTML = '<span>' + catName + '</span>';
                    btn.onclick = function() { selectCategoryOption(catName); };
                    menu.appendChild(btn);
                })(uniqueCategories[x]);
            }
        }

        function handleSearch(q) {
            searchQuery = q.toLowerCase().trim();
            renderCatalog();
        }

        function renderCatalog() {
            var container = document.getElementById('catalog-container');
            if (!container) return;
            container.innerHTML = '';

            var history = getWatchHistory();
            var filtered = [];

            for (var i = 0; i < groupedCatalog.length; i++) {
                var item = groupedCatalog[i];
                var mGenre = (item.genre || '').toLowerCase();
                var mTitle = (item.title || '').toLowerCase();
                
                var matchCat = (selectedCategory === 'ALL') || (mGenre.indexOf(selectedCategory.toLowerCase()) !== -1);
                var matchSearch = !searchQuery || (mTitle.indexOf(searchQuery) !== -1) || (mGenre.indexOf(searchQuery) !== -1);
                
                if (matchCat && matchSearch) {
                    filtered.push(item);
                }
            }

            var countEl = document.getElementById('total-movies-count');
            if (countEl) countEl.textContent = filtered.length;

            if (filtered.length === 0) {
                container.innerHTML = '<div style="grid-column: 1 / -1; text-align:center; padding:60px 0; color:#71717a; font-size:12px;">' +
                    '<i class="fas fa-film" style="font-size:32px; margin-bottom:12px; display:block; color:#3f3f46;"></i>' +
                    'Tidak ada judul yang cocok.' +
                '</div>';
                return;
            }

            for (var z = 0; z < filtered.length; z++) {
                var item = filtered[z];
                var card = document.createElement('div');
                card.className = 'movie-card';
                
                var safePoster = item.poster || 'https://images.unsplash.com/photo-1578632767115-351597cf2477?w=800';
                var yearHtml = '<div class="year-badge">' + (item.year || '2026') + '</div>';
                var badgeHtml = '';

                if (item.isSeries) {
                    badgeHtml = '<div class="episodes-badge">' + item.episodes.length + ' Eps</div>';
                } else {
                    var hasHistory = history[item.driveId] && history[item.driveId].timestamp > 10;
                    if (hasHistory) {
                        badgeHtml = '<div class="history-badge"><i class="fas fa-history" style="font-size:8px;"></i> Lanjut</div>';
                    }
                }

                card.innerHTML = '<div class="poster-box">' +
                    '<img src="' + safePoster + '" alt="poster" onerror="handleImgError(this)">' +
                    yearHtml + badgeHtml +
                '</div>' +
                '<div class="movie-info">' +
                    '<div class="movie-title">' + (item.title || 'Untitled') + '</div>' +
                '</div>';

                (function(obj) {
                    card.onclick = function() {
                        if (obj.isSeries) {
                            openSeriesModal(obj);
                        } else {
                            openPlayer({
                                driveId: obj.driveId,
                                title: obj.title,
                                genre: obj.genre,
                                year: obj.year,
                                description: obj.description
                            });
                        }
                    };
                })(item);

                container.appendChild(card);
            }
        }

        function openSeriesModal(seriesObj) {
            var modal = document.getElementById('series-modal');
            var titleEl = document.getElementById('series-modal-title');
            var subEl = document.getElementById('series-modal-sub');
            var listEl = document.getElementById('series-episodes-list');
            if (!modal) return;

            titleEl.textContent = seriesObj.title;
            subEl.textContent = seriesObj.episodes.length + ' Episode Tersedia';
            listEl.innerHTML = '';

            for (var i = 0; i < seriesObj.episodes.length; i++) {
                (function(ep) {
                    var div = document.createElement('div');
                    div.className = 'episode-item';
                    div.innerHTML = '<div style="display:flex; flex-direction:column; min-width:0; padding-right:8px;">' +
                                        '<span style="font-size:13px; font-weight:700; color:#fff;">Eps ' + ep.episodeNumber + ': ' + ep.episodeTitle + '</span>' +
                                        '<span style="font-size:11px; color:#71717a; truncate;">Klik untuk putar</span>' +
                                    '</div>' +
                                    '<i class="fas fa-play" style="color:#3b82f6; font-size:12px;"></i>';
                    div.onclick = function() {
                        closeSeriesModal();
                        openPlayer({
                            driveId: ep.driveId,
                            title: seriesObj.title + ' - Eps ' + ep.episodeNumber + ' (' + ep.episodeTitle + ')',
                            genre: seriesObj.genre,
                            year: seriesObj.year,
                            description: ep.description || seriesObj.description
                        });
                    };
                    listEl.appendChild(div);
                })(seriesObj.episodes[i]);
            }

            modal.className = "";
        }

        function closeSeriesModal() {
            var modal = document.getElementById('series-modal');
            if (modal) modal.className = "hidden";
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
            desc.textContent = movie.description || 'Tidak ada deskripsi.';
            
            var streamUrl = getApiUrl('/api/stream?id=' + movie.driveId);

            if (plyrPlayer) {
                plyrPlayer.source = {
                    type: 'video',
                    title: movie.title || 'Movie',
                    sources: [{ src: streamUrl, type: 'video/mp4' }]
                };
            }

            var history = getWatchHistory();
            var savedItem = history[movie.driveId];
            if (savedItem && savedItem.timestamp > 10) {
                pendingResumeTime = savedItem.timestamp;
                if (resumeBanner && resumeText) {
                    resumeText.textContent = 'Kamu pernah menonton sampai menit ke-' + formatSecondsToTime(pendingResumeTime) + '. Lanjutkan?';
                    resumeBanner.className = "resume-banner";
                }
            } else {
                pendingResumeTime = 0;
                if (resumeBanner) resumeBanner.className = "resume-banner hidden";
            }

            modal.className = "";
        }

        function applyResumePlayback() {
            if (plyrPlayer && pendingResumeTime > 0) {
                var targetTime = pendingResumeTime;
                function seekAndPlay() {
                    try {
                        plyrPlayer.currentTime = targetTime;
                        var p = plyrPlayer.play();
                        if (p && typeof p.catch === 'function') p.catch(function() {});
                    } catch (e) {}
                }

                if (plyrPlayer.ready) seekAndPlay();
                else {
                    plyrPlayer.once('ready', seekAndPlay);
                    plyrPlayer.once('canplay', seekAndPlay);
                }
            }
            dismissResumeBanner();
        }

        function dismissResumeBanner() {
            var resumeBanner = document.getElementById('resume-banner');
            if (resumeBanner) resumeBanner.className = "resume-banner hidden";
        }

        function closePlayer() {
            var modal = document.getElementById('player-modal');
            var resumeBanner = document.getElementById('resume-banner');
            if (plyrPlayer) {
                try { plyrPlayer.stop(); } catch (e) {}
            }
            activeMovieObject = null;
            pendingResumeTime = 0;
            if (resumeBanner) resumeBanner.className = "resume-banner hidden";
            if (modal) modal.className = "hidden";
            renderCatalog();
        }

        if (document.readyState === 'complete' || document.readyState === 'interactive') {
            fetchMovies();
        } else {
            document.addEventListener('DOMContentLoaded', fetchMovies);
        }
    </script>
</body>
</html>`;

async function handleRequest(req, res) {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Range');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
    }

    if (pathname === '/manifest.json' && req.method === 'GET') {
        const manifest = {
            name: "Shanz Stream",
            short_name: "Shanz",
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
            return res.end("Icon file not found.");
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

            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ movies: Array.isArray(movies) ? movies : [] }));
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: err.message, movies: [] }));
        }
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

    if (pathname === '/' || pathname === '/index.html') {
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
        console.log(`🎬 STREAMHUB PORTAL STREAMING SERVER READY`);
        console.log(`👉 Buka: http://localhost:${PORT}`);
        console.log("==================================================\n");
    });
}