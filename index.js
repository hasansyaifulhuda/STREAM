const { google } = require('googleapis');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const dns = require('dns');

// Force IPv4 First to prevent Windows DNS resolution delays (EAI_AGAIN)
if (dns.setDefaultResultOrder) {
    dns.setDefaultResultOrder('ipv4first');
}

function loadEnvFile() {
    const envPath = path.join(__dirname, '.env');
    if (fs.existsSync(envPath)) {
        try {
            let content = fs.readFileSync(envPath, 'utf8');
            content = content.replace(/^\uFEFF/, ''); // Strip UTF-8 BOM

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

// Map to store background stream upload jobs
const uploadJobs = new Map();

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
    if (!folderId) throw new Error("GOOGLE_DRIVE_FOLDER_ID belum diisi di file .env!");

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
    const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
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

function resolveTargetUrl(targetUrl) {
    if (!targetUrl || typeof targetUrl !== 'string') return targetUrl;
    targetUrl = targetUrl.trim();

    // Convert Pixeldrain web page links to API Direct File Download links
    if (targetUrl.includes('pixeldrain.com/u/')) {
        return targetUrl.replace('pixeldrain.com/u/', 'pixeldrain.com/api/file/');
    }

    // Convert Google Drive share links ONLY IF it's not already a direct download URL
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

    // 1. Title
    let matchTitle = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i) ||
                     html.match(/<title>([^<]+)<\/title>/i);
    if (matchTitle && matchTitle[1]) {
        title = matchTitle[1].replace(/ - MovieBox.*/i, '').replace(/ - Watch.*/i, '').trim();
    }

    // 2. Poster
    let matchPoster = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i) ||
                      html.match(/<link\s+rel=["']image_src["']\s+href=["']([^"']+)["']/i);
    if (matchPoster && matchPoster[1]) {
        poster = matchPoster[1].trim();
    }

    // 3. Description
    let matchDesc = html.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i) ||
                    html.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i);
    if (matchDesc && matchDesc[1]) {
        description = matchDesc[1].trim();
    }

    // 4. Year
    let matchYear = html.match(/\b(202[0-9]|201[0-9])\b/);
    if (matchYear) year = matchYear[1];

    // 5. Deep Scan Script Blobs for Full Movie Stream (Ignoring Trailers)
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
        const auth = getOAuth2Client();
        const drive = google.drive({ version: 'v3', auth });
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
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36',
                'Accept': '*/*'
            },
            timeout: 30000
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
            const passThrough = new PassThrough();

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

            // Upload continuous stream into Google Drive
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

                // Save Metadata to metadata.json on Drive
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
                } catch (metaErr) {
                    console.error("⚠️ Error saving metadata on stream complete:", metaErr.message);
                }
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

    // API 1: AUTH ADMIN LOGIN VERIFICATION
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

    // API 2: FETCH CATALOG MOVIES
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

    // API 3: PREVIEW METADATA FOR SINGLE OR BATCH LINKS (UP TO 10)
    if (pathname === '/api/upload/preview' && req.method === 'POST') {
        try {
            const body = await parseJsonBody(req);
            const { urls } = body;

            if (!urls || !Array.isArray(urls) || urls.length === 0) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: "Daftar URL tidak boleh kosong!" }));
            }

            const results = [];
            const targetUrls = urls.slice(0, 10); // Max 10 items limit

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
                    } catch (e) {
                        console.warn(`⚠️ Preview scraper failed for ${singleUrl}:`, e.message);
                    }
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

    // API 4: START BACKGROUND UPLOAD JOB
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

            // Start streaming upload in background
            startStreamUploadJob(jobId, url, extractedMetadata);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: true, jobId }));
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: err.message }));
        }
    }

    // API 5: UPLOAD JOB PROGRESS POLLING
    if (pathname === '/api/upload/progress' && req.method === 'GET') {
        const jobId = parsedUrl.searchParams.get('jobId');
        const job = uploadJobs.get(jobId);

        if (!job) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: "Job tidak ditemukan!" }));
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(job));
    }

    // API 6: RANGE-BASED VIDEO STREAMING FROM GOOGLE DRIVE
    if (pathname === '/api/stream' && req.method === 'GET') {
        try {
            const driveId = parsedUrl.searchParams.get('id');
            if (!driveId || driveId.startsWith('demo-') || driveId.startsWith('drive-')) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'ID file Google Drive tidak valid.' }));
            }

            const auth = getOAuth2Client();
            const drive = google.drive({ version: 'v3', auth });

            const fileMeta = await drive.files.get({ fileId: driveId, fields: 'size, mimeType' });
            const fileSize = parseInt(fileMeta.data.size || '0', 10);
            const range = req.headers.range;

            if (range && fileSize > 0) {
                const parts = range.replace(/bytes=/, "").split("-");
                const start = parseInt(parts[0], 10);
                const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
                const chunksize = (end - start) + 1;

                res.writeHead(206, {
                    'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                    'Accept-Ranges': 'bytes',
                    'Content-Length': chunksize,
                    'Content-Type': 'video/mp4'
                });

                const streamRes = await drive.files.get(
                    { fileId: driveId, alt: 'media' },
                    { responseType: 'stream', headers: { Range: `bytes=${start}-${end}` } }
                );
                streamRes.data.pipe(res);
            } else {
                res.writeHead(200, {
                    'Content-Length': fileSize,
                    'Content-Type': 'video/mp4'
                });

                const streamRes = await drive.files.get(
                    { fileId: driveId, alt: 'media' },
                    { responseType: 'stream' }
                );
                streamRes.data.pipe(res);
            }
            return;
        } catch (err) {
            console.error("⚠️ Stream Error:", err.message);
            if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message }));
            }
            return;
        }
    }

    // API 7: DELETE MOVIE & GOOGLE DRIVE FILE
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

            const auth = getOAuth2Client();
            const drive = google.drive({ version: 'v3', auth });

            try {
                await drive.files.delete({ fileId: driveId });
            } catch (e) {
                console.warn(`⚠️ File Drive (${driveId}) tidak ditemukan: ${e.message}`);
            }

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

    // API 8: UPDATE MOVIE METADATA
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

    // SERVE STATIC INDEX.HTML
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