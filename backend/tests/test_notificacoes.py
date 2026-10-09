from sqlalchemy import text

CORPO = {"resource": "/orders/1", "user_id": 42, "topic": "orders_v2", "application_id": 123}


def _contar(dono) -> int:
    with dono.connect() as c:
        return c.execute(text("select count(*) from notificacoes_recebidas")).scalar_one()


def test_grava_e_nao_duplica_pendente(cliente, dono):
    assert cliente.post("/api/ml/notificacoes", json=CORPO).status_code == 200
    assert cliente.post("/api/ml/notificacoes", json=CORPO).status_code == 200
    assert _contar(dono) == 1


def test_processada_permite_nova_notificacao_do_mesmo_recurso(cliente, dono):
    cliente.post("/api/ml/notificacoes", json=CORPO)
    with dono.begin() as c:
        c.execute(text("update notificacoes_recebidas set processado_em = now()"))
    cliente.post("/api/ml/notificacoes", json=CORPO)
    assert _contar(dono) == 2


def test_application_id_de_outro_app_e_recusado(cliente, dono):
    r = cliente.post("/api/ml/notificacoes", json=CORPO | {"application_id": 999})
    assert r.status_code == 400
    assert _contar(dono) == 0


def test_webhook_aceita_chamada_sem_sessao_e_sem_cabecalho_csrf():
    from fastapi.testclient import TestClient

    from app.main import app
    with TestClient(app) as c:
        assert c.post("/api/ml/notificacoes", json=CORPO).status_code == 200
