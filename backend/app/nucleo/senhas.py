from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError

_ph = PasswordHasher()


def gerar(senha: str) -> str:
    return _ph.hash(senha)


def conferir(hash_: str, senha: str) -> bool:
    try:
        return _ph.verify(hash_, senha)
    except VerifyMismatchError:
        return False
