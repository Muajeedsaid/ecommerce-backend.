const express = require('express');
const router = express.Router();
const Order = require('../models/Order');
const Product = require('../models/Product');

let stripe;
try {
  stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
} catch (err) {
  console.log('Stripe init error:', err.message);
}

// ─────────────────────────────────────────────
// POST /api/payment/create-checkout-session
// ─────────────────────────────────────────────
router.post('/create-checkout-session', express.json(), async (req, res) => {
  try {
    const { items, shippingAddress } = req.body;

    // ✅ Auth check — works with both cookie and Bearer token
    const token = req.headers.authorization?.split(' ')[1] || req.cookies?.token;
    if (!token) return res.status(401).json({ message: 'Not authorized' });

    const jwt = require('jsonwebtoken');
    const User = require('../models/User');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select('-password');
    if (!user) return res.status(401).json({ message: 'User not found' });

    if (!items || items.length === 0) {
      return res.status(400).json({ message: 'No items provided' });
    }
    if (!stripe) {
      return res.status(500).json({ message: 'Stripe not configured' });
    }

    const lineItems = items.map(item => ({
      price_data: {
        currency: 'usd',
        product_data: { name: item.name },
        unit_amount: Math.round(Number(item.price) * 100),
      },
      quantity: Number(item.quantity),
    }));

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      success_url: `${process.env.CLIENT_URL}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.CLIENT_URL}/cart`,
      metadata: {
        userId: user._id.toString(),
        shippingAddress: JSON.stringify(shippingAddress),
      },
    });

    const totalPrice = items.reduce(
      (sum, item) => sum + Number(item.price) * Number(item.quantity), 0
    );

    // ✅ Create order as pending — stock is NOT decremented yet
    const order = await Order.create({
      user: user._id,
      items: items.map(item => ({
        product: item.product,
        name: item.name,
        price: Number(item.price),
        quantity: Number(item.quantity),
        image: item.image || '',
      })),
      shippingAddress,
      totalPrice,
      paymentStatus: 'pending',
      orderStatus: 'processing',
      stripeSessionId: session.id,
    });

    res.json({
      success: true,
      sessionId: session.id,
      sessionUrl: session.url,
      orderId: order._id,
    });

  } catch (err) {
    console.error('Payment route error:', err.message);
    res.status(500).json({ message: 'Payment error', error: err.message });
  }
});

// ─────────────────────────────────────────────
// POST /api/payment/webhook
// ✅ Fixed: verifies Stripe signature, marks order paid, decrements stock
// ─────────────────────────────────────────────
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).json({ message: `Webhook error: ${err.message}` });
  }

  // ✅ Handle successful payment
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    try {
      const order = await Order.findOne({ stripeSessionId: session.id });

      if (!order) {
        console.error('Webhook: order not found for session', session.id);
        return res.json({ received: true });
      }

      // Already processed — skip to avoid double stock deduction
      if (order.paymentStatus === 'paid') {
        return res.json({ received: true });
      }

      // ✅ Mark order as paid
      order.paymentStatus = 'paid';
      await order.save();

      // ✅ Decrement stock only after confirmed payment
      for (const item of order.items) {
        await Product.findByIdAndUpdate(item.product, {
          $inc: { stock: -item.quantity, sold: item.quantity },
        });
      }

      console.log(`Order ${order._id} marked as paid, stock updated`);

    } catch (err) {
      console.error('Webhook processing error:', err.message);
      // Still return 200 so Stripe doesn't retry endlessly
      return res.json({ received: true });
    }
  }

  // ✅ Handle failed payment
  if (event.type === 'checkout.session.expired') {
    const session = event.data.object;
    try {
      await Order.findOneAndUpdate(
        { stripeSessionId: session.id },
        { paymentStatus: 'failed', orderStatus: 'cancelled' }
      );
    } catch (err) {
      console.error('Webhook expire error:', err.message);
    }
  }

  res.json({ received: true });
});

// ─────────────────────────────────────────────
// GET /api/payment/verify/:sessionId
// Fallback for when webhook hasn't fired yet
// ─────────────────────────────────────────────
router.get('/verify/:sessionId', async (req, res) => {
  try {
    // ✅ Auth check
    const token = req.headers.authorization?.split(' ')[1] || req.cookies?.token;
    if (!token) return res.status(401).json({ message: 'Not authorized' });

    const jwt = require('jsonwebtoken');
    const User = require('../models/User');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select('-password');
    if (!user) return res.status(401).json({ message: 'User not found' });

    const session = await stripe.checkout.sessions.retrieve(req.params.sessionId);
    const order = await Order.findOne({ stripeSessionId: req.params.sessionId });

    if (!order) return res.status(404).json({ message: 'Order not found' });

    // ✅ Fallback: if webhook missed, mark as paid here
    if (session.payment_status === 'paid' && order.paymentStatus !== 'paid') {
      order.paymentStatus = 'paid';
      await order.save();

      // Decrement stock only if not already done
      for (const item of order.items) {
        await Product.findByIdAndUpdate(item.product, {
          $inc: { stock: -item.quantity, sold: item.quantity },
        });
      }
    }

    res.json({ success: true, session, order });

  } catch (err) {
    res.status(500).json({ message: 'Verification error', error: err.message });
  }
});

module.exports = router;