# Correções do Servidor WhatsApp - Erro de Desconexão (LOGOUT)

## Problemas Identificados

### 1. **Listeners com `.once()` em vez de `.on()`**
**Problema**: Os eventos `qr`, `authenticated` e `ready` usavam `.once()`, disparando apenas uma vez. Se o cliente se reconectava, esses eventos não disparavam novamente, deixando o cliente em estado inconsistente.

**Solução**: Alterado o evento `qr` para usar `.on()` permitindo múltiplas tentativas de QR code.

```javascript
// ANTES (errado)
client.once('qr', async (qr) => { ... });

// DEPOIS (correto)
client.on('qr', async (qr) => { ... });
```

---

### 2. **Falta de Tratamento de Reconexão Automática**
**Problema**: Quando o cliente desconectava por qualquer motivo (exceto LOGOUT), não havia tentativa de reconexão automática, deixando a sessão morta.

**Solução**: Implementado sistema de reconexão automática com backoff exponencial:
- Máximo de 5 tentativas de reconexão
- Delay crescente entre tentativas (5s, 10s, 15s, 20s, 25s)
- Limpeza de timers ao destruir a sessão

```javascript
const MAX_RECONNECTION_ATTEMPTS = 5;
const RECONNECTION_DELAY = 5000; // 5 segundos

client.on('disconnected', async (reason) => {
  if (String(reason).toUpperCase() === 'LOGOUT') {
    await cleanupSession(sessionId, true);
    return;
  }
  
  // Tentar reconectar automaticamente
  const attempts = sessions[sessionId]?.reconnectAttempts || 0;
  if (attempts < MAX_RECONNECTION_ATTEMPTS) {
    reconnectionTimers[sessionId] = setTimeout(() => {
      initializeWhatsAppClient(sessionId);
    }, RECONNECTION_DELAY * (attempts + 1));
  }
});
```

---

### 3. **Uso de `.once()` para Desconexão**
**Problema**: O evento `disconnected` usava `.once()`, então apenas a primeira desconexão era tratada. Desconexões subsequentes eram ignoradas.

**Solução**: Alterado para `.on()` para capturar todas as desconexões.

```javascript
// ANTES (errado)
client.once('disconnected', async (reason) => { ... });

// DEPOIS (correto)
client.on('disconnected', async (reason) => { ... });
```

---

### 4. **Falta de Heartbeat/Keep-Alive**
**Problema**: O whatsapp-web.js pode desconectar se não houver atividade por muito tempo. Sem um mecanismo de keep-alive, sessões inativas desconectavam.

**Solução**: Implementado heartbeat que verifica o estado do cliente a cada 30 segundos:

```javascript
const HEARTBEAT_INTERVAL = 30000; // 30 segundos

const startHeartbeat = (sessionId) => {
  const interval = setInterval(async () => {
    if (await isClientValid(sessionId)) {
      // Apenas verifica o estado, mantém a conexão viva
    }
  }, HEARTBEAT_INTERVAL);
  return interval;
};
```

---

### 5. **Falta de Validação de Estado Antes de Usar o Cliente**
**Problema**: O código tentava enviar mensagens sem verificar se o cliente ainda estava válido, causando erros.

**Solução**: Adicionada função `isClientValid()` que verifica o estado real do cliente:

```javascript
const isClientValid = async (sessionId) => {
  const session = sessions[sessionId];
  if (!session || !session.client) return false;
  
  try {
    const state = await session.client.getState();
    return state === 'CONNECTED';
  } catch (e) {
    return false;
  }
};

// Usado antes de processar mensagens
if (!await isClientValid(sessionId)) {
  console.warn(`Cliente inválido ao receber mensagem`);
  return;
}
```

---

### 6. **Listeners Não Removidos Corretamente**
**Problema**: Ao limpar uma sessão, os listeners antigos permaneciam, causando comportamentos inesperados.

**Solução**: Adicionada chamada explícita para remover todos os listeners:

```javascript
if (client) {
  try {
    client.removeAllListeners(); // Remove todos os listeners
    await client.destroy();
  } catch (e) {
    console.error(`Erro ao destruir cliente:`, e);
  }
}
```

---

### 7. **Falta de Tratamento de Erros do Cliente**
**Problema**: Erros do cliente não eram capturados, causando comportamentos silenciosos.

**Solução**: Adicionado listener para erros:

```javascript
client.on('error', (err) => {
  console.error(`[Sessão ${sessionId}] Erro do cliente:`, err);
});
```

---

### 8. **Falta de Limpeza ao Encerrar o Servidor**
**Problema**: Ao encerrar o servidor, as sessões não eram limpas corretamente.

**Solução**: Adicionado handler para SIGINT:

```javascript
process.on('SIGINT', async () => {
  console.log('\n[Sistema] Encerrando servidor...');
  for (const sessionId of Object.keys(sessions)) {
    await cleanupSession(sessionId, false);
  }
  process.exit(0);
});
```

---

## Melhorias Adicionais

### Rastreamento de Atividade
Adicionado `lastActivity` para rastrear quando a sessão foi usada pela última vez:

```javascript
sessions[sessionId].lastActivity = Date.now();
```

### Contagem de Tentativas de Reconexão
Adicionado `reconnectAttempts` para controlar o número de tentativas:

```javascript
sessions[sessionId].reconnectAttempts = (sessions[sessionId]?.reconnectAttempts || 0) + 1;
```

### Melhor Tratamento de Erros ao Responder
Adicionado try-catch ao enviar mensagens de erro:

```javascript
try {
  await message.reply(text);
} catch (replyErr) {
  console.error(`Erro ao enviar mensagem:`, replyErr);
}
```

---

## Como Usar

1. **Substituir o arquivo original**:
   ```bash
   cp whatsapp-server-fixed.js whatsapp-server.js
   ```

2. **Reiniciar o servidor**:
   ```bash
   npm start
   ```

3. **Monitorar os logs** para verificar se as reconexões estão funcionando corretamente.

---

## Resultado Esperado

- ✅ Sessões se reconectam automaticamente após desconexões inesperadas
- ✅ Heartbeat mantém a conexão viva durante períodos de inatividade
- ✅ QR code pode ser regenerado se necessário
- ✅ Mensagens são processadas apenas quando o cliente está válido
- ✅ Logs detalhados para debugging
- ✅ Limpeza adequada ao encerrar o servidor

---

## Notas Importantes

- O sistema tenta reconectar até 5 vezes antes de desistir
- Cada tentativa de reconexão tem um delay crescente (backoff exponencial)
- O heartbeat verifica a conexão a cada 30 segundos
- Apenas desconexões com motivo "LOGOUT" removem a autenticação
- Outras desconexões tentam manter a sessão autenticada para reconexão rápida
