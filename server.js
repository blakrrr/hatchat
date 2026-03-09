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

const clipMemStorage = multer.memoryStorage(); // buffer in RAM, then stream to Cloudinary

const clipUploadMW = multer({
    storage: clipMemStorage,
    fileFilter: (req, file, cb) => {
        const mimeOk = file.mimetype.startsWith('video/') ||
                       file.mimetype === 'application/octet-stream';
        const extOk  = /\.(mp4|webm|mov|avi|mkv)$/i.test(file.originalname);
        (mimeOk || extOk) ? cb(null, true) : cb(new Error('Only video files allowed'), false);
    },
    limits: { fileSize: 500 * 1024 * 1024 }
});

app.post('/upload-clip', (req, res) => {
    clipUploadMW.single('clip')(req, res, async (err) => {
        if (err) return res.status(400).json({ success: false, message: err.message });
        if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });

        try {
            // Strip extension for Cloudinary public_id (it adds its own)
            const baseName = req.file.originalname.replace(/\.[^.]+$/, '');

            const uploadResult = await new Promise((resolve, reject) => {
                const stream = cloudinary.uploader.upload_stream(
                    {
                        resource_type: 'video',
                        folder: 'hatchat-clips',
                        public_id: baseName,
                        overwrite: false,
                        // Cloudinary's built-in compression (equivalent to CRF 28)
                        eager: [{ quality: 'auto', fetch_format: 'mp4' }],
                        eager_async: true,
                    },
                    (error, result) => error ? reject(error) : resolve(result)
                );
                stream.end(req.file.buffer);
            });

            res.status(200).json({
                success: true,
                filename: req.file.originalname,
                url: uploadResult.secure_url,
                public_id: uploadResult.public_id,
            });
        } catch (error) {
            console.error('Cloudinary upload error:', error);
            res.status(500).json({ success: false, message: 'Upload to cloud failed: ' + error.message });
        }
    });
});

// GET /api/clips — returns all clips from Cloudinary, newest first
app.get('/api/clips', async (req, res) => {
    try {
        const result = await cloudinary.api.resources({
            resource_type: 'video',
            type: 'upload',
            prefix: 'hatchat-clips/',
            max_results: 200,
        });
        const clips = result.resources
            .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
            .map(r => ({
                filename: path.basename(r.public_id) + '.' + r.format,
                url: r.secure_url,
                created_at: r.created_at,
            }));
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

    io.emit('update_users', { users: Object.values(users) });

    socket.on('disconnect', () => {
        onlineUsers.delete(username);
        delete users[socket.id];
        console.log(`User disconnected: ${username}`);
        chatMessages.push({ type: 'system', message: `${username} has left the chat`, timestamp: new Date().toISOString() });
        saveMessages();
        io.emit('user_leave', { username, users: Object.values(users), userColors });
        io.emit('update_users', { users: Object.values(users) });
    });
});

// ─── STATIC PAGE ROUTES ───────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/chat', (req, res) => res.sendFile(path.join(__dirname, 'chat.html')));
app.get('/clips', (req, res) => res.sendFile(path.join(__dirname, 'clips.html')));
app.get('/settings', (req, res) => res.sendFile(path.join(__dirname, 'settings.html')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
