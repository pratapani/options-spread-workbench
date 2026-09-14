"""Live EC2 option-universe scanner for Bull Put and Bear Call credit spreads.

This version keeps the proven sequential Breeze request pattern:
- one option-chain request per underlying
- no ThreadPoolExecutor
- no artificial API rate limiter
- no automatic retries

The scanner is strategy-aware:
- BULL_PUT -> PUT/PE
- BEAR_CALL -> CALL/CE

Importing this module does NOT authenticate or start a scan.
Run it explicitly with: python scan_universe.py
"""

import csv
import json
import os
import smtplib
import time
from datetime import datetime
from email.message import EmailMessage

from breeze_connect import BreezeConnect
from dotenv import load_dotenv

from credit_spread_engine import Option, calculate_iv, scan_credit_spread


BASE = os.path.dirname(os.path.abspath(__file__))
CONFIG_FILE = os.path.join(BASE, "scan_config.json")
STOCK_LOT_FILE = os.path.join(BASE, "stock_lot.csv")

MAX_STOCKS = 0

EXCLUDED = {"NIFTY", "CNXBAN", "NIFFIN", "NIF150", "NIFNEX", "NIFSEL", "MCX"}

DEFAULT_EMAIL_TO = "durgaprasadbabu@gmail.com"


def normalize_expiry(value):
    if value is None:
        return ""

    text = str(value).strip()

    for fmt in ("%Y-%m-%d", "%d-%b-%Y"):
        try:
            return datetime.strptime(text, fmt).strftime("%d-%b-%Y")
        except ValueError:
            pass

    return ""


def load_scan_config():
    required = {
        "expiry",
        "min_otm_percent",
        "max_otm_percent",
        "max_spread_width",
        "min_profit_to_loss",
        "max_profit_to_loss",
        "min_oi",
        "min_volume",
    }

    try:
        with open(CONFIG_FILE, encoding="utf-8") as f:
            cfg = json.load(f)
    except Exception as e:
        print(f"ERROR: Cannot read {CONFIG_FILE}: {e}")
        raise SystemExit(1)

    missing = required - set(cfg)

    if missing:
        print(
            "ERROR: scan_config.json missing: "
            + ", ".join(sorted(missing))
        )
        raise SystemExit(1)

    expiry = normalize_expiry(cfg.get("expiry"))

    if not expiry:
        print("ERROR: A valid selected expiry is required.")
        raise SystemExit(1)

    try:
        out = {
            "expiry": expiry,
            "strategy": str(
                cfg.get("strategy", "BULL_PUT")
            ).upper(),
            "min_otm_percent": float(cfg["min_otm_percent"]),
            "max_otm_percent": float(cfg["max_otm_percent"]),
            "max_spread_width": float(cfg["max_spread_width"]),
            "min_profit_to_loss": float(
                cfg["min_profit_to_loss"]
            ),
            "max_profit_to_loss": float(
                cfg["max_profit_to_loss"]
            ),
            "min_oi": float(cfg["min_oi"]),
            "min_volume": float(cfg["min_volume"]),
        }
    except (TypeError, ValueError):
        print("ERROR: Invalid numeric scan configuration.")
        raise SystemExit(1)

    if out["strategy"] not in {"BULL_PUT", "BEAR_CALL"}:
        print("ERROR: strategy must be BULL_PUT or BEAR_CALL.")
        raise SystemExit(1)

    if (
        out["min_otm_percent"] < 0
        or out["max_otm_percent"] < out["min_otm_percent"]
    ):
        print("ERROR: Invalid OTM range.")
        raise SystemExit(1)

    if out["max_spread_width"] <= 0:
        print("ERROR: max_spread_width must be > 0.")
        raise SystemExit(1)

    if (
        out["min_profit_to_loss"] < 0
        or out["max_profit_to_loss"]
        < out["min_profit_to_loss"]
    ):
        print("ERROR: Invalid P:L range.")
        raise SystemExit(1)

    return out


def load_stock_lots():
    lots = {}

    if not os.path.exists(STOCK_LOT_FILE):
        return lots

    try:
        with open(
            STOCK_LOT_FILE,
            newline="",
            encoding="utf-8",
        ) as f:
            for row in csv.reader(f):
                if len(row) < 2:
                    continue

                if (
                    str(row[0]).strip().upper()
                    in {"STOCK", "SYMBOL", "STOCK_CODE"}
                ):
                    continue

                try:
                    lot = int(float(row[1]))
                    stock = row[0].strip().upper()

                    if stock and lot > 0:
                        lots[stock] = lot

                except (ValueError, TypeError):
                    pass

    except Exception as e:
        print(f"WARNING: Could not read lot file: {e}")

    return lots


def get_lot_size(stock, stock_lots):
    return stock_lots.get(stock.upper(), 1)


def discover_underlyings(nfo, option_type):
    suffix = "-PE" if option_type == "PUT" else "-CE"
    out = set()

    for key in nfo:
        if not key.startswith("OPT-") or not key.endswith(suffix):
            continue

        parts = key.split("-")

        if len(parts) >= 7 and parts[1] not in EXCLUDED:
            out.add(parts[1])

    result = sorted(out)

    if MAX_STOCKS > 0:
        return result[:MAX_STOCKS]

    return result


def available_expiries_by_stock(nfo, option_type):
    suffix = "-PE" if option_type == "PUT" else "-CE"
    out = {}

    for key in nfo:
        if not key.startswith("OPT-") or not key.endswith(suffix):
            continue

        parts = key.split("-")

        if len(parts) >= 7:
            stock = parts[1]
            expiry = "-".join(parts[2:5])
            out.setdefault(stock, set()).add(expiry)

    return out


def convert_contracts(contracts, expiry, option_type):
    options = []
    spot = None

    for x in contracts:
        try:
            strike = float(x.get("strike_price", 0))
            bid = float(x.get("best_bid_price", 0))
            offer = float(x.get("best_offer_price", 0))

            if strike <= 0:
                continue

            if x.get("spot_price") not in (None, ""):
                spot = float(x["spot_price"])

            opt = Option(
                strike,
                bid,
                offer,
                int(float(x.get("best_bid_quantity", 0))),
                int(float(x.get("best_offer_quantity", 0))),
                float(x.get("open_interest", 0)),
                int(float(x.get("total_quantity_traded", 0))),
                x.get("ltt", ""),
            )

            if spot and spot > 0:
                opt.bid_iv = calculate_iv(
                    bid,
                    spot,
                    strike,
                    expiry,
                    option_type,
                )
                opt.offer_iv = calculate_iv(
                    offer,
                    spot,
                    strike,
                    expiry,
                    option_type,
                )

            options.append(opt)

        except (ValueError, TypeError):
            continue

    return options, spot


def save_results(results, strategy):
    filename = (
        "bps_results.csv"
        if strategy == "BULL_PUT"
        else "bcs_results.csv"
    )

    option_label = (
        "PE"
        if strategy == "BULL_PUT"
        else "CE"
    )

    fields = [
        "RK",
        "STRATEGY",
        "OPTION_TYPE",
        "STOCK",
        "EXPIRY",
        "SPOT",
        "SELL",
        "BUY",
        "SELL_IV",
        "BUY_IV",
        "SELL_BID",
        "SELL_OFFER",
        "BUY_BID",
        "BUY_OFFER",
        "OTM%",
        "OTM PTS",
        "WIDTH",
        "CREDIT",
        "LOT",
        "PROFIT/LOT",
        "LOSS/LOT",
        "BREAKEVEN",
        "P:L",
    ]

    output_path = os.path.join(BASE, filename)

    with open(
        output_path,
        "w",
        newline="",
        encoding="utf-8",
    ) as f:
        writer = csv.DictWriter(
            f,
            fieldnames=fields,
        )
        writer.writeheader()

        for rank, result in enumerate(results, 1):
            lot = result.get("lot_size", 1)
            credit = result["credit"]
            width = result["width"]

            writer.writerow(
                {
                    "RK": rank,
                    "STRATEGY": strategy,
                    "OPTION_TYPE": option_label,
                    "STOCK": result.get("stock", ""),
                    "EXPIRY": result.get("expiry", ""),
                    "SPOT": result.get("spot", ""),
                    "SELL": result["sell_strike"],
                    "BUY": result["buy_strike"],
                    "SELL_IV": result.get("sell_iv", 0),
                    "BUY_IV": result.get("buy_iv", 0),
                    "SELL_BID": result.get("sell_bid", 0),
                    "SELL_OFFER": result.get("sell_offer", 0),
                    "BUY_BID": result.get("buy_bid", 0),
                    "BUY_OFFER": result.get("buy_offer", 0),
                    "OTM%": result["otm_percent"],
                    "OTM PTS": result["otm_points"],
                    "WIDTH": width,
                    "CREDIT": credit,
                    "LOT": lot,
                    "PROFIT/LOT": credit * lot,
                    "LOSS/LOT": (width - credit) * lot,
                    "BREAKEVEN": result["breakeven"],
                    "P:L": result["profit_to_loss"],
                }
            )

    print(f"Results saved to: {output_path}")
    print(
        f"Execution pricing: "
        f"SELL {option_label} BID - BUY {option_label} OFFER"
    )

    return output_path


def send_results_email(filename, count, strategy):
    smtp_user = os.getenv("SMTP_USER")
    smtp_password = os.getenv("SMTP_PASSWORD")

    if not smtp_user or not smtp_password:
        return False

    try:
        msg = EmailMessage()

        msg["Subject"] = (
            f"{strategy.replace('_', ' ')} Scanner Results - "
            f"{datetime.now():%d-%b-%Y %H:%M}"
        )
        msg["From"] = smtp_user
        msg["To"] = os.getenv(
            "EMAIL_TO",
            DEFAULT_EMAIL_TO,
        )

        msg.set_content(
            "Scanner completed.\n\n"
            f"Strategy: {strategy}\n"
            f"Qualifying strategies: {count}\n"
            f"CSV attachment: {filename}\n"
        )

        with open(filename, "rb") as f:
            msg.add_attachment(
                f.read(),
                maintype="text",
                subtype="csv",
                filename=os.path.basename(filename),
            )

        with smtplib.SMTP(
            os.getenv("SMTP_HOST", "smtp.gmail.com"),
            int(os.getenv("SMTP_PORT", "587")),
            timeout=30,
        ) as smtp:
            smtp.starttls()
            smtp.login(
                smtp_user,
                smtp_password,
            )
            smtp.send_message(msg)

        return True

    except Exception as e:
        print(f"EMAIL FAILED: {e}")
        return False


def run_scan():
    load_dotenv()

    cfg = load_scan_config()

    strategy = cfg["strategy"]
    option_type = (
        "PUT"
        if strategy == "BULL_PUT"
        else "CALL"
    )
    expiry = cfg["expiry"]

    api_key = os.getenv("BREEZE_API_KEY")
    api_secret = os.getenv("BREEZE_API_SECRET")
    session_token = os.getenv("BREEZE_SESSION_TOKEN")

    if not (
        api_key
        and api_secret
        and session_token
    ):
        print("ERROR: Breeze credentials missing from .env")
        raise SystemExit(1)

    print("=" * 120)
    print(
        f"{strategy.replace('_', ' ')} "
        "UNIVERSE SCANNER"
    )
    print("=" * 120)
    print("Authenticating...")

    breeze = BreezeConnect(
        api_key=api_key
    )

    try:
        breeze.generate_session(
            api_secret=api_secret,
            session_token=session_token,
        )
    except Exception as e:
        print(
            f"Authentication FAILED: {e}"
        )
        raise SystemExit(1)

    print(
        "Authentication OK\n"
        "Loading NFO contract universe..."
    )

    try:
        nfo = breeze.stock_script_dict_list[4]
    except Exception as e:
        print(
            f"ERROR loading NFO universe: {e}"
        )
        raise SystemExit(1)

    print(
        f"NFO contracts: {len(nfo):,}"
    )

    underlyings = discover_underlyings(
        nfo,
        option_type,
    )

    expiry_map = available_expiries_by_stock(
        nfo,
        option_type,
    )

    stock_lots = load_stock_lots()

    print(
        f"Selected expiry: {expiry}\n"
        f"Option side: {option_type}\n"
        f"Stock-like underlyings: "
        f"{len(underlyings)}\n"
    )

    all_results = []
    successful = 0
    failed = 0
    zero_candidates = 0
    failure_details = []

    start = time.time()

    # Deliberately sequential, matching the old proven BPS request pattern.
    for number, stock in enumerate(
        underlyings,
        1,
    ):
        print(
            f"[{number:03d}/"
            f"{len(underlyings):03d}] "
            f"{stock:<8} ",
            end="",
            flush=True,
        )

        try:
            if expiry not in expiry_map.get(
                stock,
                set(),
            ):
                reason = (
                    f"Selected expiry "
                    f"{expiry} not available"
                )

                print(
                    f"NO SELECTED EXPIRY │ {expiry}"
                )

                failed += 1
                failure_details.append(
                    (stock, reason)
                )
                continue

            response = (
                breeze.get_option_chain_quotes(
                    stock_code=stock,
                    exchange_code="NFO",
                    product_type="options",
                    expiry_date=expiry,
                    right=(
                        "put"
                        if option_type == "PUT"
                        else "call"
                    ),
                    strike_price="",
                )
            )

            if response.get("Status") != 200:
                error = response.get(
                    "Error",
                    "Unknown error",
                )

                print(
                    f"FAILED │ {error}"
                )

                failed += 1
                failure_details.append(
                    (stock, str(error))
                )
                continue

            contracts = (
                response.get("Success")
                or []
            )

            if not contracts:
                print("NO CONTRACTS")

                failed += 1
                failure_details.append(
                    (stock, "No contracts")
                )
                continue

            options, spot = convert_contracts(
                contracts,
                expiry,
                option_type,
            )

            if not spot or spot <= 0:
                print("FAILED │ No spot")

                failed += 1
                failure_details.append(
                    (stock, "No spot")
                )
                continue

            lot = get_lot_size(
                stock,
                stock_lots,
            )

            results = scan_credit_spread(
                options,
                lot,
                spot,
                option_type,
                expiry,
                cfg["min_otm_percent"],
                cfg["max_otm_percent"],
                cfg["max_spread_width"],
                cfg["min_profit_to_loss"],
                cfg["max_profit_to_loss"],
                cfg["min_oi"],
                cfg["min_volume"],
            )

            for result in results:
                result.update(
                    stock=stock,
                    spot=spot,
                    expiry=expiry,
                    lot_size=lot,
                )

            successful += 1
            all_results.extend(results)

            if not results:
                zero_candidates += 1

            print(
                f"OK │ Spot ₹{spot:,.2f} │ "
                f"Contracts {len(contracts):2d} │ "
                f"{strategy} {len(results):2d}"
            )

        except Exception as e:
            failed += 1
            failure_details.append(
                (stock, str(e))
            )

            print(
                f"FAILED │ {e}"
            )

    all_results.sort(
        key=lambda x: (
            -x["otm_percent"],
            -x.get("sell_iv", 0),
            x["width"],
            x["profit_to_loss"],
        )
    )

    filename = save_results(
        all_results,
        strategy,
    )

    send_results_email(
        filename,
        len(all_results),
        strategy,
    )

    elapsed = (
        time.time() - start
    ) / 60

    print()
    print("=" * 120)
    print("SCAN COMPLETE")
    print(
        f"Strategy          : {strategy}"
    )
    print(
        f"Stocks scanned    : {len(underlyings)}"
    )
    print(
        f"Successful        : {successful}"
    )
    print(
        f"Failed            : {failed}"
    )
    print(
        f"No candidates     : {zero_candidates}"
    )
    print(
        f"Total opportunities: {len(all_results)}"
    )
    print(
        f"Elapsed           : {elapsed:.1f} minutes"
    )
    print("=" * 120)

    if failure_details:
        print()
        print("Failure summary:")

        for stock, reason in failure_details:
            print(
                f"  {stock}: {reason}"
            )

    return all_results


if __name__ == "__main__":
    run_scan()
