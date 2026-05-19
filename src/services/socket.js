const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} = require("@whiskeysockets/baileys");
const P = require("pino");
const { Boom } = require("@hapi/boom");
const fs = require("fs");
const path = require("path");
const axios = require('axios');
const NodeCache = require("node-cache");
const logger = require('../config/logger');
const { OpenAI } = require('openai');
const { extractDataForAI } = require('../utils/ai_processor');
const { getContentType } = require('@whiskeysockets/baileys');

// Configurações
const BASE_AUTH_DIR = path.resolve(__dirname, "..", "..", "auth_info_baileys");
const CONFIG_FILE = path.join(BASE_AUTH_DIR, "session_config.json");
const WEBHOOK_URL = process.env.WEBHOOK_URL || "https://devpedido.menuolika.com.br/api/whatsapp/webhook";

// ✅ NOVO: Variáveis para multi-instância
const CLIENT_ID = process.env.CLIENT_ID;

// 🚨 Configurações de Controle de IA
const AI_STATUS_URL = process.env.AI_STATUS_URL;
const WH_API_TOKEN = process.env.WH_API_TOKEN;
const STATUS_CACHE_TTL = 30; // 🚨 NOVO: Cache de 30 segundos

// 🤖 Configurações da OpenAI
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5-nano'; // Modelo de custo otimizado
const OPENAI_TIMEOUT = parseInt(process.env.OPENAI_TIMEOUT) * 1000 || 30000;

// 🎭 Contexto Estático (Persona da IA)
const AI_SYSTEM_PROMPT = process.env.AI_SYSTEM_PROMPT || "Você é um assistente profissional da Olika, otimizado para custo. Sua análise é baseada APENAS no texto que você recebe. Se houver mídia que não pôde ser processada, avise o usuário educadamente.";

// 📋 Contexto Dinâmico (URL para buscar dados do cliente)
const CUSTOMER_CONTEXT_URL = process.env.CUSTOMER_CONTEXT_URL;

// Inicialização da OpenAI (para o GPT-5-nano ou modelo configurado)
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  timeout: OPENAI_TIMEOUT
});

const msgRetryCounterCache = new NodeCache();

let globalSock = null;
let isSocketConnected = false;
let currentPhone = null;

// 🔥 Contador de falhas e limite
let consecutiveFailures = 0;
const MAX_FAILURES = 5;

// 🆕 Flag para evitar reconexões duplicadas e controlar estado de pareamento
let isConnecting = false;
let isPairingInProgress = false;

// 🗺️ Mapa LID → JID real (protocolo WhatsApp LID)
// O WhatsApp usa LIDs (@lid) em vez de JIDs (@s.whatsapp.net) para remetentes externos
// Este mapa é populado via contacts.upsert e usado para resolver o número real
const lidToJidMap = new Map();


// --- Persistência de Configuração ---
const loadConfig = () => {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).phone;
    }
  } catch (e) { return null; }
  return null;
};

const saveConfig = (phone) => {
  if (!fs.existsSync(BASE_AUTH_DIR)) fs.mkdirSync(BASE_AUTH_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ phone }));
};

const removeConfig = () => {
  if (fs.existsSync(CONFIG_FILE)) {
    fs.unlinkSync(CONFIG_FILE);
    console.log("🗑️ Configuração de número removida. STANDBY ATIVO.");
  }
};

/**
 * Busca contexto dinâmico do cliente no Laravel para injeção no prompt
 * @param {string} phoneNumber - Número de telefone do cliente (apenas dígitos)
 * @returns {Promise<string>} String formatada com contexto do cliente ou string vazia
 */
const getCustomerContext = async (phoneNumber) => {
  if (!CUSTOMER_CONTEXT_URL || !WH_API_TOKEN) {
    logger.warn("❌ CUSTOMER_CONTEXT_URL não configurada. Contexto dinâmico desabilitado.");
    return "";
  }

  try {
    const response = await axios.post(CUSTOMER_CONTEXT_URL, {
      phone: phoneNumber
    }, {
      headers: {
        'X-API-Token': WH_API_TOKEN,
        'Content-Type': 'application/json'
      },
      timeout: 3000 // Timeout mais curto para não atrasar a resposta
    });

    const context = response.data;

    // Se não houver cliente, retornar vazio
    if (!context.has_customer) {
      return "";
    }

    // Formatar contexto de forma concisa
    let contextString = `[CONTEXTO DO CLIENTE: Nome: ${context.name || 'Cliente'}`;

    if (context.last_order) {
      contextString += `, Último Pedido: #${context.last_order}`;
      if (context.last_order_status) {
        contextString += ` (Status: ${context.last_order_status})`;
      }
    }

    if (context.total_orders > 0) {
      contextString += `, Total de Pedidos: ${context.total_orders}`;
    }

    if (context.loyalty_points !== null && context.loyalty_points > 0) {
      contextString += `, Pontos de Fidelidade: ${context.loyalty_points}`;
    }

    contextString += "]";

    return contextString;

  } catch (error) {
    logger.error(`❌ Falha ao buscar contexto do cliente no Laravel: ${error.message}`);
    // Em caso de falha, continuar sem contexto (não bloquear a IA)
    return "";
  }
};

/**
 * Consulta o Laravel para verificar se a IA está habilitada (COM CACHE).
 * @param {string} senderJid - O JID (número) do remetente.
 * @returns {Promise<boolean>} True se a IA deve responder, False caso contrário.
 */
const checkAiStatus = async (senderJid) => {
  const cacheKey = `ai_status_${senderJid}`;
  const cachedStatus = msgRetryCounterCache.get(cacheKey);

  // 1. Cache Hit
  if (cachedStatus !== undefined) {
    logger.info(`⚡ Cache HIT para status da IA: ${senderJid} -> ${cachedStatus ? 'enabled' : 'disabled'}`);
    return cachedStatus;
  }

  if (!AI_STATUS_URL || !WH_API_TOKEN) {
    logger.warn("❌ Configurações AI_STATUS_URL/WH_API_TOKEN ausentes. IA Desabilitada.");
    return false;
  }

  try {
    const phoneNumber = senderJid.replace(/@.*$/, '').replace(/\D/g, '');

    // 2. Chamada POST para o Laravel
    const response = await axios.post(AI_STATUS_URL, {
      phone: phoneNumber
    }, {
      headers: {
        'X-API-Token': WH_API_TOKEN,
        'Content-Type': 'application/json'
      },
      timeout: 5000
    });

    const isEnabled = response.data.status === 'enabled';

    // 3. Cache Miss: Salva no cache antes de retornar
    msgRetryCounterCache.set(cacheKey, isEnabled, STATUS_CACHE_TTL);

    if (isEnabled) {
      logger.info(`✅ IA habilitada para ${phoneNumber}`);
    } else {
      logger.info(`🚫 IA desabilitada para ${phoneNumber} (${response.data.reason || 'Global_Kill_Switch'})`);
    }

    return isEnabled;

  } catch (error) {
    logger.error(`❌ Falha na comunicação com o Laravel para status da IA: ${error.message}`);
    // Política de segurança: Falha na comunicação = IA desligada.
    return false;
  }
};

// --- Função Core: Start do Socket ---
const startSock = async (phoneOverride = null) => {
  const phoneToUse = phoneOverride || loadConfig(); // Sem fallback para .env

  if (!phoneToUse) {
    console.log("⚠️ MODO STANDBY: Nenhum número configurado. Aguardando POST /connect.");
    globalSock = null;
    isSocketConnected = false;
    currentPhone = null;
    return null;
  }

  if (currentPhone !== phoneToUse) {
    currentPhone = phoneToUse;
    saveConfig(currentPhone);
  }

  const sessionPath = path.join(BASE_AUTH_DIR, currentPhone);
  if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

  const { version } = await fetchLatestBaileysVersion();
  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

  if (globalSock) { try { globalSock.end(); } catch { } }

  console.log(`🚀 Iniciando Socket para: ${currentPhone} (v${version.join(".")})`);

  const sock = makeWASocket({
    version,
    logger: P({ level: "silent" }),
    printQRInTerminal: false,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, P({ level: "silent" })),
    },
    browser: ["Ubuntu", "Chrome", "20.0.04"],
    markOnlineOnConnect: true,
    syncFullHistory: false,
    msgRetryCounterCache,
    connectTimeoutMs: 90000,
    retryRequestDelayMs: 2000,
    defaultQueryTimeoutMs: 60000,
    // 🔑 CRÍTICO: Sem este handler, o Baileys descarta silenciosamente mensagens
    // de números externos que precisam de contexto para descriptografia.
    // Retorna undefined (não encontrado) é suficiente — o Baileys vai retentar.
    getMessage: async (key) => {
      logger.info(`🔑 [getMessage] Solicitado para: ${key.remoteJid} id=${key.id}`);
      return undefined;
    },
  });

  // Geração do Código de Pareamento
  if (!sock.authState.creds.registered) {
    isPairingInProgress = true; // 🆕 Marca que está pareando
    console.log("⏳ Aguardando (3s) para pedir código...");
    setTimeout(async () => {
      // 🆕 Retry: tenta até 3 vezes pedir o código
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          console.log(`📱 Tentativa ${attempt}/3 de solicitar código...`);
          const code = await sock.requestPairingCode(currentPhone.replace(/\D/g, ""));
          console.log(`\n#################################################`);
          console.log(`📠 CÓDIGO (${currentPhone}): ${code?.match(/.{1,4}/g)?.join("-")}`);
          console.log(`#################################################\n`);
          global.currentPairingCode = code;

          // 🆕 Timeout para limpar código expirado (5 minutos)
          setTimeout(() => {
            if (global.currentPairingCode === code && !isSocketConnected) {
              console.log("⏰ Código de pareamento expirado. Solicite novo código.");
              global.currentPairingCode = null;
            }
          }, 5 * 60 * 1000);

          break; // Sucesso, sai do loop
        } catch (err) {
          console.error(`❌ Erro ao pedir código (tentativa ${attempt}/3):`, err.message);
          if (attempt < 3) {
            console.log("🔄 Aguardando 2s antes de tentar novamente...");
            await new Promise(r => setTimeout(r, 2000));
          }
        }
      }
    }, 3000); // Reduzido de 5s para 3s
  }

  // Monitoramento de Conexão
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "open") {
      console.log(`✅ ${currentPhone} CONECTADO!`);
      globalSock = sock;
      isSocketConnected = true;
      isConnecting = false; // 🆕 Libera flag de conexão
      isPairingInProgress = false; // 🆕 Pareamento concluído
      global.currentPairingCode = null;
      consecutiveFailures = 0; // 👈 ZERA O CONTADOR DE SUCESSO

      axios.post(WEBHOOK_URL, {
        client_id: CLIENT_ID, // ✅ NOVO: Multi-instância
        type: 'connection_update',
        instance_phone: currentPhone,
        status: 'CONNECTED'
      }).catch(() => { });
    }

    if (connection === "close") {
      isSocketConnected = false;
      isConnecting = false; // 🆕 Libera flag
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;

      // 🆕 Não incrementa falhas durante pareamento inicial (códigos 515, 408)
      const pairingErrorCodes = [515, 408, 428]; // Timeout de pareamento
      if (isPairingInProgress && pairingErrorCodes.includes(reason)) {
        console.log(`⚠️ Falha de pareamento (${reason}). Não conta como falha permanente.`);
        isPairingInProgress = false;
      } else {
        consecutiveFailures++; // 👈 INCREMENTA A FALHA apenas se não for pareamento
      }
      console.log(`🔴 Desconectado (${reason}). Tentativa ${consecutiveFailures}/${MAX_FAILURES}.`);

      // 🔔 Webhook de Status
      axios.post(WEBHOOK_URL, {
        client_id: CLIENT_ID, // ✅ NOVO: Multi-instância
        type: 'connection_update',
        instance_phone: currentPhone,
        status: 'DISCONNECTED'
      }).catch(() => { });


      // 🚨 NÍVEL 2/3: LOGOUT FATAL OU LIMITE DE FALHAS EXCEDIDO
      if (reason === DisconnectReason.loggedOut || consecutiveFailures >= MAX_FAILURES) {

        console.error("🚫 LIMITE DE FALHAS ATINGIDO ou LOGOUT FATAL. Entrando em modo STANDBY...");

        // 1. Notifica o Laravel para exibir o erro ao usuário
        axios.post(WEBHOOK_URL, {
          type: 'shutdown_alert',
          instance_phone: currentPhone,
          reason: 'PERSISTENT_FAILURE'
        }).catch(() => { });

        // 2. Limpeza de arquivos de sessão
        const sessionPath = path.join(BASE_AUTH_DIR, currentPhone);
        if (fs.existsSync(sessionPath)) {
          fs.rmSync(sessionPath, { recursive: true, force: true });
        }

        // 3. Limpa a configuração de número (FORÇA o Standby)
        removeConfig();

        // 4. Desativa o socket global
        globalSock = null;
        global.currentPairingCode = null;
        consecutiveFailures = 0; // Zera para a próxima tentativa

      } else {
        // NÍVEL 1: Falha Transitória (Tenta reconectar)
        console.log("🔄 Queda temporária. Tentando reconectar...");
        startSock();
      }
    }
  });

  // Eventos Mantidos - Orquestração Completa de IA
  sock.ev.on("messages.upsert", async ({ messages }) => {
    const incomingMessage = messages[0];

    // 🔍 LOG DE DEBUG - SEMPRE LOGAR PRIMEIRO (antes de qualquer filtro)
    const senderJidRaw = incomingMessage.key.remoteJid;
    const fromMeRaw = incomingMessage.key.fromMe;
    const messageId = incomingMessage.key.id;
    
    logger.info(`📩 [DEBUG INICIAL] Mensagem upsert recebida`, {
      fromMe: fromMeRaw,
      remoteJid: senderJidRaw,
      hasMessage: !!incomingMessage.message,
      messageType: incomingMessage.message ? Object.keys(incomingMessage.message)[0] : 'none',
      timestamp: new Date().toISOString()
    });

    // Filtro essencial para não processar status ou mensagens próprias
    if (fromMeRaw || !incomingMessage.message) {
      logger.info(`⏭️ [FILTRO 1] Ignorada: fromMe=${fromMeRaw}, hasMessage=${!!incomingMessage.message}`);
      return;
    }

    // 🗺️ RESOLUÇÃO DE LID: O WhatsApp usa LIDs no protocolo multi-device
    // Mensagens de números externos chegam com @lid em vez de @s.whatsapp.net
    // Tentamos resolver via mapa; se não encontrado, processamos assim mesmo com log
    let senderJid = senderJidRaw;
    if (senderJidRaw && senderJidRaw.endsWith('@lid')) {
      const resolvedJid = lidToJidMap.get(senderJidRaw);
      if (resolvedJid) {
        logger.info(`🗺️ [LID] Resolvido ${senderJidRaw} → ${resolvedJid}`);
        senderJid = resolvedJid;
        // ✅ IMPORTANTE: Se já temos o JID resolvido, NÃO enviamos webhook com LID
        // Isso evita duplicatas no banco (uma com LID, outra com JID)
      } else {
        // LID não mapeado ainda — processa assim mesmo, usando o LID como identificador
        // O número no banco será o LID até o contato ser mapeado
        const pushName = incomingMessage.pushName || 'Desconhecido';
        logger.warn(`⚠️ [LID] Não mapeado: ${senderJidRaw} (pushName=${pushName}). Processando com LID.`);
        senderJid = senderJidRaw; // mantém o @lid
      }
    }

    // 🚨 FILTRO: Ignorar broadcasts, newsletters, grupos e status
    // @lid NÃO é mais filtrado — é resolvido acima para o JID real
    if (!senderJid) return;
    if (senderJid.endsWith('@broadcast')) { logger.info(`⏭️ [FILTRO 2] Ignorado @broadcast: ${senderJid}`); return; }
    if (senderJid.endsWith('@newsletter')) { logger.info(`⏭️ [FILTRO 2] Ignorado @newsletter: ${senderJid}`); return; }
    if (senderJid.endsWith('@g.us')) { logger.info(`⏭️ [FILTRO 2] Ignorado @g.us (grupo): ${senderJid}`); return; }
    if (senderJid === 'status@broadcast') { logger.info(`⏭️ [FILTRO 2] Ignorado status@broadcast`); return; }

    // 🚨 LOG DO NÚMERO DO REMETENTE APÓS FILTROS
    const senderPhone = senderJid.replace(/@.*$/, '').replace(/\D/g, '');
    logger.info(`📞 [FILTRO 3] Mensagem válida de: ${senderPhone} (JID: ${senderJid})`);

    // 🚨 INTEGRAÇÃO COM N8N: Se N8N_WEBHOOK_URL estiver configurada no Railway (ou via fallback), desvia o fluxo para o n8n
    const n8nUrl = process.env.N8N_WEBHOOK_URL || "https://n8n-production-e19d.up.railway.app/webhook-test/d10aac8e-455d-4345-94a3-54a33bec56ff";
    if (n8nUrl) {
      logger.info(`📡 [N8N] Encaminhando mensagem de ${senderPhone} para o n8n...`);
      
      const deQuem = senderJid ? senderJid.split('@')[0] : '';
      const textoMensagem = incomingMessage.message?.conversation || 
                            incomingMessage.message?.extendedTextMessage?.text || 
                            '[Mídia/Outro]';
        
      const webhookPayload = {
        client_id: CLIENT_ID, // Mantido para referência interna
        instance_phone: currentPhone,
        number: deQuem, // Apenas o número de telefone puro (ex: 5571999999999)
        jid: senderJid, // JID completo caso o n8n precise de @s.whatsapp.net ou @lid
        text: textoMensagem,
        pushName: incomingMessage.pushName || 'Desconhecido',
        message_id: incomingMessage.key.id,
        raw_message: incomingMessage // Mantido para o n8n poder acessar botões, reações, etc. se necessário
      };

      // Dispara para o n8n
      axios.post(n8nUrl, webhookPayload)
        .then(() => logger.info(`🚀 [n8n Webhook] Dados enviados com sucesso para o n8n!`))
        .catch((e) => {
          const status = e.response?.status;
          const statusText = e.response?.statusText;
          const responseData = e.response?.data ? JSON.stringify(e.response.data) : '';
          
          if (status === 404) {
            logger.warn(`⚠️ [n8n Webhook] Erro 404: O n8n não está ouvindo eventos de teste no momento. No painel do n8n, clique em "Listen for test event" (ou "Test step") antes de enviar a mensagem, ou ative (Active) o workflow de produção.`);
          } else {
            logger.error(`❌ [n8n Webhook] Erro ao enviar para o n8n. Status: ${status || 'N/A'} (${statusText || 'N/A'}). Detalhes: ${responseData || e.message}`);
          }
        });

      // Também notificamos o Laravel para registrar a mensagem recebida no painel
      const messageType = getContentType(incomingMessage.message) || 'unknown';
      const pushName = incomingMessage.pushName || null;

      const laravelPayload = {
        client_id: CLIENT_ID,
        phone: senderJid,
        is_lid: senderJid.endsWith('@lid'),
        instance_phone: currentPhone,
        message: text,
        ai_disabled: true, // Tratado externamente (pelo n8n)
        message_type: messageType,
        push_name: pushName,
        message_id: incomingMessage.key.id
      };

      logger.info(`📡 [WEBHOOK] Enviando log de entrada para o Laravel`, { url: WEBHOOK_URL, phone: laravelPayload.phone });
      axios.post(WEBHOOK_URL, laravelPayload)
        .then(() => logger.info(`✅ [WEBHOOK] Log enviado com sucesso para o Laravel`))
        .catch((e) => logger.error('❌ [WEBHOOK] Erro ao enviar log para o Laravel:', e.message));

      return; // Interrompe para não usar a OpenAI interna
    }


    // 🚨 1. VERIFICAÇÃO DE STATUS (COM CACHE)
    logger.info(`🔍 Verificando status da IA para ${senderPhone}...`);
    const aiShouldRespond = await checkAiStatus(senderJid);

    if (!aiShouldRespond) {
      logger.info(`🚫 IA desabilitada para ${senderJid} (Controlado pelo Laravel). Ignorando.`);
      // Se a IA está desligada, você pode adicionar um Webhook aqui para logar a mensagem no Laravel ou deixar que um atendente manual trate.
      // Envia webhook apenas para LOG
      const text = incomingMessage.message?.conversation ||
        incomingMessage.message?.extendedTextMessage?.text ||
        '[Mensagem sem texto]';

      // 💡 Adiciona o tipo de mensagem e pushName para o Laravel
      const messageType = getContentType(incomingMessage.message) || 'unknown';
      const pushName = incomingMessage.pushName || null;

      // Webhook para LOG no Laravel
      const webhookPayload = {
        client_id: CLIENT_ID,
        phone: senderJid,
        is_lid: senderJid.endsWith('@lid'),
        instance_phone: currentPhone,
        message: text,
        ai_disabled: true,
        message_type: messageType,
        push_name: pushName,
        message_id: incomingMessage.key.id // ID único para deduplicação
      };
      logger.info(`📡 [WEBHOOK] Enviando para Laravel (IA desabilitada)`, { url: WEBHOOK_URL, phone: webhookPayload.phone });
      axios.post(WEBHOOK_URL, webhookPayload)
        .then(() => logger.info(`✅ [WEBHOOK] Enviado com sucesso para Laravel`))
        .catch((e) => logger.error('❌ [WEBHOOK] Erro ao enviar para Laravel:', e.message));
      return;
    }

    // 2. PROCESSO DE ORQUESTRAÇÃO DE IA
    logger.info(`✅ IA habilitada para ${senderJid}. Iniciando Orquestração de IA...`);

    // 🚨 Notificar Laravel da mensagem com IA ativa (para salvar no banco ANTES da resposta)
    const textPreview = incomingMessage.message?.conversation ||
      incomingMessage.message?.extendedTextMessage?.text ||
      '[Mensagem sem texto]';
    const messageTypePreview = getContentType(incomingMessage.message) || 'unknown';
    const pushNamePreview = incomingMessage.pushName || null;
    const webhookPayloadAi = {
      client_id: CLIENT_ID,
      phone: senderJid,
      is_lid: senderJid.endsWith('@lid'),
      instance_phone: currentPhone,
      message: textPreview,
      ai_disabled: false,
      message_type: messageTypePreview,
      push_name: pushNamePreview,
      message_id: incomingMessage.key.id // ID único para deduplicação
    };
    logger.info(`📡 [WEBHOOK] Enviando para Laravel (IA habilitada - pré-processamento)`, { url: WEBHOOK_URL, phone: webhookPayloadAi.phone });
    axios.post(WEBHOOK_URL, webhookPayloadAi)
      .then(() => logger.info(`✅ [WEBHOOK] Pré-notificação enviada com sucesso para Laravel`))
      .catch((e) => logger.warn('⚠️ [WEBHOOK] Erro ao pré-notificar Laravel:', e.message));

    try {
      // Extrai dados e processa áudio/pdf (chamada condicional a Whisper)
      const { payload } = await extractDataForAI(incomingMessage);

      // 🎭 CONTEXTO ESTÁTICO: Persona da IA (da variável de ambiente)
      const systemPrompt = AI_SYSTEM_PROMPT;

      // 📋 CONTEXTO DINÂMICO: Busca dados do cliente no Laravel
      const phoneNumber = senderJid.replace(/@.*$/, '').replace(/\D/g, '');
      const dynamicContext = await getCustomerContext(phoneNumber);

      // Construir prompt do usuário com contexto dinâmico
      let finalUserPrompt = payload;
      if (dynamicContext) {
        finalUserPrompt = `${dynamicContext}\n\n[Mensagem do Usuário]: ${payload}`;
      }

      const contentForAI = [
        { role: 'system', content: systemPrompt }, // Persona da IA
        { role: 'user', content: finalUserPrompt } // Contexto + Mensagem do usuário
      ];

      // 3. CHAMADA FINAL PARA O GPT (modelo configurado)
      const response = await openai.chat.completions.create({
        model: OPENAI_MODEL,
        messages: contentForAI,
      });

      const replyText = response.choices[0].message.content;

      // 4. RESPOSTA AO USUÁRIO (A função sendMessage agora é robusta)
      await sendMessage(senderJid, replyText);
      logger.info(`✅ Resposta da IA enviada para ${senderJid}`);
      // (webhook já enviado antes do try, não duplicar)

    } catch (error) {
      logger.error(`❌ ERRO NO FLUXO DE ORQUESTRAÇÃO: ${error.message}`);
      try {
        // A chamada sendMessage é mais robusta, mas ainda pode lançar erro.
        await sendMessage(senderJid, "Desculpe, a análise de IA falhou. Por favor, tente novamente mais tarde.");
      } catch (sendError) {
        logger.error(`❌ Erro ao enviar mensagem de erro: ${sendError.message}`);
      }
    }
  });
  sock.ev.on("creds.update", saveCreds);

  // 🗺️ Listener para popular o mapa LID → JID real
  // O WhatsApp usa LIDs no protocolo multi-device. Quando contatos chegam,
  // guardamos o mapeamento LID → JID para resolver mensagens @lid.
  sock.ev.on('contacts.upsert', (contacts) => {
    let novos = 0;
    for (const contact of contacts) {
      if (contact.lid && contact.id) {
        const lidKey = contact.lid.endsWith('@lid') ? contact.lid : `${contact.lid}@lid`;
        const jidValue = contact.id.endsWith('@s.whatsapp.net') ? contact.id : `${contact.id}@s.whatsapp.net`;
        lidToJidMap.set(lidKey, jidValue);
        novos++;
      }
    }
    if (novos > 0) {
      logger.info(`🗺️ [LID MAP] ${novos} contato(s) mapeados. Total no mapa: ${lidToJidMap.size}`);
    }
  });

  globalSock = sock;
  return sock;
};

// --- Funções de Controle Exportadas ---
const forceLogout = async () => {
  console.log("🚨 RESET MANUAL INICIADO!");

  if (globalSock) {
    try { globalSock.end(); } catch { }
    globalSock = null;
    isSocketConnected = false;
  }

  const phone = currentPhone || loadConfig();
  if (phone) {
    const sessionPath = path.join(BASE_AUTH_DIR, phone);
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
    }
  }

  removeConfig(); // APAGA A CONFIG DE NÚMERO

  // Não chama startSock() aqui, deixa o sistema em STANDBY
  return { success: true, message: "Sessão resetada. Chame /connect para novo pareamento." };
};

// Desconecta a instância sem deletar credenciais
const disconnectSock = async () => {
  console.log("🔴 DESCONEXÃO INICIADA!");

  if (!globalSock) {
    console.warn('⚠️  Socket já está desconectado');
    return { success: true, message: 'Já desconectado' };
  }

  try {
    // 1. Fazer logout para invalidar a sessão no WhatsApp
    await globalSock.logout();
    console.log('✅ Logout realizado');

    // 2. Fechar conexão
    if (globalSock.ws) {
      globalSock.ws.close();
    }
    globalSock.end();

    // 3. Limpar referência global (mas NÃO deletar credenciais)
    globalSock = null;
    isSocketConnected = false;
    console.log('✅ Instância desconectada completamente');

    return { success: true, message: 'Desconectado com sucesso' };
  } catch (error) {
    console.error(`❌ Erro ao desconectar: ${error.message}`);
    // Forçar limpeza mesmo com erro
    globalSock = null;
    isSocketConnected = false;
    throw error;
  }
};

// Inicialização: Tenta startar, se não tiver config, entra em STANDBY
(async () => {
  setTimeout(async () => {
    await startSock();
  }, 500);
})();

// --- Exportações ---
const sendMessage = async (phone, message) => {
  if (!globalSock || !isSocketConnected) throw new Error("Offline");

  // 🚨 AJUSTE DE ROBUSTEZ: Captura erros de envio
  try {
    const cleanPhone = phone.replace(/\D/g, "");
    const checkJid = cleanPhone.includes("@s.whatsapp.net") ? cleanPhone : `${cleanPhone}@s.whatsapp.net`;
    const [result] = await globalSock.onWhatsApp(checkJid);

    if (!result?.exists) throw new Error("Número inválido no WhatsApp");

    const sent = await globalSock.sendMessage(result.jid, { text: message });

    return { success: true, messageId: sent.key.id };
  } catch (e) {
    // Loga o erro, mas permite que o fluxo externo continue sem quebrar o listener
    logger.error(`❌ ERRO ao enviar mensagem para ${phone}: ${e.message}`);
    throw new Error(`Falha no envio da mensagem: ${e.message}`);
  }
};
const isConnected = () => isSocketConnected;
const getCurrentPhone = () => currentPhone;

// 🛡️ Handlers globais para prevenir crash loops no Railway
process.on('uncaughtException', (error) => {
  logger.error('❌ UNCAUGHT EXCEPTION (socket.js):', { message: error.message, stack: error.stack });
});

process.on('unhandledRejection', (reason) => {
  logger.error('❌ UNHANDLED REJECTION (socket.js):', { reason: String(reason) });
});

module.exports = { sendMessage, startSock, isConnected, getCurrentPhone, forceLogout, disconnectSock };
