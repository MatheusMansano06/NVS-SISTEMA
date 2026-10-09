import threading
import time
from collections import deque

# ponytail: em memória, vale por processo (o teto vira N× com N réplicas); com mais de uma réplica trocar por Redis.
_tentativas: dict[str, deque[float]] = {}
_trava = threading.Lock()
_VARREDURA_ACIMA = 10_000


def permitido(chave: str, maximo: int = 5, janela: float = 900) -> bool:
    with _trava:
        agora = time.monotonic()
        if len(_tentativas) > _VARREDURA_ACIMA:
            for k in [k for k, f in _tentativas.items() if agora - f[-1] > janela]:
                del _tentativas[k]
        fila = _tentativas.setdefault(chave, deque())
        while fila and agora - fila[0] > janela:
            fila.popleft()
        if len(fila) >= maximo:
            return False
        fila.append(agora)
        return True


def limpar(chave: str) -> None:
    with _trava:
        _tentativas.pop(chave, None)
