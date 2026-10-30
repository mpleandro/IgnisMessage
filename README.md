# Disparador WhatsApp → N8N

Carrega um CSV, personaliza a mensagem com `{{campo}}` (com valor padrão por campo) e dispara cada mensagem, com intervalos aleatórios, para um webhook do N8N.

## Rodar local
```
npm install
APP_PASSWORD=minhasenha npm start   # http://localhost:3000
```

## Subir na VPS (Docker)
```
cp .env.example .env     # defina APP_PASSWORD
docker compose up -d --build
```
Coloque atrás de HTTPS (Caddy/Nginx/Traefik) — a senha usa tela de login (cookie de sessão); use HTTPS.
Exemplo Caddy: `disparo.seudominio.com { reverse_proxy localhost:3000 }`

## Configurações (⚙ no topo da página)
Em `/settings.html` você escolhe o destino do disparo e informa as credenciais:
- **N8N** — URL do webhook (+ header de autenticação opcional). O servidor envia um POST por contato.
- **Evolution API direto** (opcional) — URL, nome da instância, API Key e versão (v1/v2). O servidor chama `POST /message/sendText/{instancia}` sem passar pelo N8N. "Salvar e testar conexão" só consulta o estado da instância.

As configurações ficam em `data/settings.json` (permissão 600, volume `disparador-data` no Docker), então sobrevivem a reinícios. Chaves e valores de header nunca voltam para o navegador (aparecem mascaradas); deixar o campo em branco mantém o valor salvo.

## Payload enviado ao webhook (modo N8N) (POST JSON, um por contato)
```json
{
  "campaign_id": "uuid",
  "index": 1,
  "total": 250,
  "phone": "5511999998888",
  "message": "Olá Maria, ...",
  "fields": { "nome": "Maria", "cidade": "SP", "...": "todas as colunas do CSV" }
}
```
No N8N: Webhook (POST) → nó de WhatsApp (Evolution API / Z-API / WhatsApp Cloud etc.) usando `{{$json.body.phone}}` e `{{$json.body.message}}`.
Responda rápido (Respond: Immediately) para o disparador não esperar o envio terminar.

## Notas
- A fila roda no servidor: pode fechar o navegador. Ao reabrir, o andamento é retomado.
- O estado da fila fica em memória: reiniciar o container interrompe campanhas em andamento.
- Telefones sem DDI (10–11 dígitos) recebem o DDI padrão (55); inválidos são ignorados.
- Disparo em massa viola os termos do WhatsApp se feito sem opt-in; use números aquecidos e cadência conservadora.
