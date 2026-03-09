const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const fsExtra = require('fs-extra');
const { spawn } = require('child_process'); // built-in Node module, no install needed

// ─── FFmpeg compression ────────────────────────────────────────────────────
// Called after every clip upload. Responds to the client immediately so the
// user doesn't wait; compression runs in the background and replaces the
// original file when done.
//
// Settings explained:
//   -crf 28        : quality (0=lossless, 51=worst). 28 is a good gaming-clip
//                    balance — roughly 40-60% smaller than raw NVIDIA output.
//   -preset fast   : encoding speed vs compression ratio. "fast" keeps CPU
//                    usage reasonable on Render's free tier.
//   -movflags +faststart : moves video metadata to the front of the file so
//                    the browser can start playing before the whole file loads.
function compressVideo(filePath) {
    return new Promise((resolve) => {
        const dir     = path.dirname(filePath);
        const ext     = path.extname(filePath);
        const base    = path.basename(filePath, ext);
        const tmpPath = path.join(dir, base + '_tmp' + ext);

        console.log(`Compressing: ${base}${ext}`);

        const ffmpeg = spawn('ffmpeg', [
            '-i',        filePath,
            '-vcodec',   'libx264',
            '-crf',      '28',
            '-preset',   'fast',
            '-acodec',   'aac',
            '-movflags', '+faststart',
            '-y',        tmpPath   // -y = overwrite tmpPath if it somehow exists
        ]);

        ffmpeg.on('close', (code) => {
            if (code === 0) {
                // Swap compressed file over the original
                try {
                    fs.renameSync(tmpPath, filePath);
                    console.log(`Compression done: ${base}${ext}`);
                } catch (err) {
                    console.warn('Could not replace original with compressed file:', err.message);
                }
            } else {
                // ffmpeg exited with an error — keep the original, clean up tmp
                if (fs.existsSync(tmpPath)) {
                    try { fs.unlinkSync(tmpPath); } catch (_) {}
                }
                console.warn(`Compression failed (exit ${code}): ${base}${ext}`);
            }
            resolve(); // always resolve so the promise never hangs
        });

        ffmpeg.on('error', (err) => {
            // ffmpeg binary not found or other spawn error — just keep original
            console.warn('ffmpeg unavailable, skipping compression:', err.message);
            resolve();
        });
    });
}

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
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

// ─── CLIP UPLOAD (new) ────────────────────────────────────────────────────
// We keep the ORIGINAL filename so NVIDIA's date-based names sort correctly.
// The clips directory is created automatically on first run.
const CLIPS_DIR = path.join(__dirname, 'public', 'uploads', 'clips');
fsExtra.ensureDirSync(CLIPS_DIR);

const clipStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, CLIPS_DIR),
    filename: (req, file, cb) => {
        // Avoid collisions: if name exists, prefix with a tiny timestamp
        let name = file.originalname;
        if (fs.existsSync(path.join(CLIPS_DIR, name))) {
            name = Date.now() + '_' + name;
        }
        cb(null, name);
    }
});

const clipUpload = multer({
    storage: clipStorage,
    fileFilter: (req, file, cb) => {
        const allowed = ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-msvideo'];
        allowed.includes(file.mimetype)
            ? cb(null, true)
            : cb(new Error('Only video files are allowed!'), false);
    },
    limits: { fileSize: 500 * 1024 * 1024 } // 500 MB per clip
});

// POST /upload-clip — saves file, responds immediately, then compresses in background
app.post('/upload-clip', clipUpload.single('clip'), (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });

        // Respond NOW — don't make the user wait for ffmpeg
        res.status(200).json({ success: true, filename: req.file.filename });

        // Compress in background (not awaited — fire and forget)
        compressVideo(req.file.path).catch((err) => {
            console.error('Background compression error:', err);
        });

    } catch (error) {
        console.error('Clip upload error:', error);
        if (!res.headersSent) {
            return res.status(500).json({ success: false, message: 'Server error' });
        }
    }
});

// GET /clips — returns a sorted list of all clip filenames
// Sorted alphabetically = sorted by date because NVIDIA names are date-prefixed
app.get('/clips', (req, res) => {
    try {
        const videoExts = /\.(mp4|webm|mov|avi)$/i;
        const files = fs.readdirSync(CLIPS_DIR)
            .filter(f => videoExts.test(f))
            .sort()          // alphabetical order
            .reverse();      // newest first (NVIDIA timestamps go oldest→newest alphabetically)
        return res.json({ success: true, clips: files });
    } catch (error) {
        console.error('Clips list error:', error);
        return res.status(500).json({ success: false, message: 'Server error' });
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
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/chat', (req, res) => res.sendFile(path.join(__dirname, 'chat.html')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
