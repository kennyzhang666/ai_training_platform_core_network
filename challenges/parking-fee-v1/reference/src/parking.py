from datetime import datetime


FREE_MINUTES = 30
HOURLY_RATE = 8.0
MAX_FEE = 80.0
MEMBER_DISCOUNT = 0.8


def calculate_fee(entry_time: str, exit_time: str, is_member: bool = False) -> float:
    entry = datetime.fromisoformat(entry_time)
    exit = datetime.fromisoformat(exit_time)
    minutes = max(0, int((exit - entry).total_seconds() // 60))
    if minutes <= FREE_MINUTES:
        return 0.0
    hours = (minutes + 59) // 60
    amount = min(hours * HOURLY_RATE, MAX_FEE)
    return round(amount * (MEMBER_DISCOUNT if is_member else 1.0), 2)
