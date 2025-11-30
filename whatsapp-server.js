// --- IMPORTS ---
const express = require('express');
const cors = require('cors');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { initializeApp } = require('firebase/app');
const { getDatabase, ref, get, set, remove } = require('firebase/database');
const fs = require('fs');
const path = require('path');

// --- CONFIG DIRETÓRIO DE SESSÃO (padrão Railway: /data) ---
let SESSION_BASE_PATH = process.env.SESSION_PATH || '/data/wwebjs_auth';
let sessionPathResolved = SESSION_BASE_PATH;

const ensureDir = (p) => {
  try {
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
    // quick write test
    const testFile = path.join(p, `.writetest-${Date.now()}`);
    fs.writeFileSync(testFile, 'ok');
    fs.unlinkSync(testFile);
    return true;
  } catch (err) {
    console.warn(`[SESSION] Não foi possível usar "${p}": ${err.message}`);
    return false;
  }
};

if (!ensureDir(SESSION_BASE_PATH)) {
  const fallback = path.join(__dirname, '.wwebjs_auth');
  if (ensureDir(fallback)) {
    sessionPathResolved = fallback;
    console.log(`[SESSION] Usando fallback: ${sessionPathResolved}`);
  } else {
    console.error('[SESSION] Não foi possível criar diretório de sessão nem no fallback.');
  }
}

// --- VALIDAR ENV (apenas loga variáveis faltantes) ---
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
const missingEnv = requiredEnvVars.filter(v => !process.env[v]);
if (missingEnv.length) {
  console.warn('[ENV] Variáveis de ambiente faltando (verifique .env):', missingEnv);
  // não encerra automaticamente — deixa o dev decidir
}

// --- FIREBASE ---
const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY || '',
  authDomain: process.env.FIREBASE_AUTH_DOMAIN || '',
  databaseURL: process.env.FIREBASE_DATABASE_URL || '',
  projectId: process.env.FIREBASE_PROJECT_ID || '',
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET || '',
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || '',
  appId: process.env.FIREBASE_APP_ID || '',
};
const firebaseApp = initializeApp(firebaseConfig);
const database = getDatabase(firebaseApp);

// --- EXPRESS ---
const app = express();
const port = process.env.PORT || 3001;
// Ajuste CORS: em produção, substitua '*' pela lista de origens
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json());

// --- ESTADO EM MEMÓRIA ---
/*
 sessions[sessionId] = {
   client: <whatsapp client>,
   status: 'INITIALIZING'|'qr'|'ready'|'disconnected',
   qrAttempts: number,
   reconnectAttempts: number,
   lockCleanup: boolean,
   reconnectTimerId: Timeout|null
 }
*/
const sessions = {};
const sessionModels = {}; // para IA (se usado)
const userChats = {};
const activeInitializations = {};

// --- UTILS ---
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const MAX_RECONNECT_ATTEMPTS = 4;
const RECONNECT_BASE_DELAY = 2000; // ms

// --- SYSTEM INSTRUCTION IA (opcional) ---
const createSystemInstruction = (cfg) => `
Você é o assistente do restaurante ${cfg.restaurantName || 'Restaurante'}.
Seja claro, rápido e educado.
Cardápio: ${cfg.menuUrl || 'não informado'}
Horário: ${cfg.hours || 'não informado'}
Endereço: ${cfg.address || 'não informado'}
Telefone: ${cfg.phoneNumber || 'não informado'}
`;

// --- FUNÇÃO: gravar status/qr no Firebase (path: sessions/{sessionId}/session) ---
const writeSessionStatusToDB = async (sessionId, payload) => {
  try {
    await set(ref(database, `sessions/${sessionId}/session`), payload);
  } catch (e) {
    console.warn(`[DB ${sessionId}] Erro ao escrever status no DB:`, e.message || e);
  }
};

// --- CLEANUP DE SESSÃO (seguro, não reentrante) ---
const cleanupSession = async (sessionId, removeAuthFiles = false) => {
  if (!sessions[sessionId]) {
    // ainda tentar remover arquivos se solicitado
    if (removeAuthFiles) {
      try {
        const folder = path.join(sessionPathResolved, sessionId);
        if (fs.existsSync(folder)) fs.rmSync(folder, { recursive: true, force: true });
        console.log(`[${sessionId}] Pasta de auth removida (forçado).`);
      } catch (err) {
        console.warn(`[${sessionId}] Falha ao remover pasta de auth:`, err.message || err);
      }
    }
    return;
  }

  if (sessions[sessionId].lockCleanup) {
    console.log(`[${sessionId}] cleanup já em andamento — ignorando segunda chamada.`);
    return;
  }
  sessions[sessionId].lockCleanup = true;
  console.log(`[${sessionId}] 🧹 Limpando sessão...`);

  try {
    const s = sessions[sessionId];
    if (s.reconnectTimerId) {
      clearTimeout(s.reconnectTimerId);
      s.reconnectTimerId = null;
    }

    if (s.client) {
      try {
        // tenta logout primeiro (para marcar como deslogado)
        try { await s.client.logout(); } catch (_) { /* ignorar */ }
        // depois destrói internamente
        try { await s.client.destroy(); } catch (_) { /* ignorar */ }
      } catch (e) {
        console.warn(`[${sessionId}] Erro ao encerrar client:`, e.message || e);
      }
    }

    // atualiza DB
    await writeSessionStatusToDB(sessionId, { status: 'logged_out' });

    // remove do memory
    delete sessions[sessionId];
    delete sessionModels[sessionId];
    delete userChats[sessionId];

    // opcional: remover pasta auth se quiser forçar re-login
    if (removeAuthFiles) {
      try {
        const folder = path.join(sessionPathResolved, sessionId);
        if (fs.existsSync(folder)) fs.rmSync(folder, { recursive: true, force: true });
        console.log(`[${sessionId}] Pasta de auth removida.`);
      } catch (err) {
        console.warn(`[${sessionId}] Falha ao remover pasta auth:`, err.message || err);
      }
    }

    console.log(`[${sessionId}] 🧽 Limpeza concluída.`);
  } catch (err) {
    console.error(`[${sessionId}] Erro cleanup:`, err.message || err);
  } finally {
    // garante liberação do lock
    if (sessions[sessionId]) sessions[sessionId].lockCleanup = false;
  }
};

// --- ATTACH LISTENERS (isolado por client) ---
const attachLifecycleListeners = (sessionId, client, initializationPromise) => {
  const sessionRef = ref(database, `sessions/${sessionId}/session`);

  let qrAttempts = 0;
  let readyDetected = false;
  
  // CORREÇÃO: Validar que a promise foi passada corretamente
  if (!initializationPromise || !initializationPromise.resolve) {
    console.error(`[${sessionId}] Erro: initializationPromise não foi passada corretamente aos listeners`);
    return;
  }

  client.on('qr', async (qr) => {
    try {
      qrAttempts++;
      const qrUrl = await qrcode.toDataURL(qr);

      // marca status e qr no DB; não removemos automaticamente
      await set(sessionRef, {
        status: 'qr',
        qr: qrUrl,
        attempt: qrAttempts,
        updatedAt: Date.now()
      });

      // grava no memory também
      if (!sessions[sessionId]) sessions[sessionId] = {};
      sessions[sessionId].status = 'qr';
      sessions[sessionId].lastQr = qrUrl;
      sessions[sessionId].qrAttempts = qrAttempts;

      console.log(`[${sessionId}] 📲 QR gerado (attempt ${qrAttempts})`);
      // CORREÇÃO: Resolver a promise de inicialização com o QR gerado
      if (initializationPromise && initializationPromise.resolve) {
        initializationPromise.resolve(sessions[sessionId]);
      }
    } catch (e) {
      console.error(`[${sessionId}] Erro handler 'qr':`, e.message || e);
    }
  });

  client.on('authenticated', async () => {
    console.log(`[${sessionId}] 🔐 Autenticado.`);
    // opcional: marcar no DB
    await set(sessionRef, { status: 'authenticated', updatedAt: Date.now() });
  });

  client.on('ready', async () => {
    try {
      readyDetected = true;
      console.log(`[${sessionId}] ✅ Cliente pronto (ready).`);

      // marca no DB e remove qr (frontend deve passar para status ready)
      await set(sessionRef, { status: 'ready', updatedAt: Date.now() });

      if (sessions[sessionId]) {
        sessions[sessionId].status = 'ready';
        sessions[sessionId].qrAttempts = 0;
        sessions[sessionId].lastActivity = Date.now();
        // Zera tentativas de reconexão no sucesso
        sessions[sessionId].reconnectAttempts = 0;
      }
      
      // CORREÇÃO: Resolver a promise de inicialização quando cliente fica ready
    } catch (e) {
      console.error(`[${sessionId}] Erro handler 'ready':`, e.message || e);
    }
  });

  client.on('auth_failure', async (msg) => {
    console.warn(`[${sessionId}] auth_failure:`, msg);
    await set(sessionRef, { status: 'auth_failure', updatedAt: Date.now() });
    // tenta cleanup e reconectar levemente
    await cleanupSession(sessionId, false);
    // reconectar
    if (!sessions[sessionId]) {
      setTimeout(() => initializeWhatsAppClient(sessionId), 2000);
    }
  });

  client.on('disconnected', async (reason) => {
    console.log(`[${sessionId}] ❌ Desconectado: ${reason}`);

    // Se a razão for 'LOGOUT' ou 'NAVIGATION' (conflito de sessão), limpamos permanentemente.
    if (String(reason).toUpperCase() === 'LOGOUT' || reason === 'NAVIGATION') {
      console.log(`[${sessionId}] Logout ou conflito detectado. Limpando sessão permanentemente.`);
      await set(sessionRef, { status: 'logged_out', reason: String(reason) });
      await cleanupSession(sessionId, true); // O 'true' remove os arquivos de autenticação.
      return;
    }

    // Para outras razões (ex: queda de rede), tentamos reconectar.
    await writeSessionStatusToDB(sessionId, { status: 'disconnected', reason: String(reason), updatedAt: Date.now() });

    // Tenta reconectar com backoff exponencial
    const attempts = (sessions[sessionId]?.reconnectAttempts || 0);
    if (attempts < MAX_RECONNECT_ATTEMPTS) {
      const delay = RECONNECT_BASE_DELAY * Math.pow(2, attempts);
      console.log(`[${sessionId}] Tentando reconectar em ${delay}ms (attempt ${attempts + 1})`);
      await cleanupSession(sessionId, false);
      const timerId = setTimeout(() => {
        initializeWhatsAppClient(sessionId, true).catch(err => console.error(`[${sessionId}] Reconnect fail:`, err));
      }, delay);

      // store reconnect attempts and timer (if session object exists)
      sessions[sessionId] = sessions[sessionId] || {};
      sessions[sessionId].reconnectAttempts = attempts + 1;
      sessions[sessionId].reconnectTimerId = timerId;
    } else {
      console.warn(`[${sessionId}] Máximo de tentativas de reconexão atingido.`);
      await cleanupSession(sessionId, true); // Limpa permanentemente após falhar várias vezes.
      await set(sessionRef, { status: 'disconnected_permanent', updatedAt: Date.now() });
    }
  });

  client.on('message', async (message) => {
    if (message.fromMe) return;
    try {
      const chatId = message.from;
      console.log(`[${sessionId}] 📩 Mensagem de ${chatId}: "${message.body}"`);

      // --- LÓGICA DA IA ---
      const configSnap = await get(ref(database, `tenants/${sessionId}/whatsappConfig`));
      const config = configSnap.exists() ? configSnap.val() : {};

      // Inicializa o modelo da IA para a sessão, se ainda não existir
      if (!sessionModels[sessionId]) {
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const modelName = process.env.GEMINI_MODEL_NAME || "gemini-2.5-flash"; // CORREÇÃO: Usando modelo válido
        const systemInstruction = createSystemInstruction(config);

        sessionModels[sessionId] = genAI.getGenerativeModel({
          model: modelName,
          systemInstruction,
        });
      }

      // Inicia um novo chat para o usuário, se for a primeira mensagem
      if (!userChats[sessionId]) userChats[sessionId] = {};
      if (!userChats[sessionId][chatId]) {
        userChats[sessionId][chatId] = sessionModels[sessionId].startChat({ history: [] });
      }

      // Envia a mensagem para a IA e obtém a resposta
      const chat = userChats[sessionId][chatId];
      const result = await chat.sendMessage(message.body);
      const text = result.response.text();

      // Envia a resposta da IA de volta para o usuário no WhatsApp
      await message.reply(text);

      if (sessions[sessionId]) {
        sessions[sessionId].lastActivity = Date.now();
      }
    } catch (e) {
      console.error(`[${sessionId}] Erro no handler 'message' (IA):`, e.message || e);
      try {
        await message.reply('Desculpe, não consegui processar sua mensagem no momento. 🤖');
      } catch (replyErr) {
        console.error(`[${sessionId}] Erro ao enviar mensagem de erro:`, replyErr);
      }
    }
  });
};

// --- INITIALIZE CLIENT ---
const initializeWhatsAppClient = async (sessionId, isReconnect = false) => {
  if (activeInitializations[sessionId]) {
    console.log(`[${sessionId}] Inicialização já em andamento. Abortando nova tentativa.`);
    return activeInitializations[sessionId];
  }

  let resolve, reject;
  const initializationPromise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Adiciona as funções de resolução/rejeição à promise para uso nos listeners
  initializationPromise.resolve = resolve;
  initializationPromise.reject = reject;

  activeInitializations[sessionId] = initializationPromise;
  console.log(`[${sessionId}] 🚀 Iniciando sessão WhatsApp... (lock adquirido)`);

  (async () => {
    try {
      if (sessions[sessionId]) {
        await cleanupSession(sessionId, false);
      }

      const authDir = path.join(sessionPathResolved, sessionId);
      ensureDir(authDir);

      const client = new Client({
        authStrategy: new LocalAuth({ clientId: sessionId, dataPath: authDir }),
        puppeteer: {
          headless: true, // Mantenha como true em produção
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
          ]
        }
      });

      sessions[sessionId] = sessions[sessionId] || {};
      sessions[sessionId].client = client;
      sessions[sessionId].status = 'INITIALIZING';
      if (!isReconnect) sessions[sessionId].reconnectAttempts = 0;

      // CORREÇÃO: Passar a promise de inicialização aos listeners
      attachLifecycleListeners(sessionId, client, initializationPromise);

      await client.initialize(); // Inicia o Puppeteer
      // O log de "concluído" agora é implícito pela geração do QR ou pelo status 'ready'
    } catch (err) {
      console.error(`[${sessionId}] Falha ao inicializar client:`, err.message || err);
      await cleanupSession(sessionId, false);
      reject(err);
    } finally {
      delete activeInitializations[sessionId];
      console.log(`[${sessionId}] Lock de inicialização liberado.`);
    }
  })();

  return activeInitializations[sessionId]; // Retorna a promise que será resolvida pelos listeners
};

// ----------------- ROTAS -----------------

// HEALTH
app.get('/health', (req, res) => {
  res.json({ status: 'OK', time: new Date().toISOString(), sessions: Object.keys(sessions).length });
});

// STATUS (Opção A) -> retorna { status: 'qr'|'ready'|'initializing'|'disconnected', qr?: dataURL }
app.get('/api/whatsapp/status/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  try {
    // prioridade: estado no memory se cliente ready
    const s = sessions[sessionId];
    if (s && s.client && s.client.info && s.client.info.wid) {
      return res.json({ status: 'ready' });
    }

    // fallback: ler do Firebase (onde gravamos status e QR)
    const snap = await get(ref(database, `sessions/${sessionId}/session`));
    if (!snap.exists()) {
      return res.json({ status: 'disconnected' });
    }
    const data = snap.val();
    // Retorna exatamente o que está salvo: { status, qr, attempt, ... }
    return res.json(data);
  } catch (e) {
    console.error(`[STATUS ${sessionId}] Erro:`, e.message || e);
    res.status(500).json({ status: 'error', error: e.message || e });
  }
});

// ROTA ESPECÍFICA PARA PEGAR QR (opcional)
app.get('/api/whatsapp/qr/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  try {
    const snap = await get(ref(database, `sessions/${sessionId}/session`));
    if (!snap.exists()) return res.json({ qr: null });
    const data = snap.val();
    return res.json({ qr: data.qr || null, status: data.status || null });
  } catch (e) {
    console.error(`[QR ${sessionId}] Erro:`, e.message || e);
    res.status(500).json({ error: e.message || e });
  }
});

// START
app.post('/api/whatsapp/start/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  try {
    const s = sessions[sessionId];
    if (s && s.client && s.client.info && s.client.info.wid) {
      return res.json({ success: true, message: 'Sessão já conectada' });
    }
    if (activeInitializations[sessionId]) {
      return res.status(202).json({ success: true, message: 'Inicialização em andamento' });
    }

    // marca no DB que estamos inicializando (útil ao depurar)
    await writeSessionStatusToDB(sessionId, { status: 'INITIALIZING', updatedAt: Date.now() });

    initializeWhatsAppClient(sessionId)
      .then(() => console.log(`[${sessionId}] Init concluída.`))
      .catch(err => console.error(`[${sessionId}] Falha init:`, err.message || err));

    res.json({ success: true, message: 'Inicialização iniciada' });
  } catch (e) {
    console.error(`[START ${sessionId}] Erro:`, e.message || e);
    res.status(500).json({ success: false, error: e.message || e });
  }
});

// STOP
app.post('/api/whatsapp/stop/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  try {
    // tenta logout + cleanup sem remover arquivos por padrão
    await cleanupSession(sessionId, false);
    // remove QR do DB
    await writeSessionStatusToDB(sessionId, { status: 'logged_out', qr: null, updatedAt: Date.now() });
    res.json({ success: true, message: 'Sessão parada e limpa (memória).' });
  } catch (e) {
    console.error(`[STOP ${sessionId}] Erro:`, e.message || e);
    res.status(500).json({ success: false, error: e.message || e });
  }
});

// SEND MESSAGE
app.post('/api/whatsapp/send/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const { to, message } = req.body || {};
  if (!to || !message) return res.status(400).json({ success: false, error: 'Faltando "to" ou "message"' });

  try {
    const s = sessions[sessionId];
    if (!s || !s.client) return res.status(404).json({ success: false, error: 'Sessão não encontrada' });

    const sent = await s.client.sendMessage(to, message);
    res.json({ success: true, id: sent.id && sent.id._serialized ? sent.id._serialized : null });
  } catch (e) {
    console.error(`[SEND ${sessionId}] Erro:`, e.message || e);
    res.status(500).json({ success: false, error: e.message || e });
  }
});

// LIST SESSIONS
app.get('/api/sessions', (req, res) => {
  const keys = Object.keys(sessions);
  res.json({ sessions: keys });
});

// GLOBAL ERROR HANDLER
app.use((err, req, res, next) => {
  console.error('Unhandled express error:', err);
  res.status(500).json({ error: 'Server error' });
});

// GRACEFUL SHUTDOWN
const gracefulShutdown = async () => {
  console.log('\n[Sistema] Encerrando processo — limpando sessões...');
  const keys = Object.keys(sessions);
  for (const sId of keys) {
    try { await cleanupSession(sId, false); } catch (e) { console.error(`Cleanup ${sId} falhou:`, e.message || e); }
  }
  process.exit(0);
};
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// START SERVER
app.listen(port, () => {
  console.log(`🚀 Servidor rodando em http://localhost:${port} (PORT=${port})`);
});