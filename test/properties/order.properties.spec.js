const fc = require('fast-check');

const { subtotal } = require('../../src/subtotal');
const { discounts } = require('../../src/discounts');
const { total } = require('../../src/total');
const { tax } = require('../../src/tax');
const { deliveryFee } = require('../../src/delivery');

// This price table is independent of the implementation under test.
const addOnPrices = {
  'sour-cream': 99,
  'fried-onion': 149,
  'bacon-bits': 199
};

function referenceSubtotal(order) {
  return order.items.reduce((sum, item) => {
    const extras = item.addOns.reduce((cost, addOn) => cost + addOnPrices[addOn], 0);
    return sum + (item.unitPriceCents + extras) * item.qty;
  }, 0);
}

const skuArb = fc.constantFrom('P6-POTATO', 'P12-POTATO', 'P24-POTATO', 'P6-SAUER', 'P12-SAUER');
const fillingArb = fc.constantFrom('potato', 'sauerkraut', 'sweet-cheese', 'mushroom');
const tierArb = fc.constantFrom('guest', 'regular', 'vip');
const orderItemArb = fc.record({
  kind: fc.constantFrom('hot', 'frozen'),
  sku: skuArb,
  title: fc.string(),
  filling: fillingArb,
  qty: fc.oneof(fc.integer({ min: 1, max: 30 }), fc.constantFrom(6, 11, 12, 13, 23, 24, 25)),
  unitPriceCents: fc.integer({ min: 500, max: 3000 }),
  addOns: fc.subarray(Object.keys(addOnPrices))
});
const orderArb = fc.record({
  items: fc.array(orderItemArb, { minLength: 1, maxLength: 5 })
});
const deliveryArb = fc.record({
  zone: fc.constantFrom('local', 'outer'),
  rush: fc.boolean()
});
const contextArb = fc.record({
  profile: fc.record({ tier: tierArb }),
  delivery: deliveryArb,
  coupon: fc.constantFrom(null, 'FIRST10', 'PIEROGI-BOGO')
});
const ordinaryScenarioArb = fc.record({ order: orderArb, context: contextArb });

// With qty 1, no add-ons, and no coupon, the subtotal is already the
// discounted subtotal. This reaches exact delivery boundaries without
// trusting discounts() to construct the expected input.
const thresholds = { guest: 5000, regular: 4000, vip: 3000 };
const boundaryScenarioArb = fc.tuple(
  orderItemArb,
  tierArb,
  fc.constantFrom(-1, 0, 1),
  deliveryArb
).map(([item, tier, offset, delivery]) => ({
  order: {
    items: [{
      ...item,
      qty: 1,
      unitPriceCents: thresholds[tier] + offset,
      addOns: []
    }]
  },
  context: { profile: { tier }, delivery, coupon: null }
}));
const scenarioArb = fc.oneof(ordinaryScenarioArb, boundaryScenarioArb);

function frozenOrder(unitPriceCents, qty = 1) {
  return {
    items: [{
      kind: 'frozen',
      sku: 'P6-POTATO',
      title: 'Potato pierogi',
      filling: 'potato',
      qty,
      unitPriceCents,
      addOns: []
    }]
  };
}

const guestLocalContext = {
  profile: { tier: 'guest' },
  delivery: { zone: 'local', rush: false },
  coupon: null
};
const options = { numRuns: 300, seed: 623 };

describe('Property-Based Tests for Orders', () => {
  it('1. subtotal is always a non-negative integer number of cents', () => {
    fc.assert(fc.property(orderArb, (order) => {
      const result = subtotal(order);
      expect(Number.isInteger(result)).toBe(true);
      expect(result).toBeGreaterThanOrEqual(0);
    }), options);
  });

  it('2. reordering items does not change the subtotal', () => {
    fc.assert(fc.property(orderArb, (order) => {
      const reordered = { ...order, items: [...order.items].reverse() };
      expect(subtotal(reordered)).toBe(subtotal(order));
    }), options);
  });

  it('3. subtotal matches an independent per-unit add-on calculation', () => {
    fc.assert(fc.property(orderArb, (order) => {
      expect(subtotal(order)).toBe(referenceSubtotal(order));
    }), {
      ...options,
      // Guarantee that an add-on must be multiplied by a quantity above 1.
      examples: [[{
        items: [{ ...frozenOrder(500, 3).items[0], addOns: ['sour-cream'] }]
      }]]
    });
  });

  it('4. upgrading the customer tier never raises the delivery fee', () => {
    fc.assert(fc.property(scenarioArb, ({ order, context }) => {
      // Keep the same order and delivery settings; change only the tier.
      const guest = deliveryFee(order, context.delivery, { ...context.profile, tier: 'guest' });
      const regular = deliveryFee(order, context.delivery, { ...context.profile, tier: 'regular' });
      const vip = deliveryFee(order, context.delivery, { ...context.profile, tier: 'vip' });
      expect(guest).toBeGreaterThanOrEqual(regular);
      expect(regular).toBeGreaterThanOrEqual(vip);
    }), options);
  });

  it('5. total equals subtotal minus discounts plus delivery and tax', () => {
    fc.assert(fc.property(scenarioArb, ({ order, context }) => {
      // This checks composition. The component functions can still have bugs.
      const expected = subtotal(order)
        - discounts(order, context.profile, context.coupon)
        + deliveryFee(order, context.delivery, context.profile)
        + tax(order, context.delivery);
      expect(total(order, context)).toBe(expected);
    }), {
      ...options,
      examples: [
        [{ order: frozenOrder(500), context: guestLocalContext }],
        [{
          order: frozenOrder(500),
          context: {
            ...guestLocalContext,
            delivery: { zone: 'local', rush: true }
          }
        }],
        [{ order: frozenOrder(10000), context: guestLocalContext }],
        [{ order: frozenOrder(10001), context: guestLocalContext }],
        [{ order: frozenOrder(500, 24), context: guestLocalContext }]
      ]
    });
  });
});
