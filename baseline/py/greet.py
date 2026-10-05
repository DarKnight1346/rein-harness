from users import load_user


def greeting(user_id: int) -> str:
    user = load_user(user_id)
    return f"Hello, {user.name}!"
