from dataclasses import dataclass


@dataclass
class User:
    id: int
    name: str
    email: str


_USERS = {1: User(1, "Ada", "ada@example.com")}


def load_user(user_id: int) -> User:
    if user_id not in _USERS:
        raise KeyError(user_id)
    return _USERS[user_id]
