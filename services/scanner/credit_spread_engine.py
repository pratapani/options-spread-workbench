"""Common engine for short-premium (credit) vertical spreads.

Supports Bull Put (put credit) and Bear Call (call credit) spreads while
keeping the executable pricing convention used by the original BPS engine:
short leg at bid, long leg at offer.
"""
from dataclasses import dataclass
from datetime import datetime
from typing import List, Optional
from zoneinfo import ZoneInfo
import math

RISK_FREE_RATE = 0.06
DIVIDEND_YIELD = 0.0
IST = ZoneInfo("Asia/Kolkata")

@dataclass
class Option:
    strike: float
    bid: float
    offer: float
    bid_qty: int = 0
    offer_qty: int = 0
    oi: float = 0.0
    volume: int = 0
    ltt: str = ""
    bid_iv: float = 0.0
    offer_iv: float = 0.0


def normal_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def _bs_price(spot, strike, time_to_expiry, volatility, option_type,
              risk_free_rate=RISK_FREE_RATE, dividend_yield=DIVIDEND_YIELD):
    if spot <= 0 or strike <= 0 or time_to_expiry <= 0 or volatility <= 0:
        intrinsic = max(spot - strike, 0.0) if option_type == "CALL" else max(strike - spot, 0.0)
        return intrinsic
    sqrt_t = math.sqrt(time_to_expiry)
    d1 = (math.log(spot / strike) + (risk_free_rate - dividend_yield + 0.5 * volatility ** 2) * time_to_expiry) / (volatility * sqrt_t)
    d2 = d1 - volatility * sqrt_t
    if option_type == "CALL":
        return spot * math.exp(-dividend_yield * time_to_expiry) * normal_cdf(d1) - strike * math.exp(-risk_free_rate * time_to_expiry) * normal_cdf(d2)
    return strike * math.exp(-risk_free_rate * time_to_expiry) * normal_cdf(-d2) - spot * math.exp(-dividend_yield * time_to_expiry) * normal_cdf(-d1)


def black_scholes_put_price(spot, strike, time_to_expiry, volatility, risk_free_rate=RISK_FREE_RATE, dividend_yield=DIVIDEND_YIELD):
    return _bs_price(spot, strike, time_to_expiry, volatility, "PUT", risk_free_rate, dividend_yield)


def black_scholes_call_price(spot, strike, time_to_expiry, volatility, risk_free_rate=RISK_FREE_RATE, dividend_yield=DIVIDEND_YIELD):
    return _bs_price(spot, strike, time_to_expiry, volatility, "CALL", risk_free_rate, dividend_yield)


def calculate_time_to_expiry(expiry):
    try:
        text = str(expiry).strip()
        if len(text) >= 10 and text[4] == "-":
            text = text[:10]
            expiry_dt = datetime.strptime(text, "%Y-%m-%d")
        else:
            expiry_dt = datetime.strptime(text, "%d-%b-%Y")
        expiry_dt = expiry_dt.replace(hour=15, minute=30, second=0, microsecond=0, tzinfo=IST)
        return max((expiry_dt - datetime.now(IST)).total_seconds() / (365.0 * 24 * 60 * 60), 0.0)
    except Exception:
        return 0.0


def calculate_iv(option_price, spot, strike, expiry, option_type):
    try:
        price, spot, strike = float(option_price), float(spot), float(strike)
    except (TypeError, ValueError):
        return 0.0
    if price <= 0 or spot <= 0 or strike <= 0:
        return 0.0
    t = calculate_time_to_expiry(expiry)
    if t <= 0:
        return 0.0
    # European no-arbitrage lower bounds.
    if option_type == "CALL":
        lower = max(spot * math.exp(-DIVIDEND_YIELD * t) - strike * math.exp(-RISK_FREE_RATE * t), 0.0)
    else:
        lower = max(strike * math.exp(-RISK_FREE_RATE * t) - spot * math.exp(-DIVIDEND_YIELD * t), 0.0)
    if price < lower:
        return 0.0
    lo, hi = 0.0001, 5.0
    lo_price = _bs_price(spot, strike, t, lo, option_type)
    hi_price = _bs_price(spot, strike, t, hi, option_type)
    if price < lo_price or price > hi_price:
        return 0.0
    for _ in range(100):
        mid = (lo + hi) / 2
        mp = _bs_price(spot, strike, t, mid, option_type)
        if abs(mp - price) < 1e-6:
            return mid * 100.0
        if mp < price:
            lo = mid
        else:
            hi = mid
    return ((lo + hi) / 2) * 100.0


def calculate_put_iv(option_price, spot, strike, expiry, risk_free_rate=RISK_FREE_RATE, dividend_yield=DIVIDEND_YIELD):
    return calculate_iv(option_price, spot, strike, expiry, "PUT")


def calculate_call_iv(option_price, spot, strike, expiry, risk_free_rate=RISK_FREE_RATE, dividend_yield=DIVIDEND_YIELD):
    return calculate_iv(option_price, spot, strike, expiry, "CALL")


def _relationship_ok(option_type, short_strike, long_strike, spot):
    if option_type == "PUT":
        return long_strike < short_strike < spot
    return spot < short_strike < long_strike


def calculate_credit_spread(short_leg: Option, long_leg: Option, lot_size: int, spot: float,
                            option_type: str, expiry=None) -> Optional[dict]:
    option_type = option_type.upper()
    if option_type not in {"PUT", "CALL"} or spot <= 0:
        return None
    if not _relationship_ok(option_type, short_leg.strike, long_leg.strike, spot):
        return None
    if short_leg.bid <= 0 or long_leg.offer <= 0:
        return None
    width = abs(long_leg.strike - short_leg.strike)
    credit = short_leg.bid - long_leg.offer
    if width <= 0 or credit <= 0:
        return None
    max_loss_per_unit = width - credit
    if max_loss_per_unit <= 0:
        return None
    max_profit = credit * lot_size
    max_loss = max_loss_per_unit * lot_size
    if max_profit <= 0:
        return None
    if option_type == "PUT":
        otm_points = spot - short_leg.strike
        breakeven = short_leg.strike - credit
    else:
        otm_points = short_leg.strike - spot
        breakeven = short_leg.strike + credit
    if otm_points <= 0:
        return None
    otm_percent = otm_points / spot * 100.0
    if expiry:
        short_leg.bid_iv = calculate_iv(short_leg.bid, spot, short_leg.strike, expiry, option_type)
        long_leg.offer_iv = calculate_iv(long_leg.offer, spot, long_leg.strike, expiry, option_type)
    return {
        "option_type": option_type,
        "direction": "BULLISH" if option_type == "PUT" else "BEARISH",
        "sell_strike": short_leg.strike,
        "buy_strike": long_leg.strike,
        "sell_bid": short_leg.bid,
        "sell_offer": short_leg.offer,
        "sell_bid_qty": short_leg.bid_qty,
        "sell_offer_qty": short_leg.offer_qty,
        "sell_oi": short_leg.oi,
        "sell_volume": short_leg.volume,
        "sell_ltt": short_leg.ltt,
        "sell_iv": short_leg.bid_iv,
        "buy_bid": long_leg.bid,
        "buy_offer": long_leg.offer,
        "buy_bid_qty": long_leg.bid_qty,
        "buy_offer_qty": long_leg.offer_qty,
        "buy_oi": long_leg.oi,
        "buy_volume": long_leg.volume,
        "buy_ltt": long_leg.ltt,
        "buy_iv": long_leg.offer_iv,
        "width": width,
        "execution_sell_price": short_leg.bid,
        "execution_buy_price": long_leg.offer,
        "credit": credit,
        "max_profit_per_unit": credit,
        "max_loss_per_unit": max_loss_per_unit,
        "max_profit": max_profit,
        "max_loss": max_loss,
        "profit_to_loss": max_loss / max_profit,
        "otm_points": otm_points,
        "otm_percent": otm_percent,
        "breakeven": breakeven,
    }


def scan_credit_spread(options: List[Option], lot_size=1, spot=0, option_type="PUT", expiry=None,
                       min_otm_percent=3.0, max_otm_percent=8.0, max_spread_width=200,
                       min_profit_to_loss=3.0, max_profit_to_loss=5.0, min_oi=100000, min_volume=100000):
    option_type = option_type.upper()
    if spot <= 0 or option_type not in {"PUT", "CALL"}:
        return []
    results = []
    for short_leg in options:
        if short_leg.oi < min_oi or short_leg.volume < min_volume:
            continue
        if option_type == "PUT":
            if short_leg.strike >= spot:
                continue
            otm_points = spot - short_leg.strike
        else:
            if short_leg.strike <= spot:
                continue
            otm_points = short_leg.strike - spot
        otm_percent = otm_points / spot * 100.0
        if otm_percent < min_otm_percent or (max_otm_percent is not None and otm_percent > max_otm_percent):
            continue
        for long_leg in options:
            if long_leg.oi < min_oi or long_leg.volume < min_volume:
                continue
            if option_type == "PUT":
                if long_leg.strike >= short_leg.strike:
                    continue
            else:
                if long_leg.strike <= short_leg.strike:
                    continue
            width = abs(long_leg.strike - short_leg.strike)
            if width <= 0 or width > max_spread_width:
                continue
            result = calculate_credit_spread(short_leg, long_leg, lot_size, spot, option_type, expiry)
            if not result:
                continue
            ratio = result["profit_to_loss"]
            if ratio < min_profit_to_loss or ratio > max_profit_to_loss:
                continue
            results.append(result)
    results.sort(key=lambda x: (-x["otm_percent"], -x["sell_iv"], x["width"], x["profit_to_loss"]))
    return results


def calculate_bps(short_put, long_put, lot_size, spot, expiry=None):
    return calculate_credit_spread(short_put, long_put, lot_size, spot, "PUT", expiry)


def scan_bps(puts, lot_size=1, spot=0, expiry=None, min_otm_percent=3.0, max_otm_percent=8.0,
             max_spread_width=200, min_profit_to_loss=3.0, max_profit_to_loss=5.0, min_oi=100000, min_volume=100000):
    return scan_credit_spread(puts, lot_size, spot, "PUT", expiry, min_otm_percent, max_otm_percent,
                              max_spread_width, min_profit_to_loss, max_profit_to_loss, min_oi, min_volume)
