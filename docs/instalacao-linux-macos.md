# Instalar no Linux ou macOS

O menu de `setup.bat` apresenta os três sistemas. A opção Windows executa o instalador local; Linux e macOS mostram instruções. Um `.bat` não executa nativamente nesses dois sistemas nem instala programas em outro computador.

No Linux ou Mac, extraia ou clone o projeto e abra o Terminal na pasta dele.

## Pré-requisitos

Instale **Python 3.10**, **Node.js 22+ com npm**, **Git** e **FFmpeg com ffprobe**, usando o gerenciador de pacotes do seu sistema ou os instaladores oficiais. O script Bash prepara o projeto, mas não instala esses programas automaticamente. No Linux, a distribuição pode exigir o pacote de suporte a `venv` correspondente ao Python 3.10.

Verifique no Terminal:

```bash
python3.10 --version
node --version
npm --version
git --version
ffmpeg -version
ffprobe -version
```

Se Python 3.10 estiver disponível apenas como `python3`, o setup também o encontra. Python 3.14 não serve para as versões fixadas neste projeto.

## Instalação

Na pasta do projeto:

```bash
bash scripts/setup.sh
```

O script cria `.venv`, instala as dependências e ferramentas Python, prepara `.env`, instala e compila o frontend e executa o diagnóstico. Uma `.venv` existente com outro Python ou criada no Windows deve ser renomeada antes de repetir o setup.

No **macOS**, a configuração nova usa CPU e dispensa os pacotes CUDA. No **Linux**, CUDA é selecionado quando `nvidia-smi` responde; caso contrário, usa CPU. A disponibilidade das demais dependências ainda depende da arquitetura e versão do sistema. Esta alteração não foi validada em uma máquina macOS ou Linux real.

Se `.env` já existir, ele será preservado. Para CPU, ajuste nele:

```dotenv
WHISPER_MODEL=small
WHISPER_DEVICE=cpu
WHISPER_COMPUTE_TYPE=int8
VIDEO_ENCODER=libx264
```

## Desenvolver

Abra a pasta no seu editor. No VS Code, selecione `.venv/bin/python` em **Python: Select Interpreter**.

```bash
source .venv/bin/activate
python backend/cli.py doctor
bash start.sh
```

A interface usa `http://localhost:5173`. Com a porta padrão, a documentação da API fica em `http://127.0.0.1:8000/docs`. Encerre os serviços com `Ctrl+C` no terminal do launcher.

Ollama é opcional. Se quiser a seleção com LLM local, instale e inicie o Ollama e baixe o modelo configurado no `.env`:

```bash
ollama pull llama3.1:8b-instruct-q4_K_M
```
