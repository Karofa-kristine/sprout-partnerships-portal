'use strict';

/**
 * Per-product access control. All internal + partner domains may SIGN IN; the
 * only restriction is which product each may open.
 *   - INTERNAL_DOMAINS (default sprout.ph) → all products
 *   - each partner domain → only its own product
 * Peoplebox Subscriptions rides on Peoplebox access (product key 'peoplebox').
 */

const PRODUCT_DOMAINS = {
  peoplebox: 'peoplebox.ai',
  teamtailor: 'teamtailor.com',
  disprz: 'disprz.com',
  hubstaff: 'hubstaff.com',
};

function internalDomains() {
  return (process.env.INTERNAL_DOMAINS || 'sprout.ph')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function domainOf(email) {
  return ((email || '').split('@')[1] || '').toLowerCase();
}

function allowedProductsForDomain(domain) {
  if (internalDomains().includes(domain)) return Object.keys(PRODUCT_DOMAINS);
  return Object.keys(PRODUCT_DOMAINS).filter((k) => PRODUCT_DOMAINS[k] === domain);
}

function userDomain(req) {
  return domainOf(req.session && req.session.user && req.session.user.email);
}

function allowedProducts(req) {
  return allowedProductsForDomain(userDomain(req));
}

// Express middleware: block a route unless the signed-in user may see `product`.
function requireProduct(product) {
  return function (req, res, next) {
    if (allowedProducts(req).indexOf(product) >= 0) return next();
    return res.status(403).json({ error: 'forbidden', message: 'Your account does not have access to this product.' });
  };
}

// Every internal + partner domain must be able to SIGN IN (product access is
// enforced separately). Augment ALLOWED_EMAIL_DOMAINS in code so partners
// aren't blocked at the Google gate even if the env var wasn't updated.
function ensureSignInDomains() {
  const set = {};
  (process.env.ALLOWED_EMAIL_DOMAINS || 'sprout.ph')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    .concat(internalDomains())
    .concat(Object.values(PRODUCT_DOMAINS))
    .forEach((d) => { if (d) set[d] = 1; });
  process.env.ALLOWED_EMAIL_DOMAINS = Object.keys(set).join(',');
  return process.env.ALLOWED_EMAIL_DOMAINS;
}

module.exports = {
  PRODUCT_DOMAINS, internalDomains, domainOf, allowedProductsForDomain,
  userDomain, allowedProducts, requireProduct, ensureSignInDomains,
};
