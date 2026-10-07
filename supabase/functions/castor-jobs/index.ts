// Castor Tracker — Edge Function unique : collecte des cours, estimation, backtest, accès.
// Appelée par pg_cron (en-tête x-castor-cron, secret Vault) ou par le back-office (JWT admin).
import { handle } from './handler.ts';

Deno.serve(handle);
