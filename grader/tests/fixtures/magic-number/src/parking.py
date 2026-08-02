from datetime import datetime


def calculate_fee(entry_time: str, exit_time: str, is_member: bool = False) -> float:
    entry = datetime.fromisoformat(entry_time)
    exit = datetime.fromisoformat(exit_time)
    minutes = max(0, int((exit - entry).total_seconds() // 60))
    if minutes <= 30:
        return 0.0
    hours = (minutes + 59) // 60
    amount = min(hours * 8.0, 80.0)
    return round(amount * (0.8 if is_member else 1.0), 2)
