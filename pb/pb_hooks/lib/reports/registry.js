/**
 * The nine reports from docs/PLAN.md's "Reporting" table, keyed the way the
 * route, the scheduled-report cron and the Monday digest all address them.
 * One place names every key, so reports.pb.js, lib/reports/scheduled.js and
 * lib/reports/digest.js can never disagree on what "sales" or "stock" means.
 *
 * require() this from inside each handler/cron that uses it - see
 * pb/README.md on pb_hooks isolation.
 */
function registry() {
  return {
    sales: require(`${__hooks}/lib/reports/sales.js`),
    buyins: require(`${__hooks}/lib/reports/buyins.js`),
    margin: require(`${__hooks}/lib/reports/margin.js`),
    stock: require(`${__hooks}/lib/reports/stock.js`),
    channels: require(`${__hooks}/lib/reports/channels.js`),
    customers: require(`${__hooks}/lib/reports/customers.js`),
    loyalty: require(`${__hooks}/lib/reports/loyalty.js`),
    cash: require(`${__hooks}/lib/reports/cash.js`),
    compliance: require(`${__hooks}/lib/reports/compliance.js`),
  };
}

/** Keys that need role = "admin" on top of the plain staff-only route gate. */
var ADMIN_ONLY_KEYS = { compliance: true };

module.exports = { registry: registry, ADMIN_ONLY_KEYS: ADMIN_ONLY_KEYS };
