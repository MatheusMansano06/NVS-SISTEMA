import pytest

from app.nucleo import limitador
from app.nucleo.cifra import cifrar, decifrar
from app.nucleo.senhas import conferir, gerar
from app.nucleo.sessao import emitir, ler


def test_senha_confere_so_a_correta():
    h = gerar("correta-123456")
    assert h.startswith("$argon2")
    assert conferir(h, "correta-123456")
    assert not conferir(h, "errada")


def test_cifra_ida_e_volta_sem_texto_aberto():
    dado, versao = cifrar("segredo", "conta-1")
    assert b"segredo" not in dado
    assert decifrar(dado, versao, "conta-1") == "segredo"


def test_cifra_presa_ao_contexto():
    dado, versao = cifrar("s", "conta-a")
    with pytest.raises(Exception):  # noqa: B017 — InvalidTag
        decifrar(dado, versao, "conta-b")


def test_sessao_assinada():
    token = emitir("u1")
    assert ler(token) == "u1"
    assert ler(token + "x") is None
    assert ler(None) is None


def test_limitador_bloqueia_na_sexta_e_libera_ao_limpar():
    limitador._tentativas.clear()
    assert all(limitador.permitido("k") for _ in range(5))
    assert not limitador.permitido("k")
    limitador.limpar("k")
    assert limitador.permitido("k")


def test_limitador_nao_estoura_com_threads_concorrentes():
    limitador._tentativas.clear()
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(16) as ex:
        resultados = list(ex.map(lambda _: limitador.permitido("c", 5), range(200)))
    assert resultados.count(True) == 5


def test_limitador_descarta_chaves_vencidas(monkeypatch):
    limitador._tentativas.clear()
    monkeypatch.setattr(limitador, "_VARREDURA_ACIMA", 3)
    for i in range(4):
        limitador.permitido(f"k{i}", janela=0)
    import time
    time.sleep(0.01)
    limitador.permitido("novo", janela=0)
    assert set(limitador._tentativas) == {"novo"}
