const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const fsExtra = require('fs-extra');
const { v2: cloudinary } = require('cloudinary');

// ─── Cloudinary config (set these in Render Environment Variables) ─────────
// CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key:    process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

const app = express();
app.use(cors());
// Serve static assets from /public (sounds, uploads, etc.)
app.use(express.static(path.join(__dirname, 'public')));
// Serve root-level HTML files (chat.html, clips.html, settings.html, index.html)
app.use(express.static(path.join(__dirname)));

const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: ["https://hatchat.blakrr.works", "http://hatchat.blakrr.works", "https://averrgy-github-io.onrender.com", "*"],
        methods: ["GET", "POST"]
    }
});

// ─── IMAGE UPLOAD (existing) ───────────────────────────────────────────────
const imageStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(__dirname, 'public', 'uploads')),
    filename: (req, file, cb) => {
        const uniquePrefix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniquePrefix + path.extname(file.originalname));
    }
});

const imageUpload = multer({
    storage: imageStorage,
    fileFilter: (req, file, cb) => {
        file.mimetype.startsWith('image/')
            ? cb(null, true)
            : cb(new Error('Only image files are allowed!'), false);
    },
    limits: { fileSize: 5 * 1024 * 1024 }
});

app.post('/upload', imageUpload.single('image'), (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });
        return res.status(200).json({ success: true, filePath: `/uploads/${req.file.filename}` });
    } catch (error) {
        console.error('Image upload error:', error);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
});

// ─── CLIP UPLOAD — Cloudinary ─────────────────────────────────────────────
// Files are stored in Cloudinary under the "hatchat-clips" folder.
// Cloudinary handles CDN delivery, so clips load fast everywhere.
// The original filename is preserved as the public_id so NVIDIA date-names sort correctly.

// NVIDIA filename pattern: "Game Name YYYY.MM.DD - HH.MM.SS.frames.ext"
const NVIDIA_PATTERN = /\d{4}\.\d{2}\.\d{2}\s*-\s*\d{2}\.\d{2}\.\d{2}/;
const MAX_CLIP_MB    = 50;
const MAX_CLIP_BYTES = MAX_CLIP_MB * 1024 * 1024;

const clipMemStorage = multer.memoryStorage();

const clipUploadMW = multer({
    storage: clipMemStorage,
    fileFilter: (req, file, cb) => {
        // Reject non-NVIDIA filenames immediately
        if (!NVIDIA_PATTERN.test(file.originalname)) {
            return cb(new Error('Only NVIDIA GameDVR clips (with date in filename) are allowed.'), false);
        }
        const mimeOk = file.mimetype.startsWith('video/') || file.mimetype === 'application/octet-stream';
        const extOk  = /\.(mp4|webm|mov|avi|mkv)$/i.test(file.originalname);
        (mimeOk || extOk) ? cb(null, true) : cb(new Error('Only video files allowed'), false);
    },
    limits: { fileSize: MAX_CLIP_BYTES }
});

// POST /upload-clip — supports multiple files (field name "clips[]")
app.post('/upload-clip', (req, res) => {
    clipUploadMW.array('clips[]', 20)(req, res, async (err) => {
        if (err) return res.status(400).json({ success: false, message: err.message });
        const files = req.files;
        if (!files || files.length === 0) return res.status(400).json({ success: false, message: 'No files uploaded' });

        try {
            const uploader = (req.body && req.body.uploader) ? req.body.uploader.trim() : 'unknown';
            const results  = [];
            const errors   = [];

            for (const file of files) {
                const baseName = file.originalname.replace(/\.[^.]+$/, '');
                try {
                    const uploadResult = await new Promise((resolve, reject) => {
                        const stream = cloudinary.uploader.upload_stream(
                            {
                                resource_type: 'video',
                                folder: 'hatchat-clips',
                                public_id: baseName,
                                overwrite: false,
                                // Trim to 30 seconds, compress to ~50 MB quality
                                eager: [{
                                    duration: '30',
                                    quality: 'auto:low',
                                    fetch_format: 'mp4',
                                    bit_rate: '1m',
                                }],
                                eager_async: true,
                                tags: [`uploader:${uploader}`],
                                context: `uploader=${uploader}`,
                            },
                            (error, result) => error ? reject(error) : resolve(result)
                        );
                        stream.end(file.buffer);
                    });
                    results.push({
                        filename: file.originalname,
                        url: uploadResult.secure_url,
                        public_id: uploadResult.public_id,
                        uploader,
                    });
                } catch (e) {
                    errors.push({ filename: file.originalname, message: e.message });
                }
            }

            res.status(200).json({ success: true, uploaded: results, errors });
        } catch (error) {
            console.error('Cloudinary upload error:', error);
            res.status(500).json({ success: false, message: 'Upload to cloud failed: ' + error.message });
        }
    });
});

// DELETE /api/clips/:public_id — only the original uploader can delete their clip
app.delete('/api/clips/:public_id(*)', async (req, res) => {
    const { public_id } = req.params;          // e.g. "hatchat-clips/Arc Raiders 2026..."
    const { uploader }  = req.body || {};

    if (!uploader) return res.status(400).json({ success: false, message: 'Missing uploader' });

    try {
        // Fetch the resource to verify ownership
        const info = await cloudinary.api.resource(public_id, {
            resource_type: 'video', context: true, tags: true
        });

        let owner = 'unknown';
        if (info.context && info.context.custom && info.context.custom.uploader) {
            owner = info.context.custom.uploader;
        } else if (info.tags) {
            const t = info.tags.find(t => t.startsWith('uploader:'));
            if (t) owner = t.replace('uploader:', '');
        }

        if (owner.toLowerCase() !== uploader.toLowerCase()) {
            return res.status(403).json({ success: false, message: 'You can only delete your own clips.' });
        }

        await cloudinary.uploader.destroy(public_id, { resource_type: 'video' });
        res.json({ success: true });
    } catch (error) {
        console.error('Delete error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// GET /api/clips — returns all clips from Cloudinary, grouped by uploader then sorted by date
app.get('/api/clips', async (req, res) => {
    try {
        const result = await cloudinary.api.resources({
            resource_type: 'video',
            type: 'upload',
            prefix: 'hatchat-clips/',
            max_results: 200,
            context: true,  // fetch uploader metadata
            tags: true,
        });
        const clips = result.resources.map(r => {
            // Extract uploader from context or tags
            let uploader = 'unknown';
            if (r.context && r.context.custom && r.context.custom.uploader) {
                uploader = r.context.custom.uploader;
            } else if (r.tags) {
                const tag = r.tags.find(t => t.startsWith('uploader:'));
                if (tag) uploader = tag.replace('uploader:', '');
            }
            return {
                filename: path.basename(r.public_id) + '.' + r.format,
                url: r.secure_url,
                created_at: r.created_at,
                uploader,
            };
        });
        // Sort: by uploader name, then newest-first within each uploader
        clips.sort((a, b) => {
            const u = a.uploader.localeCompare(b.uploader);
            if (u !== 0) return u;
            return new Date(b.created_at) - new Date(a.created_at);
        });
        res.json({ success: true, clips });
    } catch (error) {
        console.error('Cloudinary list error:', error);
        res.status(500).json({ success: false, message: 'Could not list clips' });
    }
});

// ─── CHAT DATA ────────────────────────────────────────────────────────────
const onlineUsers = new Set();
const userColors = {};
let users = {};
const voiceMembers = {};  // socketId -> { username }

const MESSAGES_FILE = path.join(__dirname, 'chat_messages.json');
const USER_COLORS_FILE = path.join(__dirname, 'user_colors.json');

let chatMessages = [];
try {
    if (fs.existsSync(MESSAGES_FILE)) {
        chatMessages = JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf8'));
    } else {
        fs.writeFileSync(MESSAGES_FILE, JSON.stringify(chatMessages), 'utf8');
    }
} catch (e) { console.error('Error loading messages:', e); }

try {
    if (fs.existsSync(USER_COLORS_FILE)) {
        Object.assign(userColors, JSON.parse(fs.readFileSync(USER_COLORS_FILE, 'utf8')));
    } else {
        fs.writeFileSync(USER_COLORS_FILE, JSON.stringify(userColors), 'utf8');
    }
} catch (e) { console.error('Error loading user colors:', e); }

function saveMessages() {
    try { fs.writeFileSync(MESSAGES_FILE, JSON.stringify(chatMessages), 'utf8'); }
    catch (e) { console.error('Error saving messages:', e); }
}

function saveUserColors() {
    try { fs.writeFileSync(USER_COLORS_FILE, JSON.stringify(userColors), 'utf8'); }
    catch (e) { console.error('Error saving user colors:', e); }
}

// ─── SOCKET.IO ────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
    const username = socket.handshake.query.username;
    const userColor = socket.handshake.query.color;

    if (!username) { socket.disconnect(); return; }

    if (userColor) { userColors[username] = userColor; saveUserColors(); }

    onlineUsers.add(username);
    users[socket.id] = { username, dnd: false };

    console.log(`User connected: ${username} (${socket.id})`);

    socket.on('user_join', (data) => {
        io.emit('user_join', { username: data.username, users: Object.values(users), userColors });
        chatMessages.push({ type: 'system', message: `${data.username} has joined the chat`, timestamp: new Date().toISOString() });
        saveMessages();
    });

    socket.on('chat_message', (data) => {
        const messageData = {
            type: 'message',
            username,
            message: data.message,
            timestamp: new Date().toISOString(),
            color: userColors[username],
            image: data.image || null,
            // ── Reply support: store whatever the client sent, or null ──
            replyTo: data.replyTo || null
        };
        chatMessages.push(messageData);
        saveMessages();
        io.emit('chat_message', messageData);
    });

    socket.on('load_messages', (data) => {
        const page = data.page || 1;
        const pageSize = 20;
        const start = Math.max(0, chatMessages.length - (page * pageSize));
        const end = Math.max(0, chatMessages.length - ((page - 1) * pageSize));
        socket.emit('chat_history', {
            messages: chatMessages.slice(start, end).reverse(),
            page,
            totalMessages: chatMessages.length,
            userColors
        });
        // Tell the client to scroll to the bottom after the first page loads
        if (page === 1) socket.emit('scroll_to_latest');
    });

    socket.on('update_color', (data) => {
        if (data.color) {
            userColors[username] = data.color;
            saveUserColors();
            io.emit('update_colors', { userColors });
        }
    });

    socket.on('dnd_toggle', (dndStatus) => {
        users[socket.id].dnd = dndStatus;
        io.emit('update_users', { users: Object.values(users) });
    });

    // ── Voice signalling ─────────────────────────────────────────────
    socket.on('voice_join', () => {
        const current = Object.entries(voiceMembers).map(([socketId, d]) => ({ socketId, username: d.username }));
        socket.emit('voice_current_members', current);
        voiceMembers[socket.id] = { username };
        socket.broadcast.emit('voice_user_joined', { socketId: socket.id, username });
    });

    socket.on('voice_leave', () => {
        delete voiceMembers[socket.id];
        io.emit('voice_user_left', { socketId: socket.id });
    });

    socket.on('voice_offer',  ({ to, offer })     => io.to(to).emit('voice_offer',  { from: socket.id, offer }));
    socket.on('voice_answer', ({ to, answer })    => io.to(to).emit('voice_answer', { from: socket.id, answer }));
    socket.on('voice_ice',    ({ to, candidate }) => io.to(to).emit('voice_ice',    { from: socket.id, candidate }));
    socket.on('voice_mute',   ({ muted })         => {
        if (voiceMembers[socket.id]) voiceMembers[socket.id].muted = muted;
        io.emit('voice_mute_update', { socketId: socket.id, muted });
    });

    io.emit('update_users', { users: Object.values(users) });

    socket.on('disconnect', () => {
        onlineUsers.delete(username);
        delete users[socket.id];
        console.log(`User disconnected: ${username}`);
        chatMessages.push({ type: 'system', message: `${username} has left the chat`, timestamp: new Date().toISOString() });
        saveMessages();
        io.emit('user_leave', { username, users: Object.values(users), userColors });
        io.emit('update_users', { users: Object.values(users) });
        // Clean up voice if they were in it
        if (voiceMembers[socket.id]) {
            delete voiceMembers[socket.id];
            io.emit('voice_user_left', { socketId: socket.id });
        }
    });
});

// ─── STATIC PAGE ROUTES ───────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/chat', (req, res) => res.sendFile(path.join(__dirname, 'chat.html')));
app.get('/clips', (req, res) => res.sendFile(path.join(__dirname, 'clips.html')));
app.get('/settings', (req, res) => res.sendFile(path.join(__dirname, 'settings.html')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
