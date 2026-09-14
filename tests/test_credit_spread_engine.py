import sys, unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'services'/'scanner'))
from credit_spread_engine import Option, calculate_credit_spread, scan_credit_spread, black_scholes_call_price

def opt(strike,bid,offer,oi=100000,volume=100000): return Option(strike,bid,offer,10,10,oi,volume,'2026-09-06T10:00:00')
class CreditSpreadTests(unittest.TestCase):
    def test_bull_put(self):
        r=calculate_credit_spread(opt(100,8,8.5),opt(80,2,2.5),10,110,'PUT')
        self.assertIsNotNone(r); self.assertEqual(r['credit'],5.5); self.assertEqual(r['breakeven'],94.5); self.assertEqual(r['max_profit'],55); self.assertEqual(r['max_loss'],145)
    def test_bear_call(self):
        r=calculate_credit_spread(opt(120,8,8.5),opt(140,2,2.5),10,110,'CALL')
        self.assertIsNotNone(r); self.assertEqual(r['credit'],5.5); self.assertEqual(r['breakeven'],125.5); self.assertEqual(r['max_profit'],55); self.assertEqual(r['max_loss'],145); self.assertEqual(r['otm_points'],10)
    def test_call_order_rejected(self):
        self.assertIsNone(calculate_credit_spread(opt(100,8,8.5),opt(120,2,2.5),10,110,'CALL'))
    def test_put_order_rejected(self):
        self.assertIsNone(calculate_credit_spread(opt(120,8,8.5),opt(100,2,2.5),10,110,'PUT'))
    def test_call_scan(self):
        r=scan_credit_spread([opt(120,8,8.5),opt(140,2,2.5)],10,110,'CALL',min_otm_percent=5,max_otm_percent=20,max_spread_width=30,min_profit_to_loss=0,max_profit_to_loss=100)
        self.assertEqual(len(r),1); self.assertEqual(r[0]['sell_strike'],120); self.assertEqual(r[0]['buy_strike'],140)
    def test_black_scholes_call_positive(self):
        self.assertGreater(black_scholes_call_price(100,100,1,.2),0)
if __name__=='__main__': unittest.main()
