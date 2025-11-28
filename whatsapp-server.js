// --- IMPORTS ---
const express = require('express');
const cors = require('cors');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');
const qrcode = require('qrcode');
require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { initializeApp } = require('firebase/app');
const { getDatabase, ref, get, set, remove } = require('firebase/database');
const fs = require('fs');
const path = require('path');

// --- CONFIGURAÇÃO DE SESSÃO PERSISTENTE (Render / servidores similares) ---
// Tentativa de usar SESSION_PATH (se definido), senão tenta /var/data (quando disponível), por fim usa pasta dentro do projeto (__dirname)
let SESSION_BASE_PATH = process.env.SESSION_PATH || '/var/data/wwebjs_auth';
let sessionPathResolved = SESSION_BASE_PATH;

const ensureDir = (p) => {
  try {
    if (!fs.existsSync(p)) {
      fs.mkdirSync(p, { recursive: true });
    }
    // test write
    const testFile = path.join(p, `.writetest-${Date.now()}`);
    fs.writeFileSync(testFile, 'ok');
    fs.unlinkSync(testFile);
    return true;
  } catch (err) {
    return false;
  }
};

// Tenta criar/usar SESSION_PATH (/var/data etc). Se falhar, faz fallback para pasta do projeto
if (!ensureDir(SESSION_BASE_PATH)) {
  const fallback = path.join(__dirname, '.wwebjs_auth');
  console.warn(`[Sessão] Não foi possível usar SESSION_BASE_PATH="${SESSION_BASE_PATH}". Tentando fallback: ${fallback}`);
  if (!ensureDir(fallback)) {
    console.error('[Sessão] Não foi possível criar diretório de sessão nem no fallback. Continue com cuidado.');
  } else {
    sessionPathResolved = fallback;
    console.log(`[Sessão] Diretório de sessão persistente criado em (fallback): ${sessionPathResolved}`);
  }
} else {
  console.log(`[Sessão] Diretório de sessão persistente: ${sessionPathResolved}`);
}

// --- VALIDAÇÃO DE VARIÁVEIS DE AMBIENTE ---
const requiredEnvVars = [
  'GEMINI_API_KEY',
  'FIREBASE_API_KEY',
  'FIREBASE_AUTH_DOMAIN',
  'FIREBASE_DATABASE_URL',
  'FIREBASE_PROJECT_ID',
  'FIREBASE_STORAGE_BUCKET',
  'FIREBASE_MESSAGING_SENDER_ID',
  'FIREBASE_APP_ID',
];

const missingEnvVars = requiredEnvVars.filter(envVar => !process.env[envVar]);

if (missingEnvVars.length > 0) {
  console.error('[ERRO CRÍTICO] Variáveis de ambiente essenciais não encontradas:');
  missingEnvVars.forEach(v => console.error(`- ${v}`));
  console.error('\nConfigure-as no seu ambiente ou no arquivo .env.\n');
  process.exit(1);
}

// --- CONFIGURAÇÃO DO FIREBASE ---
const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  databaseURL: process.env.FIREBASE_DATABASE_URL,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.FIREBASE_APP_ID,
};
const firebaseApp = initializeApp(firebaseConfig);
const database = getDatabase(firebaseApp);

// --- CONFIGURAÇÃO DO EXPRESS ---
const app = express();
const port = process.env.PORT || 3001;

const allowedOrigins = [
  'https://www.jataifood.com.br',
  'https://jataifood.com.br',
  'https://jatai-food-backend.onrender.com',
  'http://localhost:5173',
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1) callback(null, true);
    else {
      console.log(`[CORS] Origem bloqueada: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-Requested-With'],
  credentials: true,
  optionsSuccessStatus: 200,
  preflightContinue: false
}));

app.options('*', cors());
app.use(express.json());

// --- ARMAZENAMENTO DE SESSÕES ---
const sessions = {};            // { sessionId: { client, status, qrAttempts } }
const sessionModels = {};       // modelos Gemini por sessionId
const userChats = {};           // userChats[sessionId] = { chatId: ChatSession }
const activeInitializations = {}; // Promise lock por sessionId
const reconnectionAttempts = {};
const startRequestTimestamps = {};

// --- FUNÇÕES AUXILIARES ---
const createSystemInstruction = (config) => `
  Você é o assistente virtual do restaurante ${config.restaurantName || 'do nosso restaurante'}! Seu nome é Jataí.
  Sua personalidade é super divertida, animada e simpática! Use emojis para deixar a conversa mais legal. 🥳🍕✨
  Sua mensagem de boas-vindas é: "${config.welcomeMessage || 'Olá! Como posso te ajudar?'}"
  Sua missão é ajudar os clientes com um sorriso no rosto (virtual, claro!). Use as informações abaixo para responder:
  - Horário de funcionamento: ${config.hours || 'Não informado'}
  - Endereço (se perguntarem onde fica): ${config.address || 'Não informado'}
  - Link do Cardápio e Pedidos: ${config.menuUrl || 'Não informado'}
  - Telefone de contato: ${config.phoneNumber || 'Não informado'}
  IMPORTANTE: Ao enviar o link do cardápio, envie apenas a URL, sem formatação de link ou markdown. Por exemplo: https://seusite.com/cardapio
  NUNCA invente informações. Se não souber algo, diga algo como: "Opa, essa pergunta me pegou! Vou chamar um humano pra te ajudar, só um minutinho! 🧑‍🍳"
`;

// Helper: espera X ms
const wait = ms => new Promise(r => setTimeout(r, ms));

// Função de limpeza de sessão (melhorada)
// IMPORTANT: agora usa sessionPathResolved para remover auth quando for necessário
const cleanupSession = async (sessionId, forceRemoveAuth = false) => {
  console.log(`[Sessão ${sessionId}] 🧹 Limpando sessão... (Remover Auth: ${forceRemoveAuth})`);
  const client = sessions[sessionId] ? sessions[sessionId].client : null;

  try {
    await remove(ref(database, `tenants/${sessionId}/session`)); // Limpa o status no Firebase
  } catch (e) { /* Ignora erros se já não existir */ }

  if (client) {
    try {
      try { client.removeAllListeners(); } catch (e) {}
      await client.destroy();
    } catch (error) {
      console.error(`[Sessão ${sessionId}] Erro ao destruir cliente:`, error);
    }
    delete sessions[sessionId];
  }

  // limpa modelo IA e chats apenas da sessão afetada
  delete sessionModels[sessionId];
  if (userChats[sessionId]) delete userChats[sessionId];

  console.log(`[Sessão ${sessionId}] Modelo de IA e sessão local limpos.`);

  // remover arquivos de autenticação SOMENTE do caminho persistente configurado
  if (forceRemoveAuth) {
    try {
      const sessionFolderPath = path.join(sessionPathResolved, `session-${sessionId}`);
      if (fs.existsSync(sessionFolderPath)) {
        fs.rmSync(sessionFolderPath, { recursive: true, force: true });
        console.log(`[Sessão ${sessionId}] Pasta da sessão removida FORÇADAMENTE: ${sessionFolderPath}`);
      } else {
        console.log(`[Sessão ${sessionId}] Pasta da sessão não encontrada para remoção: ${sessionFolderPath}`);
      }
    } catch (err) {
      console.error(`[Sessão ${sessionId}] Erro ao remover a pasta da sessão:`, err);
    }
  }
};

const attachLifecycleListeners = (client, sessionId) => {
  const sessionRef = ref(database, `tenants/${sessionId}/session`);

  client.once('qr', async (qr) => {
    try {
      const snapshot = await get(sessionRef);
      const firebaseStatus = snapshot.exists() ? snapshot.val().status : 'disconnected';
      if (sessions[sessionId]?.status === 'ready' || firebaseStatus === 'ready') {
        console.log(`[Sessão ${sessionId}] ⚠️ Evento 'qr' recebido, mas a sessão já está 'ready'. Ignorando para evitar loop de reconexão.`);
        return;
      }
      sessions[sessionId].qrAttempts = (sessions[sessionId].qrAttempts || 0) + 1;
      console.log(`[Sessão ${sessionId}] QR Code gerado (Tentativa ${sessions[sessionId].qrAttempts}).`);
      const qrUrl = await qrcode.toDataURL(qr);
      await set(sessionRef, { status: 'QR_CODE', qr: qrUrl, attempt: sessions[sessionId].qrAttempts });
      sessions[sessionId].status = 'QR_CODE';
    } catch (err) {
      console.error(`[Sessão ${sessionId}] Erro no handler 'qr':`, err);
    }
  });

  client.once('authenticated', () => {
    console.log(`[Sessão ${sessionId}] ✅ Autenticado com sucesso!`);
  });

  client.once('ready', async () => {
    try {
      console.log(`[Sessão ${sessionId}] ✅ Cliente conectado e pronto!`);
      await set(sessionRef, { status: 'ready', connectedAt: new Date().toISOString() });
      if (sessions[sessionId]) {
        sessions[sessionId].status = 'ready';
        sessions[sessionId].qrAttempts = 0;
      }
      try { await remove(ref(database, `tenants/${sessionId}/session/qr`)); } catch(_) {}
      reconnectionAttempts[sessionId] = 0;
    } catch (e) {
      console.error(`[Sessão ${sessionId}] Erro no handler 'ready':`, e);
    }
  });

  client.on('message', async (message) => {
    if (message.fromMe) return;
    const chatId = message.from;
    console.log(`[Sessão ${sessionId}] 📩 Mensagem de ${chatId}: "${message.body}"`);
    try {
      const configRef = ref(database, `tenants/${sessionId}/whatsappConfig`);
      const snapshot = await get(configRef);
      const config = snapshot && snapshot.exists() ? snapshot.val() : {};
      if (config && config.isActive === false) {
        console.log(`[Sessão ${sessionId}] Assistente desativado. Ignorando.`);
        return;
      }

      if (!sessionModels[sessionId]) {
        const systemInstruction = createSystemInstruction(config || {});
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        // Modelo padrão atualizado para versão compatível
        const modelName = process.env.GEMINI_MODEL_NAME || "gemini-2.0-flash";
        const model = genAI.getGenerativeModel({ model: modelName, systemInstruction });
        sessionModels[sessionId] = model;
      }

      if (!userChats[sessionId]) {
        userChats[sessionId] = {};
      }
      if (!userChats[sessionId][chatId]) {
        console.log(`[Sessão ${sessionId}] Iniciando novo chat para o usuário ${chatId}.`);
        userChats[sessionId][chatId] = sessionModels[sessionId].startChat({ history: [] });
      }

      const chat = userChats[sessionId][chatId];
      const result = await chat.sendMessage(message.body);
      const response = await result.response;
      const text = response.text();

      try {
        await message.reply(text);
      } catch (replyError) {
        console.error(`[Sessão ${sessionId}] ❌ Erro ao enviar resposta (message.reply):`, replyError);
      }

    } catch (error) {
      console.error(`[Sessão ${sessionId}] ❌ Erro ao processar mensagem (IA):`, error);
      try { await message.reply('Desculpe, não consegui processar sua solicitação no momento. 😔'); } catch (_) {}
    }
  });

  client.once('disconnected', async (reason) => {
    console.log(`[Sessão ${sessionId}] ❌ Cliente desconectado. Razão: ${reason}`);
    const normalizedReason = (reason || '').toString().toUpperCase();

    if (normalizedReason === 'LOGOUT') {
      console.log(`[Sessão ${sessionId}] 🔴 LOGOUT detectado - limpeza completa necessária.`);
      await cleanupSession(sessionId, true);
      await set(sessionRef, { status: 'logged_out', lastReason: reason, disconnectedAt: new Date().toISOString(), requiresReauth: true });
      return;
    }

    // transient reasons (connection lost etc.) -> não remove auth, apenas reinicia instância
    if (normalizedReason.includes('CONNECTION') || normalizedReason.includes('NAVIGATION') || normalizedReason.includes('TIMEOUT')) {
      console.log(`[Sessão ${sessionId}] ⚠️ Desconexão transitória (${reason}). Limpando instância em memória para futura reconexão.`);
      reconnectionAttempts[sessionId] = (reconnectionAttempts[sessionId] || 0) + 1;
      await cleanupSession(sessionId, false);
      await set(sessionRef, { status: 'disconnected', lastReason: reason, disconnectedAt: new Date().toISOString() });
      return;
    }

    // motivos destrutivos detectados
    const destructiveReasons = ['AUTHENTICATION_FAILED', 'CHANGE_IN_CACHE', 'UNPAIRED', 'MULTI_DEVICE_LOGOUT'];
    if (destructiveReasons.includes(normalizedReason)) {
      console.log(`[Sessão ${sessionId}] Motivo destrutivo (${reason}) - realizando limpeza com remoção de auth.`);
      await cleanupSession(sessionId, true);
      await set(sessionRef, { status: 'error', lastReason: reason, disconnectedAt: new Date().toISOString() });
      return;
    }

    // fallback: limpar instância em memória
    console.log(`[Sessão ${sessionId}] Desconexão sem classificação específica (${reason}). Limpando apenas instância.`);
    await cleanupSession(sessionId, false);
    await set(sessionRef, { status: 'disconnected', lastReason: reason, disconnectedAt: new Date().toISOString() });
  });

  client.once('auth_failure', async (msg) => {
    console.error(`[Sessão ${sessionId}] ❌ Falha na autenticação:`, msg);
    await set(sessionRef, { status: 'AUTH_FAILURE', error: msg });
    await cleanupSession(sessionId, true);
  });
};

// --- Inicialização do WhatsApp Client (robusta) ---
const initializeWhatsAppClient = async (sessionId, opts = {}) => {
  if (activeInitializations[sessionId]) { // Lock principal baseado em Promise
    console.log(`[Sessão ${sessionId}] 🔁 Inicialização já em andamento - aguardando resultado existente.`);
    return activeInitializations[sessionId];
  }

  const initPromise = (async () => {
    if (sessions[sessionId] && sessions[sessionId].status === 'ready' && sessions[sessionId].client) {
      try {
        const state = await sessions[sessionId].client.getState();
        if (state === 'CONNECTED') {
          console.log(`[Sessão ${sessionId}] ✅ Cliente já conectado (memória).`);
          return sessions[sessionId];
        }
      } catch (e) {
        console.log(`[Sessão ${sessionId}] ⚠️ Cliente em memória inacessível: ${e.message}. Seguindo com reinitialização.`);
        try { await sessions[sessionId].client.destroy(); } catch (_) {}
        delete sessions[sessionId];
      }
    }

    let client = sessions[sessionId] ? sessions[sessionId].client : null;
    if (!client) {
      // Configura LocalAuth para gravar no diretório persistente configurado
      client = new Client({
        authStrategy: new LocalAuth({
          clientId: sessionId,
          dataPath: sessionPathResolved
        }),
        puppeteer: {
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu',
            '--disable-software-rasterizer',
            '--disable-extensions',
            '--disable-features=IsolateOrigins,site-per-process',
            '--disable-blink-features=AutomationControlled'
          ],
          headless: true,
        },
      });
      console.log(`[Sessão ${sessionId}] 🆕 Criando nova instância do cliente e anexando listeners.`);
      attachLifecycleListeners(client, sessionId);
    }
    sessions[sessionId] = { client, status: 'INITIALIZING', qrAttempts: 0 };

    const MAX_INIT_ATTEMPTS = 2;
    let attempt = 0;
    while (attempt < MAX_INIT_ATTEMPTS) {
      attempt++;
      try {
        console.log(`[Sessão ${sessionId}] 🚀 Inicializando cliente (tentativa ${attempt}/${MAX_INIT_ATTEMPTS})...`);
        await client.initialize();
        // A promessa só resolve aqui, após o sucesso da inicialização.
        return sessions[sessionId];
      } catch (err) {
        console.error(`[Sessão ${sessionId}] ❌ Erro na inicialização (tentativa ${attempt}):`, err && err.message ? err.message : err);

        if (attempt < MAX_INIT_ATTEMPTS) {
          const backoff = 2000 * attempt;
          console.log(`[Sessão ${sessionId}] Aguardando ${backoff}ms antes de nova tentativa de inicialização.`);
          await wait(backoff);
        } else {
          console.error(`[Sessão ${sessionId}] ❌ Excedeu número máximo de tentativas de inicialização. Limpando para permitir nova tentativa manual.`);
          // Limpa apenas a instância (não o auth) — evita perder sessão armazenada no disco por engano
          await cleanupSession(sessionId, false);
          throw new Error('Initialization failed');
        }
      }
    }
  })();

  activeInitializations[sessionId] = initPromise;

  try {
    const res = await initPromise;
    return res;
  } finally { // Garante que o lock seja liberado, aconteça o que acontecer.
    delete activeInitializations[sessionId];
  }
};

// --- ROTAS DA API ---
app.get('/health', (req, res) => {
  const healthInfo = {
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: {
      used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
      total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + 'MB'
    },
    activeSessions: Object.keys(sessions).length,
    environment: process.env.NODE_ENV || 'development',
    sessionPath: sessionPathResolved
  };
  console.log('[Health Check] Status:', healthInfo);
  res.status(200).json(healthInfo);
});

app.get('/api/whatsapp/status/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  try {
    const statusRef = ref(database, `tenants/${sessionId}/session/status`);
    const snapshot = await get(statusRef);
    const status = snapshot.exists() ? snapshot.val() : 'disconnected';
    res.json({ status });
  } catch (error) {
    console.error(`[Status ${sessionId}] Erro:`, error);
    res.status(500).json({ status: 'disconnected', message: 'Erro ao buscar status.' });
  }
});

app.get('/api/whatsapp/qr/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  try {
    const qrRef = ref(database, `tenants/${sessionId}/session/qr`);
    const snapshot = await get(qrRef);
    if (snapshot.exists()) {
      res.status(200).json({ qr: snapshot.val() });
    } else {
      res.status(200).json({ qr: null, message: 'QR code ainda não gerado ou já utilizado.' });
    }
  } catch (error) {
    console.error(`[QR ${sessionId}] Erro:`, error);
    res.status(500).json({ error: 'Erro ao buscar QR code.', qr: null });
  }
});

// Rota start atualizada: não seta lock aqui — initializeWhatsAppClient gerencia locks
app.post('/api/whatsapp/start/:sessionId', async (req, res) => {
  const { sessionId } = req.params;

  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
  const forwardedFor = req.headers['x-forwarded-for'] || req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
  const userAgent = req.headers['user-agent'] || 'unknown';
  console.log(`[${requestId}] [Sessão ${sessionId}] 📥 Recebida requisição para iniciar. from=${forwardedFor} ua="${userAgent}"`);

  // RATE LIMITING: Prevenir múltiplas requisições do frontend
  const now = Date.now();
  const DEBOUNCE_WINDOW = 10000; // 10 segundos
  
  if (startRequestTimestamps[sessionId]) {
    const timeSinceLastRequest = now - startRequestTimestamps[sessionId];
    if (timeSinceLastRequest < DEBOUNCE_WINDOW) {
      const waitTime = Math.ceil((DEBOUNCE_WINDOW - timeSinceLastRequest) / 1000);
      console.log(`[${requestId}] [Sessão ${sessionId}] ⏱️ Requisição duplicada ignorada (${timeSinceLastRequest}ms desde última).`);
      return res.status(429).json({ 
        success: false, 
        message: `Aguarde ${waitTime} segundos antes de tentar novamente.`,
        retryAfter: waitTime
      });
    }
  }
  
  startRequestTimestamps[sessionId] = now;

  const sessionRef = ref(database, `tenants/${sessionId}/session`);
  let snapshot;
  try { snapshot = await get(sessionRef); } catch (err) { snapshot = null; }
  const firebaseStatus = snapshot && snapshot.exists() ? snapshot.val().status : 'disconnected';

  // Verificar TANTO Firebase QUANTO memória
  if (firebaseStatus === 'ready' && sessions[sessionId]) {
    try {
      const state = await sessions[sessionId].client.getState();
      if (state === 'CONNECTED') {
        console.log(`[${requestId}] [Sessão ${sessionId}] ✅ Cliente realmente conectado.`);
        return res.status(200).json({ success: true, message: 'Sessão já conectada.' });
      } else {
        console.log(`[${requestId}] [Sessão ${sessionId}] ⚠️ Firebase diz 'ready' mas cliente está ${state}. Reiniciando.`);
        await cleanupSession(sessionId, false);
      }
    } catch (e) {
      console.log(`[${requestId}] [Sessão ${sessionId}] ⚠️ Erro ao verificar estado: ${e.message}. Reiniciando.`);
      await cleanupSession(sessionId, false);
    }
  } else if (firebaseStatus === 'ready' && !sessions[sessionId]) {
    console.log(`[${requestId}] [Sessão ${sessionId}] ⚠️ Firebase diz 'ready' mas sessão não existe em memória. Reiniciando.`);
    await cleanupSession(sessionId, false);
  }

  if (activeInitializations[sessionId]) {
    console.log(`[${requestId}] [Sessão ${sessionId}] 🔁 Inicialização já em andamento - vinculando à promessa existente.`);
    return res.status(202).json({ success: true, message: 'Sessão em inicialização. Aguarde (já existe uma inicialização em andamento).' });
  }

  console.log(`[${requestId}] [Sessão ${sessionId}] 🔔 Iniciando initializeWhatsAppClient...`);
  initializeWhatsAppClient(sessionId)
    .then(() => console.log(`[${requestId}] [Sessão ${sessionId}] Inicialização concluída (promessa resolvida).`))
    .catch(err => {
      console.error(`[${requestId}] [Sessão ${sessionId}] ❌ Falha na inicialização (promessa rejeitada):`, err && err.message ? err.message : err);
    });

  return res.status(202).json({ success: true, message: 'Inicialização iniciada — QR será disponibilizado no Firebase.', requestId });
});

app.post('/api/whatsapp/stop/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const session = sessions[sessionId];

  if (session && session.client) {
    console.log(`[Sessão ${sessionId}] 🛑 Recebida requisição para parar.`);
    try {
      await session.client.logout();
      await cleanupSession(sessionId, true);
      res.status(200).json({ success: true, message: `Sessão ${sessionId} desconectada.` });
    } catch (error) {
      console.error(`[Sessão ${sessionId}] Erro ao fazer logout:`, error);
      res.status(500).json({ success: false, error: 'Erro ao desconectar.' });
    }
  } else {
    try { await set(ref(database, `tenants/${sessionId}/session/status`), 'disconnected'); } catch(_) {}
    res.status(404).json({ success: false, error: `Sessão ${sessionId} não encontrada ou já inativa.` });
  }
});

app.post('/api/config/update/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const newConfig = req.body;

  if (!newConfig || Object.keys(newConfig).length === 0) {
    return res.status(400).json({ success: false, error: 'Nenhum dado fornecido.' });
  }
  try {
    const configRef = ref(database, `tenants/${sessionId}/whatsappConfig`);
    await set(configRef, newConfig);
    delete sessionModels[sessionId]; // Invalida o modelo de IA para ser recriado com a nova config
    if (userChats[sessionId]) delete userChats[sessionId];
    console.log(`[Sessão ${sessionId}] ⚙️ Configurações atualizadas.`);
    res.status(200).json({ success: true, message: 'Configurações atualizadas.' });
  } catch (error) {
    console.error(`[Config ${sessionId}] Erro ao salvar:`, error);
    res.status(500).json({ success: false, error: 'Erro ao salvar a configuração.' });
  }
});

// --- PROTEÇÕES GLOBAIS ---
process.on('unhandledRejection', (reason, p) => {
  console.error('Unhandled Rejection at:', p, 'reason:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception thrown:', err);
});

// --- INICIALIZAÇÃO DO SERVIDOR ---
app.listen(port, () => {
  console.log(`🚀 Servidor rodando em http://localhost:${port}`);
  console.log('📱 Aguardando requisições para iniciar sessões do WhatsApp...');
}); 
