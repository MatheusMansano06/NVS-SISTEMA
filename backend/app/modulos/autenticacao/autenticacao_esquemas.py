from pydantic import BaseModel, EmailStr, Field


class Cadastro(BaseModel):
    email: EmailStr
    senha: str = Field(min_length=10, max_length=128)
    nome_empresa: str = Field(min_length=2, max_length=120)


class Entrada(BaseModel):
    email: EmailStr
    senha: str = Field(max_length=128)
