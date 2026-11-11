import app from './app.js';
import { port, db, mailer } from './runtime.js';
import { runAuctionJobs } from './auction-service.js';
import { runRefundJobs } from './routes/refunds.js';

const server = app.listen(port, () => {
  console.log(`Khamari API listening on http://localhost:${port} (${db ? 'Firestore connected' : 'Firestore unavailable — data APIs disabled'})`);
});


if (db && process.env.ENABLE_BACKGROUND_JOBS !== 'false') {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await runAuctionJobs(); await runRefundJobs(); } catch (error) { console.error('Background job failed:', error.message); } finally { running = false; }
  };
  setTimeout(tick, 3000).unref();
 setInterval(tick, 300000).unref();
}

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use. Stop the previous backend before starting this one.`);
  } else {
    console.error('Server failed to start:', error.message);
  }
  if (mailer) mailer.close();
  process.exit(1);
});