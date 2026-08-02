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
    <title>MovieBox Cloud Streaming</title>
    
    <!-- PWA Manifest & App Icons -->
    <link rel="manifest" href="/manifest.json">
    <link rel="icon" type="image/png" href="/icon.png">
    <meta name="theme-color" content="#09090b">
    <meta name="mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <meta name="apple-mobile-web-app-title" content="MovieBox">
    <link rel="apple-touch-icon" href="/icon.png">

    <!-- Suppress Console Warnings -->
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
        .no-scrollbar::-webkit-scrollbar { display: none; }
        .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
        .custom-scrollbar::-webkit-scrollbar { width: 6px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: #18181b; border-radius: 8px; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #27272a; border-radius: 8px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #3f3f46; }
        
        :root {
            --plyr-color-main: #2563eb;
            --plyr-video-control-color: #f4f4f5;
            --plyr-control-radius: 12px;
        }
        
        .plyr { border-radius: 16px; overflow: hidden; height: 100%; width: 100%; }

        /* Sleek Horizontal Volume Control (Ke Samping) */
        .plyr__volume {
            display: flex !important;
            align-items: center !important;
            position: relative !important;
        }

        .plyr__volume input[data-plyr="volume"] {
            display: block !important;
            width: 65px !important;
            max-width: 65px !important;
            margin-left: 6px !important;
            opacity: 1 !important;
            visibility: visible !important;
            cursor: pointer !important;
        }

        #boost-btn {
            background: transparent !important;
            border: none !important;
            border-radius: 6px !important;
            padding: 6px 10px !important;
            font-size: 12px !important;
            transition: all 0.2s !important;
            display: flex !important;
            align-items: center !important;
            gap: 2px !important;
        }
        #boost-btn:hover { background: rgba(255,255,255,0.1) !important; }
        #boost-btn i { font-size: 14px; }

        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(-4px); }
            to { opacity: 1; transform: translateY(0); }
        }
        .animate-fadeIn { animation: fadeIn 0.2s ease-out forwards; }

        @media (max-width: 768px) {
            .plyr { border-radius: 0 !important; }
            .plyr__volume input[data-plyr="volume"] { width: 50px !important; max-width: 50px !important; }
            #boost-btn { padding: 4px 6px !important; font-size: 10px !important; }
            #boost-btn i { font-size: 12px; }
        }
    </style>
</head>
<body class="min-h-screen flex flex-col justify-between selection:bg-blue-600 selection:text-white">

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

            <div class="text-xs font-bold text-zinc-400 bg-zinc-900 border border-zinc-800 px-3 py-2 rounded-xl flex items-center gap-1.5 shrink-0">
                <i class="fas fa-film text-blue-500 text-xs"></i>
                <span id="total-movies-count" class="text-white font-extrabold">0</span>
                <span class="hidden sm:inline">Film</span>
            </div>
        </header>

        <main class="flex-grow max-w-7xl w-full mx-auto px-3 sm:px-6 py-5">
            <div id="catalog-container" class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3 sm:gap-5"></div>
        </main>
    </div>

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

    <div id="toast" class="fixed bottom-5 right-5 z-50 flex items-center gap-2.5 px-4 py-3 rounded-xl bg-zinc-900 border border-zinc-800 text-white shadow-2xl backdrop-blur-md transition-all duration-300 transform translate-y-10 opacity-0 pointer-events-none">
        <i id="toast-icon" class="fas fa-info-circle text-blue-400 text-base"></i>
        <span id="toast-message" class="text-xs font-medium"></span>
    </div>

    <!-- APPLICATION SCRIPT -->
    <script>
        var moviesData = [];
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
                keyboard: { focused: true, global: true },
                volume: 1.0,
                hideVolume: false
            });

            let audioContext = null;
            let gainNode = null;
            let sourceNode = null;
            let boostFactor = 1.0;

            function applyVolumeBoost(volume) {
                try {
                    if (!audioContext) {
                        audioContext = new (window.AudioContext || window.webkitAudioContext)();
                        gainNode = audioContext.createGain();
                        gainNode.connect(audioContext.destination);
                    }
                    const video = document.getElementById('video-element');
                    if (!video) return;
                    if (sourceNode) {
                        try { sourceNode.disconnect(); } catch(e) {}
                        sourceNode = null;
                    }
                    if (video.captureStream) {
                        const stream = video.captureStream();
                        sourceNode = audioContext.createMediaStreamSource(stream);
                        sourceNode.connect(gainNode);
                        gainNode.gain.value = volume * boostFactor;
                    }
                } catch (e) {}
            }

            window.setBoostVolume = function(factor) {
                boostFactor = Math.min(Math.max(factor, 1.0), 2.0);
                const video = document.getElementById('video-element');
                if (video) {
                    applyVolumeBoost(video.volume);
                }
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

            plyrPlayer.on('enterfullscreen', function() {
                if (window.innerWidth < 768) {
                    try {
                        if (screen.orientation && screen.orientation.lock) {
                            screen.orientation.lock('landscape').catch(function() {});
                        }
                    } catch (e) {}
                }
            });

            plyrPlayer.on('exitfullscreen', function() {
                try {
                    if (screen.orientation && screen.orientation.unlock) {
                        screen.orientation.unlock();
                    }
                } catch (e) {}
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
                boostBtn.className = 'plyr__control';
                boostBtn.setAttribute('type', 'button');
                boostBtn.setAttribute('aria-label', 'Boost Volume');
                boostBtn.innerHTML = '<i class="fas fa-volume-up"></i> <span style="font-size:8px;margin-left:2px;">1x</span>';

                var boostLevel = 1.0;
                boostBtn.onclick = function() {
                    boostLevel += 0.25;
                    if (boostLevel > 2.0) boostLevel = 1.0;
                    boostBtn.innerHTML = '<i class="fas fa-volume-up"></i> <span style="font-size:8px;margin-left:2px;">' + boostLevel.toFixed(1) + 'x</span>';
                    if (boostLevel === 1.0) {
                        boostBtn.style.color = '';
                    } else {
                        boostBtn.style.color = '#f59e0b';
                    }
                    window.setBoostVolume(boostLevel);
                    showToast('Volume Boost: ' + boostLevel.toFixed(1) + 'x', false);
                };

                var fullscreenBtn = container.querySelector('.plyr__control[data-plyr="fullscreen"]');
                if (fullscreenBtn) {
                    container.insertBefore(boostBtn, fullscreenBtn);
                } else {
                    container.appendChild(boostBtn);
                }
            }
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
            }
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
            var totalCountEl = document.getElementById('total-movies-count');
            
            var filtered = moviesData.filter(function(movie) {
                var matchesCategory = selectedCategory === 'ALL' || 
                    (movie.genre && movie.genre.toLowerCase().includes(selectedCategory.toLowerCase()));
                var matchesSearch = !searchQuery || 
                    (movie.title && movie.title.toLowerCase().includes(searchQuery.toLowerCase())) ||
                    (movie.genre && movie.genre.toLowerCase().includes(searchQuery.toLowerCase()));
                return matchesCategory && matchesSearch;
            });

            if (totalCountEl) {
                totalCountEl.textContent = filtered.length;
            }

            if (filtered.length === 0) {
                container.innerHTML = '<div class="col-span-full py-20 text-center text-zinc-500">' +
                    '<i class="fas fa-film text-4xl mb-3 block text-zinc-600"></i>' +
                    '<p class="text-xs font-medium">Tidak ada film yang cocok.</p>' +
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
                    yearBadge + historyBadge +
                    '<div class="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition duration-300 bg-black/40 backdrop-blur-[2px] z-10">' +
                        '<div class="w-10 h-10 sm:w-12 sm:h-12 rounded-full bg-blue-600 text-white flex items-center justify-center shadow-lg shadow-blue-600/40">' +
                            '<i class="fas fa-play text-xs sm:text-sm ml-0.5"></i>' +
                        '</div>' +
                    '</div>' +
                    progressBar +
                '</div>' +
                '<div class="p-2.5 sm:p-3 flex flex-col items-center justify-center text-center flex-grow">' +
                    '<h3 class="text-xs font-bold text-white text-center line-clamp-2 group-hover:text-blue-400 transition leading-snug">' + (movie.title || 'Untitled') + '</h3>' +
                    '<p class="text-[10px] text-zinc-500 mt-1">' + (movie.genre || 'General') + '</p>' +
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
                var targetTime = pendingResumeTime;
                function seekAndPlay() {
                    try {
                        plyrPlayer.currentTime = targetTime;
                        var p = plyrPlayer.play();
                        if (p && typeof p.catch === 'function') {
                            p.catch(function() {});
                        }
                    } catch (e) {}
                }

                if (plyrPlayer.ready) {
                    seekAndPlay();
                } else {
                    plyrPlayer.once('ready', seekAndPlay);
                    plyrPlayer.once('canplay', seekAndPlay);
                }
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
                try {
                    plyrPlayer.stop();
                } catch (e) {}
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

        document.addEventListener('DOMContentLoaded', async function() {
            await fetchMovies();
        });
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

            const validMovies = movies.filter(m => m.driveId && !m.driveId.startsWith('drive-') && !m.driveId.startsWith('demo-'));

            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ movies: validMovies }));
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
        console.log(`🎬 MOVIEBOX STREAMING SERVER READY (PLAYER MODE)`);
        console.log(`👉 Buka: http://localhost:${PORT}`);
        console.log("==================================================\n");
    });
}