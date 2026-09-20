# Rodar o ClipForge com Docker

Python, Node.js, FFmpeg, bibliotecas do backend, interface e Ollama ficam nos containers. No computador, você precisa apenas da pasta do projeto e do Docker com Compose. O modo incluído usa **CPU**, sem CUDA/NVENC.

## Windows

1. Instale e abra o [Docker Desktop](https://docs.docker.com/desktop/setup/install/windows-install/). Conclua os pré-requisitos indicados por ele, incluindo WSL 2/virtualização quando solicitados. Use **Linux containers**.
2. Na pasta do projeto, execute `setup.bat` e escolha **4 — Docker**. Também funciona `setup.bat --docker`.
3. Aguarde a construção das imagens e os testes de disponibilidade. Na primeira execução, os downloads podem demorar e consumir vários GB.
4. Abra **http://localhost:5173**. A documentação da API fica em **http://localhost:8000/docs**.

Se o Docker não estiver instalado, a opção abre as instruções oficiais. Se estiver parado, o script pede para abri-lo e interrompe sem executar o setup nativo de Python/Node.

## Linux e macOS

Instale [Docker com Compose](https://docs.docker.com/compose/install/). No terminal, na pasta do projeto:

```bash
docker compose up --build --detach --wait --wait-timeout 180
```

As URLs são as mesmas. O backend usa `linux/amd64` para as dependências fixadas. Em Macs com Apple Silicon, isso exige emulação e pode ser lento, especialmente para transcrição. GPU não está configurada neste Compose.

## Modelos e arquivos

O Whisper baixa o modelo `small` no primeiro processamento. O Ollama inicia sem modelos baixados; para habilitar o modelo LLM padrão, execute uma vez:

```bash
docker compose exec ollama ollama pull llama3.1:8b-instruct-q4_K_M
```

Esse download é opcional e ocupa vários GB. Até o modelo estar disponível, a seleção usa o fallback heurístico do projeto. O processamento em CPU pode ser demorado.

Use a opção de **upload de vídeo** da interface ou uma URL. Caminhos como `C:\Videos\live.mp4` não existem dentro do container. Arquivos em `output` ficam acessíveis no container como `/app/output`.

Vídeos, cortes e dados do projeto persistem em **`output/`**, na pasta local. Modelos Whisper e Ollama persistem nos volumes `whisper-models` e `ollama-models` do Compose. Parar ou recriar containers não apaga esses dados.

## Parar, reiniciar e atualizar

Execute na pasta do projeto:

```bash
# Ver os serviços e acompanhar os logs
docker compose ps
docker compose logs -f

# Parar os containers, preservando os dados
docker compose down

# Iniciar novamente
docker compose up -d --wait

# Reconstruir depois de atualizar o código
docker compose up --build -d --wait
```

`start.bat` e `stop.bat` controlam a instalação nativa; para Docker, use os comandos acima. Não use `docker compose down -v` se quiser manter os modelos dos volumes.

## Configuração

O `.env` nativo não é copiado nem carregado dentro dos containers. O Compose define valores próprios de CPU e usa `http://ollama:11434` para comunicação interna. Para mudar portas ou modelos, adicione estas opções ao `.env` da raiz:

```dotenv
DOCKER_WEB_PORT=5173
DOCKER_API_PORT=8000
DOCKER_WHISPER_MODEL=small
DOCKER_OLLAMA_MODEL=llama3.1:8b-instruct-q4_K_M
```

Se mudar o modelo Ollama, baixe o novo nome com `docker compose exec ollama ollama pull NOME`. Outras opções do backend podem ser acrescentadas ao bloco `environment` do serviço `backend` em `compose.yaml`. Aplique mudanças com `docker compose up -d --wait`.

Se a instalação nativa já estiver usando as portas, pare-a antes de iniciar Docker ou escolha outras portas. A publicação fica restrita ao próprio computador (`127.0.0.1`).

## Desenvolver

Edite os arquivos normalmente e reconstrua com `docker compose up --build -d --wait`. Este modo serve a interface compilada e não inclui recarga automática. Para desenvolvimento com recarga, use o setup nativo documentado nos guias Windows/Linux/macOS.

## Resolver falhas

- **Engine não disponível:** abra o Docker Desktop e aguarde ele iniciar.
- **Windows containers selecionado:** altere para Linux containers no Docker Desktop.
- **Falha no build:** consulte a primeira mensagem de erro; verifique internet e espaço disponível.
- **Serviço unhealthy ou timeout:** execute `docker compose logs backend web` para identificar a falha.
- **Porta ocupada:** pare a outra instalação ou ajuste `DOCKER_WEB_PORT`/`DOCKER_API_PORT`.

O Compose espera a API ficar saudável antes de iniciar a interface, conforme o [controle de inicialização do Docker](https://docs.docker.com/compose/how-tos/startup-order/).
