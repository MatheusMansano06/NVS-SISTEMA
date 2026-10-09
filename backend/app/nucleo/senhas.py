import threading

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

_ph = PasswordHasher()
# o argon2 usa ~64 MiB por chamada; limita quantas rodam juntas para o processo não estourar a memória
_vagas = threading.BoundedSemaphore(4)


def gerar(senha: str) -> str:
    with _vagas:
        return _ph.hash(senha)


def conferir(hash_: str, senha: str) -> bool:
    try:
        with _vagas:
            return _ph.verify(hash_, senha)
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False
