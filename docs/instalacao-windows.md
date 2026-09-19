# Instalar e desenvolver o ClipForge no Windows

## 1. Preparar a pasta

Use Windows 10/11 de 64 bits em um computador Intel ou AMD, com internet. Este instalador não atende Windows ARM nem 32 bits, por causa das dependências fixadas do projeto. Reserve espaço para bibliotecas, modelos e vídeos; CUDA e Ollama podem baixar vários GB. GPU Nvidia é opcional.

Extraia o ZIP completo do projeto para uma pasta sua, por exemplo `C:\Projetos\clipforge`. Não execute de dentro do ZIP. Se já clonou o repositório, use essa pasta.

## 2. Executar a instalação

Dê dois cliques em **`setup.bat`**, na raiz do projeto. Ou abra um PowerShell nessa pasta:

```powershell
.\setup.bat
```

O instalador apresenta seis etapas:

1. Procura **Python 3.10 x64**, inclusive pelo launcher `py`, mesmo que o Python padrão seja 3.14. Se faltar, tenta instalar pelo WinGet.
2. Verifica Node.js 22+ com npm, Git, FFmpeg e ffprobe. Instala os programas ausentes pelo WinGet; para Node.js, usa a versão LTS disponível.
3. Detecta Nvidia pelo `nvidia-smi`, cria a `.venv` com Python 3.10 e instala o backend, Ruff e pytest. Uma `.venv` incompatível é movida para `.venv-backup-<identificador>` na própria pasta, sem apagar seu conteúdo. Esse backup serve para recuperar arquivos; ambientes virtuais movidos não são portáveis.
4. Cria `.env` apenas se não existir, instala o frontend com `npm ci` e verifica sua compilação com `npm run build`.
5. Pergunta se deseja instalar VS Code e Ollama. Ollama baixa o modelo `llama3.1:8b-instruct-q4_K_M`; você pode responder **N** para ambos.
6. Executa o diagnóstico do projeto e mostra os próximos passos. Leia os avisos: bibliotecas instaladas não garantem que o driver ou os serviços opcionais estejam prontos.

Alguns instaladores podem pedir autorização do Windows. O WinGet recebe as opções de aceitação dos contratos de instalação. Se ele estiver ausente ou falhar, o script mostra e abre o site de download correspondente, depois interrompe. Conclua a instalação manual, abra um novo terminal e execute `setup.bat` novamente.

Para Python manual, use o [instalador Windows de 64 bits do Python 3.10.11](https://www.python.org/downloads/release/python-31011/). Instale também o launcher `py`. Não basta instalar Python 3.10 e reutilizar uma `.venv` criada com 3.14; o setup verifica esse caso.

**Ao terminar, feche o terminal e abra outro** para carregar o PATH atualizado. Você pode repetir o setup depois de uma falha; `.env` é preservado. O `npm ci` reinstala `node_modules` conforme o lockfile.

## 3. Escolher CPU ou GPU

Por padrão, uma Nvidia com driver respondendo ao `nvidia-smi` seleciona CUDA e instala cuBLAS/cuDNN. Sem essa detecção, o script não instala os pacotes `nvidia-*` e configura um `.env` novo para CPU:

```dotenv
WHISPER_MODEL=small
WHISPER_DEVICE=cpu
WHISPER_COMPUTE_TYPE=int8
VIDEO_ENCODER=libx264
```

Para forçar CPU, inclusive em uma máquina com Nvidia:

```powershell
.\setup.bat -Device cpu
```

Para exigir CUDA:

```powershell
.\setup.bat -Device cuda
```

**Se `.env` já existir, ajuste essas opções nele manualmente.** O parâmetro escolhe os pacotes a instalar e os valores de uma configuração nova; não sobrescreve sua configuração existente. Uma GPU detectada ainda pode ter driver incompatível ou pouca memória. Para CUDA, o template usa `large-v3`; com menos VRAM, experimente `medium` ou `small`. Caso NVENC falhe, use `VIDEO_ENCODER=libx264`.

O primeiro processamento baixa o modelo Whisper escolhido. Esse download não ocorre no setup. Modelos maiores exigem mais memória e espaço.

## 4. Abrir no VS Code e começar a programar

Abra a pasta inteira pelo menu **Arquivo → Abrir Pasta**, ou execute:

```powershell
code .
```

Instale a extensão **Python**, da Microsoft. Use `Ctrl+Shift+P` → **Python: Select Interpreter** → selecione `.venv\Scripts\python.exe`. Se não aparecer, informe esse caminho manualmente.

Não é necessário ativar a venv para os comandos abaixo. No terminal do VS Code, na raiz do projeto:

```powershell
# Conferir o Python e as dependências
.\.venv\Scripts\python.exe --version
.\.venv\Scripts\python.exe -m pip check

# Diagnóstico de FFmpeg, GPU e serviços
.\.venv\Scripts\python.exe backend\cli.py doctor

# Iniciar API e interface
.\start.bat
```

A interface usa `http://localhost:5173`; a documentação da API usa `http://127.0.0.1:8000/docs` com a porta padrão. Use `stop.bat` para encerrar.

Para acompanhar cada serviço em um terminal separado:

```powershell
# Terminal 1, na raiz
.\.venv\Scripts\python.exe backend\cli.py serve
```

```powershell
# Terminal 2, na raiz
cd frontend
npm run dev
```

Edite o backend em `backend/app/` e a interface em `frontend/src/`. O Vite atualiza a interface durante o desenvolvimento. Se uma alteração do backend não aparecer, reinicie a API.

Verificações úteis:

```powershell
.\.venv\Scripts\python.exe -m ruff check backend
.\.venv\Scripts\python.exe scripts\smoke_test.py
cd frontend
npm run build
```

O smoke test depende do ambiente de mídia instalado. O setup instala pytest para desenvolvimento, mas não executa toda a suíte do projeto.

## 5. Recursos opcionais

Para instalar VS Code e Ollama sem responder às perguntas opcionais:

```powershell
.\setup.bat -InstallVSCode -InstallOllama
```

O setup inicia o serviço local do Ollama se necessário e baixa o modelo padrão. Se você já configurou outro `OLLAMA_HOST` ou `OLLAMA_MODEL` no `.env`, esses valores são preservados; prepare esse servidor/modelo separadamente. Sem Ollama disponível, o projeto oferece seleção heurística; Gemini é outra opção configurável no `.env`.

Para automação, sem perguntas opcionais, navegador ou pausa final:

```powershell
$env:CLIPFORGE_NONINTERACTIVE = '1'
.\setup.bat -NonInteractive
```

Instaladores externos ainda podem solicitar autorização do Windows. O script devolve código diferente de zero quando uma etapa obrigatória falha.

## 6. Resolver problemas comuns

| Mensagem | Como resolver |
|---|---|
| `cp314`, CTranslate2 indisponível ou compilação de NumPy/pydantic-core | Execute o setup; ele seleciona Python 3.10 x64 e substitui a venv incompatível por uma nova, mantendo backup. |
| Python/Node/FFmpeg ainda não encontrado após instalar | Feche os terminais e abra outro. Se persistir, confira se o instalador adicionou o programa ao PATH. |
| WinGet ausente | Use o site aberto pelo setup ou instale/atualize o Instalador de Aplicativo da Microsoft Store. Rode o setup novamente. |
| Backup da `.venv` falhou por arquivo em uso | Pare a API, feche terminais usando a venv e execute novamente. |
| Erro de CUDA ou memória de GPU | Atualize o driver Nvidia, reduza o modelo ou configure CPU conforme a seção 3. |
| Erro em `npm ci` | Leia a primeira mensagem de erro. Confira acesso à internet e sincronização de `package.json` com `package-lock.json`; não apague o lockfile para contornar. |
| Ollama não iniciou | Abra o Ollama instalado e repita `setup.bat -InstallOllama`. |

Referências: [opções do WinGet](https://learn.microsoft.com/en-us/windows/package-manager/winget/install), [Node.js](https://nodejs.org/en/download) e [Python 3.10.11](https://www.python.org/downloads/release/python-31011/).
