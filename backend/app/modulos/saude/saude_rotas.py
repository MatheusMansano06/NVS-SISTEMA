from fastapi import APIRouter

router = APIRouter(prefix="/api")


@router.get("/saude")
def saude() -> dict[str, bool]:
    return {"ok": True}
