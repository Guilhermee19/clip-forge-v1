# ClipForge

Alternativa local e open-source ao Opus Clip. Recebe uma live, podcast ou entrevista (link ou arquivo), encontra os melhores trechos e devolve cortes verticais 9:16 com reenquadramento automático no rosto e legenda animada palavra a palavra.

Roda inteiramente na sua máquina: transcrição na GPU, LLM local via Ollama, encode em NVENC. Nada sai do PC — a API do Gemini é opcional.

---

## Como funciona

```
URL / arquivo
     │
     ▼
[1] Ingestão ──────── yt-dlp + ffprobe          → vídeo local + WAV 16 kHz
     ▼
[2] Transcrição ───── faster-whisper (CUDA)     → texto + timestamp por palavra
     ▼
[3] Análise ───────── energia do áudio (RMS)    → picos de risada/empolgação
     │                LLM (Ollama ou Gemini)    → trechos + score de viralidade
     ▼
[4] Reframe ───────── MediaPipe + suavização    → trajetória da câmera virtual
     ▼
[5] Render ────────── FFmpeg + h264_nvenc       → output/clips/*.mp4
```

Cada etapa vive em um módulo próprio em [backend/app/core/](backend/app/core/) e pode ser usada isoladamente.

---

## Requisitos

| Item | Versão | Observação |
|------|--------|------------|
| Python | 3.10+ | |
| FFmpeg | 6+ | precisa ter `h264_nvenc` compilado |
| GPU Nvidia | RTX/GTX com CUDA | opcional, mas a diferença é de horas |
| Node.js | 18+ | apenas para a interface web |
| [Ollama](https://ollama.com) | — | opcional; sem ele a seleção cai no modo heurístico |

> **yt-dlp:** mantenha atualizado (`pip install --upgrade yt-dlp`). O YouTube muda a extração de assinatura com frequência, e uma versão velha simplesmente para de enxergar os formatos de vídeo. O `doctor` avisa quando a sua passa de 120 dias.

**16 GB de RAM** dão conta de uma live de 3 h. Com 8 GB de VRAM, use `WHISPER_MODEL=large-v3` + `WHISPER_COMPUTE_TYPE=int8_float16`; com 6 GB, troque para `medium`.

---

## Instalação

### Windows

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
```

### Linux / macOS

```bash
bash scripts/setup.sh
```

O script cria a `.venv`, instala tudo, copia o `.env` e roda o diagnóstico. Manualmente:

```bash
python -m venv .venv
.venv\Scripts\activate          # Windows
source .venv/bin/activate       # Linux

pip install -r backend/requirements.txt
cp .env.example .env
cd frontend && npm install && cd ..
```

Modelo do LLM local (uma vez):

```bash
ollama pull llama3.1:8b-instruct-q4_K_M
```

Confira o ambiente antes do primeiro job:

```bash
python backend/cli.py doctor
```

```
┌─────────────────┬────────┬──────────────────────────────────────────┐
│ FFmpeg          │ OK     │ ffmpeg                                   │
│ NVENC           │ OK     │ h264_nvenc disponivel                    │
│ Encoder ativo   │ OK     │ h264_nvenc                               │
│ CUDA (Whisper)  │ OK     │ device=cuda, modelo=large-v3             │
│ LLM (ollama)    │ OK     │ Ollama OK (llama3.1:8b-instruct-q4_K_M)  │
└─────────────────┴────────┴──────────────────────────────────────────┘
```

E valide a pipeline inteira com um vídeo sintético (não baixa nada):

```bash
python scripts/smoke_test.py
```

---

## Uso

### CLI

```bash
# 3 cortes de um vídeo do YouTube
python backend/cli.py --input "https://www.youtube.com/watch?v=XXXX" --min-clips 3

# arquivo local, split-screen forçado, até 8 cortes
python backend/cli.py -i "D:/lives/podcast.mkv" --max-clips 8 --reframe split

# só listar os trechos escolhidos, sem renderizar
python backend/cli.py -i video.mp4 --dry-run
```

| Flag | Efeito |
|------|--------|
| `-i, --input` | URL ou caminho local |
| `--min-clips` / `--max-clips` | quantos cortes gerar |
| `--reframe` | `auto`, `single`, `split`, `center` |
| `--language` | idioma da transcrição (padrão: `pt`) |
| `--no-subtitles` | não queimar legenda |
| `--no-cache` | ignorar transcrição salva |
| `--dry-run` | analisar sem renderizar |

Os cortes saem em `output/clips/`, cada um com `.mp4`, `.ass` (legenda editável) e `.jpg` (capa).

### Interface web

**Windows** — duplo-clique em `start.bat` (ou `start.bat` no terminal). Ele checa o ambiente, sobe a API e a UI em janelas separadas e abre o navegador. Para encerrar, `stop.bat`.

**Linux / macOS** — `./start.sh`. Os dois serviços rodam como filhos do script, então um `Ctrl+C` derruba tudo junto.

Ou manualmente, em dois terminais:

```bash
python backend/cli.py serve        # API em :8000  (docs em /docs)
cd frontend && npm run dev         # UI  em :5173
```

#### Fluxo na interface

O trabalho acontece em duas etapas, e elas são separadas de propósito:

**1. Encontrar os momentos.** Cole o link e diga quantos trechos quer. A pipeline baixa, transcreve e seleciona — só isso. Nenhum arquivo de vídeo é gerado ainda, e o formulário não pergunta nada sobre legenda ou formato, porque essas decisões dependem do corte.

**2. Configurar e gerar, corte a corte.** Clique num trecho da lista para abrir o editor. Ao abrir, ele analisa o trecho e **recomenda** um layout e um formato, explicando o porquê. A partir daí você ajusta:

| Ajuste | O que faz |
|--------|-----------|
| **Trim** | início e fim, por slider ou passos de 1 segundo |
| **Formatos** | 9:16, 4:5, 1:1, 16:9 — dá para marcar vários e gerar um arquivo de cada |
| **Reposicionamento** | automático, seguir o falante, split-screen, centro fixo, posição manual ou **gameplay + webcam** |
| **Legenda** | queimar a legenda animada ou não |

A prévia mostra o vídeo original no trecho, com uma moldura por cima marcando o que sobra depois do crop. Nada é codificado até você clicar em gerar.

##### Layout gameplay + webcam

É o caso de quem grava stream: a tela do jogo ocupa quase tudo e a webcam fica num canto. Um crop vertical simples teria que escolher entre o jogo e você — o layout empilhado leva os dois, como nos cortes que você vê no TikTok.

O editor detecta esse caso sozinho. Quando encontra um rosto pequeno encostado numa borda, recomenda o layout composto e já propõe as duas faixas:

```
Rosto pequeno junto da borda: parece webcam sobre captura de tela.
O layout empilha o conteudo principal e a webcam.
  faixa 'Conteudo': x=0.03 y=0.19 w=0.70 h=0.62 peso=0.62
  faixa 'Webcam':   x=0.68 y=0.25 w=0.18 h=0.23 peso=0.38
```

Na prévia aparecem dois retângulos coloridos. Arraste para mover, use a alça do canto para redimensionar, e o slider *Divisão da tela* decide quanto da altura vai para cada faixa. A faixa 1 fica em cima no vídeo final.

Cada região é gravada em frações do frame (0–1), não em pixels, então o mesmo enquadramento vale para qualquer formato de saída.

### API

| Método | Rota | Descrição |
|--------|------|-----------|
| `GET` | `/api/health` | diagnóstico do ambiente |
| `POST` | `/api/jobs` | enfileira uma URL ou caminho local |
| `POST` | `/api/jobs/upload` | enfileira um arquivo enviado |
| `GET` | `/api/jobs/{id}` | estado de um job |
| `DELETE` | `/api/jobs/{id}` | cancela um job |
| `WS` | `/ws/jobs/{id}` | progresso em tempo real |
| `GET` | `/api/jobs/{id}/source` | vídeo de origem para a prévia (aceita `Range`) |
| `GET` | `/api/jobs/{id}/suggest` | layout e formato recomendados para um trecho |
| `POST` | `/api/jobs/{id}/render` | renderiza o corte, um arquivo por formato pedido |
| `GET` | `/api/formats` | formatos e modos de enquadramento disponíveis |
| `GET` | `/api/clips` | biblioteca de cortes renderizados |

---

## Configuração

Tudo fica no `.env` (veja [.env.example](.env.example) para a lista completa e comentada). Os ajustes que mais importam:

```ini
WHISPER_MODEL=large-v3            # medium se a VRAM for curta
WHISPER_COMPUTE_TYPE=int8_float16 # float16 é mais rápido, int8_float16 economiza VRAM

LLM_PROVIDER=ollama               # ollama | gemini | heuristic
OLLAMA_MODEL=llama3.1:8b-instruct-q4_K_M

MIN_CLIPS=5
CLIP_MIN_DURATION=20
CLIP_MAX_DURATION=75
AUDIO_ENERGY_WEIGHT=0.25          # peso do áudio no score final

REFRAME_SMOOTHING=0.12            # menor = câmera mais suave
REFRAME_MODE=auto                 # auto | single | split | center

VIDEO_ENCODER=h264_nvenc
NVENC_CQ=21                       # menor = mais qualidade e arquivo maior
```

### Sobre o modelo do LLM

Modelos de 8B (como o `llama3.1:8b`) identificam bem **onde** está o momento bom, mas erram ao **delimitar** o trecho: costumam devolver só a frase do gancho, uns 5 segundos, mesmo com o prompt exigindo 20 a 75. O `analyzer` corrige isso expandindo o corte a partir do ponto marcado, então nada é descartado por causa disso.

Ainda assim, a *seleção* melhora bastante com um modelo maior. Se a VRAM permitir:

```bash
ollama pull qwen2.5:14b-instruct-q4_K_M   # ou llama3.1:70b, se couber
```

E ajuste `OLLAMA_MODEL` no `.env`. Alternativa sem custo de VRAM: `LLM_PROVIDER=gemini` com uma chave da API.

### Modo heurístico

Sem Ollama e sem chave do Gemini, defina `LLM_PROVIDER=heuristic`: os cortes são escolhidos pelos picos de energia do áudio, ancorados em fronteiras de fala. A qualidade é menor, mas a pipeline roda inteira.

---

## Estrutura

```
clipforge/
├── backend/
│   ├── app/
│   │   ├── config.py            configuração tipada (.env)
│   │   ├── models.py            dataclasses compartilhadas
│   │   ├── core/
│   │   │   ├── ingest.py        yt-dlp + extração de áudio
│   │   │   ├── transcriber.py   faster-whisper (CUDA)
│   │   │   ├── audio_energy.py  envelope RMS e picos
│   │   │   ├── analyzer.py      Ollama / Gemini / heurística
│   │   │   ├── reframer.py      MediaPipe, tracking e suavização
│   │   │   ├── subtitles.py     .ass animado palavra a palavra
│   │   │   ├── renderer.py      FFmpeg + NVENC
│   │   │   └── pipeline.py      orquestração e progresso
│   │   ├── api/
│   │   │   ├── server.py        FastAPI + WebSocket
│   │   │   ├── jobs.py          fila em memória
│   │   │   └── schemas.py       contratos da API
│   │   └── utils/               logging, ffmpeg, CUDA
│   ├── cli.py                   ponto de entrada do terminal
│   └── requirements.txt
├── frontend/                    Vite + React + TypeScript + Tailwind
├── scripts/                     setup.ps1, setup.sh, smoke_test.py
├── start.bat / start.sh         sobe API + UI de uma vez
├── stop.bat                     encerra os serviços (Windows)
└── output/clips/                cortes gerados
```

---

## Detalhes de implementação

**Câmera virtual.** O reframer amostra 5 frames por segundo, detecta rostos com MediaPipe e agrupa as detecções em *tracks* por proximidade. A trajetória passa por zona morta (ignora micro-tremor), filtro exponencial (suaviza) e limite de velocidade (impede teletransporte), e é simplificada com Ramer-Douglas-Peucker. Os keyframes viram uma expressão de `t` no filtro `crop` do FFmpeg — a interpolação acontece dentro do encoder, sem passe intermediário.

**Falante ativo.** Com duas pessoas em quadro, a abertura da boca (via FaceMesh) indica quem está falando. A troca de foco exige 0,7 s de domínio contínuo, senão a câmera ficaria em pingue-pongue.

**Split-screen.** Quando os dois rostos estão bem separados na horizontal, cada um vai para metade da tela vertical — sai melhor que uma câmera pulando entre eles.

**Layout composto.** As faixas são recortadas do mesmo frame com `split`, escaladas com `force_original_aspect_ratio=increase` seguido de um crop — assim cada faixa preenche seu espaço sem esticar a imagem — e unidas com `vstack`. A última faixa absorve a sobra do arredondamento, senão a soma das alturas não bate com a saída e o `vstack` recusa.

**Prévia sem renderizar.** O editor não gera arquivo nenhum para mostrar o corte: ele toca o vídeo de origem em loop no trecho, com uma máscara CSS sobre a área descartada. O endpoint do vídeo responde a `Range`, então dar seek num arquivo de 15 GB baixa só os bytes daquele ponto. Ajustar o corte é instantâneo — é um `currentTime`, não um encode.

**Legendas.** Timestamps por palavra do Whisper viram cartões de até 4 palavras. Cada palavra falada é destacada em cor e escala por tags inline do ASS, o que funciona em qualquer versão do libass.

**Uma passada de FFmpeg.** Recorte temporal, crop animado, escala, legenda e encode acontecem num único comando. Um vídeo de 3 h nunca é reescrito por inteiro.

---

## Solução de problemas

| Sintoma | Causa provável | Correção |
|---------|----------------|----------|
| `Could not load cudnn_ops64_9.dll` | libs CUDA fora do PATH | `pip install nvidia-cublas-cu12 nvidia-cudnn-cu12` (o `app/utils/cuda.py` cuida do resto) |
| `h264_nvenc indisponivel` | build do FFmpeg sem NVENC | `winget install Gyan.FFmpeg` ou baixe o build do gyan.dev |
| Ollama "não instalado" | modelo não baixado | `ollama pull llama3.1:8b-instruct-q4_K_M` |
| Legenda sem aparecer | fonte ausente | instale a Montserrat ou troque `SUBTITLE_FONT` no `.env` |
| VRAM estourando | modelo grande demais | `WHISPER_MODEL=medium` e `WHISPER_COMPUTE_TYPE=int8` |
| Câmera tremendo | suavização fraca | reduza `REFRAME_SMOOTHING` para `0.08` |
| `Requested format is not available` | **yt-dlp desatualizado** (não é o seletor de formato) | `pip install --upgrade yt-dlp` — o `doctor` avisa quando a versão passa de 120 dias |
| `ffprobe falhou em ...source.mp4.ytdl` | download interrompido no cache | resolvido: o cache agora ignora resíduo e o yt-dlp retoma. Para forçar do zero, apague a pasta em `output/cache/` |
| `Sign in to confirm your age` | vídeo restrito | exporte os cookies do navegador e aponte `YTDLP_COOKIES` no `.env` |
| `start.bat` fecha na hora | falta a `.venv` ou dependências | rode `scripts\setup.ps1`; a janela mostra o motivo antes de fechar |
| `UnicodeEncodeError: charmap` | console Windows em cp1252 | resolvido: a CLI força UTF-8 nos streams no boot |
| Cortes todos com a mesma duração | modelo pequeno devolve só o gancho | esperado — o corte é expandido a partir do ponto marcado. Um modelo maior seleciona melhor |
| Enquadramento errado no corte | sem rosto em quadro (gameplay, slides) o modo automático cai no centro | abra o corte no editor: use **posição manual** ou **gameplay + webcam** |
| Faixa da webcam pegou a área errada | a sugestão achou outro rosto (personagem do jogo, por exemplo) | arraste os retângulos na prévia; a sugestão é só um ponto de partida |
| Botão *Editar* não aparece | o vídeo de origem saiu do cache | os cortes já renderizados continuam válidos; para reeditar, rode o job de novo |

---

## Licença

MIT.
#   c l i p - f o r g e - v 1 
 
 #   c l i p - f o r g e - v 1 
 
 