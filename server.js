require('dotenv').config();
const express = require('express');
const { Bot, webhookCallback } = require('grammy');
const { ethers } = require('ethers');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- БЛОКЧЕЙН ----------
const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

const REGISTRY_ABI = [
    "function submitMetrics(address author, bytes32 postId, uint256 followers, uint256 likes, uint256 reposts) external"
];
const SUBSCRIPTION_ABI = [
    "function isActive(address user) view returns (bool)"
];
const MONITOR_ABI = [
    "function updateMined(address user, uint256 amount) external"
];

const registry = new ethers.Contract(process.env.REGISTRY_ADDRESS, REGISTRY_ABI, wallet);
const subscription = new ethers.Contract(process.env.SUBSCRIPTION_ADDRESS, SUBSCRIPTION_ABI, wallet);
const monitor = new ethers.Contract(process.env.MONITOR_ADDRESS, MONITOR_ABI, wallet);

// ---------- ХРАНЕНИЕ КОШЕЛЬКОВ ----------
const WALLETS_FILE = path.join(__dirname, 'wallets.json');
let wallets = {};
try { if (fs.existsSync(WALLETS_FILE)) wallets = JSON.parse(fs.readFileSync(WALLETS_FILE, 'utf8')); } catch (e) {}
function saveWallets() { fs.writeFileSync(WALLETS_FILE, JSON.stringify(wallets, null, 2)); }

// ---------- ХРАНИЛИЩЕ НАГРАД ----------
const REWARDS_FILE = path.join(__dirname, 'rewards.json');
let rewardsDB = [];
try { if (fs.existsSync(REWARDS_FILE)) rewardsDB = JSON.parse(fs.readFileSync(REWARDS_FILE, 'utf8')); } catch (e) {}
function saveRewards() { fs.writeFileSync(REWARDS_FILE, JSON.stringify(rewardsDB, null, 2)); }

// ---------- ВИДЖЕТЫ ----------
const widgetMsgs = {};
const claimKeys = new Map();

// ---------- Telegram бот ----------
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
bot.catch((err) => console.error('Ошибка бота:', err.error || err));

// Логирование всех входящих обновлений
bot.use(async (ctx, next) => {
    console.log('Получено обновление:', JSON.stringify(ctx.update, null, 2));
    await next();
});

// ---------- Универсальный обработчик команд (поддерживает каналы) ----------
bot.use(async (ctx, next) => {
    const msg = ctx.message ?? ctx.channelPost;
    if (!msg || !msg.text || !msg.entities) return next();

    const commandEntity = msg.entities.find(e => e.type === 'bot_command' && e.offset === 0);
    if (!commandEntity) return next();

    const command = msg.text.slice(1, commandEntity.length).split('@')[0];
    const args = msg.text.slice(commandEntity.length).trim().split(/\s+/);

    // ── /start ──
    if (command === 'start') {
        try {
            await ctx.reply(
                '👋 Я Bot DiRo. Сделай ДВА простых ШАГА.\n\n' +
                'ШАГ 1. Добавь меня в администраторы твоего канала/чата, и я буду автоматически отслеживать посты и реакции!\n' +
                'ШАГ 2. В своём(ей) канале/группе привяжи кошелёк командой:\n\n' +
                '/wallet 0xТВОЙ_АДРЕС'
            );
        } catch (e) {
            console.error('Ошибка ответа на /start:', e.message);
        }
        return;
    }

    // ── /wallet ──
    if (command === 'wallet') {
        const addr = args[0];
        if (!addr) {
            await ctx.reply('⚠️ /wallet 0xТВОЙ_АДРЕС');
            return;
        }
        if (!ethers.utils.isAddress(addr)) {
            await ctx.reply('❌ Неверный адрес.');
            return;
        }

        const chatId = ctx.chat?.id;
        const chatType = ctx.chat?.type;
        const userId = ctx.from?.id;

        // Личный чат
        if (chatType === 'private') {
            wallets[userId] = addr;
            saveWallets();
            await ctx.reply('✅ Ваш личный кошелёк сохранён!');
            return;
        }

        // Канал
        if (chatType === 'channel') {
            wallets[chatId] = addr;
            saveWallets();
            await ctx.reply(`✅ Кошелёк ${addr} сохранён для этого канала!`);
            return;
        }

        // Группа / супергруппа
        try {
            const admins = await ctx.api.getChatAdministrators(chatId);
            const isAdmin = admins.some(a => a.user.id === userId);
            if (!isAdmin) {
                wallets[userId] = addr;
                saveWallets();
                await ctx.reply('✅ Ваш личный кошелёк сохранён!');
                return;
            }
        } catch (e) {
            await ctx.reply('❌ Не удалось проверить права. Убедитесь, что бот является администратором.');
            return;
        }

        wallets[chatId] = addr;
        saveWallets();
        await ctx.reply(`✅ Кошелёк ${addr} сохранён для этого чата!`);
        return;
    }

    await next();
});

// ---------- ПОКАЗАТЬ ВИДЖЕТ ----------
async function showWidget(ctx, chatId, postId, walletAddr, followers, likes, reposts) {
    const rewardEstimate = Math.floor(likes * 0.5 + followers * 0.01);
    const shortKey = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    claimKeys.set(shortKey, { postId, walletAddr });

    const text = `🦖 ~${rewardEstimate} DiRo\n❤️ ${likes} | 🔁 ${reposts} | 👥 ${followers}`;
    const replyMarkup = {
        inline_keyboard: [[
            { text: '🎁 Забрать награду', callback_data: `claim_${shortKey}` }
        ]]
    };

    try {
        if (widgetMsgs[postId]) {
            await ctx.api.editMessageText(chatId, widgetMsgs[postId], text, { reply_markup: replyMarkup });
        } else {
            const sent = await ctx.reply(text, { reply_markup: replyMarkup });
            widgetMsgs[postId] = sent.message_id;
        }
    } catch (e) { console.error('Ошибка виджета:', e.message); }
}

// ---------- ОСНОВНАЯ ФУНКЦИЯ ОБРАБОТКИ ПОСТА ----------
async function handlePost(ctx, chatId, messageId, followers, likes, reposts, authorId = null) {
    let walletAddr = null;
    if (authorId && wallets[authorId]) walletAddr = wallets[authorId];
    if (!walletAddr) walletAddr = wallets[chatId];
    if (!walletAddr) return;

    try {
        const active = await subscription.isActive(walletAddr);
        if (!active) {
            await ctx.api.sendMessage(authorId || chatId,
                '❌ Ваша подписка не активна. Приобретите подписку на сайте.'
            );
            return;
        }
    } catch (e) {
        console.error('Ошибка проверки подписки:', e.message);
        return;
    }

    const rawPostId = `${chatId}_${messageId}`;
    const postId = ethers.utils.hexZeroPad(
        ethers.utils.hexlify(ethers.utils.toUtf8Bytes(rawPostId.substring(0, 32))),
        32
    );

    const rewardEstimate = Math.floor(likes * 0.5 + followers * 0.01);

    await showWidget(ctx, chatId, postId, walletAddr, followers, likes, reposts);

    if (rewardsDB.some(r => r.postId === postId)) {
        console.log('⏭️  Награда уже сохранена для', postId);
        return;
    }

    try {
        const tx = await registry.submitMetrics(walletAddr, postId, followers, likes, reposts, {
            gasLimit: 300000,
            maxFeePerGas: ethers.utils.parseUnits('1500', 'gwei'),
            maxPriorityFeePerGas: ethers.utils.parseUnits('150', 'gwei')
        });
        console.log(`✅ Транзакция отправлена: ${tx.hash}`);

        rewardsDB.push({
            postId, walletAddr, chatId, messageId,
            followers, likes, reposts,
            timestamp: Date.now(), claimed: false, pending: true
        });
        saveRewards();

        try {
            await monitor.updateMined(walletAddr, rewardEstimate);
        } catch (e) { console.error('Ошибка updateMined:', e.message); }

        tx.wait().then(() => {
            const idx = rewardsDB.findIndex(r => r.postId === postId);
            if (idx !== -1) {
                rewardsDB[idx].pending = false;
                saveRewards();
                console.log('🎉 Транзакция подтверждена');
            }
        }).catch(e => console.error('❌ Ошибка подтверждения:', e.message));
    } catch (e) {
        console.error('❌ Ошибка отправки метрик:', e.message);
    }
}

// ---------- ОБРАБОТЧИКИ СОБЫТИЙ ----------
bot.on('channel_post', async (ctx) => {
    const post = ctx.channelPost;
    const chatId = post.chat.id;
    const messageId = post.message_id;
    const authorId = post.from?.id || chatId;
    const followers = (await ctx.api.getChat(chatId)).participants_count || 0;
    await handlePost(ctx, chatId, messageId, followers, 0, 0, authorId);
});

bot.on('message_reaction_count', async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.messageReactionCount?.message_id;
    if (!chatId || !messageId) return;
    const reactions = ctx.messageReactionCount?.reactions || [];
    const total = reactions.reduce((sum, r) => sum + (r.total_count || 0), 0);
    const followers = (await ctx.api.getChat(chatId)).participants_count || 0;
    await handlePost(ctx, chatId, messageId, followers, total, 0);
});

bot.on('message_reaction', async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.messageReaction?.message_id;
    if (!chatId || !messageId) return;
    const newR = ctx.messageReaction?.new_reactions || [];
    const oldR = ctx.messageReaction?.old_reactions || [];
    const added = newR.length - oldR.length;
    if (added <= 0) return;
    const followers = (await ctx.api.getChat(chatId)).participants_count || 0;
    await handlePost(ctx, chatId, messageId, followers, added, 0);
});

bot.on('message', async (ctx) => {
    const msg = ctx.message;
    if (!msg.chat || (msg.chat.type !== 'group' && msg.chat.type !== 'supergroup')) return;
    const authorId = msg.from.id;
    const followers = (await ctx.api.getChat(msg.chat.id)).participants_count || 0;
    await handlePost(ctx, msg.chat.id, msg.message_id, followers, 0, 0, authorId);
});

// ---------- КНОПКА "ЗАБРАТЬ НАГРАДУ" ----------
bot.on('callback_query', async (ctx) => {
    const data = ctx.callbackQuery?.data;
    if (!data?.startsWith('claim_')) return;

    const shortKey = data.slice(6);
    const info = claimKeys.get(shortKey);
    if (!info) {
        await ctx.answerCallbackQuery({ text: 'Данные устарели, попробуйте снова.' });
        return;
    }
    const { postId, walletAddr } = info;
    claimKeys.delete(shortKey);

    // Ссылка на будущий wallet.html (замените домен на свой, когда подключите)
    const claimUrl = `https://ваш-домен.onrender.com/wallet.html?postId=${encodeURIComponent(postId)}&wallet=${walletAddr}`;
    await ctx.api.sendMessage(
        ctx.from.id,
        `🦖 Чтобы забрать награду, откройте эту ссылку в браузере:\n${claimUrl}`
    );
    await ctx.answerCallbackQuery({ text: 'Ссылка отправлена в личные сообщения!' });

    const widgetMsgId = widgetMsgs[postId];
    if (widgetMsgId) {
        try { await ctx.api.deleteMessage(ctx.chat?.id, widgetMsgId); } catch (e) {}
        delete widgetMsgs[postId];
    }
});

// ---------- API ДЛЯ КОШЕЛЬКА ----------
app.get('/rewards/:walletAddr', (req, res) => {
    const addr = req.params.walletAddr.toLowerCase();
    res.json(rewardsDB.filter(r => r.walletAddr.toLowerCase() === addr && !r.claimed));
});

app.post('/mark-claimed', (req, res) => {
    const { postId } = req.body;
    const idx = rewardsDB.findIndex(r => r.postId === postId);
    if (idx !== -1) { rewardsDB.splice(idx, 1); saveRewards(); res.json({ success: true }); }
    else { res.status(404).json({ error: 'Not found' }); }
});

// ---------- WEBHOOK НАСТРОЙКА ----------
const WEBHOOK_URL = process.env.WEBHOOK_URL;

app.get('/health', (req, res) => res.send('OK'));
app.use('/webhook', webhookCallback(bot, 'express'));

async function setupWebhook() {
    if (!WEBHOOK_URL) {
        console.error('❌ WEBHOOK_URL не задан в переменных окружения!');
        process.exit(1);
    }
    try {
        await bot.api.deleteWebhook();
        await bot.api.setWebhook(WEBHOOK_URL + '/webhook');
        console.log(`✅ Вебхук установлен: ${WEBHOOK_URL}/webhook`);
    } catch (e) {
        console.error('❌ Ошибка установки вебхука:', e.message);
    }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
    await setupWebhook();
});

process.once('SIGINT', () => bot.api.deleteWebhook().then(() => process.exit(0)));
process.once('SIGTERM', () => bot.api.deleteWebhook().then(() => process.exit(0)));
