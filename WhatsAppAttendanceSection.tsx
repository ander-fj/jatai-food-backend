import React, { useState, useEffect } from 'react';
import { useAuth } from '../hooks/useAuth';
import { toast } from 'sonner';
import { Save, Loader, CheckCircle, AlertTriangle, QrCode, Wifi, WifiOff, LogOut, ChevronDown } from 'lucide-react';
import { getDatabase, ref, get, set } from 'firebase/database';

interface WhatsAppConfig {
  isActive: boolean;
  restaurantName: string;
  phoneNumber: string;
  menuUrl: string;
  hours: string;
  address: string;
  welcomeMessage: string;
}

const WhatsAppAttendanceSection: React.FC = () => {
  const { username } = useAuth();
  const [config, setConfig] = useState<WhatsAppConfig>({
    isActive: true,
    restaurantName: '',
    phoneNumber: '',
    menuUrl: '',
    hours: '',
    address: '',
    welcomeMessage: 'Olá! Eu sou o Jataí, seu assistente virtual. Como posso te ajudar hoje? 😊',
  });
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectionStatus, setConnectionStatus] = useState('disconnected');
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isConfigOpen, setIsConfigOpen] = useState(false); // Estado para controlar o recolhimento

  useEffect(() => {
    const fetchConfig = async () => {
      if (!username) return;
      setIsLoading(true);
      try {
        const db = getDatabase();
        const configRef = ref(db, `tenants/${username}/whatsappConfig`);
        const snapshot = await get(configRef);
        if (snapshot.exists()) {
          setConfig(snapshot.val());
        }
      } catch (err) {
        console.error("Erro ao buscar configurações do WhatsApp:", err);
        setError('Não foi possível carregar as configurações.');
        toast.error('Falha ao carregar as configurações do assistente.');
      } finally {
        setIsLoading(false);
      }
    };

    fetchConfig();
  }, [username]);

  useEffect(() => {
    if (!username) return;

    const interval = setInterval(async () => {
      try {
        const response = await fetch(`http://localhost:3001/api/whatsapp/status/${username}`);
        const data = await response.json();
        setConnectionStatus(data.status || 'disconnected');

        if (data.status === 'QR_CODE') {
          const qrResponse = await fetch(`http://localhost:3001/api/whatsapp/qr/${username}`);
          const qrData = await qrResponse.json();
          setQrCode(qrData.qr);
        } else {
          setQrCode(null);
        }
      } catch (err) {
        console.error("Erro ao verificar status do WhatsApp:", err);
        setConnectionStatus('disconnected');
      }
    }, 3000); // Verifica a cada 3 segundos

    return () => clearInterval(interval);
  }, [username]);

  const handleConnect = async () => {
    if (!username) return;
    setIsConnecting(true);
    setQrCode(null);
    await fetch(`http://localhost:3001/api/whatsapp/start/${username}`, { method: 'POST' });
    toast.info('Iniciando conexão com o WhatsApp. Aguarde o QR Code.');
    // O useEffect cuidará de atualizar o status e o QR code
  };

  const handleDisconnect = async () => {
    if (!username) return;
    await fetch(`http://localhost:3001/api/whatsapp/stop/${username}`, { method: 'POST' });
    toast.success('Sessão do WhatsApp desconectada.');
    setConnectionStatus('disconnected');
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setConfig(prev => ({ ...prev, [name]: value }));
  };

  const handleSaveConfig = async () => {
    if (!username) {
      toast.error("Usuário não autenticado. Não é possível salvar.");
      return;
    }

    setIsSaving(true);
    setError(null);

    try {
      // 1. Salvar no Firebase (persistência)
      const db = getDatabase();
      const configRef = ref(db, `tenants/${username}/whatsappConfig`);
      await set(configRef, config);

      // 2. Enviar para o servidor Node.js (para atualizar a IA em tempo real)
      const response = await fetch(`http://localhost:3001/api/config/update/${username}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(config),
      });

      if (!response.ok) {
        throw new Error('Falha ao atualizar o servidor do assistente.');
      }

      const result = await response.json();

      if (result.success) {
        toast.success('Configurações do assistente salvas e atualizadas com sucesso!');
      } else {
        throw new Error(result.error || 'Ocorreu um erro no servidor.');
      }

    } catch (err: any) {
      console.error("Erro ao salvar configurações:", err);
      setError(err.message || 'Não foi possível salvar as configurações.');
      toast.error(`Erro ao salvar: ${err.message}`);
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex justify-center items-center p-8">
        <Loader className="animate-spin mr-2" />
        <span>Carregando configurações do assistente...</span>
      </div>
    );
  }

  return (
    <div className="p-6 bg-white rounded-lg shadow-sm max-w-4xl mx-auto">
      <h2 className="text-2xl font-bold mb-4 text-gray-800">Atendimento via WhatsApp</h2>
      <p className="mb-6 text-gray-600">
        Configure as informações que o assistente virtual (Jataí) usará para responder seus clientes no WhatsApp.
        Lembre-se de salvar após qualquer alteração.
      </p>

      <div className="mb-8 p-4 border rounded-lg bg-gray-50">
        <h3 className="text-lg font-bold text-gray-800 mb-3">Status da Conexão</h3>
        <div className="flex items-center justify-between">
            <div className="flex items-center">
                {connectionStatus === 'ready' && <Wifi className="h-6 w-6 text-green-500 mr-2" />}
                {connectionStatus !== 'ready' && <WifiOff className="h-6 w-6 text-red-500 mr-2" />}
                <span className={`font-semibold ${connectionStatus === 'ready' ? 'text-green-600' : 'text-red-600'}`}>
                    {connectionStatus === 'ready' ? 'Conectado' : 
                     connectionStatus === 'QR_CODE' ? 'Aguardando leitura do QR Code' :
                     connectionStatus === 'INITIALIZING' ? 'Iniciando...' :
                     'Desconectado'}
                </span>
            </div>
            {connectionStatus !== 'ready' && (
                <button
                    onClick={handleConnect}
                    disabled={isConnecting || connectionStatus === 'INITIALIZING' || connectionStatus === 'QR_CODE'}
                    className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-green-600 hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500 disabled:bg-gray-400 disabled:cursor-not-allowed"
                >
                    <QrCode className="mr-2 h-5 w-5" />
                    Conectar WhatsApp
                </button>
            )}
            {connectionStatus === 'ready' && (
                <button
                    onClick={handleDisconnect}
                    className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-red-600 hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500"
                >
                    <LogOut className="mr-2 h-5 w-5" />
                    Desconectar
                </button>
            )}
        </div>

        {connectionStatus === 'QR_CODE' && qrCode && (
            <div className="mt-4 p-4 bg-white rounded-md shadow-inner flex flex-col items-center">
                <h4 className="text-md font-semibold text-gray-700 mb-2">Escaneie para conectar</h4>
                <img src={qrCode} alt="QR Code do WhatsApp" className="w-48 h-48 rounded-md" />
                <p className="text-xs text-gray-500 mt-2">Abra o WhatsApp no seu celular, vá em Aparelhos Conectados e escaneie o código.</p>
            </div>
        )}
      </div>

      {error && (
        <div className="bg-red-100 border-l-4 border-red-500 text-red-700 p-4 mb-6" role="alert">
          <div className="flex">
            <div className="py-1"><AlertTriangle className="h-6 w-6 text-red-500 mr-4" /></div>
            <div>
              <p className="font-bold">Erro</p>
              <p className="text-sm">{error}</p>
            </div>
          </div>
        </div>
      )}

      <div className="border border-gray-200 rounded-lg">
        <button
          type="button"
          onClick={() => setIsConfigOpen(!isConfigOpen)}
          className="w-full flex justify-between items-center p-4 bg-gray-50 hover:bg-gray-100 focus:outline-none rounded-t-lg"
        >
          <h3 className="text-lg font-bold text-gray-800">Configurações do Assistente</h3>
          <ChevronDown className={`h-6 w-6 text-gray-600 transition-transform transform ${isConfigOpen ? 'rotate-180' : ''}`} />
        </button>

        {isConfigOpen && (
          <div className="p-6 space-y-6 border-t border-gray-200">
            <div>
                <label className="flex items-center justify-between cursor-pointer">
                    <span className="flex flex-col">
                        <span className="text-lg font-semibold text-gray-800">Ativar Assistente Virtual</span>
                        <span className="text-sm text-gray-500">Se desativado, o robô não responderá a nenhuma mensagem no WhatsApp.</span>
                    </span>
                    <span className="relative">
                        <input
                            type="checkbox"
                            className="sr-only"
                            checked={config.isActive}
                            onChange={() => setConfig(prev => ({ ...prev, isActive: !prev.isActive }))}
                        />
                        <span className={`block w-14 h-8 rounded-full transition ${config.isActive ? 'bg-indigo-600' : 'bg-gray-300'}`}></span>
                        <span className={`absolute left-1 top-1 block w-6 h-6 rounded-full bg-white transform transition-transform ${config.isActive ? 'translate-x-6' : ''}`}></span>
                    </span>
                </label>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <label htmlFor="restaurantName" className="block text-sm font-medium text-gray-700 mb-1">Nome do Restaurante</label>
                <input type="text" name="restaurantName" id="restaurantName" value={config.restaurantName} onChange={handleInputChange} className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500" />
              </div>
              <div>
                <label htmlFor="phoneNumber" className="block text-sm font-medium text-gray-700 mb-1">Telefone de Contato</label>
                <input type="text" name="phoneNumber" id="phoneNumber" value={config.phoneNumber} onChange={handleInputChange} className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500" />
              </div>
            </div>

            <div>
              <label htmlFor="menuUrl" className="block text-sm font-medium text-gray-700 mb-1">Link do Cardápio</label>
              <input type="url" name="menuUrl" id="menuUrl" value={config.menuUrl} onChange={handleInputChange} placeholder="https://seu-cardapio.com" className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500" />
            </div>

            <div>
              <label htmlFor="hours" className="block text-sm font-medium text-gray-700 mb-1">Horário de Funcionamento</label>
              <input type="text" name="hours" id="hours" value={config.hours} onChange={handleInputChange} placeholder="Ex: Terça a Domingo, das 18h às 23h" className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500" />
            </div>

            <div>
              <label htmlFor="address" className="block text-sm font-medium text-gray-700 mb-1">Endereço</label>
              <input type="text" name="address" id="address" value={config.address} onChange={handleInputChange} placeholder="Rua, Número, Bairro, Cidade-UF" className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500" />
            </div>

            <div>
              <label htmlFor="welcomeMessage" className="block text-sm font-medium text-gray-700 mb-1">Mensagem de Boas-vindas</label>
              <textarea
                name="welcomeMessage"
                id="welcomeMessage"
                rows={4}
                value={config.welcomeMessage}
                onChange={handleInputChange}
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500"
              />
              <p className="mt-2 text-xs text-gray-500">Esta é a primeira mensagem que o assistente enviará. Use emojis para deixar mais amigável! 🚀</p>
            </div>

            <div className="flex justify-end">
              <button
                onClick={handleSaveConfig}
                disabled={isSaving}
                className="inline-flex items-center px-6 py-2 border border-transparent text-base font-medium rounded-md shadow-sm text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:bg-indigo-300 disabled:cursor-not-allowed"
              >
                {isSaving ? (
                  <>
                    <Loader className="animate-spin -ml-1 mr-3 h-5 w-5" />
                    Salvando...
                  </>
                ) : (
                  <>
                    <Save className="-ml-1 mr-2 h-5 w-5" />
                    Salvar Configurações
                  </>
                )}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default WhatsAppAttendanceSection;