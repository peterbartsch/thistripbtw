<?php
/* Local-only Stripe stand-in for smoke tests. NOT deployed.
   Run:  php -S 127.0.0.1:4242 test/mock-stripe.php
   Point the app at it with STRIPE_API_BASE=http://127.0.0.1:4242 in .env.

   Answers GET /v1/checkout/sessions/{id} like the real API. The tier amount is
   encoded in the session id: cs_smoke_<amount>_<nonce>  (e.g. cs_smoke_250_ab12).
   Returns the same id back, so replaying an id trips the app's dup guard (409). */

$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
if (!preg_match('#^/v1/checkout/sessions/([^/]+)$#', $path, $m)) {
  http_response_code(404);
  header('Content-Type: application/json');
  echo json_encode(['error' => ['message' => 'No such checkout session']]);
  return;
}
$id = rawurldecode($m[1]);
$amount = preg_match('/_(\d+)_/', $id, $a) ? (int)$a[1] : 250;   // default plan tier
// let a test force an unpaid/not-found session
$paid = strpos($id, 'unpaid') === false;
/* Real sessions carry the address Stripe collected to send a receipt; D-067 mints the account
   from it. `noemail` in the id drops it, so a test can prove a claim still succeeds without. */
$email = strpos($id, 'noemail') !== false ? null : 'buyer+' . substr(sha1($id), 0, 8) . '@example.test';

header('Content-Type: application/json');
echo json_encode([
  'id'             => $id,
  'object'         => 'checkout.session',
  'payment_status' => $paid ? 'paid' : 'unpaid',
  'amount_total'   => $amount,
  'currency'       => 'usd',
  'customer_details' => $email ? ['email' => $email] : null,
]);
