'use strict'
const { calcRowAmount, calcPurchaseSubtotal } = require('../src/utils/purchaseCalc')

describe('purchaseCalc.calcRowAmount', () => {
  test('no discount / no CC: qty × rate (unchanged legacy behaviour)', () => {
    expect(calcRowAmount({ qty: 10, rate: 25.5 })).toEqual({ amount: 255, cc_amount: 0 })
  })

  test('CC is charged on the bonus qty only', () => {
    // 5 bonus × 100 × 10% = 50 ; goods 10×100 = 1000
    expect(calcRowAmount({ qty: 10, rate: 100, bonus: 5, cc_pct: 10 })).toEqual({ amount: 1050, cc_amount: 50 })
  })

  test('discount applies to goods only, never to CC (same as routes/sales.js)', () => {
    // goods 1000 − 10% = 900 ; CC 50 stays 50
    expect(calcRowAmount({ qty: 10, rate: 100, bonus: 5, cc_pct: 10, discount_pct: 10 }))
      .toEqual({ amount: 950, cc_amount: 50 })
  })

  test('missing / blank values do not produce NaN', () => {
    const r = calcRowAmount({ qty: '', rate: undefined, bonus: null, cc_pct: '', discount_pct: '' })
    expect(r).toEqual({ amount: 0, cc_amount: 0 })
  })

  test('subtotal is the sum of discounted line amounts', () => {
    expect(calcPurchaseSubtotal([
      { qty: 2, rate: 50, discount_pct: 20 },   // 80
      { qty: 1, rate: 30 },                     // 30
    ])).toBe(110)
  })
})
