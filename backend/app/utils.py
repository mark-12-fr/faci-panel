"""utils.py — small serialization helpers."""
from sqlalchemy import inspect as sa_inspect


def orm_to_dict(obj) -> dict | None:
    """Convert a SQLAlchemy ORM row into a plain dict of its columns.

    FastAPI's jsonable_encoder then handles UUID → str, Decimal → float and
    datetime → ISO string on the way out.
    """
    if obj is None:
        return None
    return {c.key: getattr(obj, c.key) for c in sa_inspect(obj).mapper.column_attrs}


def orm_list(objs) -> list[dict]:
    return [orm_to_dict(o) for o in objs]
