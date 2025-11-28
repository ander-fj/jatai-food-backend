const express = require('express');
const cors = require('cors');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { initializeApp, cert } = require('firebase-admin/app');
const { getDatabase, ref, get } = require('firebase/database');
const fs = require('fs-extra');
const path = require('path');

// --- CONFIGURAÇÃO INICIAL ---

let serviceAccount;
try {
  serviceAccount = require('./firebase-service-account.json'); 
} catch (error) {
    console.error("\n[ERRO CRÍTICO] O arquivo 'firebase-service-account.json' não foi encontrado na pasta 'server'.");
    console.error("Este arquivo é essencial para a comunicação com o Firebase. Baixe-o no console do Firebase e coloque-o na pasta 'server'.\n");
    process.exit(1);
}

if (!process.env.GEMINI_API_KEY) {
  console.error("\n[ERRO CRÍTICO] A variável de ambiente 'GEMINI_API_KEY' não foi encontrada.");
  console.error("Esta chave é essencial para a comunicação com a IA. Por favor, configure-a no seu arquivo .env.\n");
  process.exit(1);
}

// --- CONFIGURAÇÃO DO FIREBASE ---
initializeApp({
  credential: cert(serviceAccount),
  databaseURL: `https://${serviceAccount.project_id}.firebaseio.com`
});
const database = getDatabase();

const app = express();
const port = process.env.PORT || 3001;

// Middleware para habilitar CORS
app.use(cors());
// Middleware para interpretar o corpo das requisições como JSON
app.use(express.json());

// --- CONSTANTES ---
const KEEP_ALIVE_INTERVAL = 15000; // 15 segundos
const HEARTBEAT_INTERVAL = 20000; // 20 segundos
const MESSAGE_TIMEOUT = 25000; // 25 segundos
const INIT_COOLDOWN = 8000; // 8 segundos

/**
 * Encapsula a lógica de um cliente WhatsApp, incluindo estado e eventos.
 */
class WhatsAppClient {
  constructor(sessionId) {
    this.id = sessionId;
    this.client = null;
    this.status = 'NOT_INITIALIZED'; // NOT_INITIALIZED, INITIALIZING, QR_CODE, READY, AUTH_FAILURE, DISCONNECTED
    this.isReady = false;
    this.isInitializing = false;
    this.qrCode = null;
    this.chatSessions = {}; // Armazena sessões de chat da IA para esta instância
    this.messageProcessingLocks = {}; // Lock para evitar processar mesma mensagem múltiplas vezes
    this.messageQueue = []; // Fila de mensagens se desconectar
    this.lastActivityTime = Date.now();
    this.keepAliveInterval = null;
    this.heartbeatInterval = null;
    this.qrRegenerationTimer = null;
    this.readyDetected = false;
    this.disconnectInProgress = false;

    this.initializeClient();
  }

  /**
   * Configura o cliente e seus listeners de evento.
   */
  initializeClient() {
    console.log(`[Sessão ${this.id}] ⚙️  Configurando novo cliente com LocalAuth.`);
    this.client = new Client({
      authStrategy: new LocalAuth({ clientId: this.id }),
      puppeteer: {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-extensions',
          '--disable-plugins',
          '--disable-images',
          '--disable-web-security',
          '--disable-features=IsolateOrigins,site-per-process',
        ]
      }
    });

    // --- LISTENERS DE EVENTO ---

    this.client.on('qr', (qr) => {
      if (this.readyDetected) {
        console.warn(`[Sessão ${this.id}] ⚠️  QR regenerado após estar ready - LOGOUT AUTOMÁTICO DETECTADO`);
        
        // Destruir cliente imediatamente para evitar conflito
        if (!this.disconnectInProgress) {
          this.disconnectInProgress = true;
          console.log(`[Sessão ${this.id}] Destruindo cliente para evitar conflito...`);
          this.cleanup(true);
        }
        return;
      }

      console.log(`[Sessão ${this.id}] 📱  QR Code gerado. Aguardando leitura...`);
      this.status = 'QR_CODE';
      this.qrCode = qr;
    });

    this.client.once('authenticated', () => {
      console.log(`[Sessão ${this.id}] 🔐 Autenticado com sucesso!`);
      this.status = 'AUTHENTICATED';
    });

    this.client.once('ready', () => {
      console.log(`[Sessão ${this.id}] ✅  Cliente conectado e pronto!`);
      this.status = 'ready';
      this.isReady = true;
      this.readyDetected = true;
      this.disconnectInProgress = false;
      this.qrCode = null;
      this.lastActivityTime = Date.now();

      // Iniciar keep-alive e heartbeat
      this.startKeepAlive();
      this.startHeartbeat();
    });

    this.client.on('auth_failure', (msg) => {
      console.error(`[Sessão ${this.id}] ❌  Falha na autenticação: ${msg}`);
      this.status = 'AUTH_FAILURE';
      this.cleanup(true);
    });

    this.client.on('disconnected', (reason) => {
      console.log(`[Sessão ${this.id}] ❌  Cliente desconectado. Razão: ${reason}`);
      this.status = 'DISCONNECTED';
      this.isReady = false;
      this.readyDetected = false;
      
      if (reason === 'LOGOUT') {
        console.log(`[Sessão ${this.id}] 🔴  LOGOUT detectado - limpeza completa necessária.`);
        this.cleanup(true);
      }
    });

    this.client.on('error', (error) => {
      console.error(`[Sessão ${this.id}] ❌ Erro do cliente:`, error.message);
    });

    this.client.on('message', (message) => this.handleMessage(message));
  }

  /**
   * Keep-Alive: Enviar sinais de vida para manter a conexão ativa
   */
  startKeepAlive() {
    if (this.keepAliveInterval) clearInterval(this.keepAliveInterval);

    this.keepAliveInterval = setInterval(async () => {
      try {
        if (this.isReady && this.client) {
          try {
            await this.client.getState();
          } catch (e) {
            // Ignorar erros de keep-alive
          }
        } else {
          clearInterval(this.keepAliveInterval);
        }
      } catch (e) {
        clearInterval(this.keepAliveInterval);
      }
    }, KEEP_ALIVE_INTERVAL);
  }

  /**
   * Heartbeat: Verificar saúde da conexão
   */
  startHeartbeat() {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);

    this.heartbeatInterval = setInterval(async () => {
      try {
        if (this.isReady && this.client) {
          try {
            await this.client.getState();
            this.lastActivityTime = Date.now();
            console.log(`[Sessão ${this.id}] 💓 Heartbeat OK`);
          } catch (e) {
            clearInterval(this.heartbeatInterval);
          }
        } else {
          clearInterval(this.heartbeatInterval);
        }
      } catch (e) {
        clearInterval(this.heartbeatInterval);
      }
    }, HEARTBEAT_INTERVAL);
  }

  /**
   * Verifica se o cliente é válido
   */
  async isClientValid() {
    if (!this.client || !this.isReady) return false;
    try {
      const state = await this.client.getState();
      return state === 'CONNECTED';
    } catch (e) {
      return false;
    }
  }

  /**
   * Inicia a conexão com o WhatsApp.
   */
  async initialize() {
    if (this.isInitializing || this.isReady) {
      console.log(`[Sessão ${this.id}] ⚠️  Tentativa de inicialização ignorada (Já inicializando ou pronto). Status: ${this.status}`);
      return;
    }

    console.log(`[Sessão ${this.id}] 🔔  Iniciando initialize()...`);
    this.isInitializing = true;
    this.status = 'INITIALIZING';

    try {
      // Aguardar um pouco antes de inicializar
      await new Promise(r => setTimeout(r, INIT_COOLDOWN));

      await this.client.initialize();
    } catch (error) {
      console.error(`[Sessão ${this.id}] 💥  Erro durante a inicialização do cliente:`, error);
      this.status = 'ERROR';
    } finally {
      this.isInitializing = false;
      console.log(`[Sessão ${this.id}] ✨  Processo de initialize() finalizado.`);
    }
  }

  /**
   * Lida com mensagens recebidas.
   */
  async handleMessage(message) {
    if (message.fromMe) return;

    const messageId = message.id.id || `${Date.now()}-${Math.random()}`;

    // Evitar processar mesma mensagem múltiplas vezes
    if (this.messageProcessingLocks[messageId]) {
      return;
    }

    this.messageProcessingLocks[messageId] = true;

    try {
      console.log(`[Sessão ${this.id}] 📩  Mensagem de ${message.from}: "${message.body}"`);

      // Validar cliente antes de processar
      if (!await this.isClientValid()) {
        console.warn(`[Sessão ${this.id}] ⚠️  Cliente inválido ao receber mensagem`);
        // Adicionar à fila
        this.messageQueue.push({ from: message.from, body: message.body, timestamp: Date.now() });
        return;
      }

      // Ignorar mensagens vazias
      if (!message.body || message.body.trim() === '') {
        console.log(`[Sessão ${this.id}] ⏭️  Mensagem vazia, ignorando`);
        return;
      }

      try {
        const configRef = ref(database, `tenants/${this.id}/whatsappConfig`);
        const snapshot = await get(configRef);
        const restaurantData = snapshot.exists() ? snapshot.val() : {};

        if (!restaurantData.isActive) {
          console.log(`[Sessão ${this.id}] Assistente desativado. Ignorando.`);
          return;
        }

        const chatId = message.from;
        if (!this.chatSessions[chatId]) {
          console.log(`[Sessão ${this.id}] Iniciando nova sessão de IA para ${chatId}`);
          const systemInstruction = this.createSystemInstruction(restaurantData);
          const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
          const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash", systemInstruction });
          this.chatSessions[chatId] = model.startChat({ history: [] });
        }

        const chat = this.chatSessions[chatId];

        // Adicionar timeout para evitar travamento
        const result = await Promise.race([
          chat.sendMessage(message.body),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Timeout ao processar mensagem')), MESSAGE_TIMEOUT)
          )
        ]);

        const text = result.response.text();

        // Validar cliente novamente antes de enviar resposta
        if (!await this.isClientValid()) {
          console.warn(`[Sessão ${this.id}] ⚠️  Cliente desconectou antes de enviar resposta`);
          return;
        }

        await message.reply(text);
        this.lastActivityTime = Date.now();

      } catch (e) {
        console.error(`[Sessão ${this.id}] ❗️ Erro ao processar mensagem com IA:`, e.message);

        // Verificar se é erro do Puppeteer
        if (this.isPuppeteerError(e)) {
          console.error(`[Sessão ${this.id}] ❌ Erro crítico do Puppeteer detectado`);
          return;
        }

        // Tentar enviar mensagem de erro se cliente ainda estiver válido
        if (await this.isClientValid()) {
          try {
            await message.reply('🤖 Oops! Tive um probleminha para processar sua mensagem. Tente novamente em um instante.');
          } catch (replyErr) {
            console.error(`[Sessão ${this.id}] Erro ao enviar mensagem de erro:`, replyErr.message);
          }
        }
      }
    } finally {
      delete this.messageProcessingLocks[messageId];
    }
  }

  /**
   * Verifica se é erro do Puppeteer
   */
  isPuppeteerError(error) {
    const errorStr = String(error);
    return errorStr.includes('Falha na avaliação') || 
           errorStr.includes('ExecutionContext') ||
           errorStr.includes('Target closed') ||
           errorStr.includes('Session closed');
  }

  createSystemInstruction(data) {
    return `
      Você é o assistente virtual do restaurante ${data.restaurantName || 'do nosso restaurante'}! Seu nome é Jataí.
      Sua personalidade é super divertida, animada e simpática! Use emojis para deixar a conversa mais legal. 🥳🍕✨
      Sua mensagem de boas-vindas é: "${data.welcomeMessage || 'Olá! Como posso te ajudar?'}"
      Sua missão é ajudar os clientes com um sorriso no rosto (virtual, claro!). Use as informações abaixo para responder:
      - Horário de funcionamento: ${data.hours || 'Não informado'}
      - Endereço (se perguntarem onde fica): ${data.address || 'Não informado'}
      - Link do Cardápio e Pedidos: ${data.menuUrl || 'Não informado'}
      - Telefone de contato: ${data.phoneNumber || 'Não informado'}
      IMPORTANTE: Ao enviar o link do cardápio, envie apenas a URL, sem formatação de link ou markdown. Por exemplo: https://seusite.com/cardapio
      NUNCA invente informações. Se não souber algo, diga algo como: "Opa, essa pergunta me pegou! Vou chamar um humano pra te ajudar, só um minutinho! 🧑‍🍳"
    `;
  }

  /**
   * Limpa as sessões de IA para forçar a recriação com novas instruções.
   */
  resetIaSession() {
      console.log(`[Sessão ${this.id}] 🧠 Reiniciando todas as sessões de IA devido à atualização de configuração.`);
      this.chatSessions = {};
  }

  /**
   * Desconecta o cliente e limpa os recursos.
   * @param {boolean} force - Se true, remove a pasta de sessão do disco.
   */
  async cleanup(force = false) {
    console.log(`[Sessão ${this.id}] 🧹  Limpando sessão... (Remover Auth: ${force})`);
    
    // Limpar timers
    if (this.keepAliveInterval) clearInterval(this.keepAliveInterval);
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    if (this.qrRegenerationTimer) clearTimeout(this.qrRegenerationTimer);

    if (this.client) {
      try {
        await this.client.destroy();
      } catch (e) {
        console.error(`[Sessão ${this.id}] ❗️ Erro ao destruir cliente:`, e.message);
      }
    }
    this.client = null;
    this.isReady = false;
    this.status = 'DISCONNECTED';
    this.chatSessions = {}; // Limpa sessões de IA
    this.messageProcessingLocks = {};

    if (force) {
      const sessionPath = path.join(__dirname, '.wwebjs_auth', `session-${this.id}`);
      try {
        await fs.remove(sessionPath);
        console.log(`[Sessão ${this.id}] 🗑️  Pasta da sessão ${sessionPath} removida FORÇADAMENTE.`);
      } catch (e) {
        console.error(`[Sessão ${this.id}] ❗️ Erro ao remover pasta da sessão:`, e.message);
      }
    }
  }
}

/**
 * Gerencia todas as instâncias de clientes WhatsApp ativas.
 */
class SessionManager {
  constructor() {
    this.sessions = new Map();
  }

  getSession(sessionId) {
    if (!this.sessions.has(sessionId)) {
      console.log(`[Gerenciador] 🏭  Criando nova instância de cliente para a sessão ${sessionId}.`);
      const newClient = new WhatsAppClient(sessionId);
      this.sessions.set(sessionId, newClient);
    }
    return this.sessions.get(sessionId);
  }

  removeSession(sessionId) {
    if (this.sessions.has(sessionId)) {
      this.sessions.delete(sessionId);
      console.log(`[Gerenciador] 🛑  Sessão ${sessionId} removida do gerenciador.`);
    }
  }
}

const sessionManager = new SessionManager();

// --- ROTAS DA API ---

app.post('/api/whatsapp/start/:username', async (req, res) => {
  const sessionId = req.params.username;
  console.log(`[API] 📥  Recebida requisição para iniciar a sessão ${sessionId}.`);
  
  const session = sessionManager.getSession(sessionId);
  session.initialize();

  res.status(200).json({ success: true, message: 'Inicialização solicitada.' });
});

app.post('/api/whatsapp/stop/:username', async (req, res) => {
  const sessionId = req.params.username;
  console.log(`[API] 📥  Recebida requisição para parar a sessão ${sessionId}.`);
  
  const session = sessionManager.getSession(sessionId);
  if (session) {
    await session.cleanup(true);
    sessionManager.removeSession(sessionId);
  }

  res.status(200).json({ success: true, message: 'Sessão parada e limpa.' });
});

app.get('/api/whatsapp/status/:username', (req, res) => {
  const sessionId = req.params.username;
  const session = sessionManager.getSession(sessionId);
  
  res.status(200).json({
    success: true,
    status: session.status,
    isReady: session.isReady,
  });
});

app.get('/api/whatsapp/qr/:username', async (req, res) => {
  const sessionId = req.params.username;
  const session = sessionManager.getSession(sessionId);

  if (session && session.status === 'QR_CODE' && session.qrCode) {
    try {
      const qrImage = await qrcode.toDataURL(session.qrCode);
      res.status(200).json({ success: true, qr: qrImage });
    } catch (error) {
      res.status(500).json({ success: false, message: 'Erro ao gerar imagem do QR Code.' });
    }
  } else {
    res.status(404).json({ success: false, message: 'QR Code não disponível.' });
  }
});

app.post('/api/config/update/:username', (req, res) => {
    const { username } = req.params;
    const session = sessionManager.getSession(username);

    if (session) {
        session.resetIaSession();
    }

    console.log(`[Sessão ${username}] ⚙️  Configurações atualizadas.`);
    res.status(200).json({ success: true, message: 'Configurações atualizadas e sessões de IA reiniciadas.' });
});

app.listen(port, () => {
  console.log(`🚀 Servidor WhatsApp rodando na porta ${port}`);
});