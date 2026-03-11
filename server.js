const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const fsExtra = require('fs-extra');
const { v2: cloudinary } = require('cloudinary');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const httpsModule = require('https');

// ─── Cloudinary config ─────────────────────────────────────────────────────
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key:    process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname)));

const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: ["https://hatchat.blakrr.works", "http://hatchat.blakrr.works",
                 "https://averrgy-github-io.onrender.com", "*"],
        methods: ["GET", "POST"]
    }
});

// ─── GITHUB PERSISTENCE FOR users.json ────────────────────────────────────
// Render's free tier has ephemeral storage — every restart wipes the disk.
// To survive restarts, we read users.json FROM GitHub on boot, and push it
// back TO GitHub every time an account is created or logged into.
// You need a GITHUB_TOKEN env var on Render (a personal access token with
// repo write access). Without it the server still works — accounts just
// won't persist across restarts (degraded mode).

const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_REPO   = 'blakrrr/hatchat';
const GITHUB_BRANCH = 'main';
const GITHUB_PATH   = 'users.json';

let githubUsersSha = null; // tracks the SHA of the current users.json on GitHub

function githubRequest(method, urlPath, body) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;
        const options = {
            hostname: 'api.github.com',
            path: urlPath,
            method,
            headers: {
                'Authorization': `token ${GITHUB_TOKEN}`,
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'hatchat-server',
                ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {})
            }
        };
        const req = httpsModule.request(options, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
                catch(e) { resolve({ status: res.statusCode, body: data }); }
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

async function fetchUsersFromGitHub() {
    if (!GITHUB_TOKEN) return null;
    try {
        const res = await githubRequest('GET', `/repos/${GITHUB_REPO}/contents/${GITHUB_PATH}?ref=${GITHUB_BRANCH}`);
        if (res.status !== 200) return null;
        githubUsersSha = res.body.sha;
        const content = Buffer.from(res.body.content, 'base64').toString('utf8');
        console.log('[GitHub] Loaded users.json from GitHub (SHA:', githubUsersSha, ')');
        return JSON.parse(content);
    } catch(e) { console.error('[GitHub] Failed to fetch users.json:', e.message); return null; }
}

async function pushUsersToGitHub(usersData) {
    if (!GITHUB_TOKEN) return;
    try {
        const content = Buffer.from(JSON.stringify(usersData, null, 2)).toString('base64');
        const body = { message: 'chore: update users [skip ci]', content, branch: GITHUB_BRANCH };
        if (githubUsersSha) body.sha = githubUsersSha;
        const res = await githubRequest('PUT', `/repos/${GITHUB_REPO}/contents/${GITHUB_PATH}`, body);
        if (res.status === 200 || res.status === 201) {
            githubUsersSha = res.body.content?.sha || githubUsersSha;
            console.log('[GitHub] Pushed users.json to GitHub');
        } else {
            console.error('[GitHub] Push failed:', res.status, JSON.stringify(res.body).substring(0, 200));
        }
    } catch(e) { console.error('[GitHub] Push error:', e.message); }
}
