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
- `draft.json` — rascunho do disparo: sequência de mensagens, valores padrão, números digitados, cadência, janela, agendamento e o CSV carregado.
- `campaigns.json` — campanhas agendadas, em andamento e as últimas 50 encerradas. Ao reiniciar o servidor, as agendadas e as em andamento continuam de onde pararam.

## Sequência de mensagens
Na etapa **Mensagens** cada contato recebe uma sequência, como numa conversa (“Oi, bom dia!” … “Como vai?”). Até 20 mensagens, cada uma com texto, `{{variáveis}}` e anexo próprios. A partir da 2ª, defina quanto tempo esperar antes dela (aleatório entre mínimo e máximo, em segundos).
- Mensagens vazias são puladas (também quando uma `{{variável}}` fica vazia para aquele contato).
- Se uma mensagem falhar, o resto da sequência daquele contato não é enviado; o contato conta como falha.
- A cadência geral (intervalo e pausa a cada N) vale **entre contatos**, depois que a sequência do contato termina.
- A janela de horário é checada antes de começar cada contato; uma sequência iniciada vai até o fim.
- Ao lado do editor, uma simulação do WhatsApp mostra como a sequência chega (formatação *negrito* _itálico_ ~riscado~, links, anexos, botões). As setas trocam o contato simulado.
- **🔗 Link** insere um link no cursor (com texto opcional antes). Na Evolution, mensagens com link vão com `linkPreview: true`.
- O teste vai **só para o número digitado** em “Número para teste”, usando os dados do contato exibido na simulação, com esperas limitadas a 10 s.

## Botões (experimental)
Até 3 por mensagem (abrir link, resposta rápida, ligar), sem anexo na mesma mensagem. O WhatsApp só garante botões na API oficial (Cloud API); em números comuns podem não aparecer em alguns aparelhos — teste antes.
- **Evolution v2**: `POST /message/sendButtons/{instancia}` (`description` = texto, botões `url`/`reply`/`call`).
- **Evolution v1**: os botões viram texto no fim da mensagem (`▸ Texto: link`).
- **N8N**: o payload ganha `buttons: [{ type, text, value }]` e `message_with_buttons` (versão em texto).

## Tema
O switch no topo alterna claro/escuro (salvo no navegador; sem escolha, segue o sistema).

## Agendamento
Na etapa **Agendamento**, marque “Agendar” e escolha data e hora (horário de Brasília). A campanha fica salva no servidor e começa sozinha. Dá para agendar várias; o quadro **Campanhas** lista todas, com “Iniciar agora”, “Cancelar” e “Remover”.

Local dos arquivos: `~/.disparador/` ao rodar direto com Node (fora da pasta do projeto, então substituir o código não apaga nada); `/app/data` no Docker, no volume `disparador-data`. Evite `docker compose down -v`, que apaga o volume. O botão **Limpar** no topo apaga só o rascunho do disparo, não as configurações.
 Chaves e valores de header nunca voltam para o navegador (aparecem mascaradas); deixar o campo em branco mantém o valor salvo.

## Payload enviado ao webhook (modo N8N) (POST JSON, um por mensagem da sequência)
```json
{
  "campaign_id": "uuid",
  "index": 1,
  "total": 250,
  "step": 1,
  "steps": 3,
  "phone": "5511999998888",
  "message": "Olá Maria, ...",
  "fields": { "nome": "Maria", "cidade": "SP", "...": "todas as colunas do CSV" }
}
```
No N8N: Webhook (POST) → nó de WhatsApp (Evolution API / Z-API / WhatsApp Cloud etc.) usando `{{$json.body.phone}}` e `{{$json.body.message}}`.
Responda rápido (Respond: Immediately) para o disparador não esperar o envio terminar.

## Anexos (imagem, vídeo, documento)
Cada mensagem da sequência pode ter um anexo (até 50 MB); o texto dela vira a legenda. O mesmo arquivo vai para todos os contatos do disparo. Os arquivos ficam em `media/` dentro da pasta de dados.
- **Evolution direto**: usa `POST /message/sendMedia/{instancia}` com o arquivo em base64 (v1 e v2).
- **N8N**: o payload ganha o campo `media`, e o arquivo é baixado pela URL (precisa ser acessível pelo N8N, então use o domínio público com HTTPS):
```json
"media": { "type": "image|video|document", "mimetype": "image/png", "fileName": "foto.png", "size": 123456, "url": "https://disparo.seudominio.com/media/<id>/foto.png" }
```
A rota `/media/<id>` é pública (o N8N precisa baixar sem login), protegida por um id aleatório de 128 bits. Se usar proxy reverso, aumente o limite de upload (Nginx: `client_max_body_size 50m`).

## Notas
- A fila roda no servidor: pode fechar o navegador. Ao reabrir, o andamento é retomado.
- As campanhas ficam salvas em `campaigns.json`: reiniciar o container retoma as agendadas e as em andamento. Se reiniciar no meio da espera entre mensagens, a próxima sai logo ao voltar.
- Telefones sem DDI (10–11 dígitos) recebem o DDI padrão (55); inválidos são ignorados.
- Disparo em massa viola os termos do WhatsApp se feito sem opt-in; use números aquecidos e cadência conservadora.
