import time
from collections import defaultdict, deque

# ponytail: em memória, vale por processo; com mais de uma réplica trocar por Redis.
_tentativas: dict[str, deque[float]] = defaultdict(deque)


def permitido(chave: str, maximo: int = 5, janela: float = 900) -> bool:
    agora = time.monotonic()
    fila = _tentativas[chave]
    while fila and agora - fila[0] > janela:
        fila.popleft()
    if len(fila) >= maximo:
        return False
    fila.append(agora)
    return True


def limpar(chave: str) -> None:
    _tentativas.pop(chave, None)
