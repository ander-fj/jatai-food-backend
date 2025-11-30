// --- IMPORTS ---
const express = require('express');
const cors = require('cors');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { initializeApp } = require('firebase/app');
const { getDatabase, ref, get, set } = require('firebase/database');
const fs = require('fs');
const path = require('path');

// --- CONFIG DIRETÓRIO DE SESSÃO ---
let SESSION_BASE_PATH = process.env.SESSION_PATH || '/var/data/wwebjs_auth';
let sessionPathResolved = SESSION_BASE_PATH;

const ensureDir = (p) => {
  try {
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(path.join(p, `.test-${Date.now()}`), 'ok');
    return true;
  } catch {
    return false;
  }
};

if (!ensureDir(SESSION_BASE_PATH)) {
  const fallback = path.join(__dirname, '.wwebjs_auth');
  if (ensureDir(fallback)) sessionPathResolved = fallback;
  else console.error('Não foi possível criar diretório de sessão.');
}

// --- VALIDAR ENV ---
[
  'GEMINI_API_KEY',
  'FIREBASE_API_KEY',
  'FIREBASE_AUTH_DOMAIN',
  'FIREBASE_DATABASE_URL',
  'FIREBASE_PROJECT_ID',
  'FIREBASE_STORAGE_BUCKET',
  'FIREBASE_MESSAGING_SENDER_ID',
  'FIREBASE_APP_ID',
].forEach(v => {
  if (!process.env[v]) {
    console.error(`FALTANDO: ${v}`);
    process.exit(1);
  }
});

// --- FIREBASE ---
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

// --- EXPRESS ---
const app = express();
const port = process.env.PORT || 3001;
app.use(cors({ origin: "*", credentials: true }));
app.use(express.json());

// --- ESTRUTURA DE SESSÕES ---
const sessions = {};            // cada sessão ativa
const sessionModels = {};       // modelos IA por sessão
const userChats = {};           // chats separados por cliente
const activeInitializations = {}; // evita iniciar duas vezes
const reconnectionTimers = {};  // timers de reconexão
const sessionLocks = {};        // trava para limpeza

// --- IA ---
const createSystemInstruction = (cfg) => `
Você é o assistente do restaurante ${cfg.restaurantName || 'Restaurante'}.
Use linguagem leve, direta e amigável.
Nunca invente informações.
Cardápio: ${cfg.menuUrl || 'não informado'}
Horário: ${cfg.hours || 'não informado'}
Endereço: ${cfg.address || 'não informado'}
Telefone: ${cfg.phoneNumber || 'não informado'}
`;

// UTIL
const wait = (ms) => new Promise(r => setTimeout(r, ms));
// --- CLEANUP DE SESSÃO (CORRIGIDA — SEM DUPLICIDADE) ---
const cleanupSession = async (sessionId) => {
  if (sessionLocks[sessionId]) return;   // evita reentrância
  sessionLocks[sessionId] = true;

  console.log(`🧹 [${sessionId}] Limpando sessão...`);

  try {
    if (sessions[sessionId]) {
      const client = sessions[sessionId];

      try {
        await client.destroy();
      } catch (err) {
        console.error(`Erro ao destruir cliente: ${err}`);
      }

      delete sessions[sessionId];
    }

    // limpa timers de reconexão
    if (reconnectionTimers[sessionId]) {
      clearTimeout(reconnectionTimers[sessionId]);
      delete reconnectionTimers[sessionId];
    }

    await wait(300);

    console.log(`🧽 [${sessionId}] Sessão limpa.`);
  } catch (e) {
    console.error(`Erro geral cleanup: ${e}`);
  }

  sessionLocks[sessionId] = false;
};


// --- INICIALIZAR CLIENT (SEM LOOP, SEM DUPLICAR INSTÂNCIA) ---
const initializeWhatsAppClient = async (sessionId) => {
  if (activeInitializations[sessionId]) {
    console.log(`⏳ [${sessionId}] Inicialização já em andamento, ignorado.`);
    return;
  }

  activeInitializations[sessionId] = true;

  console.log(`🚀 [${sessionId}] Iniciando nova sessão WhatsApp...`);

  const authDir = path.join(sessionPathResolved, sessionId);
  ensureDir(authDir);

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: sessionId, dataPath: sessionPathResolved }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
  });

  sessions[sessionId] = client;
  sessionModels[sessionId] = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

  // ==========================================================
  // EVENTOS PRINCIPAIS
  // ==========================================================

  // ---- QRCODE ----
  client.on('qr', async (qr) => {
    console.log(`📲 [${sessionId}] QR gerado.`);

    // Proteção: só gera QR se *não estiver conectado*
    if (client.info && client.info.wid) {
      console.log(`⚠️ [${sessionId}] QR recebido APÓS conexão → ignorado`);
      return;
    }

    const qrUrl = await qrcode.toDataURL(qr);

    try {
      await set(ref(database, `sessions/${sessionId}/qr`), qrUrl);
    } catch (e) {
      console.error(`Erro salvar QR Firebase:`, e);
    }
  });

  // ---- READY ----
  client.on('ready', async () => {
    console.log(`✅ [${sessionId}] Cliente READY (conectado e estável).`);

    // Remove QR no Firebase
    await set(ref(database, `sessions/${sessionId}/qr`), null);

    activeInitializations[sessionId] = false;
  });

  // ---- AUTHENTICATED ----
  client.on('authenticated', () => {
    console.log(`🔐 [${sessionId}] Autenticado.`);
  });

  // ---- AUTH FAILURE ----
  client.on('auth_failure', async () => {
    console.log(`❌ [${sessionId}] Falha de autenticação.`);
    await cleanupSession(sessionId);
    activeInitializations[sessionId] = false;

    setTimeout(() => initializeWhatsAppClient(sessionId), 2000);
  });

  // ---- DISCONNECT ----
  client.on('disconnected', async (reason) => {
    console.log(`⚡ [${sessionId}] Desconectado: ${reason}`);

    await cleanupSession(sessionId);
    activeInitializations[sessionId] = false;

    // reconectar
    reconnectionTimers[sessionId] = setTimeout(() => {
      initializeWhatsAppClient(sessionId);
    }, 2500);
  });

  // ---- RECEBIMENTO DE MENSAGEM ----
  client.on('message', async (msg) => {
    let from = msg.from;
    let text = msg.body?.trim() || '';

    console.log(`💬 [${sessionId}] Mensagem recebida de ${from}:`, text);

    try {
      const configSnap = await get(ref(database, `sessions/${sessionId}/config`));
      let cfg = configSnap.exists() ? configSnap.val() : {};

      const model = sessionModels[sessionId].getGenerativeModel({
        model: "gemini-1.5-flash",
        systemInstruction: createSystemInstruction(cfg)
      });

      const resp = await model.generateContent({
        contents: [{ role: "user", parts: [{ text }] }]
      });

      let output = resp.response.text();

      await msg.reply(output);
    } catch (e) {
      console.error(`Erro IA:`, e);
      await msg.reply("⚠️ Ocorreu um erro ao processar a resposta.");
    }
  });

  try {
    await client.initialize();
  } catch (err) {
    console.error(`Erro ao iniciar cliente:`, err);
    activeInitializations[sessionId] = false;
  }
};

// -------------------- PARTE 3/3 --------------------
// ROTAS, HEALTHCHECK, START/STOP, SALVAR CONFIG, ENVIAR MENSAGEM

// HEALTHCHECK
app.get('/health', (req, res) => {
  try {
    res.json({
      status: 'OK',
      time: new Date().toISOString(),
      activeSessions: Object.keys(sessions).length
    });
  } catch (e) {
    res.status(500).json({ status: 'ERROR', error: e.message });
  }
});

// STATUS DA SESSÃO
app.get('/api/whatsapp/status/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  try {
    const client = sessions[sessionId];
    if (client && client.info && client.info.wid) {
      return res.json({ status: 'ready' });
    }
    // fallback: checar no firebase
    const snap = await get(ref(database, `sessions/${sessionId}/qr`));
    const hasQr = snap.exists() && snap.val();
    return res.json({ status: hasQr ? 'qr' : 'disconnected' });
  } catch (e) {
    console.error('Erro status:', e);
    res.status(500).json({ status: 'error' });
  }
});

// PEGAR QR (se existir no DB)
app.get('/api/whatsapp/qr/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  try {
    const snap = await get(ref(database, `sessions/${sessionId}/qr`));
    if (!snap.exists()) return res.json({ qr: null });
    res.json({ qr: snap.val() });
  } catch (e) {
    console.error('Erro QR:', e);
    res.status(500).json({ error: 'Erro ao buscar QR' });
  }
});

// INICIAR SESSÃO (start)
app.post('/api/whatsapp/start/:sessionId', async (req, res) => {
  const { sessionId } = req.params;

  try {
    // se já existe cliente com info, retorna OK
    const client = sessions[sessionId];
    if (client && client.info && client.info.wid) {
      return res.json({ success: true, message: 'Sessão já conectada' });
    }

    // Evita chamadas muito frequentes: trava simples
    if (activeInitializations[sessionId]) {
      return res.status(202).json({ success: true, message: 'Inicialização em andamento' });
    }

    initializeWhatsAppClient(sessionId)
      .then(() => console.log(`[${sessionId}] Init concluída`))
      .catch(err => console.error(`[${sessionId}] Falha init:`, err));

    res.json({ success: true, message: 'Inicialização iniciada' });
  } catch (e) {
    console.error('Erro start:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// PARAR SESSÃO (logout + cleanup)
app.post('/api/whatsapp/stop/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  try {
    const client = sessions[sessionId];
    if (client) {
      try {
        await client.logout();
      } catch (err) {
        console.warn(`[${sessionId}] Logout retornou erro (ignorado):`, err.message || err);
      }
      await cleanupSession(sessionId);
      // limpar QR no DB
      await set(ref(database, `sessions/${sessionId}/qr`), null);
      return res.json({ success: true, message: 'Sessão encerrada' });
    } else {
      // Forçar limpeza de arquivos/DB mesmo sem cliente
      await cleanupSession(sessionId).catch(() => {});
      await set(ref(database, `sessions/${sessionId}/qr`), null);
      return res.json({ success: true, message: 'Sessão não estava carregada; limpeza forçada' });
    }
  } catch (e) {
    console.error('Erro stop:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ATUALIZAR CONFIG (salva no Firebase; reinicia modelo IA localmente)
app.post('/api/config/update/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const data = req.body || {};
  try {
    await set(ref(database, `sessions/${sessionId}/config`), data);
    // zera modelo e contexto local para regenerar com nova config
    delete sessionModels[sessionId];
    delete userChats[sessionId];
    res.json({ success: true });
  } catch (e) {
    console.error('Erro salvar config:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ENVIAR MENSAGEM VIA API (para testes / integrações)
app.post('/api/whatsapp/send/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const { to, message } = req.body || {};
  if (!to || !message) return res.status(400).json({ success: false, error: 'Faltando "to" ou "message"' });

  try {
    const client = sessions[sessionId];
    if (!client) return res.status(404).json({ success: false, error: 'Sessão não encontrada' });

    // envia mensagem (usa whisper / number@c.us ou group id)
    const sent = await client.sendMessage(to, message);
    res.json({ success: true, id: sent.id._serialized });
  } catch (e) {
    console.error('Erro enviar mensagem:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ROTAS ADICIONAIS ÚTEIS
app.get('/api/sessions', (req, res) => {
  const keys = Object.keys(sessions);
  res.json({ sessions: keys });
});

// TRATAMENTO GLOBAL DE ERROS (simples)
app.use((err, req, res, next) => {
  console.error('Unhandled express error:', err);
  res.status(500).json({ error: 'Server error' });
});

// SIGINT / SIGTERM: LIMPEZA ORDENADA
const gracefulShutdown = async () => {
  console.log('\n[Sistema] Encerrando processo — limpando sessões...');
  const keys = Object.keys(sessions);
  for (const s of keys) {
    try {
      await cleanupSession(s);
    } catch (e) {
      console.error(`Erro cleanup ${s}:`, e);
    }
  }
  process.exit(0);
};
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// INICIAR SERVIDOR
app.listen(port, () => {
  console.log(`🚀 Servidor rodando em http://localhost:${port} (PORT=${port})`);
});
