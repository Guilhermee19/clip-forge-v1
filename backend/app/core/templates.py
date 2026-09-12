"""Templates de edicao: o mesmo acabamento em todos os cortes.

Um canal tem uma cara. Refazer layout, divisao da tela, posicao das faixas e
estilo de legenda a cada corte nao so da trabalho como produz resultados
ligeiramente diferentes entre si — que e o oposto do que um feed quer.

Um template guarda tudo que **nao** depende do trecho:

    enquadramento (modo, zoom, faixas) + formatos + legenda

Ficam de fora o inicio/fim do corte e os keyframes de camera: os dois so fazem
sentido dentro de um trecho especifico.

As faixas sao gravadas em fracoes do frame, entao o mesmo template vale para
videos de resolucoes diferentes — a interface so reajusta a proporcao delas
para o formato de saida na hora de aplicar.
"""

from __future__ import annotations

import json
import threading
import time
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from app.config import settings
from app.utils.logging import get_logger

logger = get_logger(__name__)

# Dois salvamentos simultaneos reescreveriam o mesmo arquivo.
_lock = threading.RLock()


@dataclass
class Template:
    """Um acabamento salvo, pronto para aplicar em qualquer corte."""

    id: str
    name: str
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    # Aplicado sozinho quando o editor abre.
    is_default: bool = False

    # ------------------------------------------------------- enquadramento
    reframe_mode: str = "auto"
    zoom: float = 1.0
    regions: list[dict[str, Any]] = field(default_factory=list)

    # ------------------------------------------------------------- formato
    aspect_ratios: list[str] = field(default_factory=lambda: ["9:16"])

    # ------------------------------------------------------------- legenda
    burn_subtitles: bool = True
    subtitle_style: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _path() -> Path:
    return settings.output_dir / "templates.json"


def _read() -> list[Template]:
    path = _path()
    if not path.is_file():
        return []
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        logger.warning("templates.json ilegivel (%s); comecando do zero.", exc)
        return []

    templates: list[Template] = []
    for item in raw:
        try:
            templates.append(Template(**item))
        except TypeError as exc:
            # Um template de uma versao futura nao pode derrubar os outros.
            logger.warning("Template ignorado (%s): %s", exc, item.get("name", "?"))
    return templates


def _write(templates: list[Template]) -> None:
    path = _path()
    path.parent.mkdir(parents=True, exist_ok=True)

    # Escreve num temporario e troca: uma queda no meio da escrita nao deixa um
    # JSON pela metade, que apagaria todos os templates de uma vez.
    temp = path.with_suffix(".json.tmp")
    temp.write_text(
        json.dumps([t.to_dict() for t in templates], ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    temp.replace(path)


def list_all() -> list[Template]:
    """Templates salvos: o padrao primeiro, depois do mais recente ao antigo."""
    return sorted(_read(), key=lambda t: (not t.is_default, -t.updated_at))


def get(template_id: str) -> Template | None:
    return next((t for t in _read() if t.id == template_id), None)


def save(data: dict[str, Any], *, template_id: str | None = None) -> Template:
    """Cria ou atualiza um template.

    Um unico template pode ser o padrao: marcar um desmarca o anterior.
    """
    with _lock:
        templates = _read()
        now = time.time()

        existing = next((t for t in templates if t.id == template_id), None)
        if existing is None:
            template = Template(id=uuid.uuid4().hex[:8], name=data.get("name", "Template"))
            templates.append(template)
        else:
            template = existing

        for key, value in data.items():
            if hasattr(template, key) and key not in ("id", "created_at"):
                setattr(template, key, value)
        template.updated_at = now

        if template.is_default:
            for other in templates:
                if other.id != template.id:
                    other.is_default = False

        _write(templates)
        logger.info("Template salvo: %s (%s)", template.name, template.id)
        return template


def delete(template_id: str) -> bool:
    """Remove um template. `False` se ele nao existia."""
    with _lock:
        templates = _read()
        remaining = [t for t in templates if t.id != template_id]
        if len(remaining) == len(templates):
            return False
        _write(remaining)
        logger.info("Template %s removido", template_id)
        return True
