def test_saude(cliente):
    r = cliente.get("/api/saude")
    assert r.status_code == 200
    assert r.json() == {"ok": True}
