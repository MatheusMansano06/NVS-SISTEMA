import httpx
from sqlalchemy import Connection, text

from app.integracoes.mercado_livre import ml_cliente as ml
from app.nucleo.banco import transacao
from app.nucleo.cifra import cifrar, decifrar


class ContaPrecisaReautorizar(Exception):
    pass


def salvar_credenciais(conn: Connection, conta_id: str, empresa_id: str, t: dict) -> None:
    acesso, versao = cifrar(t["access_token"], conta_id)
    refresh, _ = cifrar(t["refresh_token"], conta_id)
    conn.execute(text(
        "insert into credenciais_conta(conta_id, empresa_id, access_token_cifrado, refresh_token_cifrado, "
        "expira_em, escopos, versao_chave) values (cast(:c as uuid), cast(:e as uuid), :a, :r, "
        "now() + :s * interval '1 second', :esc, :v) "
        "on conflict (conta_id) do update set access_token_cifrado = excluded.access_token_cifrado, "
        "refresh_token_cifrado = excluded.refresh_token_cifrado, expira_em = excluded.expira_em, "
        "escopos = excluded.escopos, versao_chave = excluded.versao_chave, atualizado_em = now()"),
        {"c": conta_id, "e": empresa_id, "a": acesso, "r": refresh,
         "s": int(t["expires_in"]), "esc": t.get("scope", ""), "v": versao})


def token_valido(conta_id: str, empresa_id: str, http: httpx.Client) -> str:
    reautorizar = False
    # a trava segura uma conexão durante a chamada ao ML; é por conta, então só serializa a mesma conta
    with transacao(empresa_id) as conn:
        conn.execute(text("select pg_advisory_xact_lock(hashtextextended(:c, 0))"), {"c": conta_id})
        r = conn.execute(text(
            "select access_token_cifrado, refresh_token_cifrado, versao_chave, "
            "expira_em > now() + interval '60 seconds' as vivo "
            "from credenciais_conta where conta_id = cast(:c as uuid)"), {"c": conta_id}).one()
        if r.vivo:
            return decifrar(r.access_token_cifrado, r.versao_chave, conta_id)
        try:
            novos = ml.renovar(http, decifrar(r.refresh_token_cifrado, r.versao_chave, conta_id))
        except ml.RefreshInvalido:
            conn.execute(text("update contas_marketplace set status = 'reautorizar' "
                              "where id = cast(:c as uuid)"), {"c": conta_id})
            reautorizar = True
        else:
            salvar_credenciais(conn, conta_id, empresa_id, novos)
            return novos["access_token"]
    if reautorizar:
        raise ContaPrecisaReautorizar(conta_id)
    raise AssertionError("inalcancavel")
