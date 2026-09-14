from credit_spread_engine import scan_credit_spread

def scan(options, **kwargs):
    return scan_credit_spread(options, option_type="PUT", **kwargs)
