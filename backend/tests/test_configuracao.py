from app.nucleo.configuracao import Configuracao


def test_normaliza_url_do_railway_e_deriva_url_do_app():
    c = Configuracao(database_url="postgres://u:p@h/d", app_senha="s",
                     segredo_sessao="x", chaves_token="1:abc")
    assert c.database_url == "postgresql+psycopg://u:p@h/d"
    assert c.url_app == "postgresql+psycopg://nvs_app:s@h/d"
