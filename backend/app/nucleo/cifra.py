import base64
import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.nucleo.configuracao import configuracao


def _chaves() -> dict[int, bytes]:
    pares = (p.split(":", 1) for p in configuracao().chaves_token.split(","))
    return {int(v): base64.b64decode(k) for v, k in pares}


def cifrar(texto: str, contexto: str) -> tuple[bytes, int]:
    chaves = _chaves()
    versao = max(chaves)
    nonce = os.urandom(12)
    dado = AESGCM(chaves[versao]).encrypt(nonce, texto.encode(), contexto.encode())
    return nonce + dado, versao


def decifrar(dado: bytes, versao: int, contexto: str) -> str:
    dado = bytes(dado)
    return AESGCM(_chaves()[versao]).decrypt(dado[:12], dado[12:], contexto.encode()).decode()
