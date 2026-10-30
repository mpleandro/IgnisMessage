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

## Persistência
Tudo é gravado automaticamente enquanto você digita — não precisa clicar em salvar:
- `settings.json` — destino (N8N/Evolution), URL do webhook, chaves.
- `draft.json` — rascunho do disparo: mensagem, valores padrão, números digitados, cadência, janela e o CSV carregado.

Local dos arquivos: `~/.disparador/` ao rodar direto com Node (fora da pasta do projeto, então substituir o código não apaga nada); `/app/data` no Docker, no volume `disparador-data`. Evite `docker compose down -v`, que apaga o volume. O botão **Limpar** no topo apaga só o rascunho do disparo, não as configurações.
 Chaves e valores de header nunca voltam para o navegador (aparecem mascaradas); deixar o campo em branco mantém o valor salvo.

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

## Anexos (imagem, vídeo, documento)
Na etapa **Mensagem** dá para anexar um arquivo (até 50 MB); o texto vira a legenda. O mesmo arquivo vai para todos os contatos do disparo. Os arquivos ficam em `media/` dentro da pasta de dados.
- **Evolution direto**: usa `POST /message/sendMedia/{instancia}` com o arquivo em base64 (v1 e v2).
- **N8N**: o payload ganha o campo `media`, e o arquivo é baixado pela URL (precisa ser acessível pelo N8N, então use o domínio público com HTTPS):
```json
"media": { "type": "image|video|document", "mimetype": "image/png", "fileName": "foto.png", "size": 123456, "url": "https://disparo.seudominio.com/media/<id>/foto.png" }
```
A rota `/media/<id>` é pública (o N8N precisa baixar sem login), protegida por um id aleatório de 128 bits. Se usar proxy reverso, aumente o limite de upload (Nginx: `client_max_body_size 50m`).

## Notas
- A fila roda no servidor: pode fechar o navegador. Ao reabrir, o andamento é retomado.
- O estado da fila fica em memória: reiniciar o container interrompe campanhas em andamento.
- Telefones sem DDI (10–11 dígitos) recebem o DDI padrão (55); inválidos são ignorados.
- Disparo em massa viola os termos do WhatsApp se feito sem opt-in; use números aquecidos e cadência conservadora.
