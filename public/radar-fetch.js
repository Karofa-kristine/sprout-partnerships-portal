/* Shared loader for the RADAR-backed reports (Billing, Leads, ChannelHub).
 *
 * radarFetch(url) → Promise of the JSON body. A request that fails for a
 * temporary reason (network error or HTTP 5xx, e.g. a RADAR / proxy hiccup or
 * a timeout while the warehouse wakes up) is retried once after 3 seconds
 * before an error is shown. 4xx errors (no access, bad input) are not retried.
 *
 * radarStaleNote(d) → text to append to a report's "as of" line when the
 * server answered with its last saved copy because RADAR failed.
 */
(function () {
  function getJSON(url) {
    return fetch(url, { credentials: 'same-origin' }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.ok) return j;
        var e = new Error(j.message || ('HTTP ' + r.status));
        e.status = r.status;
        throw e;
      });
    });
  }

  window.radarFetch = function (url) {
    return getJSON(url).catch(function (e) {
      if (e.status && e.status < 500) throw e;
      return new Promise(function (ok) { setTimeout(ok, 3000); }).then(function () { return getJSON(url); });
    });
  };

  window.radarStaleNote = function (d) {
    if (!d || !d.stale) return '';
    return ' · ⚠ RADAR is not responding right now, so this is the last saved copy' +
      (d.staleAt && !d.fetchedAt ? ' (from ' + new Date(d.staleAt).toLocaleString() + ')' : '') + '. Try Refresh again later.';
  };
})();
