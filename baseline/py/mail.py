from users import load_user


def mail_to(user_id: int) -> str:
    return f"mailto:{load_user(user_id).email}"
