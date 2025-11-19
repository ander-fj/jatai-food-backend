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

// Configuração completa de CORS para suportar requisições POST e preflight
app.use(cors({
  origin: function (origin, callback) {
    // Permite requisições sem origin (como Postman, curl, etc.)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      console.log(`[CORS] Origem bloqueada: ${origin}`);
      callback(new Error('Não permitido pelo CORS'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  credentials: true,
  optionsSuccessStatus: 200,
  preflightContinue: false
}));

// Tratamento explícito de requisições OPTIONS (preflight)
app.options('*', cors());

app.use(express.json());

// --- ARMAZENAMENTO DE SESSÕES ---
const sessions = {};
const sessionModels = {}; // Armazena o modelo de IA base por sessão.
const sessionConfigs = {}; // Armazena a última configuração usada para o modelo.
const userChats = {}; // Armazena as conversas ativas: userChats[sessionId][chatId]
const initializingLocks = {}; // Previne múltiplas inicializações simultâneas

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
  NUNCA invente informações. Se não souber algo, diga algo como: "Opa, essa pergunta me pegou! 😬 Vou chamar um humano pra te ajudar, só um minutinho! 🧑‍🍳"
`;

const initializeWhatsAppClient = async (sessionId) => {
  // Verifica se já existe uma instância ativa
  if (sessions[sessionId] && sessions[sessionId].client) {
    console.log(`[Sessão ${sessionId}] Já existe uma instância ativa.`);
    return;
  }

  const sessionRef = ref(database, `tenants/${sessionId}/session`);

  console.log(`[Sessão ${sessionId}] Configurando novo cliente...`);
  
  const client = new Client({
    authStrategy: new LocalAuth({ clientId: sessionId }),
    puppeteer: {
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu'
      ],
      headless: true,
    },
  });

  sessions[sessionId] = { client, status: 'INITIALIZING', qrAttempts: 0 };

  // Limite máximo de tentativas de QR code
  const MAX_QR_ATTEMPTS = 3;

  // Evento QR Code
  client.on('qr', async (qr) => {
    const sessionRef = ref(database, `tenants/${sessionId}/session`);
    const snapshot = await get(sessionRef);
    const firebaseSessionData = snapshot.exists() ? snapshot.val() : {};

    // LÓGICA DE PREVENÇÃO DE QR DESNECESSÁRIO
    // Se a sessão já foi autenticada com sucesso antes (marcador 'authenticatedOnce')
    // ou se o status no Firebase é 'ready', não geramos um novo QR code.
    // Isso previne que uma pequena instabilidade de rede que gere um evento 'qr'
    // force o usuário a escanear novamente sem necessidade.
    if (firebaseSessionData.authenticatedOnce || firebaseSessionData.status === 'ready') {
      console.log(`[Sessão ${sessionId}] ⚠️ Evento 'qr' recebido, mas uma sessão autenticada já existe. Ignorando a geração de um novo QR Code para permitir a reconexão automática.`);
      return; // Ignora a geração do QR Code
    }

    // Incrementa o contador de tentativas
    sessions[sessionId].qrAttempts++;
    
    console.log(`[Sessão ${sessionId}] QR Code gerado (Tentativa ${sessions[sessionId].qrAttempts}/${MAX_QR_ATTEMPTS}). Aguardando escaneamento.`);
    
    // Verifica se excedeu o número máximo de tentativas
    if (sessions[sessionId].qrAttempts > MAX_QR_ATTEMPTS) {
      console.log(`[Sessão ${sessionId}] ⚠️ Número máximo de tentativas de QR code atingido. Encerrando inicialização.`);
      await set(sessionRef, { 
        status: 'QR_EXPIRED', 
        message: 'QR code expirou. Por favor, solicite uma nova inicialização.' 
      });
      await cleanupSession(sessionId, false);
      delete initializingLocks[sessionId];
      return;
    }
    
    qrcodeTerminal.generate(qr, { small: true });
    
    try {
      const qrUrl = await qrcode.toDataURL(qr);
      // Ao gerar um QR, o status é atualizado. O marcador 'authenticatedOnce' será removido
      // e apenas definido como 'true' novamente no evento 'ready'.
      await set(sessionRef, { status: 'QR_CODE', qr: qrUrl, attempt: sessions[sessionId].qrAttempts });
      sessions[sessionId].status = 'QR_CODE';
    } catch (error) {
      console.error(`[Sessão ${sessionId}] Erro ao gerar QR code:`, error);
    }
  });

  // Evento Ready
  client.on('ready', async () => {
    console.log(`[Sessão ${sessionId}] ✅ Cliente conectado e pronto!`);
    await set(sessionRef, { 
      status: 'ready', 
      conectadoEm: new Date().toISOString(),
      authenticatedOnce: true // Marca que a autenticação já foi bem-sucedida uma vez.
    });
    sessions[sessionId].status = 'ready';
    sessions[sessionId].qrAttempts = 0;
    delete initializingLocks[sessionId];
    
    // Remove o QR code quando conectar
    await remove(ref(database, `tenants/${sessionId}/session/qr`));
  });

  // Evento de Autenticação
  client.on('authenticated', () => {
    console.log(`[Sessão ${sessionId}] ✅ Autenticado com sucesso!`);
  });

  // Evento de Mensagens
  client.on('message', async (message) => {
    if (message.fromMe) return;

    // 1. VALIDAÇÃO DA MENSAGEM RECEBIDA
    // Ignora mensagens vazias ou que contenham apenas espaços em branco.
    if (!message.body || message.body.trim() === '') {
      console.log(`[Sessão ${sessionId}] 📩 Mensagem vazia recebida de ${message.from}. Ignorando.`);
      return;
    }

    console.log(`[Sessão ${sessionId}] 📩 Mensagem de ${message.from}: "${message.body}"`);
    const chatId = message.from;

    try {
      const configRef = ref(database, `tenants/${sessionId}/whatsappConfig`);
      const snapshot = await get(configRef);
      const config = snapshot.exists() ? snapshot.val() : {};

      console.log('--- INÍCIO DEBUG FIREBASE ---');
      console.log(`[Sessão ${sessionId}] Buscando configuração em: tenants/${sessionId}/whatsappConfig`);
      if (snapshot.exists()) {
        console.log(`[Sessão ${sessionId}] DADOS ENCONTRADOS NO FIREBASE:`, JSON.stringify(config, null, 2));
      } else {
        console.log(`[Sessão ${sessionId}] NENHUM DADO ENCONTRADO em tenants/${sessionId}/whatsappConfig. Usando config vazia.`);
      }
      console.log('--- FIM DEBUG FIREBASE ---');

      if (!config.isActive) {
        console.log(`[Sessão ${sessionId}] Assistente desativado. Ignorando.`);
        return;
      }

      // Compara a configuração atual com a última usada para esta sessão.
      const configChanged = JSON.stringify(config) !== JSON.stringify(sessionConfigs[sessionId]);

      // 1. Garante que o modelo de IA base para a sessão (tenant) exista e esteja atualizado.
      if (!sessionModels[sessionId] || configChanged) {
        if (configChanged) {
          console.log(`[Sessão ${sessionId}] ⚙️ Detectada mudança na configuração. Recriando modelo de IA e limpando chats.`);
          // Limpa os chats da sessão para forçar a recriação com o novo modelo.
          delete userChats[sessionId];
        } else {
          console.log(`[Sessão ${sessionId}] Criando/Recriando modelo de IA com novas instruções.`);
        }
        
        const systemInstruction = createSystemInstruction(config);
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const modelName = process.env.GEMINI_MODEL_NAME || "gemini-2.5-flash";
        const model = genAI.getGenerativeModel({ model: modelName, systemInstruction });
        
        sessionModels[sessionId] = model;
        sessionConfigs[sessionId] = config; // Armazena a configuração usada.
      }

      // 2. Garante que a estrutura de chat para a sessão exista.
      if (!userChats[sessionId]) {
        userChats[sessionId] = {};
      }

      // 3. Inicia ou reutiliza a sessão de chat para o usuário específico dentro da sessão do tenant.
      if (!userChats[sessionId][chatId]) {
        console.log(`[Sessão ${sessionId}] Iniciando novo chat para o usuário ${chatId}.`);
        userChats[sessionId][chatId] = sessionModels[sessionId].startChat({ history: [] });
      }

      const chat = userChats[sessionId][chatId];
      const result = await chat.sendMessage(message.body);
      const response = await result.response;
      
      // 2. VALIDAÇÃO DA RESPOSTA DA IA
      // Garante que a resposta da IA é uma string válida antes de enviar.
      const text = response.text()?.trim();

      if (text) {
        console.log(`[Sessão ${sessionId}] 🤖 Resposta: "${text.substring(0, 50)}..."`);
        try {
          await message.reply(text);
        } catch (replyError) {
          console.error(`[Sessão ${sessionId}] ❌ Erro ao enviar a resposta da IA. Fallback. Erro:`, replyError);
          try {
            await message.reply('Opa, tive um probleminha para responder. Pode tentar de novo?');
          } catch (fallbackError) {
            console.error(`[Sessão ${sessionId}] ❌ Erro ao enviar a mensagem de fallback após falha inicial. Erro:`, fallbackError);
          }
        }
      } else {
        console.warn(`[Sessão ${sessionId}] ⚠️ A IA não retornou uma resposta válida para "${message.body}". Enviando fallback.`);
        try {
          await message.reply('Não entendi, pode repetir? 🤔');
        } catch (replyError) {
          console.error(`[Sessão ${sessionId}] ❌ Erro ao enviar a mensagem de fallback de IA inválida. Erro:`, replyError);
        }
      }

    } catch (error) {
      console.error(`[Sessão ${sessionId}] ❌ Erro ao processar mensagem:`, error);
      try {
        await message.reply('Desculpe, não consegui processar sua solicitação no momento. 😔');
      } catch (finalFallbackError) {
        console.error(`[Sessão ${sessionId}] ❌ Erro ao enviar a mensagem de erro final. Erro:`, finalFallbackError);
      }
    }
  });

  // Evento de Desconexão
  client.on('disconnected', async (reason) => {
    console.log(`[Sessão ${sessionId}] ❌ Cliente desconectado. Razão: ${reason}`);
    
    // Razões que forçam a remoção da autenticação e exigem novo QR code.
    const destructiveReasons = ['AUTHENTICATION_FAILED', 'CHANGE_IN_CACHE', 'UNPAIRED', 'LOGOUT'];
    
    if (destructiveReasons.includes(reason)) {
        console.log(`[Sessão ${sessionId}] O motivo da desconexão (${reason}) requer limpeza completa da sessão. Limpando...`);
        await cleanupSession(sessionId, true); // Força a remoção da pasta de autenticação
    } else {
        // Para outras desconexões não destrutivas.
        // Apenas destrói a instância do cliente, mas mantém os arquivos de autenticação.
        // Isso permite uma reconexão rápida sem precisar escanear o QR code novamente.
        console.log(`[Sessão ${sessionId}] Desconexão não destrutiva (${reason}). Limpando instância do cliente para futura reconexão.`);
        await cleanupSession(sessionId, false); // Apenas destrói o cliente, mantém a autenticação
    }
    
    // Remove o lock de inicialização se existir
    if (initializingLocks[sessionId]) {
      console.log(`[Sessão ${sessionId}] 🔓 Lock de inicialização removido após desconexão.`);
      delete initializingLocks[sessionId];
    }
  });
  
  // Evento de Falha de Autenticação
  client.on('auth_failure', async (msg) => {
    console.error(`[Sessão ${sessionId}] ❌ Falha na autenticação:`, msg);
    await set(sessionRef, { status: 'AUTH_FAILURE', error: msg });
    sessions[sessionId].status = 'AUTH_FAILURE';
    await cleanupSession(sessionId, true); // Força limpeza completa em caso de falha de autenticação
    
    if (initializingLocks[sessionId]) {
      console.log(`[Sessão ${sessionId}] 🔓 Lock de inicialização removido após falha de autenticação.`);
      delete initializingLocks[sessionId];
    }
  });

  // Inicialização com timeout
  try {
    console.log(`[Sessão ${sessionId}] 🚀 Inicializando cliente...`);
    
    // Timeout de 120 segundos para inicialização
    const initPromise = client.initialize();
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Timeout na inicialização')), 120000)
    );
    
    await Promise.race([initPromise, timeoutPromise]); // Usa Promise.race para competir com o timeout
    
  } catch (error) {
    console.error(`[Sessão ${sessionId}] ❌ Erro crítico na inicialização:`, error);
    await set(sessionRef, { status: 'ERROR', error: error.message });
    await cleanupSession(sessionId, false); // Não força limpeza de auth em caso de timeout
    
    if (initializingLocks[sessionId]) {
      console.log(`[Sessão ${sessionId}] 🔓 Lock de inicialização removido após erro crítico.`);
      delete initializingLocks[sessionId];
    }
  }
};

// Função de limpeza de sessão
const cleanupSession = async (sessionId, forceRemoveAuth = false) => {
  console.log(`[Sessão ${sessionId}] 🧹 Limpando sessão... (Remover Auth: ${forceRemoveAuth})`);
  
  // Remove do Firebase
  await remove(ref(database, `tenants/${sessionId}/session`));
  

  // Destrói o cliente
  if (sessions[sessionId] && sessions[sessionId].client) {
    try {
      await sessions[sessionId].client.destroy();
    } catch (error) {
      console.error(`[Sessão ${sessionId}] Erro ao destruir cliente:`, error);
    }
    delete sessions[sessionId];
    // Limpa o modelo de IA associado à sessão
    delete sessionModels[sessionId];
    // Limpa todos os chats de usuários associados a esta sessão
    Object.keys(userChats).forEach(chatId => {
        // Uma lógica mais refinada poderia verificar se o chatId pertence à sessionId se necessário
        delete userChats[chatId];
    });
    console.log(`[Sessão ${sessionId}] Modelo de IA e sessão local limpos.`);
  }

  // Remove a pasta da sessão APENAS se forçado (logout, etc.)
  if (forceRemoveAuth) {
    const sessionFolderPath = path.join('.wwebjs_auth', `session-${sessionId}`);
    try {
      if (fs.existsSync(sessionFolderPath)) {
        fs.rmSync(sessionFolderPath, { recursive: true, force: true });
        console.log(`[Sessão ${sessionId}] Pasta da sessão .wwebjs_auth/session-${sessionId} removida FORÇADAMENTE.`);
      }
    } catch (err) {
      console.error(`[Sessão ${sessionId}] Erro ao remover a pasta da sessão:`, err);
    }
  }
};

// --- ROTAS DA API ---

// Health check endpoint com informações detalhadas
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
    environment: process.env.NODE_ENV || 'development'
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

app.post('/api/whatsapp/start/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  console.log(`[Sessão ${sessionId}] 📥 Recebida requisição para iniciar.`);

  // Verificação robusta para evitar reinicializações desnecessárias.
  const existingSession = sessions[sessionId];
  
  // 1. Verifica o status no Firebase (fonte de verdade persistente)
  const sessionRef = ref(database, `tenants/${sessionId}/session`);
  const snapshot = await get(sessionRef);
  const firebaseStatus = snapshot.exists() ? snapshot.val().status : 'disconnected';

  if (firebaseStatus === 'ready') {
    console.log(`[Sessão ${sessionId}] ✅ Status 'ready' encontrado no Firebase. Requisição ignorada.`);
    return res.status(200).json({ success: true, message: 'A sessão já está conectada (Status Firebase: ready).' });
  }

  // 2. Verifica o status na memória local
  if (existingSession) {
    // Se a sessão está pronta e conectada, ignora a requisição.
    if (existingSession.status === 'ready') {
      try {
        const state = await existingSession.client.getState();
        if (state === 'CONNECTED') {
          console.log(`[Sessão ${sessionId}] ✅ Cliente já conectado e pronto. Requisição ignorada.`);
          return res.status(200).json({ success: true, message: 'A sessão já está conectada.' });
        }
      } catch (e) {
        console.log(`[Sessão ${sessionId}] ⚠️ Cliente em estado 'ready' mas inacessível: ${e.message}. Prosseguindo para reiniciar.`);
        await cleanupSession(sessionId, false); // Limpa a sessão corrompida antes de continuar.
      }
    }
    // Se a sessão já está inicializando (gerando QR ou conectando), informa o cliente para aguardar.
    else if (['INITIALIZING', 'QR_CODE'].includes(existingSession.status)) {
      console.log(`[Sessão ${sessionId}] ⏳ Sessão já em andamento com status '${existingSession.status}'. Requisição ignorada.`);
      return res.status(202).json({ success: true, message: 'Sessão já está em processo de inicialização. Aguarde.' });
    }
  }
  
  // Bloqueia múltiplas inicializações concorrentes.
  if (initializingLocks[sessionId]) {
    console.log(`[Sessão ${sessionId}] ⚠️ Sessão já está sendo inicializada. Requisição bloqueada.`);
    return res.status(409).json({
      success: false,
      message: 'A sessão já está em processo de inicialização. Por favor, aguarde.',
    });
  }

  // Ativa o lock de inicialização
  initializingLocks[sessionId] = true;
  console.log(`[Sessão ${sessionId}] 🔒 Lock de inicialização ativado.`);
  
  // Define o status inicial no Firebase
  await set(ref(database, `tenants/${sessionId}/session/status`), 'INITIALIZING');

  // A lógica principal de inicialização é chamada aqui.
  // O catch lida com falhas inesperadas durante a chamada.
  initializeWhatsAppClient(sessionId).catch(err => {
    console.error(`[Sessão ${sessionId}] ❌ Falha não capturada na inicialização:`, err);
    // Garante que o lock seja liberado em caso de erro.
    delete initializingLocks[sessionId];
  });

  // Responde imediatamente para não bloquear o cliente.
  res.status(202).json({
    success: true,
    message: `Inicialização da sessão ${sessionId} iniciada.`,
  });
});

app.post('/api/whatsapp/stop/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const session = sessions[sessionId];

  if (session && session.client) {
    console.log(`[Sessão ${sessionId}] 🛑 Recebida requisição para parar.`);
    try {
      await session.client.logout();
      res.status(200).json({ success: true, message: `Sessão ${sessionId} desconectada com sucesso.` });
    } catch (error) {
      console.error(`[Sessão ${sessionId}] Erro ao fazer logout:`, error);
      res.status(500).json({ success: false, error: 'Erro ao desconectar.' });
    }
  } else {
    await remove(ref(database, `tenants/${sessionId}/session`));
    res.status(404).json({ success: false, error: `Sessão ${sessionId} não encontrada ou já inativa.` });
  }
});

app.post('/api/config/update/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const newConfig = req.body;

  if (!newConfig || Object.keys(newConfig).length === 0) {
    return res.status(400).json({ success: false, error: 'Nenhum dado de configuração foi fornecido.' });
  }
  
  try {
    const configRef = ref(database, `tenants/${sessionId}/whatsappConfig`);
    await set(configRef, newConfig);

    // Invalida o modelo de IA da sessão para forçar a recriação com a nova configuração na próxima mensagem.
    delete sessionModels[sessionId];
    // Limpa todos os chats de usuários existentes para forçar a recriação com o novo modelo.
    Object.keys(userChats).forEach(chatId => {
        delete userChats[chatId];
    });
    
    console.log(`[Sessão ${sessionId}] ⚙️ Configurações atualizadas.`);
    res.status(200).json({ success: true, message: 'Configurações atualizadas com sucesso.' });
  } catch (error) {
    console.error(`[Config ${sessionId}] Erro ao salvar:`, error);
    res.status(500).json({ success: false, error: 'Erro ao salvar a configuração.' });
  }
});

// --- INICIALIZAÇÃO DO SERVIDOR ---
app.listen(port, () => {
  console.log(`🚀 Servidor rodando em http://localhost:${port}`);
  console.log('📱 Aguardando requisições para iniciar sessões do WhatsApp...');
});