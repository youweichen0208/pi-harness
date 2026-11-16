/** Legacy browser entry now exercises the real native single-package update
 * contract: explicit review, success/failure, rollback and durable job status.
 * OMP has no Pi batch-update partial result or raw worker-log UI. */
if (!process.argv.includes('--browser')) process.argv.push('--browser');
await import('./component-updates-test.mjs');
