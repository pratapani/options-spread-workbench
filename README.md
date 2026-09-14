# Options Spread Workbench

A single options credit-spread screening and analysis workbench supporting:

- **Bull Put Spread (BPS)** — sell the higher-strike put, buy the lower-strike put; profit if the underlying remains above the short put.
- **Bear Call Spread (BCS)** — sell the lower-strike call, buy the higher-strike call; profit if the underlying remains below the short call.

The application is for research/screening only. It does not place, modify, or cancel orders.

## Architecture

```text
Windows React/Vite dashboard
        |
        v
Windows Node controller
        |
        | SSH/SCP
        v
EC2 Python scanner
        |
        +--> Bull Put / Bear Call strategy rules
        |
        v
CSV results -> Windows dashboard
```

The scanner now uses a **common credit-spread engine**. Direction-specific rules live under `services/scanner/strategies/` so future strategies can reuse the same pricing, risk, IV, ranking and filtering infrastructure.

## Strategy mathematics

Both strategies use executable-side pricing:

```text
Credit = Short-leg BID - Long-leg OFFER
Maximum Profit = Credit × quantity
Maximum Loss = (Spread Width - Credit) × quantity
```

Bull Put:

```text
Long Put Strike < Short Put Strike < Spot
Break-even = Short Put Strike - Credit
OTM points = Spot - Short Put Strike
```

Bear Call:

```text
Spot < Short Call Strike < Long Call Strike
Break-even = Short Call Strike + Credit
OTM points = Short Call Strike - Spot
```

## Project structure

```text
apps/
  controller/
    controller.mjs
    public/
  web/
    src/main.jsx
    src/styles.css
    public/sample_bps_results.csv
    public/sample_bcs_results.csv
services/
  scanner/
    credit_spread_engine.py
    bps_engine.py                 # backward-compatible BPS API
    scan_universe.py              # live Breeze scanner
    scan_config.json
    requirements.txt
    strategies/
      bull_put.py
      bear_call.py
      __init__.py
scripts/
  deploy-scanner.ps1
tests/
  test_bps_engine.py
  test_credit_spread_engine.py
data/
references/
```

## Running locally

Install dashboard dependencies:

```powershell
npm.cmd run install:web
```

Build:

```powershell
npm.cmd run build
```

Start the controller:

```powershell
npm.cmd run controller
```

Start the complete local workflow:

```powershell
npm.cmd start
```

Run Python unit tests:

```powershell
npm.cmd run test:python
```

## EC2 deployment

After changing scanner code:

```powershell
npm.cmd run deploy:scanner
```

The deployment now uploads the common engine and both strategy modules in addition to the scanner configuration.

## Scan configuration

The controller writes `services/scanner/scan_config.json` on EC2 for each run. The important strategy field is:

```json
{
  "strategy": "BULL_PUT"
}
```

or:

```json
{
  "strategy": "BEAR_CALL"
}
```

The dashboard sets this automatically from the selected strategy tab.

## Security

Never commit or redistribute:

- `.env`
- Breeze API credentials/session tokens
- AWS credentials
- PEM private keys

The ZIP distribution produced from this refactor intentionally excludes local secrets and `node_modules`/`.git`. Copy your own `.env` and SSH key back into the working directory on Windows as needed.
