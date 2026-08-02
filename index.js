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
    maxSockets: 150,
    maxFreeSockets: 20,
    timeout: 60000
});

const httpAgent = new http.Agent({
    keepAlive: true,
    keepAliveMsecs: 30000,
    maxSockets: 150
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

process.on('uncaughtException', (err) => {});
process.on('unhandledRejection', (reason) => {});

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

    let lastError = null;

    for (let i = 0; i < pool.length; i++) {
        const authObj = getNextRotatedAuth();
        try {
            const accessToken = await getAccessTokenForClient(authObj);

            const headers = {
                'Authorization': `Bearer ${accessToken}`
            };

            if (rangeHeader) {
                headers['Range'] = rangeHeader;
            }

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
                            'Cache-Control': 'public, max-age=3600'
                        };

                        if (driveRes.headers['content-range']) {
                            responseHeaders['Content-Range'] = driveRes.headers['content-range'];
                        }
                        if (driveRes.headers['content-length']) {
                            responseHeaders['Content-Length'] = driveRes.headers['content-length'];
                        }

                        res.writeHead(driveRes.statusCode, responseHeaders);

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

            const expectedPassword = (process.env.ADMIN_PASSWORD || '').trim();
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

            const expectedPassword = (process.env.ADMIN_PASSWORD || '').trim();
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

    if (pathname === '/' || pathname === '/index.html') {
        const indexPath = path.join(__dirname, 'index.html');
        if (fs.existsSync(indexPath)) {
            const htmlContent = fs.readFileSync(indexPath, 'utf8');
            res.writeHead(200, { 'Content-Type': 'text/html' });
            return res.end(htmlContent);
        }
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