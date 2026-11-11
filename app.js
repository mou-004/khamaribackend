
<<<<<<< HEAD
=======

>>>>>>> 4600934 (Fix backend CORS configuration)
import cors from 'cors';

import registerAuthExtra from './routes/auth-extra.js';
import registerPaymentRoutes from './routes/payments.js';
import { app } from './runtime.js';

import registerAuthRoutes from './routes/auth.js';
import registerHealthRoutes from './routes/health.js';
import registerProductsRoutes from './routes/products.js';
import registerCategoriesRoutes from './routes/categories.js';
import registerAuctionsRoutes from './routes/auctions.js';
import registerOrdersRoutes from './routes/orders.js';
import registerUploadRoutes from './routes/uploads.js';
import registerCouponRoutes from './routes/coupons.js';
import registerSellerRoutes from './routes/seller.js';
import registerAccountRoutes from './routes/account.js';
import registerAdminRoutes from './routes/admin.js';
import registerEngageRoutes from './routes/engage.js';
import registerRefundRoutes from './routes/refunds.js';
import registerPreOrderRoutes from './routes/preorders.js';
import registerSupportRoutes from './routes/support.js';

// ========================================
// CORS CONFIGURATION
// ========================================

const allowedOrigins = [
  'https://khamariclient.onrender.com',
  'http://localhost:5173'
];

app.use(cors({
  origin: allowedOrigins,
  credentials: true,
  methods: [
    'GET',
    'HEAD',
    'POST',
    'PUT',
    'PATCH',
    'DELETE',
    'OPTIONS'
  ],
  allowedHeaders: [
    'Content-Type',
    'Authorization'
  ],
  optionsSuccessStatus: 204
}));

// ========================================
// REGISTER API ROUTES
// ========================================

registerAuthRoutes(app);
registerAuthExtra(app);
registerPaymentRoutes(app);
registerHealthRoutes(app);
registerProductsRoutes(app);
registerCategoriesRoutes(app);
registerAuctionsRoutes(app);
registerOrdersRoutes(app);
registerUploadRoutes(app);
registerCouponRoutes(app);
registerSellerRoutes(app);
registerAccountRoutes(app);
registerAdminRoutes(app);
registerEngageRoutes(app);
registerRefundRoutes(app);
registerPreOrderRoutes(app);
registerSupportRoutes(app);

// ========================================
// 404 HANDLER
// ========================================

app.use((req, res) => {
  res.status(404).json({
    error: `Route not found: ${req.method} ${req.path}`
  });
});

// ========================================
// GLOBAL ERROR HANDLER
// ========================================

app.use((error, _req, res, _next) => {
  if (
    error.status &&
    error.status >= 400 &&
    error.status <= 599
  ) {
    return res.status(error.status).json({
      error: error.message
    });
  }

  console.error(error);

  const diagnostic = process.env.NODE_ENV !== 'production';

  res.status(500).json({
    error: 'An unexpected server error occurred.',
    ...(diagnostic ? {
      detail: error.message || 'Unknown server error',
      stage: error.orderStage || null,
      code: error.code || null
    } : {})
  });
});

export default app;
<<<<<<< HEAD
=======


>>>>>>> 4600934 (Fix backend CORS configuration)
